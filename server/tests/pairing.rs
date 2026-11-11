//! v4 QR pairing (PLAN_V4 §5.1/§5.2, §6.2, §6.3, §8.3 S4–S9; Abnahme §13 Nr. 5–8, 11–13,
//! 26 server side): codes, status, cancel, redemption by the native app and the PWA,
//! expiry (simulated clock), replay and parallel redemption, CSRF, limits, device limit,
//! account lock, cascade on account deletion, no code in the log.
//!
//! Every test logs into one process-wide subscriber (TRACE): `tracing` caches callsite
//! interest per process, so a scoped subscriber in one test would miss events while other
//! tests run without one (see `account_logs.rs`).

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use axum::http::{Method, StatusCode};
use buddy_core::pairing::{PAIRING_TTL_SECS, code_hash, format_code};
use buddy_server::auth::sha256_hex;
use buddy_server::cli;
use buddy_server::config::Config;
use chrono::Duration;
use common::*;
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> LogBuf {
        self.clone()
    }
}

fn log() -> &'static LogBuf {
    static LOG: OnceLock<LogBuf> = OnceLock::new();
    LOG.get_or_init(|| {
        let buf = LogBuf::default();
        let sub = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .finish();
        tracing::subscriber::set_global_default(sub).unwrap();
        buf
    })
}

async fn app_with(f: impl FnOnce(&mut Config)) -> TestApp {
    log();
    TestApp::with(f).await
}

async fn app() -> TestApp {
    app_with(|_| {}).await
}

fn assert_error(r: &Resp, status: StatusCode, code: &str) {
    assert_eq!(r.status, status, "{}", r.text);
    assert_eq!(r.body["error"], code, "{}", r.text);
}

