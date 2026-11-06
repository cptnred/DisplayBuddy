//! Phase N2 end to end: FCM HTTP v1 channel against a local fake (OAuth token endpoint +
//! `messages:send`), `PUT/DELETE /devices/current/push`, dedupe via `deviceState`
//! (§7.4: no push when `scheduled_seq` covers the occurrence), invalid tokens removed,
//! retries, access-token caching. No real network: the fake runs on loopback, the RSA key
//! is generated per test run (nothing secret in the repository).

mod common;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_server::push::PushOptions;
use buddy_server::push::native_fcm::{FCM_SCOPE, FcmChannel, FcmEndpoints, ServiceAccount};
use buddy_server::{build_app, reminders};
use chrono::Duration;
use common::*;
use openssl::hash::MessageDigest;
use openssl::pkey::{PKey, Public};
use openssl::rsa::Rsa;
use openssl::sign::Verifier;
use serde_json::{Value, json};
use tokio::task::JoinSet;

const PROJECT: &str = "buddy-test-123";
const EMAIL: &str = "buddy-push@buddy-test-123.iam.gserviceaccount.com";
const FCM_TOKEN: &str = "eKClHsXFm9E:APA91bHtestTOKEN_1-x";

// ---------------------------------------------------------------- fake Google

#[derive(Clone, Default)]
struct FakeGoogle {
    public_key: Arc<Mutex<Option<PKey<Public>>>>,
    token_uri: Arc<Mutex<String>>,
    /// Verified assertion claims, one per token request.
    assertions: Arc<Mutex<Vec<Value>>>,
    /// (authorization header, message body)
    sends: Arc<Mutex<Vec<(String, Value)>>>,
    /// Scripted send answers (status, body); afterwards 200.
    answers: Arc<Mutex<VecDeque<(u16, Value)>>>,
    issued: Arc<Mutex<u32>>,
}

impl FakeGoogle {
    async fn start() -> (Self, String) {
        let fake = FakeGoogle::default();
        let f1 = fake.clone();
        let f2 = fake.clone();
        let app = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move |body: String| {
                    let f = f1.clone();
                    async move { f.token(&body) }
                }),
            )
            .route(
                "/v1/projects/{project}/messages:send",
                axum::routing::post(
                    move |axum::extract::Path(project): axum::extract::Path<String>,
                          headers: HeaderMap,
                          body: String| {
                        let f = f2.clone();
                        async move { f.send(&project, &headers, &body) }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        *fake.token_uri.lock().unwrap() = format!("{base}/token");
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (fake, base)
    }

    /// RFC 7523 JWT bearer grant: verifies the RS256 signature with the service account's
    /// public key and the claims Google requires.
    fn token(&self, form: &str) -> axum::response::Response {
        let mut grant = "";
        let mut assertion = "";
        for pair in form.split('&') {
            match pair.split_once('=') {
                Some(("grant_type", v)) => grant = v,
                Some(("assertion", v)) => assertion = v,
                _ => {}
            }
        }
        assert_eq!(
            grant,
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"
        );
        let parts: Vec<&str> = assertion.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        assert_eq!(header["kid"], "key-1");
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        let key = self.public_key.lock().unwrap().clone().unwrap();
        let mut v = Verifier::new(MessageDigest::sha256(), &key).unwrap();
        v.update(format!("{}.{}", parts[0], parts[1]).as_bytes())
            .unwrap();
        if !v.verify(&sig).unwrap() {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({"error": "invalid_grant"})),
            )
                .into_response();
        }
        assert_eq!(claims["iss"], EMAIL);
        assert_eq!(claims["scope"], FCM_SCOPE);
        assert_eq!(claims["aud"], self.token_uri.lock().unwrap().as_str());
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            3600
        );
        self.assertions.lock().unwrap().push(claims);
        let mut n = self.issued.lock().unwrap();
        *n += 1;
        axum::Json(
            json!({"access_token": format!("ya29.access-{n}"), "expires_in": 3599,
                          "token_type": "Bearer"}),
        )
        .into_response()
    }

    fn send(&self, project: &str, headers: &HeaderMap, body: &str) -> axum::response::Response {
        assert_eq!(project, PROJECT);
        let auth = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body: Value = serde_json::from_str(body).expect("JSON message");
        self.sends.lock().unwrap().push((auth, body));
        let (code, answer) = self.answers.lock().unwrap().pop_front().unwrap_or((
            200,
            json!({"name": format!("projects/{PROJECT}/messages/1")}),
        ));
        (StatusCode::from_u16(code).unwrap(), axum::Json(answer)).into_response()
    }

    fn answer(&self, code: u16, body: Value) {
        self.answers.lock().unwrap().push_back((code, body));
    }

    fn sends(&self) -> Vec<(String, Value)> {
        self.sends.lock().unwrap().clone()
    }

    fn issued(&self) -> u32 {
        *self.issued.lock().unwrap()
    }
}

