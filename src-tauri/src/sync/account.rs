//! v4 account client (PLAN_V4 §5, §6.1, §6.4, §6.6, §7.1): server info, registration with
//! proof-of-work, recovery and the `/me/*` calls. Messages come from `buddy_core::accounts`.
//!
//! - Errors are command strings `code: detail` (PLAN_V4 §7.1, [`error_text`]).
//! - Passwords, tokens, recovery codes and invite codes are never logged and never part of an
//!   error string; they only travel in JSON bodies.
//! - Registration and recovery end like `sync_connect` ([`super::finish_connect`]); account
//!   deletion like `sync_disconnect` without the server call ([`super::disconnect_local`]).
//! - No lock is held while a request runs.

use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use buddy_core::accounts::{
    AccountAccess, AccountCreate, AccountDelete, AccountInfo, AccountRecover, DeviceInfo,
    DeviceList, DeviceRevoke, LegalLinks, PasswordChange, RecoveryCodeRequest,
    RecoveryCodeResponse, RegistrationChallenge, ServerInfo, normalize_recovery_code,
    password_acceptable, validate_new_username,
};
use buddy_core::pow;
use chrono_tz::Tz;
use serde::de::DeserializeOwned;
use tauri::AppHandle;
use tauri_plugin_http::reqwest::{Method, RequestBuilder, Url};

use super::client::{Client, ClientError, SystemClock, TIMEOUT, Timed};
use crate::model::{AccountRegistered, SyncStatus};
use crate::state::lock;

/// The desktop gives up solving after 60 s (D-87).
pub const POW_DEADLINE: Duration = Duration::from_secs(60);
/// Nonces per chunk; the deadline is checked between chunks (D-110).
const POW_CHUNK: u32 = 1 << 18;
pub const POW_TIMEOUT: &str = "pow_timeout";
/// HTTP 404 on a fixed v4 path: a v3 server (PLAN_V4 §9.1).
pub const SERVER_TOO_OLD: &str = "server_too_old";

/// Maps a client error to `code: detail`. `on_404` is the code for HTTP 404 (`None` keeps
/// the server's code). Server codes pass through (`username_taken`, `device_limit`, …);
/// the UI maps unknown codes to a generic text.
pub fn error_text(e: ClientError, on_404: Option<&str>) -> String {
    match e {
        ClientError::Server { status: 404, .. } if on_404.is_some() => {
            format!("{}: HTTP 404", on_404.unwrap_or_default())
        }
        ClientError::Server { status: 429, .. } => "too_many_requests: HTTP 429".into(),
        ClientError::Server { status, code } if !code.is_empty() => {
            format!("{code}: HTTP {status}")
        }
        other => other.to_string(),
    }
}

async fn call<T: DeserializeOwned>(
    client: &Client,
    req: Result<RequestBuilder, ClientError>,
    on_404: Option<&str>,
) -> Result<Timed<T>, String> {
    let req = req.map_err(|e| error_text(e, None))?;
    client
        .json(req, TIMEOUT)
        .await
        .map_err(|e| error_text(e, on_404))
}

async fn call_empty(
    client: &Client,
    req: Result<RequestBuilder, ClientError>,
    on_404: Option<&str>,
) -> Result<(), String> {
    let req = req.map_err(|e| error_text(e, None))?;
    client
        .send::<serde_json::Value>(req, TIMEOUT, false)
        .await
        .map(|_| ())
        .map_err(|e| error_text(e, on_404))
}

/// Ids in URL paths (device / pairing ids are UUIDs): nothing that could change the path.
pub fn check_path_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(id)
    } else {
        Err("invalid_input: id".into())
    }
}

// ---- proof-of-work ----------------------------------------------------------------

/// Solves in chunks and checks `deadline` between them (blocking; run off the runtime).
pub fn solve_chunked(challenge: &str, bits: u32, deadline: Duration) -> Result<u32, String> {
    if pow::decode_challenge(challenge).is_none() || bits > 256 {
        return Err("protocol: malformed challenge".into());
    }
    let started = Instant::now();
    let mut lo = 0u32;
    loop {
        let hi = lo.saturating_add(POW_CHUNK);
        if let Some(nonce) = pow::solve(challenge, bits, lo..hi) {
            return Ok(nonce);
        }
        if hi == u32::MAX {
            return Err(format!("{POW_TIMEOUT}: no solution"));
        }
        if started.elapsed() >= deadline {
            return Err(format!(
                "{POW_TIMEOUT}: gave up after {} s",
                deadline.as_secs()
            ));
        }
        lo = hi;
    }
}