/// `POST /pairing` as `token`; returns the body.
async fn start(t: &TestApp, token: &str) -> Value {
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Bearer(token),
            Some(json!({})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.body
}

async fn status(t: &TestApp, token: &str, id: &str) -> Resp {
    t.call(
        Method::GET,
        &format!("/api/v1/pairing/{id}"),
        Cred::Bearer(token),
        None,
    )
    .await
}

async fn redeem_mobile_at(t: &TestApp, ip: &str, code: &str) -> Resp {
    t.post_at(
        ip,
        "/api/v1/devices/pairing",
        json!({"code": code, "deviceName": "Pixel 8", "kind": "mobile"}),
    )
    .await
}

async fn redeem_mobile(t: &TestApp, code: &str) -> Resp {
    redeem_mobile_at(t, "198.51.100.30", code).await
}

async fn redeem_web(t: &TestApp, code: &str, device_id: Option<&str>) -> Resp {
    t.send(pwa_request(
        Method::POST,
        "/api/v1/session/pairing",
        None,
        Some(json!({"code": code, "deviceName": "iPhone (Web-App)", "deviceId": device_id})),
    ))
    .await
}

fn cookie(r: &Resp) -> String {
    let set = r.header("set-cookie").expect("Set-Cookie");
    assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict"));
    set.split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string()
}

async fn device_row(t: &TestApp, id: &str) -> (String, String, Option<String>) {
    sqlx::query_as("SELECT kind, created_via, revoked_at FROM devices WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------- POST /pairing

#[tokio::test]
async fn start_returns_code_url_and_stores_only_the_hash() {
    let t = app().await;
    let (desk, token) = t.device("desktop").await;
    let b = start(&t, &token).await;
    let code = b["code"].as_str().unwrap();
    assert_eq!(code.len(), 12);
    assert_eq!(
        buddy_core::pairing::normalize_code(code).as_deref(),
        Some(code)
    );
    assert_eq!(b["url"], format!("{ORIGIN}/pair#c={code}"));
    assert_eq!(b["serverTime"], START);
    assert_eq!(b["expiresAt"], "2026-11-06T10:03:00.000Z");
    let parsed: buddy_core::pairing::PairingStart = serde_json::from_value(b.clone()).unwrap();
    let (hash, by, user): (String, String, i64) =
        sqlx::query_as("SELECT code_hash, created_by, user_id FROM pairings WHERE id = ?")
            .bind(&parsed.pairing_id)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(hash, code_hash(code));
    assert_eq!((by.as_str(), user), (desk.as_str(), t.user_id));

    let s = status(&t, &token, &parsed.pairing_id).await;
    assert_eq!(s.status, StatusCode::OK, "{}", s.text);
    assert_eq!(
        s.body,
        json!({"pairingId": parsed.pairing_id, "state": "pending", "expiresAt": "2026-11-06T10:03:00.000Z",
               "device": null, "redeemedAt": null, "serverTime": START})
    );
}

#[tokio::test]
async fn only_desktops_create_codes() {
    let t = app().await;
    let (_, mobile) = t.device("mobile").await;
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Bearer(&mobile),
            Some(json!({})),
        )
        .await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    let (_, sid, _) = t.web_login(None).await;
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Cookie(&sid),
            Some(json!({})),
        )
        .await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    let r = t
        .call(Method::POST, "/api/v1/pairing", Cred::None, Some(json!({})))
        .await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM pairings").await, 0);
}

#[tokio::test]
async fn new_code_cancels_the_open_one_of_the_same_device() {
    let t = app().await;
    let (_, token) = t.device("desktop").await;
    let first = start(&t, &token).await;
    let second = start(&t, &token).await;
    assert_ne!(first["code"], second["code"]);
    let s = status(&t, &token, first["pairingId"].as_str().unwrap()).await;
    assert_eq!(s.body["state"], "cancelled");
    let r = redeem_mobile(&t, first["code"].as_str().unwrap()).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "pairing_invalid");
    let r = redeem_mobile(&t, second["code"].as_str().unwrap()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

#[tokio::test]
async fn at_most_three_open_codes_per_account() {
    let t = app().await;
    let mut tokens = vec![];
    for _ in 0..4 {
        tokens.push(t.device("desktop").await.1);
    }
    for tok in &tokens[..3] {
        start(&t, tok).await;
    }
    t.clock.advance(Duration::seconds(60));
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Bearer(&tokens[3]),
            Some(json!({})),
        )
        .await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(
        r.header("retry-after"),
        Some("120"),
        "until the oldest expires"
    );
    // a desktop renewing its own code is not blocked by its own open one
    start(&t, &tokens[0]).await;
    // after expiry there is room again
    t.clock.advance(Duration::seconds(PAIRING_TTL_SECS));
    start(&t, &tokens[3]).await;
}

#[tokio::test]
async fn twenty_codes_per_hour_per_account() {
    let t = app().await;
    let (_, token) = t.device("desktop").await;
    for _ in 0..20 {
        start(&t, &token).await;
    }
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Bearer(&token),
            Some(json!({})),
        )
        .await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("3600"));
    t.clock.advance(Duration::hours(1));
    start(&t, &token).await;
}

// ---------------------------------------------------------------- GET / DELETE

