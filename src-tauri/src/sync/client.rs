//! HTTP client for the sync server (PLAN_V3_SYNC §6, §8). Rust-side only (pattern
//! D-07), via the `reqwest` re-exported by `tauri-plugin-http` 2.8.3 (rustls + ring,
//! builds for `x86_64-pc-windows-gnu`, D-52). TLS verification is never relaxed.
//!
//! - Base `<server>/api/v1`, JSON, `Authorization: Bearer <token>`.
//! - Only `https://`; plain `http://` only for loopback hosts (local server / tests).
//! - Every successful response carries `serverTime`; together with the send and
//!   receive time it yields one clock-offset sample (`buddy_core::clock`).
//! - The token and request bodies are never logged.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri_plugin_http::reqwest::{self, StatusCode, Url};

use buddy_core::clock::offset_sample;
use buddy_core::sync::{
    ApiError, DeviceKind, DeviceLogin, DeviceLoginResponse, PushRequest, PushResponse, Seq,
    SyncChanges, error_codes,
};
use buddy_core::zoned::parse_instant;

/// Default timeout of every request (§8).
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// Timeout of the start-up pull (§8: "Beim Start zuerst ein Pull (Timeout 5 s)").
pub const START_TIMEOUT: Duration = Duration::from_secs(5);
pub const API_PREFIX: &str = "/api/v1";
/// Page size of `/sync/changes`.
pub const PULL_LIMIT: u32 = 500;

/// Source of the device time (Unix ms), injectable for tests.
pub trait DeviceClock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl DeviceClock for SystemClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// Invalid server address (not https, malformed).
    InvalidUrl(String),
    /// Network error / timeout: server not reachable.
    Offline(String),
    /// 401: token missing, wrong or revoked (or wrong password at login).
    Unauthorized,
    /// 410 `full_resync_required` on `/sync/changes`.
    ResyncRequired,
    /// Any other non-2xx answer.
    Server { status: u16, code: String },
    /// Unreadable answer.
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(m) => write!(f, "invalid_url: {m}"),
            Self::Offline(m) => write!(f, "offline: {m}"),
            Self::Unauthorized => write!(f, "unauthorized"),
            Self::ResyncRequired => write!(f, "full_resync_required"),
            Self::Server { status, code } => write!(f, "server: HTTP {status} {code}"),
            Self::Protocol(m) => write!(f, "protocol: {m}"),
        }
    }
}

/// A response plus the clock-offset sample it produced (if the RTT was short enough).
#[derive(Debug)]
pub struct Timed<T> {
    pub value: T,
    pub offset_sample: Option<i64>,
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Normalises a user-entered server address to `scheme://host[:port][/path]` without
/// trailing slash. `https` only, `http` only for loopback; no credentials, query or
/// fragment.
pub fn normalize_server_url(input: &str) -> Result<String, ClientError> {
    let input = input.trim();
    let url = Url::parse(input).map_err(|e| ClientError::InvalidUrl(e.to_string()))?;
    let host = url
        .host_str()
        .ok_or_else(|| ClientError::InvalidUrl("no host".into()))?
        .to_ascii_lowercase();
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&host) => {}
        s => return Err(ClientError::InvalidUrl(format!("scheme {s} not allowed"))),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ClientError::InvalidUrl("credentials in URL".into()));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ClientError::InvalidUrl("query or fragment".into()));
    }
    let mut s = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(&host));
    if let Some(port) = url.port() {
        s.push_str(&format!(":{port}"));
    }
    let path = url.path().trim_end_matches('/');
    s.push_str(path);
    Ok(s)
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
    clock: Arc<dyn DeviceClock>,
}