// ---- public calls -------------------------------------------------------------------

/// `GET /info`; 404 → `server_too_old`.
pub async fn server_info(client: &Client) -> Result<ServerInfo, String> {
    let req = Ok(client.get("/info"));
    Ok(call(client, req, Some(SERVER_TOO_OLD)).await?.value)
}

pub struct NewAccount {
    pub username: String,
    pub password: String,
    pub device_name: String,
    pub invite_code: Option<String>,
    pub time_zone: Option<String>,
}

/// Local checks with the server's rules (§8.1), then challenge → PoW → `POST /accounts`.
pub async fn register(
    client: &Client,
    account: NewAccount,
    deadline: Duration,
) -> Result<Timed<AccountAccess>, String> {
    let username = validate_new_username(account.username.trim())
        .ok_or("username_invalid: rules of PLAN_V4 §8.1")?;
    if !password_acceptable(&account.password, &username) {
        return Err("password_weak: too short or equal to the username".into());
    }
    let challenge: RegistrationChallenge = call(
        client,
        client.post_json("/accounts/challenge", &serde_json::json!({})),
        Some(SERVER_TOO_OLD),
    )
    .await?
    .value;
    let started = Instant::now();
    let (text, bits) = (challenge.challenge.clone(), challenge.bits);
    let nonce = tauri::async_runtime::spawn_blocking(move || solve_chunked(&text, bits, deadline))
        .await
        .map_err(|e| format!("internal: {e}"))??;
    log::info!(
        "account: proof of work ({bits} bits) solved in {} ms",
        started.elapsed().as_millis()
    );
    let body = AccountCreate {
        username,
        password: account.password,
        device_name: account.device_name,
        time_zone: account.time_zone,
        invite_code: account
            .invite_code
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty()),
        challenge_id: challenge.id,
        nonce,
    };
    let access: Timed<AccountAccess> = call(
        client,
        client.post_json("/accounts", &body),
        Some(SERVER_TOO_OLD),
    )
    .await?;
    log::info!(
        "account: created, this PC is device {}",
        access.value.device_id
    );
    Ok(access)
}

/// `POST /accounts/recover` (all other devices are signed out, a new code comes back).
pub async fn recover(
    client: &Client,
    username: &str,
    recovery_code: &str,
    new_password: String,
    device_name: String,
) -> Result<Timed<AccountAccess>, String> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("invalid_input: username".into());
    }
    let code = normalize_recovery_code(recovery_code).ok_or("invalid_input: recovery code")?;
    if !password_acceptable(&new_password, &username) {
        return Err("password_weak: too short or equal to the username".into());
    }
    let body = AccountRecover {
        username,
        recovery_code: code,
        new_password,
        device_name,
    };
    let access: Timed<AccountAccess> = call(
        client,
        client.post_json("/accounts/recover", &body),
        Some(SERVER_TOO_OLD),
    )
    .await?;
    log::info!(
        "account: recovered, this PC is device {}",
        access.value.device_id
    );
    Ok(access)
}

// ---- signed-in calls ------------------------------------------------------------------

pub async fn info(client: &Client) -> Result<AccountInfo, String> {
    Ok(
        call(client, Ok(client.get("/me/account")), Some(SERVER_TOO_OLD))
            .await?
            .value,
    )
}

pub async fn devices(client: &Client) -> Result<Vec<DeviceInfo>, String> {
    let list: DeviceList = call(client, Ok(client.get("/me/devices")), Some(SERVER_TOO_OLD))
        .await?
        .value;
    Ok(list.devices)
}

/// Own or younger device without password, older ones need it (`password_required`, D-91).
pub async fn revoke_device(
    client: &Client,
    device_id: &str,
    password: Option<String>,
) -> Result<(), String> {
    let id = check_path_id(device_id)?;
    let body = DeviceRevoke {
        password: password.filter(|p| !p.is_empty()),
    };
    call_empty(
        client,
        client.post_json(&format!("/me/devices/{id}/revoke"), &body),
        Some("not_found"),
    )
    .await
}