#[tokio::test]
async fn status_and_cancel_only_for_the_creating_device() {
    let t = app().await;
    let (_, token) = t.device("desktop").await;
    let (_, other) = t.device("desktop").await;
    let id = start(&t, &token).await["pairingId"]
        .as_str()
        .unwrap()
        .to_string();
    for (method, path) in [
        (Method::GET, format!("/api/v1/pairing/{id}")),
        (Method::DELETE, format!("/api/v1/pairing/{id}")),
        (Method::GET, "/api/v1/pairing/unknown".to_string()),
        (Method::DELETE, "/api/v1/pairing/unknown".to_string()),
    ] {
        let r = t.call(method, &path, Cred::Bearer(&other), None).await;
        assert_error(&r, StatusCode::NOT_FOUND, "not_found");
    }
    let r = t
        .call(
            Method::GET,
            &format!("/api/v1/pairing/{id}"),
            Cred::None,
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(status(&t, &token, &id).await.body["state"], "pending");

    let r = t
        .call(
            Method::DELETE,
            &format!("/api/v1/pairing/{id}"),
            Cred::Bearer(&token),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(status(&t, &token, &id).await.body["state"], "cancelled");
}

#[tokio::test]
async fn cancel_after_redemption_keeps_it_redeemed() {
    let t = app().await;
    let (_, token) = t.device("desktop").await;
    let b = start(&t, &token).await;
    let id = b["pairingId"].as_str().unwrap();
    let r = redeem_mobile(&t, b["code"].as_str().unwrap()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = t
        .call(
            Method::DELETE,
            &format!("/api/v1/pairing/{id}"),
            Cred::Bearer(&token),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(status(&t, &token, id).await.body["state"], "redeemed");
}

// ---------------------------------------------------------------- redemption

/// Abnahme Nr. 6 (server) and Nr. 13: native app, sync, PC sees the device, "Das war ich
/// nicht – abmelden" signs it out.
#[tokio::test]
async fn native_app_redeems_and_desktop_can_sign_it_out() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let b = start(&t, &desk).await;
    let id = b["pairingId"].as_str().unwrap();
    t.clock.advance(Duration::seconds(30));
    // display form with hyphens and lower case is accepted
    let r = redeem_mobile(&t, &format_code(b["code"].as_str().unwrap()).to_lowercase()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(
        r.header("set-cookie").is_none(),
        "bearer endpoint, no cookie"
    );
    let access: buddy_core::pairing::PairingAccess = serde_json::from_value(r.body).unwrap();
    assert_eq!(access.username, USER);
    assert_eq!(access.server_time, "2026-11-06T10:00:30.000Z");
    let (kind, via, revoked) = device_row(&t, &access.device_id).await;
    assert_eq!(
        (kind.as_str(), via.as_str(), revoked),
        ("mobile", "pairing", None)
    );
    let th: String = sqlx::query_scalar("SELECT token_hash FROM devices WHERE id = ?")
        .bind(&access.device_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(th, sha256_hex(&access.token));

    let me = t
        .call(Method::GET, "/api/v1/me", Cred::Bearer(&access.token), None)
        .await;
    assert_eq!(me.body["deviceId"], access.device_id.as_str());
    t.push(
        &access.token,
        json!({"notes": [note_rec(NOTE_A, "Vom Handy", "2026-11-06T10:00:30.000Z", &access.device_id)], "reminders": []}),
    )
    .await;

    let s = status(&t, &desk, id).await;
    assert_eq!(
        s.body,
        json!({"pairingId": id, "state": "redeemed", "expiresAt": "2026-11-06T10:03:00.000Z",
               "device": {"id": access.device_id, "name": "Pixel 8", "kind": "mobile"},
               "redeemedAt": "2026-11-06T10:00:30.000Z", "serverTime": "2026-11-06T10:00:30.000Z"})
    );

    // "Das war ich nicht – abmelden": the younger device, no password needed (D-91)
    let r = t
        .call(
            Method::POST,
            &format!("/api/v1/me/devices/{}/revoke", access.device_id),
            Cred::Bearer(&desk),
            Some(json!({"password": null})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    let r = t.changes(&access.token, 0, 10).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

/// Abnahme Nr. 5 (server): the PWA gets a cookie session and syncs; the PC sees it.
#[tokio::test]
async fn pwa_redeems_into_a_cookie_session() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let b = start(&t, &desk).await;
    let r = redeem_web(&t, b["code"].as_str().unwrap(), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let sid = cookie(&r);
    let device = r.body["deviceId"].as_str().unwrap().to_string();
    assert_eq!(r.body["serverTime"], START);
    let (kind, via, _) = device_row(&t, &device).await;
    assert_eq!((kind.as_str(), via.as_str()), ("web", "pairing"));
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id_hash = ? AND device_id = ?")
            .bind(sha256_hex(&sid))
            .bind(&device)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(n, 1);
    let r = t
        .call(
            Method::GET,
            "/api/v1/sync/changes?since=0&limit=10",
            Cred::Cookie(&sid),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let s = status(&t, &desk, b["pairingId"].as_str().unwrap()).await;
    assert_eq!(s.body["state"], "redeemed");
    assert_eq!(
        s.body["device"],
        json!({"id": device, "name": "iPhone (Web-App)", "kind": "web"})
    );
}

/// `deviceId` is reused like in `POST /session`: same device, new session id, no new device
/// (also when the device limit is reached).
#[tokio::test]
async fn pwa_reuses_its_device_with_a_new_session() {
    let t = app_with(|c| c.quota.devices = Some(2)).await;
    let (_, desk) = t.device("desktop").await;
    let (web, old_sid, _) = t.web_login(None).await;
    let b = start(&t, &desk).await;
    let r = redeem_web(&t, b["code"].as_str().unwrap(), Some(&web)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["deviceId"], web.as_str());
    let sid = cookie(&r);
    assert_ne!(sid, old_sid);
    let old = t
        .call(Method::GET, "/api/v1/me", Cred::Cookie(&old_sid), None)
        .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED, "old session gone");
    let new = t
        .call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
        .await;
    assert_eq!(new.status, StatusCode::OK);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM devices WHERE user_id = ?", t.user_id)
            .await,
        2
    );
    let (_, via, _) = device_row(&t, &web).await;
    assert_eq!(via, "password", "a reused device keeps its origin");

    // a foreign or unknown deviceId creates a new device (here: blocked by the limit)
    let b = start(&t, &desk).await;
    let r = redeem_web(&t, b["code"].as_str().unwrap(), Some("not-a-device")).await;
    assert_error(&r, StatusCode::CONFLICT, "device_limit");
}

#[tokio::test]
async fn bad_requests_do_not_consume_the_code() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    for body in [
        json!({"code": code, "deviceName": "Pixel", "kind": "desktop"}),
        json!({"code": code, "deviceName": "  ", "kind": "mobile"}),
        json!({"code": code, "kind": "mobile"}),
    ] {
        let r = t
            .post_at("198.51.100.30", "/api/v1/devices/pairing", body)
            .await;
        // 400, or 422 from the JSON extractor for a missing field
        assert!(r.status.is_client_error(), "{}", r.text);
        assert_eq!(r.body["error"], "bad_request", "{}", r.text);
    }
    assert_eq!(redeem_mobile(&t, &code).await.status, StatusCode::OK);
}

/// Abnahme Nr. 7: a code is valid for 3 minutes (simulated clock).
#[tokio::test]
async fn expired_code_is_invalid() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let b = start(&t, &desk).await;
    t.clock.advance(Duration::seconds(PAIRING_TTL_SECS));
    let r = redeem_mobile(&t, b["code"].as_str().unwrap()).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "pairing_invalid");
    let r = redeem_web(&t, b["code"].as_str().unwrap(), None).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "pairing_invalid");
    let s = status(&t, &desk, b["pairingId"].as_str().unwrap()).await;
    assert_eq!(s.body["state"], "expired");
    assert_eq!(s.body["device"], Value::Null);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM devices WHERE user_id = ?", t.user_id)
            .await,
        1
    );

    // one second before the end it still works
    let b = start(&t, &desk).await;
    t.clock.advance(Duration::seconds(PAIRING_TTL_SECS - 1));
    assert_eq!(
        redeem_mobile(&t, b["code"].as_str().unwrap()).await.status,
        StatusCode::OK
    );
}

/// Abnahme Nr. 8: a used code a second time – one device, then `pairing_invalid`.
#[tokio::test]
async fn code_is_single_use() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    assert_eq!(redeem_mobile(&t, &code).await.status, StatusCode::OK);
    assert_error(
        &redeem_mobile(&t, &code).await,
        StatusCode::BAD_REQUEST,
        "pairing_invalid",
    );
    assert_error(
        &redeem_web(&t, &code, None).await,
        StatusCode::BAD_REQUEST,
        "pairing_invalid",
    );
    assert_eq!(
        t.count(
            "SELECT COUNT(*) FROM devices WHERE user_id = ? AND created_via = 'pairing'",
            t.user_id
        )
        .await,
        1
    );
}

/// Abnahme Nr. 8: parallel redemptions – exactly one wins.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_redemptions_exactly_one_wins() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    // real tasks on a multi-threaded runtime, so the requests race for the write lock
    let mut set = tokio::task::JoinSet::new();
    for i in 0..8 {
        let app = t.app.clone();
        let req = if i % 2 == 0 {
            at_ip(
                request(
                    Method::POST,
                    "/api/v1/devices/pairing",
                    Cred::None,
                    Some(json!({"code": code, "deviceName": "Pixel 8", "kind": "mobile"})),
                ),
                "198.51.100.30",
            )
        } else {
            at_ip(
                pwa_request(
                    Method::POST,
                    "/api/v1/session/pairing",
                    None,
                    Some(json!({"code": code, "deviceName": "Web", "deviceId": null})),
                ),
                "198.51.100.31",
            )
        };
        set.spawn(async move {
            use http_body_util::BodyExt;
            use tower::ServiceExt;
            let res = app.oneshot(req).await.unwrap();
            let status = res.status();
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            (status, body)
        });
    }
    let results = set.join_all().await;
    let ok = results.iter().filter(|r| r.0 == StatusCode::OK).count();
    assert_eq!(ok, 1, "{results:?}");
    for (status, body) in results.iter().filter(|r| r.0 != StatusCode::OK) {
        assert_eq!(
            (*status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("pairing_invalid"))
        );
    }
    assert_eq!(
        t.count(
            "SELECT COUNT(*) FROM devices WHERE user_id = ? AND created_via = 'pairing'",
            t.user_id
        )
        .await,
        1
    );
}

