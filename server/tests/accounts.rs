//! v4 accounts (PLAN_V4 §13 Nr. 1–4, 14–20, 22–27, server side): /info, registration with
//! proof-of-work, invites, limits, recovery, /me/*, export, delete, quotas, account lock,
//! housekeeping (logs without secrets: `account_logs.rs`).

mod common;

use axum::http::{Method, StatusCode};
use buddy_core::accounts::{format_recovery_code, recovery_code_hash};
use buddy_server::auth::sha256_hex;
use buddy_server::cli;
use buddy_server::config::Config;
use chrono::Duration;
use common::*;
use serde_json::{Value, json};

const IP: &str = "198.51.100.20";
const NEW_PW: &str = "a brand new passphrase";

fn open(c: &mut Config) {
    c.registration = buddy_core::accounts::RegistrationMode::Open;
}

fn ip(n: u32) -> String {
    format!("203.0.113.{n}")
}

async fn open_app() -> TestApp {
    TestApp::with(open).await
}

/// Registers `name` and returns (deviceId, token, recoveryCode).
async fn registered(t: &TestApp, from: &str, name: &str) -> (String, String, String) {
    let r = t.register(from, account_body(name, PASS)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    (
        r.body["deviceId"].as_str().unwrap().into(),
        r.body["token"].as_str().unwrap().into(),
        r.body["recoveryCode"].as_str().unwrap().into(),
    )
}

async fn user_id(t: &TestApp, name: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(name)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn get(t: &TestApp, path: &str, token: &str) -> Resp {
    t.call(Method::GET, path, Cred::Bearer(token), None).await
}

async fn post(t: &TestApp, path: &str, token: &str, body: Value) -> Resp {
    t.call(Method::POST, path, Cred::Bearer(token), Some(body))
        .await
}

fn assert_error(r: &Resp, status: StatusCode, code: &str) {
    assert_eq!(r.status, status, "{}", r.text);
    assert_eq!(r.body["error"], code, "{}", r.text);
}

// ---------------------------------------------------------------- /info

#[tokio::test]
async fn info_defaults_for_self_hosters() {
    let t = TestApp::new().await;
    let r = t.call(Method::GET, "/api/v1/info", Cred::None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(r.body["apiLevel"], 2);
    assert_eq!(r.body["registration"], "closed");
    assert_eq!(
        r.body["features"],
        json!(["accounts", "pairing", "recovery", "export", "quota"])
    );
    assert_eq!(r.body["passwordMinChars"], 12);
    assert_eq!(r.body["serverTime"], START);
    assert_eq!(
        r.body["legal"],
        json!({"imprintUrl": null, "privacyUrl": null, "termsUrl": null})
    );
    assert_eq!(r.body["operator"], Value::Null);
    let parsed: buddy_core::accounts::ServerInfo = serde_json::from_value(r.body).unwrap();
    assert_eq!(parsed.version, env!("CARGO_PKG_VERSION"));

    let t = TestApp::with(|c| {
        open(c);
        c.legal.privacy_url = Some("https://pev-point.de/datenschutz".into());
        c.operator_name = Some("pev-point.de".into());
    })
    .await;
    let r = t.call(Method::GET, "/api/v1/info", Cred::None, None).await;
    assert_eq!(r.body["registration"], "open");
    assert_eq!(
        r.body["legal"]["privacyUrl"],
        "https://pev-point.de/datenschutz"
    );
    assert_eq!(r.body["operator"], "pev-point.de");
}

// ---------------------------------------------------------------- registration

/// Abnahme Nr. 1.
#[tokio::test]
async fn register_creates_account_and_desktop_device() {
    let t = open_app().await;
    let (device, token, code) = registered(&t, IP, "Anna").await;
    assert_eq!(code.len(), 24);
    let id = user_id(&t, "anna").await;
    let (via, zone, hash, rec_at): (String, String, String, Option<String>) = sqlx::query_as(
        "SELECT created_via, time_zone, recovery_hash, recovery_created_at FROM users WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(via, "register");
    assert_eq!(zone, "Europe/Berlin");
    assert_eq!(hash, recovery_code_hash(&code), "only the hash is stored");
    assert_eq!(rec_at.as_deref(), Some(START));
    let (kind, dvia, th): (String, String, String) =
        sqlx::query_as("SELECT kind, created_via, token_hash FROM devices WHERE id = ?")
            .bind(&device)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!((kind.as_str(), dvia.as_str()), ("desktop", "register"));
    assert_eq!(th, sha256_hex(&token));

    // behaves like a connected desktop: /me and sync work
    let me = get(&t, "/api/v1/me", &token).await;
    assert_eq!(me.body["username"], "anna", "stored lower-case");
    assert_eq!(me.body["deviceId"], device.as_str());
    t.push(
        &token,
        json!({"notes": [note_rec(NOTE_A, "Hallo", START, &device)], "reminders": []}),
    )
    .await;
    let info = get(&t, "/api/v1/me/account", &token).await;
    assert_eq!(info.body["recoveryCodeCreatedAt"], START);
    assert_eq!(info.body["usage"]["notes"], 1);
    assert_eq!(info.body["usage"]["devices"], 1);
}

/// Abnahme Nr. 2: nothing is created on any of these.
#[tokio::test]
async fn register_rejects_bad_names_and_passwords() {
    let t = open_app().await;
    let cases: [(&str, &str, StatusCode, &str); 8] = [
        ("Martin", PASS, StatusCode::CONFLICT, "username_taken"),
        ("ab", PASS, StatusCode::BAD_REQUEST, "username_invalid"),
        ("admin", PASS, StatusCode::BAD_REQUEST, "username_invalid"),
        (
            "anna@x.de",
            PASS,
            StatusCode::BAD_REQUEST,
            "username_invalid",
        ),
        (
            "anna",
            "too short",
            StatusCode::BAD_REQUEST,
            "password_weak",
        ),
        (
            "anna",
            "Unbelievable",
            StatusCode::BAD_REQUEST,
            "password_weak",
        ),
        (
            "longusername1",
            "LongUserName1",
            StatusCode::BAD_REQUEST,
            "password_weak",
        ),
        (
            "anna",
            &"x".repeat(1025),
            StatusCode::BAD_REQUEST,
            "password_weak",
        ),
    ];
    for (n, (name, pw, status, code)) in cases.into_iter().enumerate() {
        let r = t.register(&ip(n as u32 + 1), account_body(name, pw)).await;
        assert_error(&r, status, code);
    }
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM users").await, 1);
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM devices").await, 0);
}

/// Abnahme Nr. 3 (closed) and Nr. 25 (self-hoster without new variables).
#[tokio::test]
async fn closed_by_default() {
    let t = TestApp::new().await;
    let r = t.post_at(IP, "/api/v1/accounts/challenge", json!({})).await;
    assert_error(&r, StatusCode::FORBIDDEN, "registration_closed");
    let mut body = account_body("anna", PASS);
    body["challengeId"] = json!("x");
    body["nonce"] = json!(1);
    let r = t.post_at(IP, "/api/v1/accounts", body).await;
    assert_error(&r, StatusCode::FORBIDDEN, "registration_closed");
    // unlimited quotas, v3 password login unchanged
    let (_, token) = t.device("desktop").await;
    let info = get(&t, "/api/v1/me/account", &token).await;
    assert_eq!(
        info.body["quota"],
        json!({"bytes": null, "notes": null, "devices": null})
    );
}

/// Abnahme Nr. 3 (invite).
#[tokio::test]
async fn invite_mode() {
    let t =
        TestApp::with(|c| c.registration = buddy_core::accounts::RegistrationMode::Invite).await;
    let now = t.clock_now();
    let code = cli::invite_create(&t.state.db, now, None, Some("für Anna"))
        .await
        .unwrap();
    let expired = cli::invite_create(&t.state.db, now, Some(Duration::minutes(5)), None)
        .await
        .unwrap();

    let r = t.register(&ip(1), account_body("anna", PASS)).await;
    assert_error(&r, StatusCode::FORBIDDEN, "invite_required");
    for (n, wrong) in ["0000-0000-0000-0000-0000-0000", "nonsense"]
        .into_iter()
        .enumerate()
    {
        let mut b = account_body("anna", PASS);
        b["inviteCode"] = json!(wrong);
        let r = t.register(&ip(2 + n as u32), b).await;
        assert_error(&r, StatusCode::FORBIDDEN, "invite_invalid");
    }
    t.clock.advance(Duration::minutes(6));
    let mut b = account_body("anna", PASS);
    b["inviteCode"] = json!(format_recovery_code(&expired));
    let r = t.register(&ip(4), b).await;
    assert_error(&r, StatusCode::FORBIDDEN, "invite_invalid");

    // the formatted, lower-case code works (normalisation)
    let mut b = account_body("anna", PASS);
    b["inviteCode"] = json!(format_recovery_code(&code).to_lowercase());
    let r = t.register(&ip(5), b.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let anna = user_id(&t, "anna").await;
    let via: String = sqlx::query_scalar("SELECT created_via FROM users WHERE id = ?")
        .bind(anna)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(via, "invite");
    let list = cli::invite_list(&t.state.db).await.unwrap();
    let used = list.iter().find(|i| i.used_at.is_some()).unwrap();
    assert_eq!(used.used_by.as_deref(), Some("anna"));
    assert_eq!(used.label.as_deref(), Some("für Anna"));
    assert_eq!(used.id.len(), cli::INVITE_ID_LEN);

    // used up
    b["username"] = json!("berta");
    let r = t.register(&ip(6), b).await;
    assert_error(&r, StatusCode::FORBIDDEN, "invite_invalid");

    // revoke: only unused invites
    assert!(cli::invite_revoke(&t.state.db, &used.id).await.is_err());
    let unused = list.iter().find(|i| i.used_at.is_none()).unwrap();
    cli::invite_revoke(&t.state.db, &unused.id).await.unwrap();
    assert_eq!(cli::invite_list(&t.state.db).await.unwrap().len(), 1);
}

/// Abnahme Nr. 4: wrong, expired and reused challenges.
#[tokio::test]
async fn challenges_must_be_fresh_solved_and_unused() {
    let t = open_app().await;
    // wrong nonce
    let r = t
        .post_at(&ip(1), "/api/v1/accounts/challenge", json!({}))
        .await;
    let (id, ch, bits) = (
        r.body["id"].as_str().unwrap().to_string(),
        r.body["challenge"].as_str().unwrap().to_string(),
        r.body["bits"].as_u64().unwrap() as u32,
    );
    assert_eq!(bits, 8);
    assert_eq!(r.body["serverTime"], START);
    assert_eq!(r.body["expiresAt"], "2026-11-06T10:10:00.000Z");
    let wrong = (0..)
        .find(|n| !buddy_core::pow::verify(&ch, bits, *n))
        .unwrap();
    let mut b = account_body("anna", PASS);
    b["challengeId"] = json!(id);
    b["nonce"] = json!(wrong);
    assert_error(
        &t.post_at(&ip(1), "/api/v1/accounts", b.clone()).await,
        StatusCode::BAD_REQUEST,
        "challenge_invalid",
    );
    // the challenge is used up by the failed attempt
    b["nonce"] = json!(buddy_core::pow::solve(&ch, bits, 0..u32::MAX).unwrap());
    assert_error(
        &t.post_at(&ip(1), "/api/v1/accounts", b).await,
        StatusCode::BAD_REQUEST,
        "challenge_invalid",
    );
    // expired after 10 min
    let (id, nonce) = t.solved_challenge(&ip(1)).await;
    t.clock.advance(Duration::minutes(10));
    let mut b = account_body("anna", PASS);
    b["challengeId"] = json!(id);
    b["nonce"] = json!(nonce);
    assert_error(
        &t.post_at(&ip(1), "/api/v1/accounts", b).await,
        StatusCode::BAD_REQUEST,
        "challenge_invalid",
    );
    // reused after a success
    let (id, nonce) = t.solved_challenge(&ip(1)).await;
    let mut b = account_body("anna", PASS);
    b["challengeId"] = json!(id);
    b["nonce"] = json!(nonce);
    assert_eq!(
        t.post_at(&ip(1), "/api/v1/accounts", b.clone())
            .await
            .status,
        StatusCode::OK
    );
    b["username"] = json!("berta");
    assert_error(
        &t.post_at(&ip(1), "/api/v1/accounts", b).await,
        StatusCode::BAD_REQUEST,
        "challenge_invalid",
    );
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM users").await, 2);
}

/// Abnahme Nr. 4 (limits) and PLAN_V4 §8.2.
#[tokio::test]
async fn registration_limits() {
    let t = open_app().await;
    for name in ["anna", "berta", "carla"] {
        registered(&t, IP, name).await;
    }
    let r = t.register(IP, account_body("dora", PASS)).await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    let wait: i64 = r.header("retry-after").unwrap().parse().unwrap();
    assert!(wait > 0 && wait <= 3600, "{wait}");
    // after an hour the IP may register again
    t.clock.advance(Duration::hours(1));
    registered(&t, IP, "dora").await;

    // challenges: 10 per hour and IP (the window above holds 1)
    for _ in 0..9 {
        t.solved_challenge(IP).await;
    }
    let r = t.post_at(IP, "/api/v1/accounts/challenge", json!({})).await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert!(r.header("retry-after").is_some());
    assert!(
        t.post_at(&ip(9), "/api/v1/accounts/challenge", json!({}))
            .await
            .status
            == StatusCode::OK,
        "other IPs are not affected"
    );
}

#[tokio::test]
async fn registration_ten_per_day_and_global_limit() {
    let t = open_app().await;
    for n in 0..10 {
        registered(&t, IP, &format!("user{n}")).await;
        t.clock.advance(Duration::minutes(25));
    }
    t.clock.advance(Duration::hours(2));
    let r = t.register(IP, account_body("user10", PASS)).await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");

    let t = TestApp::with(|c| {
        open(c);
        c.registration_daily_limit = 2;
    })
    .await;
    registered(&t, &ip(1), "anna").await;
    registered(&t, &ip(2), "berta").await;
    let r = t.register(&ip(3), account_body("carla", PASS)).await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    t.clock.advance(Duration::days(1));
    registered(&t, &ip(3), "carla").await;
}

// ---------------------------------------------------------------- recovery

/// Abnahme Nr. 16.
#[tokio::test]
async fn recovery_signs_out_everything_and_rotates_the_code() {
    let t = TestApp::new().await;
    let code = cli::user_recovery(&t.state.db, t.clock_now(), USER)
        .await
        .unwrap();
    let (_, old_token) = t.device("desktop").await;
    let (_, cookie, _) = t.web_login(None).await;
    let body = |code: &str, pw: &str| json!({"username": USER, "recoveryCode": code, "newPassword": pw, "deviceName": "Neuer PC"});
    // weak new password is refused before anything happens
    let r = t
        .post_at(IP, "/api/v1/accounts/recover", body(&code, "short"))
        .await;
    assert_error(&r, StatusCode::BAD_REQUEST, "password_weak");

    let r = t
        .post_at(
            IP,
            "/api/v1/accounts/recover",
            body(&format_recovery_code(&code).to_lowercase(), NEW_PW),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token = r.body["token"].as_str().unwrap();
    let new_code = r.body["recoveryCode"].as_str().unwrap();
    assert_ne!(new_code, code);
    assert_eq!(get(&t, "/api/v1/me", token).await.status, StatusCode::OK);
    assert_eq!(
        get(&t, "/api/v1/me", &old_token).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&cookie), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let devices = get(&t, "/api/v1/me/devices", token).await;
    let list = devices.body["devices"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["createdVia"], "recovery");
    assert_eq!(list[0]["kind"], "desktop");
    assert_eq!(list[0]["current"], true);
    // the old code is used up, the new password works
    let r = t
        .post_at(IP, "/api/v1/accounts/recover", body(&code, NEW_PW))
        .await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(
                json!({"username": USER, "password": NEW_PW, "deviceName": "x", "kind": "mobile"}),
            ),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

#[tokio::test]
async fn recovery_errors_are_uniform_and_braked() {
    let t = TestApp::new().await;
    let code = cli::user_recovery(&t.state.db, t.clock_now(), USER)
        .await
        .unwrap();
    let wrong = "0000-0000-0000-0000-0000-0000";
    let try_ = |user: &str, code: &str| json!({"username": user, "recoveryCode": code, "newPassword": NEW_PW, "deviceName": "PC"});
    let unknown = t
        .post_at(&ip(1), "/api/v1/accounts/recover", try_("nobody", wrong))
        .await;
    let bad = t
        .post_at(&ip(1), "/api/v1/accounts/recover", try_(USER, wrong))
        .await;
    let garbage = t
        .post_at(&ip(1), "/api/v1/accounts/recover", try_(USER, "nope"))
        .await;
    assert_error(&unknown, StatusCode::UNAUTHORIZED, "unauthorized");
    assert_eq!(
        unknown.body, bad.body,
        "same answer: no account enumeration"
    );
    assert_eq!(unknown.body, garbage.body);
    // brake (IP, user): 5 failures (2 above), then 429 – even with the right code
    for _ in 0..3 {
        t.post_at(&ip(1), "/api/v1/accounts/recover", try_(USER, wrong))
            .await;
    }
    let r = t
        .post_at(&ip(1), "/api/v1/accounts/recover", try_(USER, &code))
        .await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("30"));
    // a v3 account without code cannot be recovered
    let t = TestApp::new().await;
    let r = t
        .post_at(IP, "/api/v1/accounts/recover", try_(USER, wrong))
        .await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
}

// ---------------------------------------------------------------- /me

/// Abnahme Nr. 14 (D-91).
#[tokio::test]
async fn revoke_own_or_younger_without_password() {
    let t = TestApp::new().await;
    let (old, old_tok) = t.device("desktop").await;
    t.clock.advance(Duration::minutes(1));
    let (young, young_tok) = t.device("mobile").await;
    t.clock.advance(Duration::minutes(1));
    let (youngest, youngest_tok) = t.device("mobile").await;

    let path = |id: &str| format!("/api/v1/me/devices/{id}/revoke");
    // younger → older: password needed
    let r = post(&t, &path(&old), &young_tok, json!({"password": null})).await;
    assert_error(&r, StatusCode::FORBIDDEN, "password_required");
    let r = post(
        &t,
        &path(&old),
        &young_tok,
        json!({"password": "wrong password!"}),
    )
    .await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    assert_eq!(
        get(&t, "/api/v1/me", &young_tok).await.status,
        StatusCode::OK,
        "a wrong confirmation does not sign the caller out"
    );
    // older → younger: no password
    let r = post(&t, &path(&youngest), &old_tok, json!({})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(
        get(&t, "/api/v1/me", &youngest_tok).await.status,
        StatusCode::UNAUTHORIZED
    );
    // unknown / already revoked
    let r = post(&t, &path(&youngest), &old_tok, json!({})).await;
    assert_error(&r, StatusCode::NOT_FOUND, "not_found");
    // with the password the younger may sign out the older
    let r = post(&t, &path(&old), &young_tok, json!({"password": PASS})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(
        get(&t, "/api/v1/me", &old_tok).await.status,
        StatusCode::UNAUTHORIZED
    );
    // own device, via cookie: cookie is cleared
    let (web, cookie, _) = t.web_login(None).await;
    let r = t
        .call(
            Method::POST,
            &path(&web),
            Cred::Cookie(&cookie),
            Some(json!({})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert!(r.header("set-cookie").unwrap().contains("Max-Age=0"));
    let list = get(&t, "/api/v1/me/devices", &young_tok).await;
    let ids: Vec<&str> = list.body["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [young.as_str()]);
}

async fn put_password(t: &TestApp, token: String, body: Value) -> Resp {
    t.call(
        Method::PUT,
        "/api/v1/me/password",
        Cred::Bearer(&token),
        Some(body),
    )
    .await
}

/// Abnahme Nr. 15 (D-89).
#[tokio::test]
async fn password_change_rules() {
    let t = TestApp::new().await;
    let (_, pc) = t.device("desktop").await;
    let (_, phone) = t.device("mobile").await;
    let (_, cookie, _) = t.web_login(None).await;
    let put = |token: &str, body: Value| put_password(&t, token.to_string(), body);
    // weak
    let r = put(
        &pc,
        json!({"currentPassword": PASS, "newPassword": "short", "signOutOthers": false}),
    )
    .await;
    assert_error(&r, StatusCode::BAD_REQUEST, "password_weak");
    // wrong current password
    let r = put(&pc, json!({"currentPassword": "not the password", "newPassword": NEW_PW, "signOutOthers": false})).await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    // without current password: device younger than 24 h
    let r = put(
        &pc,
        json!({"currentPassword": null, "newPassword": NEW_PW, "signOutOthers": false}),
    )
    .await;
    assert_error(&r, StatusCode::FORBIDDEN, "password_required");
    // with the current password, others stay when asked to
    let r = put(
        &pc,
        json!({"currentPassword": PASS, "newPassword": NEW_PW, "signOutOthers": false}),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(get(&t, "/api/v1/me", &phone).await.status, StatusCode::OK);

    // ≥ 24 h: a web device still may not, a desktop may and signs everyone else out
    t.clock.advance(Duration::hours(25));
    let r = t
        .call(
            Method::PUT,
            "/api/v1/me/password",
            Cred::Cookie(&cookie),
            Some(json!({"currentPassword": null, "newPassword": "third pass phrase", "signOutOthers": true})),
        )
        .await;
    assert_error(&r, StatusCode::FORBIDDEN, "password_required");
    let r = put(&pc, json!({"currentPassword": null, "newPassword": "third pass phrase", "signOutOthers": false})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(get(&t, "/api/v1/me", &pc).await.status, StatusCode::OK);
    assert_eq!(
        get(&t, "/api/v1/me", &phone).await.status,
        StatusCode::UNAUTHORIZED,
        "signOutOthers is forced"
    );
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&cookie), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let changed: Option<String> =
        sqlx::query_scalar("SELECT password_changed_at FROM users WHERE id = ?")
            .bind(t.user_id)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert!(changed.is_some());
}

#[tokio::test]
async fn new_recovery_code_needs_the_password() {
    let t = TestApp::new().await;
    let old = cli::user_recovery(&t.state.db, t.clock_now(), USER)
        .await
        .unwrap();
    let (_, token) = t.device("desktop").await;
    let r = post(
        &t,
        "/api/v1/me/recovery-code",
        &token,
        json!({"password": "nope nope nope"}),
    )
    .await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    let r = post(
        &t,
        "/api/v1/me/recovery-code",
        &token,
        json!({"password": PASS}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["serverTime"], START);
    let new = r.body["recoveryCode"].as_str().unwrap();
    assert_ne!(new, old);
    let r = t
        .post_at(
            IP,
            "/api/v1/accounts/recover",
            json!({"username": USER, "recoveryCode": old, "newPassword": NEW_PW, "deviceName": "PC"}),
        )
        .await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
    let r = t
        .post_at(
            IP,
            "/api/v1/accounts/recover",
            json!({"username": USER, "recoveryCode": new, "newPassword": NEW_PW, "deviceName": "PC"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

/// Abnahme Nr. 19 (server side): a v3 account has no code; the account view says so.
#[tokio::test]
async fn account_info_and_device_list() {
    let t = TestApp::with(|c| {
        c.quota.bytes = Some(52_428_800);
        c.quota.devices = Some(10);
    })
    .await;
    let (desk, token) = t.device("desktop").await;
    t.clock.advance(Duration::minutes(1));
    let (phone, _) = t.device("mobile").await;
    sqlx::query(
        "UPDATE devices SET native_push_platform = 'fcm', native_push_token = 'x' WHERE id = ?",
    )
    .bind(&phone)
    .execute(&t.state.db)
    .await
    .unwrap();
    cli::user_quota(&t.state.db, USER, None, Some(Some(7)), None)
        .await
        .unwrap();
    let r = get(&t, "/api/v1/me/account", &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["username"], USER);
    assert_eq!(r.body["recoveryCodeCreatedAt"], Value::Null);
    assert_eq!(r.body["contentFormat"], 1);
    assert_eq!(
        r.body["usage"],
        json!({"bytes": 0, "notes": 0, "devices": 2})
    );
    assert_eq!(
        r.body["quota"],
        json!({"bytes": 52428800, "notes": 7, "devices": 10})
    );
    let r = get(&t, "/api/v1/me/devices", &token).await;
    let list = r.body["devices"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["id"], desk.as_str());
    assert_eq!(list[0]["current"], true);
    assert_eq!(list[0]["createdVia"], "password");
    assert_eq!(list[0]["push"], false);
    assert_eq!(list[1]["current"], false);
    assert_eq!(list[1]["push"], true);
    let _: buddy_core::accounts::DeviceList = serde_json::from_value(r.body).unwrap();

    // Abnahme Nr. 27: a future content format is reported as stored (clients stop syncing)
    sqlx::query("UPDATE users SET content_format = 2")
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = get(&t, "/api/v1/me/account", &token).await;
    assert_eq!(r.body["contentFormat"], 2);
}

/// Abnahme Nr. 18 (D-93).
#[tokio::test]
async fn export_has_data_but_no_secrets() {
    let t = TestApp::new().await;
    let code = cli::user_recovery(&t.state.db, t.clock_now(), USER)
        .await
        .unwrap();
    let (desk, token) = t.device("desktop").await;
    let (phone, _) = t.device("mobile").await;
    sqlx::query("UPDATE devices SET native_push_platform = 'fcm', native_push_token = 'FCM-SECRET-TOKEN' WHERE id = ?")
        .bind(&phone)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) \
         VALUES (?, 'https://push.example/ENDPOINT-SECRET', 'P256DH-SECRET', 'AUTH-SECRET', ?)",
    )
    .bind(&desk)
    .bind(START)
    .execute(&t.state.db)
    .await
    .unwrap();
    let later = "2026-11-06T10:00:01.000Z";
    t.push(
        &token,
        json!({"notes": [note_rec(NOTE_A, "Einkauf", START, &desk), note_rec(&nid(2), "weg", START, &desk)],
               "reminders": [reminder_rec(NOTE_A, START, &desk, "scheduled", Some("Europe/Berlin"))],
               "order": {"updatedAt": START, "updatedBy": desk, "ids": [NOTE_A]}}),
    )
    .await;
    // a newer version (old one becomes a revision) and a deletion
    t.push(
        &token,
        json!({"notes": [note_rec(NOTE_A, "Einkauf 2", later, &desk), tombstone(&nid(2), later, &desk)],
               "reminders": []}),
    )
    .await;

    let r = get(&t, "/api/v1/me/export", &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(
        r.header("content-disposition"),
        Some("attachment; filename=\"display-buddy-export-martin-2026-11-06.json\"")
    );
    let e: buddy_core::accounts::AccountExport = serde_json::from_value(r.body.clone()).unwrap();
    assert_eq!(e.format, "display-buddy-export/1");
    assert_eq!(e.exported_at, START);
    assert_eq!(e.account.username, USER);
    assert_eq!(e.account.time_zone, "Europe/Berlin");
    assert_eq!(e.devices.len(), 2);
    assert!(e.devices.iter().all(|d| d.push));
    assert_eq!(e.notes.len(), 1, "only live notes");
    assert_eq!(e.notes[0].note.as_ref().unwrap().title, "Einkauf 2");
    assert_eq!(e.reminders.len(), 1);
    assert_eq!(e.order.unwrap().ids, [NOTE_A]);
    assert_eq!(e.revisions.len(), 2);
    assert!(
        e.revisions
            .iter()
            .any(|v| v.note.as_ref().is_some_and(|n| n.title == "Einkauf"))
    );
    assert!(r.body["devices"][0].get("current").is_none());

    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users UNION ALL SELECT recovery_hash FROM users \
         UNION ALL SELECT token_hash FROM devices WHERE token_hash IS NOT NULL",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    for secret in [
        token.as_str(),
        code.as_str(),
        "FCM-SECRET-TOKEN",
        "ENDPOINT-SECRET",
        "P256DH-SECRET",
        "AUTH-SECRET",
        PASS,
        "argon2",
    ]
    .into_iter()
    .chain(hashes.iter().map(String::as_str))
    {
        assert!(!r.text.contains(secret), "export leaks {secret}");
    }

    // 1 per minute
    let r = get(&t, "/api/v1/me/export", &token).await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("60"));
    t.clock.advance(Duration::seconds(60));
    assert_eq!(
        get(&t, "/api/v1/me/export", &token).await.status,
        StatusCode::OK
    );
}

/// Abnahme Nr. 17 (server side, D-92): every row of the account is gone, another account
/// is untouched.
#[tokio::test]
async fn delete_account_cascades() {
    let t = open_app().await;
    let (anna_dev, anna_tok, _) = registered(&t, IP, "anna").await;
    t.push(
        &anna_tok,
        json!({"notes": [note_rec(&nid(9), "Anna", START, &anna_dev)], "reminders": []}),
    )
    .await;
    cli::invite_create(&t.state.db, t.clock_now(), None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE invites SET used_at = ?, used_by = ?")
        .bind(START)
        .bind(t.user_id)
        .execute(&t.state.db)
        .await
        .unwrap();

    let (desk, token) = t.device("desktop").await;
    let (_, cookie, _) = t.web_login(None).await;
    let later = "2026-11-06T10:00:01.000Z";
    t.push(
        &token,
        json!({"notes": [note_rec(NOTE_A, "a", START, &desk)],
               "reminders": [reminder_rec(NOTE_A, START, &desk, "scheduled", None)],
               "order": {"updatedAt": START, "updatedBy": desk, "ids": [NOTE_A]}}),
    )
    .await;
    t.push(
        &token,
        json!({"notes": [note_rec(NOTE_A, "b", later, &desk)], "reminders": []}),
    )
    .await;
    for sql in [
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) \
         SELECT id, 'https://push.example/x', 'k', 'a', created_at FROM devices WHERE id = ?",
        "INSERT INTO push_log (device_id, note_id, at, channel, status) \
         VALUES (?, 'n', 'at', 'webpush', 'sent')",
        "INSERT INTO pairings (id, user_id, created_by, code_hash, created_at, expires_at) \
         SELECT 'p1', user_id, id, 'h', created_at, created_at FROM devices WHERE id = ?",
    ] {
        sqlx::query(sql)
            .bind(&desk)
            .execute(&t.state.db)
            .await
            .unwrap();
    }

    let del = |body: Value| {
        t.call(
            Method::POST,
            "/api/v1/me/delete",
            Cred::Cookie(&cookie),
            Some(body),
        )
    };
    let r = del(json!({"password": PASS, "confirmUsername": "anna"})).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "bad_request");
    let r = del(json!({"password": "not my password", "confirmUsername": "MARTIN"})).await;
    assert_error(&r, StatusCode::FORBIDDEN, "forbidden");
    let r = del(json!({"password": PASS, "confirmUsername": "MARTIN"})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert!(r.header("set-cookie").unwrap().contains("Max-Age=0"));

    let me = t.user_id;
    for sql in [
        "SELECT COUNT(*) FROM users WHERE id = ?",
        "SELECT COUNT(*) FROM devices WHERE user_id = ?",
        "SELECT COUNT(*) FROM sessions WHERE user_id = ?",
        "SELECT COUNT(*) FROM notes WHERE user_id = ?",
        "SELECT COUNT(*) FROM note_revisions WHERE user_id = ?",
        "SELECT COUNT(*) FROM reminders WHERE user_id = ?",
        "SELECT COUNT(*) FROM note_order WHERE user_id = ?",
        "SELECT COUNT(*) FROM pairings WHERE user_id = ?",
        "SELECT COUNT(*) FROM invites WHERE used_by = ?",
    ] {
        assert_eq!(t.count(sql, me).await, 0, "{sql}");
    }
    assert_eq!(
        t.scalar_i64("SELECT COUNT(*) FROM push_subscriptions")
            .await,
        0
    );
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM push_log").await, 0);
    assert_eq!(
        t.scalar_i64("SELECT COUNT(*) FROM invites").await,
        1,
        "kept, used_by null"
    );
    assert_eq!(
        get(&t, "/api/v1/me", &token).await.status,
        StatusCode::UNAUTHORIZED
    );
    // anna is untouched
    let anna = user_id(&t, "anna").await;
    assert_eq!(
        t.count("SELECT COUNT(*) FROM notes WHERE user_id = ?", anna)
            .await,
        1
    );
    assert_eq!(
        get(&t, "/api/v1/me", &anna_tok).await.status,
        StatusCode::OK
    );
}

// ---------------------------------------------------------------- quotas, lock

/// Abnahme Nr. 22 (D-94).
#[tokio::test]
async fn quota_net_rule() {
    let t = TestApp::with(|c| c.quota.notes = Some(2)).await;
    let (dev, token) = t.device("desktop").await;
    t.push(
        &token,
        json!({"notes": [note_rec(&nid(1), "1", START, &dev), note_rec(&nid(2), "2", START, &dev)], "reminders": []}),
    )
    .await;
    let seq = t.scalar_i64("SELECT seq FROM users").await;
    // a third note: refused as a whole, nothing applied
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Bearer(&token),
            Some(json!({"notes": [note_rec(&nid(3), "3", START, &dev)],
                        "reminders": [reminder_rec(&nid(1), START, &dev, "scheduled", None)]})),
        )
        .await;
    assert_error(&r, StatusCode::PAYLOAD_TOO_LARGE, "quota_exceeded");
    assert_eq!(t.scalar_i64("SELECT seq FROM users").await, seq);
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM reminders").await, 0);
    // delete one and add one in the same push: no growth → goes through
    let later = "2026-11-06T10:00:01.000Z";
    t.push(
        &token,
        json!({"notes": [tombstone(&nid(1), later, &dev), note_rec(&nid(3), "3", later, &dev)], "reminders": []}),
    )
    .await;

    // bytes: an account over its byte quota may still shorten and delete
    let big = |id: &str, n: usize, at: &str| {
        let mut r = note_rec(id, "gross", at, &dev);
        r["note"]["content"] = json!({"type": "doc", "content": [{"type": "paragraph",
            "content": [{"type": "text", "text": "x".repeat(n)}]}]});
        r
    };
    cli::user_quota(&t.state.db, USER, Some(Some(3000)), Some(Some(100)), None)
        .await
        .unwrap();
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Bearer(&token),
            Some(json!({"notes": [big(&nid(4), 4000, later)], "reminders": []})),
        )
        .await;
    assert_error(&r, StatusCode::PAYLOAD_TOO_LARGE, "quota_exceeded");
    cli::user_quota(&t.state.db, USER, Some(None), None, None)
        .await
        .unwrap();
    t.push(
        &token,
        json!({"notes": [big(&nid(4), 4000, later)], "reminders": []}),
    )
    .await;
    cli::user_quota(&t.state.db, USER, Some(Some(3000)), None, None)
        .await
        .unwrap();
    let t2 = "2026-11-06T10:00:02.000Z";
    t.push(
        &token,
        json!({"notes": [big(&nid(4), 3500, t2)], "reminders": []}),
    )
    .await; // shorter, still over: allowed
    let t3 = "2026-11-06T10:00:03.000Z";
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Bearer(&token),
            Some(json!({"notes": [big(&nid(4), 3600, t3)], "reminders": []})),
        )
        .await;
    assert_error(&r, StatusCode::PAYLOAD_TOO_LARGE, "quota_exceeded");
    t.push(
        &token,
        json!({"notes": [tombstone(&nid(4), t3, &dev)], "reminders": []}),
    )
    .await;
}

/// Abnahme Nr. 23.
#[tokio::test]
async fn device_limit() {
    let t = TestApp::with(|c| c.quota.devices = Some(2)).await;
    let (first, first_tok) = t.device("desktop").await;
    let (web, _, _) = t.web_login(None).await;
    let login = json!({"username": USER, "password": PASS, "deviceName": "3", "kind": "mobile"});
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login.clone()),
        )
        .await;
    assert_error(&r, StatusCode::CONFLICT, "device_limit");
    let r = t
        .send(pwa_request(
            Method::POST,
            "/api/v1/session",
            None,
            Some(json!({"username": USER, "password": PASS, "deviceName": "Handy", "deviceId": null})),
        ))
        .await;
    assert_error(&r, StatusCode::CONFLICT, "device_limit");
    // reusing the web device does not count anew
    t.web_login(Some(&web)).await;
    // after signing one out there is room again
    let r = post(
        &t,
        &format!("/api/v1/me/devices/{first}/revoke"),
        &first_tok,
        json!({}),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = t
        .call(Method::POST, "/api/v1/devices", Cred::None, Some(login))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

/// Abnahme Nr. 24 (D-95, S19).
#[tokio::test]
async fn disabled_account() {
    let t = TestApp::new().await;
    let (_, token) = t.device("desktop").await;
    let (_, cookie, _) = t.web_login(None).await;
    cli::user_set_disabled(&t.state.db, t.clock_now(), USER, true)
        .await
        .unwrap();
    assert_error(
        &get(&t, "/api/v1/me", &token).await,
        StatusCode::FORBIDDEN,
        "account_disabled",
    );
    assert_error(
        &t.changes(&token, 0, 10).await,
        StatusCode::FORBIDDEN,
        "account_disabled",
    );
    assert_error(
        &t.call(Method::GET, "/api/v1/me", Cred::Cookie(&cookie), None)
            .await,
        StatusCode::FORBIDDEN,
        "account_disabled",
    );
    let login =
        |pw: &str| json!({"username": USER, "password": pw, "deviceName": "x", "kind": "desktop"});
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login(PASS)),
        )
        .await;
    assert_error(&r, StatusCode::FORBIDDEN, "account_disabled");
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login("wrong password!")),
        )
        .await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
    let shown = cli::user_list(&t.state.db).await.unwrap();
    assert!(shown[0].disabled_at.is_some());
    // unlocking restores every device
    cli::user_set_disabled(&t.state.db, t.clock_now(), USER, false)
        .await
        .unwrap();
    assert_eq!(get(&t, "/api/v1/me", &token).await.status, StatusCode::OK);
}

// ---------------------------------------------------------------- limits

/// D-103: the Android background sync polls /sync/changes every 3 min – never braked.
#[tokio::test]
async fn sync_is_never_rate_limited() {
    let t = TestApp::new().await;
    let (_, token) = t.device("mobile").await;
    for _ in 0..100 {
        let r = t.changes(&token, 0, 10).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    }
}

/// D-103: failures over many usernames from one IP: 30 per hour, then 15 min lock.
#[tokio::test]
async fn ip_wide_failure_limit() {
    let t = TestApp::new().await;
    let login = |user: String, pw: &str| json!({"username": user, "password": pw, "deviceName": "x", "kind": "desktop"});
    for n in 0..30 {
        let r = t
            .post_at(
                IP,
                "/api/v1/devices",
                login(format!("user{n}"), "whatever pw"),
            )
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{n}");
    }
    let r = t
        .post_at(IP, "/api/v1/devices", login(USER.into(), PASS))
        .await;
    assert_error(&r, StatusCode::TOO_MANY_REQUESTS, "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("900"));
    let r = t
        .post_at(&ip(7), "/api/v1/devices", login(USER.into(), PASS))
        .await;
    assert_eq!(r.status, StatusCode::OK, "other IPs are not affected");
    t.clock.advance(Duration::minutes(15));
    let r = t
        .post_at(IP, "/api/v1/devices", login(USER.into(), PASS))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

// ---------------------------------------------------------------- housekeeping

#[tokio::test]
async fn housekeeping_removes_old_pairings_devices_and_invites() {
    let t = TestApp::new().await;
    let (old, _) = t.device("desktop").await;
    let (recent, _) = t.device("mobile").await;
    let (live, _) = t.device("desktop").await;
    let now = t.clock_now();
    let days = |d: i64| buddy_core::zoned::format_utc(&(now - Duration::days(d)));
    for (id, at) in [(&old, days(31)), (&recent, days(29))] {
        sqlx::query("UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?")
            .bind(at)
            .bind(id)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    for (id, at) in [("p-old", days(2)), ("p-new", days(0))] {
        sqlx::query(
            "INSERT INTO pairings (id, user_id, created_by, code_hash, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(t.user_id)
        .bind(&live)
        .bind(id)
        .bind(&at)
        .bind(&at)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    for (hash, used, expires) in [
        ("used-old", Some(days(91)), None),
        ("used-new", Some(days(89)), None),
        ("expired-old", None, Some(days(91))),
        ("open", None, None),
    ] {
        sqlx::query(
            "INSERT INTO invites (code_hash, created_at, used_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(hash)
        .bind(days(100))
        .bind(used)
        .bind(expires)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let s = buddy_server::housekeeping::purge(&t.state.db, now)
        .await
        .unwrap();
    assert_eq!((s.pairings, s.revoked_devices, s.invites), (1, 1, 2));
    let devices: Vec<String> = sqlx::query_scalar("SELECT id FROM devices ORDER BY created_at")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert!(!devices.contains(&old) && devices.contains(&recent) && devices.contains(&live));
    let invites: Vec<String> =
        sqlx::query_scalar("SELECT code_hash FROM invites ORDER BY code_hash")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(invites, ["open", "used-new"]);
}