/// `PUT /me/password`. Other devices are always signed out (OWASP Session Management:
/// end other sessions after a password change; forced anyway without the current one, D-89).
pub async fn change_password(
    client: &Client,
    current_password: Option<String>,
    new_password: String,
) -> Result<(), String> {
    if !password_acceptable(&new_password, "") {
        return Err("password_weak: too short".into());
    }
    let body = PasswordChange {
        current_password: current_password.filter(|p| !p.is_empty()),
        new_password,
        sign_out_others: true,
    };
    call_empty(
        client,
        client.with_json(Method::PUT, "/me/password", &body),
        Some(SERVER_TOO_OLD),
    )
    .await
}

pub async fn new_recovery_code(client: &Client, password: String) -> Result<String, String> {
    let r: RecoveryCodeResponse = call(
        client,
        client.post_json("/me/recovery-code", &RecoveryCodeRequest { password }),
        Some(SERVER_TOO_OLD),
    )
    .await?
    .value;
    Ok(r.recovery_code)
}

/// `GET /me/export` as JSON (kept as is, unknown fields included).
pub async fn export(client: &Client) -> Result<serde_json::Value, String> {
    Ok(
        call(client, Ok(client.get("/me/export")), Some(SERVER_TOO_OLD))
            .await?
            .value,
    )
}

/// `display-buddy-export-<name>-<JJJJ-MM-TT>.json` (PLAN_V4 §6.6); the date of `exportedAt`
/// in the PC's zone, characters outside `[A-Za-z0-9._@-]` of the name become `_`.
pub fn export_file_name(export: &serde_json::Value, zone: Tz) -> String {
    let name: String = export["account"]["username"]
        .as_str()
        .unwrap_or("konto")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._@-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let date = export["exportedAt"]
        .as_str()
        .and_then(buddy_core::zoned::parse_instant)
        .map(|t| t.with_timezone(&zone).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "export".into());
    format!("display-buddy-export-{name}-{date}.json")
}

pub fn write_export(path: &Path, export: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(export).map_err(|e| format!("internal: {e}"))?;
    std::fs::write(path, bytes).map_err(|e| format!("io: {e}"))
}

pub async fn delete(
    client: &Client,
    password: String,
    confirm_username: String,
) -> Result<(), String> {
    let body = AccountDelete {
        password,
        confirm_username: confirm_username.trim().to_string(),
    };
    call_empty(
        client,
        client.post_json("/me/delete", &body),
        Some(SERVER_TOO_OLD),
    )
    .await
}

/// `kind` = imprint | privacy | terms → the configured link, only `https://` without
/// credentials (PLAN_V4 §5.1).
pub fn legal_link(links: &LegalLinks, kind: &str) -> Result<String, String> {
    let url = match kind {
        "imprint" => &links.imprint_url,
        "privacy" => &links.privacy_url,
        "terms" => &links.terms_url,
        _ => return Err("invalid_input: kind".into()),
    }
    .as_deref()
    .ok_or("not_found: link not configured")?;
    let parsed = Url::parse(url).map_err(|_| "invalid_url: link")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("invalid_url: link must be https".into());
    }
    Ok(parsed.to_string())
}

// ---- app glue (commands/account.rs) ------------------------------------------------------

/// Legal links of the last `account_server_info` (the form may show another server than
/// the stored one); `account_open_link` opens from here.
static LAST_LEGAL: LazyLock<Mutex<Option<LegalLinks>>> = LazyLock::new(|| Mutex::new(None));

fn anonymous(server_url: &str) -> Result<(String, Client), String> {
    let (stored, server) = super::resolve_server(server_url)?;
    let client = Client::new(&server, None, Arc::new(SystemClock)).map_err(|e| e.to_string())?;
    Ok((stored, client))
}

pub async fn app_server_info(server_url: &str) -> Result<ServerInfo, String> {
    let (_, client) = anonymous(server_url)?;
    let info = server_info(&client).await?;
    *lock(&LAST_LEGAL) = Some(info.legal.clone());
    Ok(info)
}

pub async fn app_register(
    app: &AppHandle,
    server_url: &str,
    account: NewAccount,
) -> Result<AccountRegistered, String> {
    let (stored, client) = anonymous(server_url)?;
    let device_name = super::check_device_name(&account.device_name)?;
    let account = NewAccount {
        device_name: device_name.clone(),
        time_zone: Some(crate::reminders::device_zone().name().to_string()),
        ..account
    };
    let access = register(&client, account, POW_DEADLINE).await?;
    connected(app, &stored, &device_name, access)
}