#[tokio::test]
async fn revoked_creator_invalidates_the_code() {
    let t = app().await;
    let (desk_id, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    cli::device_revoke(&t.state.db, t.clock_now(), &desk_id)
        .await
        .unwrap();
    assert_error(
        &redeem_mobile(&t, &code).await,
        StatusCode::BAD_REQUEST,
        "pairing_invalid",
    );
}

// ---------------------------------------------------------------- CSRF, limits

/// Abnahme Nr. 11: cross-site `POST /session/pairing` (login CSRF, S9).
#[tokio::test]
async fn cross_site_session_pairing_is_forbidden() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    let body = json!({"code": code, "deviceName": "Evil", "deviceId": null});
    let cross = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/v1/session/pairing")
        .header("sec-fetch-site", "cross-site")
        .header("origin", "https://evil.example")
        .header("x-buddy-request", "1")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let r = t.send(cross).await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    assert!(r.header("set-cookie").is_none());
    // without X-Buddy-Request (a plain form post)
    let form = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/v1/session/pairing")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    assert_eq!(t.send(form).await.status, StatusCode::FORBIDDEN);
    // the code is untouched
    assert_eq!(redeem_web(&t, &code, None).await.status, StatusCode::OK);
}

/// Abnahme Nr. 12: 11 wrong codes from one IP → 429 with `Retry-After`; other IPs go on.
#[tokio::test]
async fn wrong_codes_lock_the_ip() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    let ip = "203.0.113.9";
    let wrong = ["0000-0000-0000", "not a code", "", "ZZZZZZZZZZZZ"];
    for i in 0..10 {
        let r = redeem_mobile_at(&t, ip, wrong[i % wrong.len()]).await;
        assert_error(&r, StatusCode::BAD_REQUEST, "pairing_invalid");
    }
    let r = redeem_mobile_at(&t, ip, "0000-0000-0001").await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("900"));
    // locked: even the right code, also via the PWA endpoint
    assert_eq!(
        redeem_mobile_at(&t, ip, &code).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    let web = t
        .send(at_ip(
            pwa_request(
                Method::POST,
                "/api/v1/session/pairing",
                None,
                Some(json!({"code": code, "deviceName": "x", "deviceId": null})),
            ),
            ip,
        ))
        .await;
    assert_eq!(web.status, StatusCode::TOO_MANY_REQUESTS);
    // another IP is not affected
    assert_eq!(
        redeem_mobile_at(&t, "203.0.113.10", &code).await.status,
        StatusCode::OK
    );
    t.clock.advance(Duration::minutes(15));
    assert_error(
        &redeem_mobile_at(&t, ip, &code).await,
        StatusCode::BAD_REQUEST,
        "pairing_invalid",
    );
}

