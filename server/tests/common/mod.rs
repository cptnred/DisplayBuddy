//! Test harness: the full router on a SQLite file in a temp directory, a manual clock,
//! requests via `tower::ServiceExt::oneshot` (axum example `testing`).
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use buddy_server::clock::ManualClock;
use buddy_server::config::Config;
use buddy_server::{AppState, build_app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

pub const USER: &str = "martin";
pub const PASS: &str = "correct horse battery";
pub const ORIGIN: &str = "https://buddy.example.test";
pub const START: &str = "2026-11-06T10:00:00.000Z";
pub const NOTE_A: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";

pub struct TestApp {
    pub app: Router,
    pub state: AppState,
    pub clock: Arc<ManualClock>,
    pub dir: TempDir,
    pub user_id: i64,
}

#[derive(Debug)]
pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub text: String,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

pub enum Cred<'a> {
    None,
    Bearer(&'a str),
    /// Cookie with the PWA's normal headers (same-origin, X-Buddy-Request).
    Cookie(&'a str),
}

impl TestApp {
    pub async fn new() -> Self {
        Self::with(|_| {}).await
    }

    pub async fn with(f: impl FnOnce(&mut Config)) -> Self {
        Self::build(f, None).await
    }

    /// With a fresh VAPID key and the given push options (fake push service).
    pub async fn with_push(opts: buddy_server::push::PushOptions) -> Self {
        Self::build(|_| {}, Some(opts)).await
    }

    async fn build(
        f: impl FnOnce(&mut Config),
        push: Option<buddy_server::push::PushOptions>,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::for_tests(dir.path());
        if push.is_some() {
            let key = dir.path().join("vapid.pem");
            buddy_server::vapid::generate(&key, false).unwrap();
            config.vapid_private_key_file = Some(key);
            config.vapid_subject = Some("mailto:admin@example.org".into());
        }
        f(&mut config);
        let db = buddy_server::db::open(&config.db_path).await.unwrap();
        let clock = Arc::new(ManualClock::at(START));
        let user_id =
            buddy_server::cli::user_add(&db, clock_now(&clock), USER, PASS, "Europe/Berlin")
                .await
                .unwrap();
        let vapid = config
            .vapid_private_key_file
            .as_ref()
            .map(|p| buddy_server::vapid::Vapid::load(p, None).unwrap());
        let mut state = AppState::new(db, config, clock.clone(), vapid);
        if let Some(opts) = push {
            state = state.with_push(opts);
        }
        Self {
            app: build_app(state.clone()),
            state,
            clock,
            dir,
            user_id,
        }
    }

    pub async fn send(&self, mut req: Request<Body>) -> Resp {
        if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
            req.extensions_mut().insert(ConnectInfo(
                "198.51.100.1:40000".parse::<SocketAddr>().unwrap(),
            ));
        }
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Resp {
            status,
            headers,
            body,
            text,
        }
    }

    pub async fn call(
        &self,
        method: Method,
        path: &str,
        cred: Cred<'_>,
        body: Option<Value>,
    ) -> Resp {
        self.send(request(method, path, cred, body)).await
    }

    /// Registers a desktop/mobile device; returns (deviceId, token).
    pub async fn device(&self, kind: &str) -> (String, String) {
        let r = self
            .call(
                Method::POST,
                "/api/v1/devices",
                Cred::None,
                Some(json!({"username": USER, "password": PASS, "deviceName": format!("{kind} test"), "kind": kind})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        (
            r.body["deviceId"].as_str().unwrap().to_string(),
            r.body["token"].as_str().unwrap().to_string(),
        )
    }

    /// PWA login; returns (deviceId, cookie value, full Set-Cookie header).
    pub async fn web_login(&self, device_id: Option<&str>) -> (String, String, String) {
        let r = self
            .send(pwa_request(
                Method::POST,
                "/api/v1/session",
                None,
                Some(json!({"username": USER, "password": PASS, "deviceName": "Handy", "deviceId": device_id})),
            ))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        let set = r.header("set-cookie").unwrap().to_string();
        let value = set
            .split(';')
            .next()
            .unwrap()
            .split_once('=')
            .unwrap()
            .1
            .to_string();
        (r.body["deviceId"].as_str().unwrap().to_string(), value, set)
    }

    pub async fn push(&self, token: &str, body: Value) -> Resp {
        let r = self
            .call(
                Method::POST,
                "/api/v1/sync/push",
                Cred::Bearer(token),
                Some(body),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        r
    }

    pub async fn changes(&self, token: &str, since: i64, limit: i64) -> Resp {
        self.call(
            Method::GET,
            &format!("/api/v1/sync/changes?since={since}&limit={limit}"),
            Cred::Bearer(token),
            None,
        )
        .await
    }

    pub fn clock_now(&self) -> chrono::DateTime<chrono::Utc> {
        clock_now(&self.clock)
    }

    pub async fn scalar_i64(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }
}

fn clock_now(c: &ManualClock) -> chrono::DateTime<chrono::Utc> {
    use buddy_server::clock::Clock;
    c.now()
}

pub fn request(method: Method, path: &str, cred: Cred<'_>, body: Option<Value>) -> Request<Body> {
    match cred {
        Cred::Cookie(c) => pwa_request(method, path, Some(c), body),
        Cred::Bearer(t) => {
            let mut b = Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {t}"));
            if body.is_some() {
                b = b.header(header::CONTENT_TYPE, "application/json");
            }
            b.body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
                .unwrap()
        }
        Cred::None => {
            let mut b = Request::builder().method(method).uri(path);
            if body.is_some() {
                b = b.header(header::CONTENT_TYPE, "application/json");
            }
            b.body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
                .unwrap()
        }
    }
}

/// A request as the PWA sends it (same origin, X-Buddy-Request, optional cookie).
pub fn pwa_request(
    method: Method,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("sec-fetch-site", "same-origin")
        .header("origin", ORIGIN)
        .header("x-buddy-request", "1");
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, format!("__Host-buddy_session={c}"));
    }
    if body.is_some() {
        b = b.header(header::CONTENT_TYPE, "application/json");
    }
    b.body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
        .unwrap()
}

pub fn note_json(id: &str, title: &str, updated_at: &str) -> Value {
    json!({"id": id, "title": title, "color": "yellow",
           "content": {"type": "doc", "content": []},
           "createdAt": "2026-11-01T08:00:00.000Z", "updatedAt": updated_at, "schemaVersion": 1})
}

pub fn note_rec(id: &str, title: &str, at: &str, by: &str) -> Value {
    json!({"id": id, "updatedAt": at, "updatedBy": by, "deleted": false, "note": note_json(id, title, at)})
}

pub fn tombstone(id: &str, at: &str, by: &str) -> Value {
    json!({"id": id, "updatedAt": at, "updatedBy": by, "deleted": true, "note": null})
}

pub fn reminder_rec(id: &str, at: &str, by: &str, state: &str, zone: Option<&str>) -> Value {
    json!({"noteId": id, "updatedAt": at, "updatedBy": by, "deleted": false,
           "reminder": {"noteId": id, "at": "2026-11-07T08:00:00.000Z", "repeat": "daily",
                        "state": state, "firedAt": null, "updatedAt": at, "timeZone": zone}})
}

/// Deterministic note id number `n`.
pub fn nid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// The request as if it came from `ip` (limits are per IP).
pub fn at_ip(mut req: Request<Body>, ip: &str) -> Request<Body> {
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(ip.parse().unwrap(), 40000)));
    req
}