impl Client {
    /// `server_url` as entered or stored (normalised here).
    pub fn new(
        server_url: &str,
        token: Option<String>,
        clock: Arc<dyn DeviceClock>,
    ) -> Result<Self, ClientError> {
        let server = normalize_server_url(server_url)?;
        let loopback = Url::parse(&server)
            .ok()
            .and_then(|u| u.host_str().map(is_loopback))
            .unwrap_or(false);
        let mut builder = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("DisplayBuddy/", env!("CARGO_PKG_VERSION")));
        if loopback {
            // a local server is never reached through a system proxy
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|e| ClientError::Protocol(e.to_string()))?;
        Ok(Self {
            http,
            base: format!("{server}{API_PREFIX}"),
            token,
            clock,
        })
    }

    pub(super) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub(super) async fn send<T: DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
        timeout: Duration,
        expect_body: bool,
    ) -> Result<Timed<Option<T>>, ClientError> {
        let mut req = req.timeout(timeout).header("Accept", "application/json");
        if let Some(t) = &self.token {
            req = req.bearer_auth(t);
        }
        let sent = self.clock.now_ms();
        let resp = req.send().await.map_err(|e| {
            // reqwest's message never contains the token; the URL is not secret
            ClientError::Offline(e.without_url().to_string())
        })?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ClientError::Offline(e.without_url().to_string()))?;
        let received = self.clock.now_ms();
        if !status.is_success() {
            let code = serde_json::from_slice::<ApiError>(&bytes)
                .map(|e| e.error)
                .unwrap_or_default();
            return Err(match status {
                StatusCode::UNAUTHORIZED => ClientError::Unauthorized,
                StatusCode::GONE => ClientError::ResyncRequired,
                _ if code == error_codes::FULL_RESYNC_REQUIRED => ClientError::ResyncRequired,
                _ => ClientError::Server {
                    status: status.as_u16(),
                    code,
                },
            });
        }
        if !expect_body || status == StatusCode::NO_CONTENT || bytes.is_empty() {
            return Ok(Timed {
                value: None,
                offset_sample: None,
            });
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| ClientError::Protocol(e.to_string()))?;
        let offset = value
            .get("serverTime")
            .and_then(|v| v.as_str())
            .and_then(parse_instant)
            .and_then(|t| offset_sample(t.timestamp_millis(), sent, received));
        let typed =
            serde_json::from_value(value).map_err(|e| ClientError::Protocol(e.to_string()))?;
        Ok(Timed {
            value: Some(typed),
            offset_sample: offset,
        })
    }

    pub(super) async fn json<T: DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
        timeout: Duration,
    ) -> Result<Timed<T>, ClientError> {
        let t = self.send::<T>(req, timeout, true).await?;
        let value = t
            .value
            .ok_or_else(|| ClientError::Protocol("empty response".into()))?;
        Ok(Timed {
            value,
            offset_sample: t.offset_sample,
        })
    }

    pub(super) fn post_json(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<reqwest::RequestBuilder, ClientError> {
        self.with_json(reqwest::Method::POST, path, body)
    }

    /// A request with a JSON body (bodies are never logged).
    pub(super) fn with_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &impl Serialize,
    ) -> Result<reqwest::RequestBuilder, ClientError> {
        let bytes = serde_json::to_vec(body).map_err(|e| ClientError::Protocol(e.to_string()))?;
        Ok(self
            .http
            .request(method, self.url(path))
            .header("Content-Type", "application/json")
            .body(bytes))
    }

    pub(super) fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path))
    }

    pub(super) fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.delete(self.url(path))
    }

    /// `POST /devices` – registers this PC, returns device id and token.
    pub async fn register(
        &self,
        username: &str,
        password: &str,
        device_name: &str,
    ) -> Result<Timed<DeviceLoginResponse>, ClientError> {
        let body = DeviceLogin {
            username: username.to_string(),
            password: password.to_string(),
            device_name: device_name.to_string(),
            kind: DeviceKind::Desktop,
        };
        let req = self.post_json("/devices", &body)?;
        self.json(req, TIMEOUT).await
    }

    /// `DELETE /devices/current` – signs this PC out.
    pub async fn unregister(&self, timeout: Duration) -> Result<(), ClientError> {
        let req = self.http.delete(self.url("/devices/current"));
        self.send::<serde_json::Value>(req, timeout, false)
            .await
            .map(|_| ())
    }

    /// `GET /sync/changes?since&limit`.
    pub async fn changes(
        &self,
        since: Seq,
        timeout: Duration,
    ) -> Result<Timed<SyncChanges>, ClientError> {
        let req = self.http.get(self.url("/sync/changes")).query(&[
            ("since", since.to_string()),
            ("limit", PULL_LIMIT.to_string()),
        ]);
        self.json(req, timeout).await
    }

    /// `POST /sync/push`.
    pub async fn push(&self, body: &PushRequest) -> Result<Timed<PushResponse>, ClientError> {
        let req = self.post_json("/sync/push", body)?;
        self.json(req, TIMEOUT).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// One recorded request of the mock server.
    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub auth: Option<String>,
        pub body: String,
    }

    pub type Handler = dyn Fn(&Seen) -> (u16, String) + Send + Sync;

    /// Minimal HTTP/1.1 mock server on 127.0.0.1 (one request per connection).
    pub struct MockServer {
        pub url: String,
        pub seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl MockServer {
        pub fn start(handler: Arc<Handler>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let seen2 = seen.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        continue;
                    }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let mut len = 0usize;
                    let mut auth = None;
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                            break;
                        }
                        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
                        let v = v.trim().to_string();
                        match k.to_ascii_lowercase().as_str() {
                            "content-length" => len = v.parse().unwrap_or(0),
                            "authorization" => auth = Some(v),
                            _ => {}
                        }
                    }
                    let mut body = vec![0; len];
                    let _ = reader.read_exact(&mut body);
                    let req = Seen {
                        method,
                        path,
                        auth,
                        body: String::from_utf8_lossy(&body).into_owned(),
                    };
                    seen2.lock().unwrap().push(req.clone());
                    let (status, body) = handler(&req);
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                }
            });
            Self { url, seen }
        }
    }

    /// Fake device clock: every reading advances by `step` ms.
    pub struct FakeClock {
        pub now: AtomicI64,
        pub step: i64,
    }

    impl DeviceClock for FakeClock {
        fn now_ms(&self) -> i64 {
            self.now.fetch_add(self.step, Ordering::SeqCst)
        }
    }

    pub fn fake_clock(start_iso: &str, step: i64) -> Arc<FakeClock> {
        Arc::new(FakeClock {
            now: AtomicI64::new(parse_instant(start_iso).unwrap().timestamp_millis()),
            step,
        })
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn server_url_rules() {
        assert_eq!(
            normalize_server_url(" https://Buddy.Example.org/ ").unwrap(),
            "https://buddy.example.org"
        );
        assert_eq!(
            normalize_server_url("https://example.org:8443/base/").unwrap(),
            "https://example.org:8443/base"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(normalize_server_url("http://localhost").is_ok());
        for bad in [
            "http://example.org",
            "ftp://example.org",
            "example.org",
            "https://user:pw@example.org",
            "https://example.org/?x=1",
            "https://example.org/#f",
            "",
        ] {
            assert!(
                matches!(normalize_server_url(bad), Err(ClientError::InvalidUrl(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn register_sends_desktop_login_and_measures_offset() {
        let server = MockServer::start(Arc::new(|_| {
            (
                201,
                r#"{"deviceId":"d1","token":"tok","serverTime":"2026-11-06T10:00:10.000Z"}"#.into(),
            )
        }));
        // device is 10 s behind the server; every clock reading advances 100 ms
        let clock = fake_clock("2026-11-06T10:00:00.000Z", 100);
        let c = Client::new(&server.url, None, clock).unwrap();
        let r = block(c.register("anna", "geheim-passwort", "Büro-PC")).unwrap();
        assert_eq!(r.value.device_id, "d1");
        assert_eq!(r.value.token, "tok");
        // sent at 0 ms, received at 100 ms → offset = 10 000 − 50
        assert_eq!(r.offset_sample, Some(9_950));
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path, "/api/v1/devices");
        assert!(seen[0].auth.is_none());
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body["kind"], "desktop");
        assert_eq!(body["deviceName"], "Büro-PC");
    }

    #[test]
    fn bearer_token_and_error_mapping() {
        let server = MockServer::start(Arc::new(|req| {
            if req.path.starts_with("/api/v1/sync/changes?since=0") {
                (401, r#"{"error":"unauthorized","message":"x"}"#.into())
            } else if req.path.starts_with("/api/v1/sync/changes?since=5") {
                (
                    410,
                    r#"{"error":"full_resync_required","message":"x"}"#.into(),
                )
            } else if req.path.starts_with("/api/v1/sync/push") {
                (503, r#"{"error":"internal","message":"x"}"#.into())
            } else {
                (204, String::new())
            }
        }));
        let clock = fake_clock("2026-11-06T10:00:00.000Z", 1);
        let c = Client::new(&server.url, Some("secret-token".into()), clock).unwrap();
        assert_eq!(
            block(c.changes(0, TIMEOUT)).unwrap_err(),
            ClientError::Unauthorized
        );
        assert_eq!(
            block(c.changes(5, TIMEOUT)).unwrap_err(),
            ClientError::ResyncRequired
        );
        assert_eq!(
            block(c.push(&PushRequest::default())).unwrap_err(),
            ClientError::Server {
                status: 503,
                code: "internal".into()
            }
        );
        block(c.unregister(TIMEOUT)).unwrap();
        let seen = server.seen.lock().unwrap();
        assert!(
            seen.iter()
                .all(|s| s.auth.as_deref() == Some("Bearer secret-token"))
        );
        assert_eq!(seen[0].path, "/api/v1/sync/changes?since=0&limit=500");
        assert_eq!(seen.last().unwrap().method, "DELETE");
        assert_eq!(seen.last().unwrap().path, "/api/v1/devices/current");
    }

    #[test]
    fn unreachable_server_is_offline() {
        // bind and drop: nothing listens on this port any more
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let clock = fake_clock("2026-11-06T10:00:00.000Z", 1);
        let c = Client::new(&format!("http://127.0.0.1:{port}"), None, clock).unwrap();
        assert!(matches!(
            block(c.changes(0, Duration::from_secs(2))),
            Err(ClientError::Offline(_))
        ));
    }

    #[test]
    fn slow_round_trip_gives_no_sample_and_bad_json_is_protocol_error() {
        let server = MockServer::start(Arc::new(|req| {
            if req.path.contains("since=1") {
                (200, "not json".into())
            } else {
                (
                    200,
                    r#"{"cursor":3,"hasMore":false,"notes":[],"reminders":[],"order":null,"serverTime":"2026-11-06T10:00:00.000Z"}"#
                        .into(),
                )
            }
        }));
        let clock = fake_clock("2026-11-06T10:00:00.000Z", 6_000); // RTT 6 s
        let c = Client::new(&server.url, Some("t".into()), clock).unwrap();
        let r = block(c.changes(0, TIMEOUT)).unwrap();
        assert_eq!(r.value.cursor, 3);
        assert_eq!(r.offset_sample, None);
        assert!(matches!(
            block(c.changes(1, TIMEOUT)),
            Err(ClientError::Protocol(_))
        ));
    }
}