/// The device limit (Abnahme Nr. 23) applies to pairing; the code stays usable.
#[tokio::test]
async fn device_limit_applies() {
    let t = app_with(|c| c.quota.devices = Some(2)).await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    t.device("mobile").await;
    assert_error(
        &redeem_mobile(&t, &code).await,
        StatusCode::CONFLICT,
        "device_limit",
    );
    assert_error(
        &redeem_web(&t, &code, None).await,
        StatusCode::CONFLICT,
        "device_limit",
    );
    // freeing a slot makes the same code work
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE kind = 'mobile'")
        .bind(START)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(redeem_mobile(&t, &code).await.status, StatusCode::OK);
}

/// Abnahme Nr. 24: a disabled account can neither create nor redeem codes.
#[tokio::test]
async fn disabled_account() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    cli::user_set_disabled(&t.state.db, t.clock_now(), USER, true)
        .await
        .unwrap();
    assert_error(
        &redeem_mobile(&t, &code).await,
        StatusCode::FORBIDDEN,
        "account_disabled",
    );
    assert_error(
        &redeem_web(&t, &code, None).await,
        StatusCode::FORBIDDEN,
        "account_disabled",
    );
    let r = t
        .call(
            Method::POST,
            "/api/v1/pairing",
            Cred::Bearer(&desk),
            Some(json!({})),
        )
        .await;
    assert_error(&r, StatusCode::FORBIDDEN, "account_disabled");
    assert_eq!(
        t.count("SELECT COUNT(*) FROM devices WHERE user_id = ?", t.user_id)
            .await,
        1
    );
}