pub async fn app_recover(
    app: &AppHandle,
    server_url: &str,
    username: &str,
    recovery_code: &str,
    new_password: String,
    device_name: &str,
) -> Result<AccountRegistered, String> {
    let (stored, client) = anonymous(server_url)?;
    let device_name = super::check_device_name(device_name)?;
    let access = recover(
        &client,
        username,
        recovery_code,
        new_password,
        device_name.clone(),
    )
    .await?;
    connected(app, &stored, &device_name, access)
}

fn connected(
    app: &AppHandle,
    stored: &str,
    device_name: &str,
    access: Timed<AccountAccess>,
) -> Result<AccountRegistered, String> {
    let status = super::finish_connect(
        app,
        stored,
        device_name,
        &access.value.device_id,
        &access.value.token,
        access.offset_sample,
    )?;
    Ok(AccountRegistered {
        status,
        recovery_code: access.value.recovery_code,
    })
}

/// Rust-side save dialog (tauri-plugin-dialog); `None` = cancelled.
pub async fn app_export(app: &AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let client = super::signed_in_client(app)?;
    let data = export(&client).await?;
    let name = export_file_name(&data, crate::reminders::device_zone());
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Daten exportieren")
        .set_file_name(&name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("io: {e}"))?;
    write_export(&path, &data)?;
    log::info!("account: export saved");
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub async fn app_delete(
    app: &AppHandle,
    password: String,
    confirm_username: String,
) -> Result<SyncStatus, String> {
    let client = super::signed_in_client(app)?;
    delete(&client, password, confirm_username).await?;
    log::info!("account: deleted on the server; local notes stay");
    super::disconnect_local(app)
}

pub async fn app_open_link(app: &AppHandle, kind: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let cached = lock(&LAST_LEGAL).clone();
    let links = match cached {
        Some(l) => l,
        None => {
            let stored = crate::state::current_settings(app).sync_server_url;
            app_server_info(&stored).await?.legal
        }
    };
    let url = legal_link(&links, kind)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("opener: {e}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::sync::client::tests::{MockServer, Seen, fake_clock};
    use std::sync::Mutex as StdMutex;

    pub fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    pub fn client(url: &str, token: Option<&str>) -> Client {
        let clock = fake_clock("2026-11-10T10:00:00.000Z", 1);
        Client::new(url, token.map(String::from), clock).unwrap()
    }

    // ---- log capture: no secret may appear in any log line ---------------------------

    static LOGS: StdMutex<Vec<String>> = StdMutex::new(Vec::new());
    struct Capture;
    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, r: &log::Record) {
            LOGS.lock().unwrap().push(r.args().to_string());
        }
        fn flush(&self) {}
    }
    static CAPTURE: Capture = Capture;

    pub fn capture_logs() {
        if log::set_logger(&CAPTURE).is_ok() {
            log::set_max_level(log::LevelFilter::Trace);
        }
    }

    pub fn assert_not_logged(secrets: &[&str]) {
        let logs = LOGS.lock().unwrap();
        assert!(!logs.is_empty(), "nothing was logged");
        for line in logs.iter() {
            for s in secrets {
                assert!(!line.contains(s), "secret {s:?} in log line {line:?}");
            }
        }
    }

    const PASSWORD: &str = "ein langer geheimer Satz";
    const TOKEN: &str = "tok-SECRET-123";
    const RECOVERY: &str = "ABCDEFGHJKMNPQRSTVWXYZ01";
    // 16 zero bytes, base64url; nonce found quickly for small bits
    const CHALLENGE: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    fn register_server(bits: u32) -> MockServer {
        MockServer::start(Arc::new(move |req: &Seen| match req.path.as_str() {
            "/api/v1/accounts/challenge" => (
                200,
                format!(
                    r#"{{"id":"ch1","challenge":"{CHALLENGE}","bits":{bits},"expiresAt":"2026-11-10T10:10:00.000Z","serverTime":"2026-11-10T10:00:00.000Z"}}"#
                ),
            ),
            "/api/v1/accounts" => {
                let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
                let nonce = body["nonce"].as_u64().unwrap() as u32;
                if !pow::verify(CHALLENGE, bits, nonce) {
                    return (400, r#"{"error":"challenge_invalid","message":"x"}"#.into());
                }
                if body["username"] == "vergeben" {
                    return (409, r#"{"error":"username_taken","message":"x"}"#.into());
                }
                (
                    201,
                    format!(
                        r#"{{"deviceId":"dev-1","token":"{TOKEN}","recoveryCode":"{RECOVERY}","serverTime":"2026-11-10T10:00:01.000Z"}}"#
                    ),
                )
            }
            _ => (404, r#"{"error":"not_found","message":"x"}"#.into()),
        }))
    }

    fn new_account(name: &str) -> NewAccount {
        NewAccount {
            username: name.into(),
            password: PASSWORD.into(),
            device_name: "Büro-PC".into(),
            invite_code: Some("  ".into()),
            time_zone: Some("Europe/Berlin".into()),
        }
    }

    #[test]
    fn register_solves_the_challenge_and_creates_the_account() {
        capture_logs();
        let server = register_server(8);
        let c = client(&server.url, None);
        let access = block(register(&c, new_account(" Anna "), POW_DEADLINE)).unwrap();
        assert_eq!(access.value.token, TOKEN);
        assert_eq!(access.value.recovery_code, RECOVERY);
        assert!(access.offset_sample.is_some());
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].body, "{}");
        let body: serde_json::Value = serde_json::from_str(&seen[1].body).unwrap();
        assert_eq!(body["username"], "anna"); // lower-cased
        assert_eq!(body["challengeId"], "ch1");
        assert_eq!(body["timeZone"], "Europe/Berlin");
        assert_eq!(body["inviteCode"], serde_json::Value::Null); // blank → null
        assert!(seen.iter().all(|s| s.auth.is_none()));
        // secrets only in bodies, never in paths
        assert!(
            seen.iter()
                .all(|s| !s.path.contains(PASSWORD) && !s.path.contains(TOKEN))
        );
        drop(seen);
        assert_not_logged(&[PASSWORD, TOKEN, RECOVERY]);
    }

    #[test]
    fn register_checks_locally_and_maps_server_errors() {
        let server = register_server(4);
        let c = client(&server.url, None);
        let err = |a| block(register(&c, a, POW_DEADLINE)).unwrap_err();
        assert!(err(new_account("ab")).starts_with("username_invalid:"));
        assert!(err(new_account("admin")).starts_with("username_invalid:"));
        let mut weak = new_account("anna");
        weak.password = "kurz".into();
        assert!(err(weak).starts_with("password_weak:"));
        assert_eq!(server.seen.lock().unwrap().len(), 0, "nothing sent");
        assert_eq!(err(new_account("vergeben")), "username_taken: HTTP 409");
    }

    #[test]
    fn pow_gives_up_after_the_deadline() {
        // 64 bits are unsolvable in practice; deadline 0 → after the first chunk
        assert!(
            solve_chunked(CHALLENGE, 64, Duration::ZERO)
                .unwrap_err()
                .starts_with("pow_timeout:")
        );
        assert!(
            solve_chunked("!!", 4, POW_DEADLINE)
                .unwrap_err()
                .starts_with("protocol:")
        );
        let server = register_server(64);
        let c = client(&server.url, None);
        let e = block(register(&c, new_account("anna"), Duration::ZERO)).unwrap_err();
        assert!(e.starts_with("pow_timeout:"), "{e}");
        assert_eq!(server.seen.lock().unwrap().len(), 1, "no POST /accounts");
    }

    #[test]
    fn v3_server_is_too_old_and_status_codes_map() {
        let server = MockServer::start(Arc::new(|_: &Seen| {
            (
                404,
                r#"{"error":"not_found","message":"unknown API endpoint"}"#.into(),
            )
        }));
        let c = client(&server.url, None);
        assert_eq!(
            block(server_info(&c)).unwrap_err(),
            "server_too_old: HTTP 404"
        );
        assert_eq!(
            block(register(&c, new_account("anna"), POW_DEADLINE)).unwrap_err(),
            "server_too_old: HTTP 404"
        );
        let srv = |status: u16, code: &str| ClientError::Server {
            status,
            code: code.into(),
        };
        assert_eq!(
            error_text(srv(429, ""), None),
            "too_many_requests: HTTP 429"
        );
        assert_eq!(
            error_text(srv(403, "registration_closed"), None),
            "registration_closed: HTTP 403"
        );
        assert_eq!(
            error_text(srv(409, "device_limit"), Some(SERVER_TOO_OLD)),
            "device_limit: HTTP 409"
        );
        assert_eq!(
            error_text(srv(404, "not_found"), None),
            "not_found: HTTP 404"
        );
        assert_eq!(error_text(srv(502, ""), None), "server: HTTP 502 ");
        assert_eq!(error_text(ClientError::Unauthorized, None), "unauthorized");
        assert!(error_text(ClientError::Offline("x".into()), None).starts_with("offline:"));
    }

    #[test]
    fn server_info_parses() {
        let server = MockServer::start(Arc::new(|_: &Seen| {
            (
                200,
                r#"{"serverTime":"2026-11-10T10:00:00.000Z","version":"0.4.0","apiLevel":2,"registration":"invite","features":["accounts","pairing"],"passwordMinChars":12,"legal":{"imprintUrl":"https://example.org/impressum","privacyUrl":null,"termsUrl":null},"operator":null}"#
                    .into(),
            )
        }));
        let info = block(server_info(&client(&server.url, None))).unwrap();
        assert_eq!(info.api_level, 2);
        assert_eq!(server.seen.lock().unwrap()[0].path, "/api/v1/info");
        assert_eq!(
            legal_link(&info.legal, "imprint").unwrap(),
            "https://example.org/impressum"
        );
        assert!(
            legal_link(&info.legal, "privacy")
                .unwrap_err()
                .starts_with("not_found")
        );
        assert!(
            legal_link(&info.legal, "evil")
                .unwrap_err()
                .starts_with("invalid_input")
        );
        let http = LegalLinks {
            terms_url: Some("http://example.org/agb".into()),
            ..Default::default()
        };
        assert!(
            legal_link(&http, "terms")
                .unwrap_err()
                .starts_with("invalid_url")
        );
    }

    #[test]
    fn recover_normalises_the_code() {
        capture_logs();
        let server = MockServer::start(Arc::new(|req: &Seen| {
            let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
            if body["recoveryCode"] == "ABCDEFGHJKMNPQRSTVWXYZ01" {
                (
                    200,
                    r#"{"deviceId":"dev-2","token":"tok-NEW-9","recoveryCode":"ZZZZZZZZZZZZZZZZZZZZZZZZ","serverTime":"2026-11-10T10:00:00.000Z"}"#
                        .into(),
                )
            } else {
                (401, r#"{"error":"unauthorized","message":"x"}"#.into())
            }
        }));
        let c = client(&server.url, None);
        let r = |code: &str| block(recover(&c, "anna", code, PASSWORD.into(), "PC".into()));
        let ok = r("abcd-efgh-jkmn-pqrs-tvwx-yzo1").unwrap();
        assert_eq!(ok.value.recovery_code, "ZZZZZZZZZZZZZZZZZZZZZZZZ");
        assert_eq!(
            r("ABCD-EFGH-JKMN-PQRS-TVWX-YZ00").unwrap_err(),
            "unauthorized"
        );
        assert!(r("zu kurz").unwrap_err().starts_with("invalid_input:"));
        assert_eq!(
            server.seen.lock().unwrap()[0].path,
            "/api/v1/accounts/recover"
        );
        assert_not_logged(&[
            PASSWORD,
            "tok-NEW-9",
            "ZZZZZZZZZZZZZZZZZZZZZZZZ",
            "ABCDEFGHJKMNPQRSTVWXYZ01",
        ]);
    }

    #[test]
    fn signed_in_calls_use_bearer_and_the_right_paths() {
        let server = MockServer::start(Arc::new(|req: &Seen| {
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/api/v1/me/account") => (
                    200,
                    r#"{"username":"anna","createdAt":"2026-11-01T10:00:00.000Z","timeZone":"Europe/Berlin","contentFormat":1,"usage":{"bytes":1,"notes":2,"devices":3},"quota":{"bytes":null,"notes":5000,"devices":10},"recoveryCodeCreatedAt":null,"serverTime":"2026-11-10T10:00:00.000Z"}"#.into(),
                ),
                ("GET", "/api/v1/me/devices") => (
                    200,
                    r#"{"devices":[{"id":"d1","kind":"desktop","name":"PC","createdAt":"2026-11-01T10:00:00.000Z","lastSeenAt":null,"createdVia":"register","current":true,"push":false}],"serverTime":"2026-11-10T10:00:00.000Z"}"#.into(),
                ),
                ("POST", "/api/v1/me/devices/d2/revoke") if req.body.contains("password\":null") => {
                    (403, r#"{"error":"password_required","message":"x"}"#.into())
                }
                ("POST", "/api/v1/me/devices/d2/revoke") => (204, String::new()),
                ("PUT", "/api/v1/me/password") => (204, String::new()),
                ("POST", "/api/v1/me/recovery-code") => (
                    200,
                    r#"{"recoveryCode":"ABCDEFGHJKMNPQRSTVWXYZ01","serverTime":"2026-11-10T10:00:00.000Z"}"#.into(),
                ),
                ("POST", "/api/v1/me/delete") => (204, String::new()),
                _ => (404, r#"{"error":"not_found","message":"x"}"#.into()),
            }
        }));
        let c = client(&server.url, Some("tok"));
        let info = block(info(&c)).unwrap();
        assert_eq!(info.quota.notes, Some(5000));
        assert_eq!(block(devices(&c)).unwrap()[0].id, "d1");
        assert_eq!(
            block(revoke_device(&c, "d2", None)).unwrap_err(),
            "password_required: HTTP 403"
        );
        block(revoke_device(&c, "d2", Some("pw".into()))).unwrap();
        assert!(
            block(revoke_device(&c, "../x", None))
                .unwrap_err()
                .starts_with("invalid_input")
        );
        assert!(
            block(change_password(&c, None, "kurz".into()))
                .unwrap_err()
                .starts_with("password_weak")
        );
        block(change_password(&c, None, PASSWORD.into())).unwrap();
        assert_eq!(
            block(new_recovery_code(&c, "pw".into())).unwrap(),
            "ABCDEFGHJKMNPQRSTVWXYZ01"
        );
        block(delete(&c, "pw".into(), " anna ".into())).unwrap();
        let seen = server.seen.lock().unwrap();
        assert!(seen.iter().all(|s| s.auth.as_deref() == Some("Bearer tok")));
        let pw: serde_json::Value =
            serde_json::from_str(&seen.iter().find(|s| s.method == "PUT").unwrap().body).unwrap();
        assert_eq!(pw["currentPassword"], serde_json::Value::Null);
        assert_eq!(pw["signOutOthers"], true);
        let del: serde_json::Value = serde_json::from_str(&seen.last().unwrap().body).unwrap();
        assert_eq!(del["confirmUsername"], "anna");
    }

    #[test]
    fn export_is_written_to_a_file_with_the_planned_name() {
        let server = MockServer::start(Arc::new(|_: &Seen| {
            (
                200,
                r#"{"format":"display-buddy-export/1","exportedAt":"2026-11-10T23:30:00.000Z","account":{"username":"anna","createdAt":"2026-11-01T10:00:00.000Z","timeZone":"Europe/Berlin","contentFormat":1},"devices":[],"notes":[],"reminders":[],"order":null,"revisions":[],"serverTime":"2026-11-10T23:30:00.000Z"}"#
                    .into(),
            )
        }));
        let data = block(export(&client(&server.url, Some("t")))).unwrap();
        assert_eq!(server.seen.lock().unwrap()[0].path, "/api/v1/me/export");
        // 23:30 UTC is already the next day in Berlin
        assert_eq!(
            export_file_name(&data, chrono_tz::Europe::Berlin),
            "display-buddy-export-anna-2026-11-11.json"
        );
        assert_eq!(
            export_file_name(
                &serde_json::json!({"account":{"username":"a/b c"}}),
                chrono_tz::UTC
            ),
            "display-buddy-export-a_b_c-export.json"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        write_export(&path, &data).unwrap();
        let back: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(back, data);
    }

    #[test]
    fn default_server_url() {
        let (stored, server) = super::super::resolve_server("  ").unwrap();
        assert_eq!(stored, "");
        assert_eq!(server, crate::model::DEFAULT_SYNC_SERVER_URL);
        assert_eq!(
            super::super::server_or_default(""),
            "https://buddy.pev-point.de"
        );
        let (stored, server) = super::super::resolve_server("https://Own.Example/").unwrap();
        assert_eq!(
            (stored.as_str(), server.as_str()),
            ("https://own.example", "https://own.example")
        );
        assert!(super::super::resolve_server("http://own.example").is_err());
        assert!(super::super::check_device_name(&"x".repeat(65)).is_err());
    }
}