fn fcm_error(code: u16, status: &str, error_code: &str) -> (u16, Value) {
    (
        code,
        json!({"error": {"code": code, "message": "x", "status": status, "details": [
            {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": error_code}]}}),
    )
}

// ---------------------------------------------------------------- helpers

/// The test app with a real [`FcmChannel`] pointed at the fake; the channel shares the
/// app's manual clock (token expiry).
async fn app() -> (TestApp, FakeGoogle) {
    let (fake, base) = FakeGoogle::start().await;
    let rsa = Rsa::generate(2048).unwrap();
    let pkey = PKey::from_rsa(rsa).unwrap();
    let pem = String::from_utf8(pkey.private_key_to_pem_pkcs8().unwrap()).unwrap();
    *fake.public_key.lock().unwrap() =
        Some(PKey::public_key_from_pem(&pkey.public_key_to_pem().unwrap()).unwrap());
    let sa = ServiceAccount::parse(
        &json!({"type": "service_account", "project_id": PROJECT, "private_key_id": "key-1",
                "private_key": pem, "client_email": EMAIL,
                "token_uri": "https://oauth2.googleapis.com/token"})
        .to_string(),
    )
    .unwrap();
    let mut t = TestApp::new().await;
    let channel = FcmChannel::new(
        sa,
        FcmEndpoints {
            token_uri: format!("{base}/token"),
            fcm_base: base,
        },
        buddy_server::push::http_client(true).unwrap(),
        t.clock.clone(),
    )
    .unwrap();
    t.state = t.state.clone().with_push(PushOptions {
        allow_insecure_endpoints: true,
        retry_delays: [StdDuration::from_millis(1); 3],
        native: Arc::new(channel),
    });
    t.app = build_app(t.state.clone());
    (t, fake)
}

async fn round(t: &TestApp) -> reminders::TickReport {
    let mut tasks = JoinSet::new();
    let r = reminders::tick(&t.state, &mut tasks).await.unwrap();
    while tasks.join_next().await.is_some() {}
    r
}

async fn put_token(t: &TestApp, bearer: &str, body: Value) -> Resp {
    t.call(
        Method::PUT,
        "/api/v1/devices/current/push",
        Cred::Bearer(bearer),
        Some(body),
    )
    .await
}

async fn register(t: &TestApp, bearer: &str, token: &str) {
    let r = put_token(t, bearer, json!({"platform": "fcm", "token": token})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
}

/// A desktop stores note A with a one-off reminder at `at`; returns (device, bearer).
async fn reminder_at(t: &TestApp, at: &str, updated_at: &str) -> (String, String) {
    let (pc, tok) = t.device("desktop").await;
    store_reminder(t, &pc, &tok, at, updated_at).await;
    (pc, tok)
}

async fn store_reminder(t: &TestApp, pc: &str, tok: &str, at: &str, updated_at: &str) -> i64 {
    let note = json!({"id": NOTE_A, "title": "Einkauf", "color": "yellow",
        "content": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Milch, Brot"}]}]},
        "createdAt": "2026-11-01T08:00:00.000Z", "updatedAt": START, "schemaVersion": 1});
    let r = t
        .push(
            tok,
            json!({
                "notes": [{"id": NOTE_A, "updatedAt": START, "updatedBy": pc, "deleted": false, "note": note}],
                "reminders": [{"noteId": NOTE_A, "updatedAt": updated_at, "updatedBy": pc, "deleted": false,
                    "reminder": {"noteId": NOTE_A, "at": at, "repeat": "none", "state": "scheduled",
                                 "firedAt": null, "updatedAt": updated_at, "timeZone": "Europe/Berlin"}}]
            }),
        )
        .await;
    r.body["cursor"].as_i64().unwrap()
}

async fn device_token(t: &TestApp, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT native_push_token FROM devices WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn log_rows(t: &TestApp) -> Vec<(String, String, i64)> {
    sqlx::query_as("SELECT channel, status, attempts FROM push_log ORDER BY device_id")
        .fetch_all(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn unplanned_reminder_is_sent_through_fcm_v1() {
    let (t, fake) = app().await;
    let (phone, bearer) = t.device("mobile").await;
    register(&t, &bearer, FCM_TOKEN).await;
    assert_eq!(device_token(&t, &phone).await.as_deref(), Some(FCM_TOKEN));
    // the phone never reported deviceState: it planned nothing → push
    reminder_at(&t, "2026-11-06T10:01:00.000Z", START).await;
    t.clock.advance(Duration::minutes(1));
    let r = round(&t).await;
    assert_eq!((r.fired, r.dispatched), (1, 1));

    let sends = fake.sends();
    assert_eq!(sends.len(), 1);
    let (auth, body) = &sends[0];
    assert_eq!(auth, "Bearer ya29.access-1");
    let m = &body["message"];
    assert_eq!(m["token"], FCM_TOKEN);
    assert_eq!(m["notification"]["title"], "Erinnerung: Einkauf");
    assert_eq!(m["notification"]["body"], "Milch, Brot");
    assert_eq!(m["data"]["noteId"], NOTE_A);
    assert_eq!(m["data"]["at"], "2026-11-06T10:01:00.000Z");
    assert_eq!(m["data"]["timeZone"], "Europe/Berlin");
    assert_eq!(m["android"]["priority"], "HIGH");
    assert_eq!(m["android"]["notification"]["channel_id"], "reminders");
    assert_eq!(log_rows(&t).await, vec![("fcm".into(), "sent".into(), 1)]);
    // nothing twice
    assert_eq!(round(&t).await.dispatched, 0);
    assert_eq!(fake.sends().len(), 1);
    assert_eq!(fake.issued(), 1);
}

#[tokio::test]
async fn no_push_when_the_phone_planned_the_occurrence_but_after_a_change_it_is_sent() {
    let (t, fake) = app().await;
    let (_phone, bearer) = t.device("mobile").await;
    register(&t, &bearer, FCM_TOKEN).await;
    let (pc, pc_tok) = t.device("desktop").await;
    let cursor = store_reminder(&t, &pc, &pc_tok, "2026-11-06T10:01:00.000Z", START).await;
    // the shell planned everything up to the cursor and reports it (§10.3)
    t.push(
        &bearer,
        json!({"deviceState": {"scheduledSeq": cursor, "localNotifications": "granted"}}),
    )
    .await;
    t.clock.advance(Duration::minutes(1));
    let r = round(&t).await;
    assert_eq!(
        (r.fired, r.dispatched),
        (1, 0),
        "the local notification rings"
    );
    assert!(fake.sends().is_empty());

    // The PC moves the reminder while the phone is closed: the phone does not know the new
    // occurrence (scheduled_seq < at_seq) → it is woken by FCM.
    store_reminder(
        &t,
        &pc,
        &pc_tok,
        "2026-11-06T10:05:00.000Z",
        "2026-11-06T10:01:30.000Z",
    )
    .await;
    t.clock.advance(Duration::minutes(4));
    let r = round(&t).await;
    assert_eq!((r.fired, r.dispatched), (1, 1));
    let sends = fake.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0].1["message"]["data"]["at"],
        "2026-11-06T10:05:00.000Z"
    );
}

#[tokio::test]
async fn invalid_tokens_are_removed() {
    for answer in [
        fcm_error(404, "NOT_FOUND", "UNREGISTERED"),
        fcm_error(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"),
    ] {
        let (t, fake) = app().await;
        let (phone, bearer) = t.device("mobile").await;
        register(&t, &bearer, FCM_TOKEN).await;
        reminder_at(&t, "2026-11-06T10:01:00.000Z", START).await;
        fake.answer(answer.0, answer.1.clone());
        t.clock.advance(Duration::minutes(1));
        assert_eq!(round(&t).await.dispatched, 1);
        assert_eq!(device_token(&t, &phone).await, None, "{}", answer.0);
        assert_eq!(log_rows(&t).await, vec![("fcm".into(), "gone".into(), 1)]);
        let platform: Option<String> =
            sqlx::query_scalar("SELECT native_push_platform FROM devices WHERE id = ?")
                .bind(&phone)
                .fetch_one(&t.state.db)
                .await
                .unwrap();
        assert_eq!(platform, None);
    }
}

#[tokio::test]
async fn transient_errors_are_retried_and_access_tokens_cached_and_renewed() {
    let (t, fake) = app().await;
    let (_phone, bearer) = t.device("mobile").await;
    register(&t, &bearer, FCM_TOKEN).await;
    reminder_at(&t, "2026-11-06T10:01:00.000Z", START).await;
    let (c, b) = fcm_error(503, "UNAVAILABLE", "UNAVAILABLE");
    fake.answer(c, b);
    let (c, b) = fcm_error(401, "UNAUTHENTICATED", "UNSPECIFIED_ERROR");
    fake.answer(c, b);
    t.clock.advance(Duration::minutes(1));
    assert_eq!(round(&t).await.dispatched, 1);
    assert_eq!(log_rows(&t).await, vec![("fcm".into(), "sent".into(), 3)]);
    let auths: Vec<String> = fake.sends().into_iter().map(|s| s.0).collect();
    // 503 keeps the token; 401 drops it and the third attempt fetches a new one
    assert_eq!(
        auths,
        vec![
            "Bearer ya29.access-1",
            "Bearer ya29.access-1",
            "Bearer ya29.access-2"
        ]
    );

    // /push/test reuses the cached token …
    let test = || {
        t.call(
            Method::POST,
            "/api/v1/push/test",
            Cred::Bearer(&bearer),
            None,
        )
    };
    assert_eq!(test().await.status, StatusCode::NO_CONTENT);
    assert_eq!(fake.issued(), 2);
    let last = fake.sends().pop().unwrap();
    assert_eq!(last.1["message"]["data"]["type"], "test");
    // … until shortly before it expires (3599 s − 5 min margin)
    t.clock.advance(Duration::minutes(56));
    assert_eq!(test().await.status, StatusCode::NO_CONTENT);
    assert_eq!(fake.issued(), 3);
    let claims = fake.assertions.lock().unwrap().last().cloned().unwrap();
    assert_eq!(claims["iat"].as_i64().unwrap(), t.clock_now().timestamp());

    // a rejected token answers /push/test with 404 and removes it
    let (c, b) = fcm_error(404, "NOT_FOUND", "UNREGISTERED");
    fake.answer(c, b);
    assert_eq!(test().await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        test().await.status,
        StatusCode::NOT_FOUND,
        "no token any more"
    );
}

#[tokio::test]
async fn token_endpoint_rules() {
    let (t, _fake) = app().await;
    let (phone, bearer) = t.device("mobile").await;
    let (_pc, pc_bearer) = t.device("desktop").await;
    let (_web, cookie, _) = t.web_login(None).await;
    let fcm = json!({"platform": "fcm", "token": FCM_TOKEN});

    // only the native app (Bearer, kind mobile)
    assert_eq!(
        put_token(&t, &pc_bearer, fcm.clone()).await.status,
        StatusCode::BAD_REQUEST
    );
    let r = t
        .send(pwa_request(
            Method::PUT,
            "/api/v1/devices/current/push",
            Some(&cookie),
            Some(fcm.clone()),
        ))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert_eq!(
        t.call(
            Method::PUT,
            "/api/v1/devices/current/push",
            Cred::None,
            Some(fcm.clone())
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    // APNs is not implemented (D-55); malformed tokens are refused
    for body in [
        json!({"platform": "apns", "token": "abcdef"}),
        json!({"platform": "fcm", "token": ""}),
        json!({"platform": "fcm", "token": "has space"}),
        json!({"platform": "fcm", "token": "x".repeat(4097)}),
    ] {
        let r = put_token(&t, &bearer, body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}: {}", r.text);
        assert_eq!(r.body["error"], "bad_request", "{}", r.text);
    }
    // not a NativePushToken at all → 422 like every other JSON shape error
    for body in [
        json!({"platform": "gcm", "token": "abc"}),
        json!({"token": "abc"}),
    ] {
        let r = put_token(&t, &bearer, body.clone()).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}: {}",
            r.text
        );
    }
    assert_eq!(device_token(&t, &phone).await, None);

    // a token moves to the device that registers it (reinstall / new login)
    register(&t, &bearer, FCM_TOKEN).await;
    let (phone2, bearer2) = t.device("mobile").await;
    register(&t, &bearer2, FCM_TOKEN).await;
    assert_eq!(device_token(&t, &phone).await, None);
    assert_eq!(device_token(&t, &phone2).await.as_deref(), Some(FCM_TOKEN));
    // re-registering is idempotent; a new token replaces the old one
    register(&t, &bearer2, FCM_TOKEN).await;
    register(&t, &bearer2, "newtoken:2").await;
    assert_eq!(
        device_token(&t, &phone2).await.as_deref(),
        Some("newtoken:2")
    );

    // DELETE forgets it
    let r = t
        .call(
            Method::DELETE,
            "/api/v1/devices/current/push",
            Cred::Bearer(&bearer2),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(device_token(&t, &phone2).await, None);

    // logout (DELETE /devices/current) also drops the token
    register(&t, &bearer2, FCM_TOKEN).await;
    let r = t
        .call(
            Method::DELETE,
            "/api/v1/devices/current",
            Cred::Bearer(&bearer2),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(device_token(&t, &phone2).await, None);
}

#[tokio::test]
async fn without_fcm_configuration_tokens_are_refused() {
    let t = TestApp::new().await;
    let (_phone, bearer) = t.device("mobile").await;
    let r = put_token(&t, &bearer, json!({"platform": "fcm", "token": FCM_TOKEN})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
}

#[tokio::test]
async fn a_token_registered_after_the_reminder_fired_still_gets_it_within_24h() {
    let (t, fake) = app().await;
    let (_phone, bearer) = t.device("mobile").await;
    reminder_at(&t, "2026-11-06T10:01:00.000Z", START).await;
    t.clock.advance(Duration::minutes(1));
    assert_eq!(round(&t).await.dispatched, 0, "no token yet");
    register(&t, &bearer, FCM_TOKEN).await;
    assert_eq!(round(&t).await.dispatched, 1);
    assert_eq!(fake.sends().len(), 1);
}