/// Deleting the account removes its pairings (ON DELETE CASCADE); its codes are dead.
#[tokio::test]
async fn account_deletion_cascades() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let first = start(&t, &desk).await;
    redeem_mobile(&t, first["code"].as_str().unwrap()).await;
    let code = start(&t, &desk).await["code"].as_str().unwrap().to_string();
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM pairings").await, 2);
    let r = t
        .call(
            Method::POST,
            "/api/v1/me/delete",
            Cred::Bearer(&desk),
            Some(json!({"password": PASS, "confirmUsername": USER})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM pairings").await, 0);
    assert_error(
        &redeem_mobile(&t, &code).await,
        StatusCode::BAD_REQUEST,
        "pairing_invalid",
    );
}

/// Abnahme Nr. 26 (server): neither the code (both forms) nor token or session id appear
/// in the log; pairing and device ids do.
#[tokio::test]
async fn logs_contain_no_codes() {
    let t = app().await;
    let (_, desk) = t.device("desktop").await;
    let a = start(&t, &desk).await;
    let r = redeem_mobile(&t, a["code"].as_str().unwrap()).await;
    let token = r.body["token"].as_str().unwrap().to_string();
    let device = r.body["deviceId"].as_str().unwrap().to_string();
    let b = start(&t, &desk).await;
    let r = redeem_web(&t, b["code"].as_str().unwrap(), None).await;
    let sid = cookie(&r);
    redeem_mobile(&t, b["code"].as_str().unwrap()).await; // a failure is logged too
    let log = String::from_utf8(log().0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("pairing redeemed"), "capture works");
    assert!(log.contains(a["pairingId"].as_str().unwrap()));
    assert!(log.contains(&device));
    for code in [&a, &b].map(|x| x["code"].as_str().unwrap().to_string()) {
        assert!(!log.contains(&code), "log leaks {code}");
        assert!(!log.contains(&format_code(&code)), "log leaks {code}");
    }
    assert!(!log.contains(&token) && !log.contains(&sid));
}