/// Body of `POST /accounts` without challenge fields.
pub fn account_body(username: &str, password: &str) -> Value {
    json!({"username": username, "password": password, "deviceName": "Windows-PC",
           "timeZone": "Europe/Berlin", "inviteCode": null})
}

impl TestApp {
    /// `POST /accounts/challenge` from `ip`; returns (id, nonce solving it).
    pub async fn solved_challenge(&self, ip: &str) -> (String, u32) {
        let r = self
            .send(at_ip(
                request(
                    Method::POST,
                    "/api/v1/accounts/challenge",
                    Cred::None,
                    Some(json!({})),
                ),
                ip,
            ))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        let ch = r.body["challenge"].as_str().unwrap();
        let bits = r.body["bits"].as_u64().unwrap() as u32;
        let nonce = buddy_core::pow::solve(ch, bits, 0..u32::MAX).unwrap();
        (r.body["id"].as_str().unwrap().to_string(), nonce)
    }

    /// Full registration from `ip` (challenge + proof-of-work + `POST /accounts`).
    pub async fn register(&self, ip: &str, mut body: Value) -> Resp {
        let (id, nonce) = self.solved_challenge(ip).await;
        body["challengeId"] = json!(id);
        body["nonce"] = json!(nonce);
        self.post_at(ip, "/api/v1/accounts", body).await
    }

    pub async fn post_at(&self, ip: &str, path: &str, body: Value) -> Resp {
        self.send(at_ip(
            request(Method::POST, path, Cred::None, Some(body)),
            ip,
        ))
        .await
    }

    pub async fn count(&self, sql: &str, user: i64) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
            .bind(user)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }
}
