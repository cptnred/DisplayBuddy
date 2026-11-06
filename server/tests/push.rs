//! Phase D end to end: scheduler round → Web Push to a local fake push service that
//! decrypts with the subscriber key (RFC 8291, `ece`) and verifies the VAPID JWT (RFC 8292,
//! ES256 with `p256`); native channel via a fake; dedupe rule, retries, 404/410, 24 h
//! window, `/push/test`, `PUT`/`DELETE /push/subscription`.

mod common;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use axum::http::{Method, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_core::sync::{NativePushPlatform, ReminderPushPayload};
use buddy_server::push::PushOptions;
use buddy_server::push::native::{BoxFuture, NativeOutcome, NativePushChannel};
use buddy_server::reminders;
use chrono::Duration;
use common::*;
use serde_json::{Value, json};
use tokio::task::JoinSet;

// RFC 8291 §5 receiver key pair and auth secret.
const RX_PRIV: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const RX_PUB: &str =
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RX_AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

fn b64(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).unwrap()
}

// ---------------------------------------------------------------- fake push service

#[derive(Debug, Clone)]
struct Captured {
    path: String,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, n: &str) -> Option<&str> {
        self.headers.get(n).and_then(|v| v.to_str().ok())
    }

    fn payload(&self) -> ReminderPushPayload {
        let plain = ece::decrypt(
            &ece::EcKeyComponents::new(b64(RX_PRIV), b64(RX_PUB)),
            &b64(RX_AUTH),
            &self.body,
        )
        .expect("decrypts with the subscriber key");
        serde_json::from_slice(&plain).unwrap()
    }

    /// Verifies `Authorization: vapid t=<jwt>, k=<key>` and returns (claims, k).
    fn vapid(&self) -> (Value, String) {
        let auth = self.header("authorization").unwrap();
        let rest = auth.strip_prefix("vapid ").expect("vapid scheme");
        let mut t = "";
        let mut k = "";
        for part in rest.split(',') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("t=") {
                t = v;
            } else if let Some(v) = part.strip_prefix("k=") {
                k = v;
            }
        }
        let mut it = t.split('.');
        let (h, c, s) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        let header: Value = serde_json::from_slice(&b64(h)).unwrap();
        assert_eq!(header["alg"], "ES256");
        use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
        let vk = VerifyingKey::from_sec1_bytes(&b64(k)).unwrap();
        let sig = Signature::from_slice(&b64(s)).unwrap();
        vk.verify(format!("{h}.{c}").as_bytes(), &sig)
            .expect("JWT signed with the VAPID key");
        (serde_json::from_slice(&b64(c)).unwrap(), k.to_string())
    }
}

#[derive(Clone, Default)]
struct Fake {
    got: Arc<Mutex<Vec<Captured>>>,
    /// Status codes to answer with, in order; afterwards 201.
    answers: Arc<Mutex<VecDeque<u16>>>,
}

impl Fake {
    async fn start() -> (Self, String) {
        let fake = Fake::default();
        let f = fake.clone();
        let app = axum::Router::new().fallback(
            move |uri: axum::http::Uri, headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let f = f.clone();
                async move {
                    f.got.lock().unwrap().push(Captured {
                        path: uri.path().to_string(),
                        headers,
                        body: body.to_vec(),
                    });
                    let code = f.answers.lock().unwrap().pop_front().unwrap_or(201);
                    StatusCode::from_u16(code).unwrap()
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (fake, base)
    }

    fn answer(&self, codes: &[u16]) {
        self.answers.lock().unwrap().extend(codes);
    }

    fn got(&self) -> Vec<Captured> {
        self.got.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------- fake native channel

#[derive(Default)]
struct FakeNative {
    sent: Mutex<Vec<(String, ReminderPushPayload)>>,
}

impl NativePushChannel for FakeNative {
    fn supports(&self, p: NativePushPlatform) -> bool {
        p == NativePushPlatform::Fcm
    }

    fn send<'a>(
        &'a self,
        _p: NativePushPlatform,
        token: &'a str,
        payload: &'a ReminderPushPayload,
    ) -> BoxFuture<'a, NativeOutcome> {
        self.sent
            .lock()
            .unwrap()
            .push((token.to_string(), payload.clone()));
        Box::pin(async { NativeOutcome::Delivered })
    }
}

// ---------------------------------------------------------------- helpers

async fn app(native: Arc<FakeNative>) -> TestApp {
    TestApp::with_push(PushOptions {
        allow_insecure_endpoints: true,
        retry_delays: [StdDuration::from_millis(1); 3],
        native,
    })
    .await
}

async fn round(t: &TestApp) -> reminders::TickReport {
    let mut tasks = JoinSet::new();
    let r = reminders::tick(&t.state, &mut tasks).await.unwrap();
    while tasks.join_next().await.is_some() {}
    r
}

fn sub_body(endpoint: &str) -> Value {
    json!({"endpoint": endpoint, "expirationTime": null,
           "keys": {"p256dh": RX_PUB, "auth": RX_AUTH}})
}

async fn subscribe(t: &TestApp, cookie: &str, endpoint: &str) {
    let r = t
        .call(
            Method::PUT,
            "/api/v1/push/subscription",
            Cred::Cookie(cookie),
            Some(sub_body(endpoint)),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
}

/// A desktop stores note A („Einkauf“ / „Milch, Brot“) with a one-off reminder at `at`.
async fn reminder_at(t: &TestApp, at: &str) -> String {
    let (pc, tok) = t.device("desktop").await;
    let note = json!({"id": NOTE_A, "title": "Einkauf", "color": "yellow",
        "content": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Milch, Brot"}]}]},
        "createdAt": "2026-11-01T08:00:00.000Z", "updatedAt": START, "schemaVersion": 1});
    t.push(
        &tok,
        json!({
            "notes": [{"id": NOTE_A, "updatedAt": START, "updatedBy": pc, "deleted": false, "note": note}],
            "reminders": [{"noteId": NOTE_A, "updatedAt": START, "updatedBy": pc, "deleted": false,
                "reminder": {"noteId": NOTE_A, "at": at, "repeat": "none", "state": "scheduled",
                             "firedAt": null, "updatedAt": START, "timeZone": "Europe/Berlin"}}]
        }),
    )
    .await;
    pc
}

async fn log_rows(t: &TestApp) -> Vec<(String, String, i64)> {
    sqlx::query_as("SELECT channel, status, attempts FROM push_log ORDER BY device_id")
        .fetch_all(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn due_reminder_is_pushed_once_encrypted_and_signed() {
    let (fake, base) = Fake::start().await;
    let t = app(Arc::default()).await;
    let (_web, cookie, _) = t.web_login(None).await;
    subscribe(&t, &cookie, &format!("{base}/push/1")).await;
    reminder_at(&t, "2026-11-06T10:05:00.000Z").await;

    // not due yet
    let r = round(&t).await;
    assert_eq!((r.fired, r.dispatched), (0, 0));
    assert_eq!(
        r.next.map(|n| buddy_core::zoned::format_utc(&n)).as_deref(),
        Some("2026-11-06T10:05:00.000Z")
    );

    t.clock.advance(Duration::minutes(5));
    let r = round(&t).await;
    assert_eq!((r.fired, r.dispatched, r.next), (1, 1, None));
    let got = fake.got();
    assert_eq!(got.len(), 1);
    let m = &got[0];
    assert_eq!(m.path, "/push/1");
    assert_eq!(m.header("content-encoding"), Some("aes128gcm"));
    assert_eq!(m.header("ttl"), Some("86400"));
    assert_eq!(m.header("urgency"), Some("high"));
    assert_eq!(
        m.header("topic").map(str::to_string),
        Some(buddy_server::push::payload::topic(NOTE_A))
    );
    let p = m.payload();
    assert_eq!(p.kind, "reminder");
    assert_eq!(p.title, "Erinnerung: Einkauf");
    assert_eq!(p.body, "Milch, Brot");
    assert_eq!(p.url, format!("/notes/{NOTE_A}"));
    assert_eq!(p.at.as_deref(), Some("2026-11-06T10:05:00.000Z"));
    assert_eq!(p.time_zone.as_deref(), Some("Europe/Berlin"));
    let (claims, k) = m.vapid();
    assert_eq!(claims["aud"], base.as_str());
    assert_eq!(claims["sub"], "mailto:admin@example.org");
    let now = t.clock_now().timestamp();
    let exp = claims["exp"].as_i64().unwrap();
    assert!(exp > now && exp - now <= 24 * 3600, "exp within a day");
    assert_eq!(k, t.state.vapid.as_ref().unwrap().public_key());

    assert_eq!(
        log_rows(&t).await,
        vec![("webpush".into(), "sent".into(), 1)]
    );
    // the reminder is due now, with firedAt
    let payload: String = sqlx::query_scalar("SELECT payload FROM reminders")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let rem: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(rem["state"], "due");
    assert_eq!(rem["updatedAt"], START, "firing keeps updatedAt (D-30)");

    // later rounds and a restart do not send again
    t.clock.advance(Duration::minutes(1));
    assert_eq!(round(&t).await.dispatched, 0);
    reminders::release_pending(&t.state.db).await.unwrap();
    assert_eq!(round(&t).await.dispatched, 0);
    assert_eq!(fake.got().len(), 1);
}

#[tokio::test]
async fn transient_errors_are_retried_and_gone_subscriptions_removed() {
    let (fake, base) = Fake::start().await;
    let t = app(Arc::default()).await;
    let (_web, cookie, _) = t.web_login(None).await;
    subscribe(&t, &cookie, &format!("{base}/push/1")).await;
    reminder_at(&t, START).await;
    fake.answer(&[503, 429]);
    assert_eq!(round(&t).await.dispatched, 1);
    assert_eq!(fake.got().len(), 3);
    assert_eq!(
        log_rows(&t).await,
        vec![("webpush".into(), "sent".into(), 3)]
    );

    // second account device: always failing → failed after 1 + 3 attempts
    let (_web2, cookie2, _) = t.web_login(None).await;
    subscribe(&t, &cookie2, &format!("{base}/push/2")).await;
    fake.answer(&[500, 500, 500, 500]);
    assert_eq!(
        round(&t).await.dispatched,
        1,
        "new subscription gets the open occurrence"
    );
    let rows = log_rows(&t).await;
    assert!(
        rows.contains(&("webpush".into(), "failed".into(), 4)),
        "{rows:?}"
    );

    // 410 removes the subscription
    let (_web3, cookie3, _) = t.web_login(None).await;
    subscribe(&t, &cookie3, &format!("{base}/push/3")).await;
    fake.answer(&[410]);
    assert_eq!(round(&t).await.dispatched, 1);
    assert_eq!(
        t.scalar_i64("SELECT COUNT(*) FROM push_subscriptions WHERE endpoint LIKE '%/push/3'")
            .await,
        0
    );
    assert!(
        log_rows(&t)
            .await
            .contains(&("webpush".into(), "gone".into(), 1))
    );
}

#[tokio::test]
async fn occurrences_older_than_24h_are_only_marked_due() {
    let (fake, base) = Fake::start().await;
    let t = app(Arc::default()).await;
    let (_web, cookie, _) = t.web_login(None).await;
    subscribe(&t, &cookie, &format!("{base}/push/1")).await;
    reminder_at(&t, "2026-11-05T09:59:00.000Z").await;
    let r = round(&t).await;
    assert_eq!((r.fired, r.dispatched), (1, 0));
    assert!(fake.got().is_empty());
}

#[tokio::test]
async fn mobile_devices_get_native_push_only_when_not_planned_locally() {
    let native = Arc::new(FakeNative::default());
    let t = app(native.clone()).await;
    let (mobile, _tok) = t.device("mobile").await;
    sqlx::query(
        "UPDATE devices SET native_push_platform = 'fcm', native_push_token = 'tok-1' WHERE id = ?",
    )
    .bind(&mobile)
    .execute(&t.state.db)
    .await
    .unwrap();
    reminder_at(&t, "2026-11-06T10:01:00.000Z").await;
    let (seq, at_seq): (i64, i64) = sqlx::query_as("SELECT seq, at_seq FROM reminders")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(seq, at_seq);
    // the shell planned exactly this version locally
    sqlx::query(
        "UPDATE devices SET scheduled_seq = ?, local_notifications = 'granted' WHERE id = ?",
    )
    .bind(at_seq)
    .bind(&mobile)
    .execute(&t.state.db)
    .await
    .unwrap();

    t.clock.advance(Duration::minutes(1));
    let r = round(&t).await;
    assert_eq!(
        (r.fired, r.dispatched),
        (1, 0),
        "local notification rings, no push"
    );
    let (seq2, at_seq2): (i64, i64) = sqlx::query_as("SELECT seq, at_seq FROM reminders")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert!(seq2 > seq, "firing bumps seq");
    assert_eq!(at_seq2, at_seq, "but not the occurrence version");
    assert!(native.sent.lock().unwrap().is_empty());

    // notifications denied on the device → native push
    sqlx::query("UPDATE devices SET local_notifications = 'denied' WHERE id = ?")
        .bind(&mobile)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(round(&t).await.dispatched, 1);
    let sent = native.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "tok-1");
    assert_eq!(sent[0].1.note_id.as_deref(), Some(NOTE_A));
    assert_eq!(log_rows(&t).await, vec![("fcm".into(), "sent".into(), 1)]);
}

#[tokio::test]
async fn push_test_and_subscription_endpoints() {
    let (fake, base) = Fake::start().await;
    let t = app(Arc::default()).await;
    let (web, cookie, _) = t.web_login(None).await;
    let test = |c: &str| common::request(Method::POST, "/api/v1/push/test", Cred::Cookie(c), None);
    // no subscription yet
    assert_eq!(t.send(test(&cookie)).await.status, StatusCode::NOT_FOUND);

    subscribe(&t, &cookie, &format!("{base}/push/a")).await;
    let r = t.send(test(&cookie)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    let got = fake.got();
    assert_eq!(got.len(), 1);
    let p = got[0].payload();
    assert_eq!((p.kind.as_str(), p.url.as_str()), ("test", "/"));
    assert_eq!(got[0].header("topic"), None);
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM push_log").await, 0);

    // a failing push service is reported as 502 without retries
    fake.answer(&[500]);
    assert_eq!(t.send(test(&cookie)).await.status, StatusCode::BAD_GATEWAY);
    assert_eq!(fake.got().len(), 2);

    // re-subscribe replaces the endpoint of the device
    subscribe(&t, &cookie, &format!("{base}/push/b")).await;
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM push_subscriptions WHERE device_id = ?")
            .bind(&web)
            .fetch_one(&t.state.db)
            .await
            .unwrap()
    };
    assert_eq!(count().await, 1);

    // DELETE with a stale endpoint leaves the current one alone …
    let del = |body: Option<Value>| {
        common::request(
            Method::DELETE,
            "/api/v1/push/subscription",
            Cred::Cookie(&cookie),
            body,
        )
    };
    let r = t
        .send(del(Some(json!({"endpoint": format!("{base}/push/a")}))))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(count().await, 1);
    // … the matching endpoint removes it
    let r = t
        .send(del(Some(json!({"endpoint": format!("{base}/push/b")}))))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(count().await, 0);
    // without a body the device's subscription goes
    subscribe(&t, &cookie, &format!("{base}/push/c")).await;
    assert_eq!(t.send(del(None)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(count().await, 0);

    // bad subscriptions and bearer devices are rejected
    let r = t
        .call(
            Method::PUT,
            "/api/v1/push/subscription",
            Cred::Cookie(&cookie),
            Some(sub_body("http://10.0.0.1/push")),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let (_pc, tok) = t.device("desktop").await;
    let r = t
        .call(
            Method::PUT,
            "/api/v1/push/subscription",
            Cred::Bearer(&tok),
            Some(sub_body(&format!("{base}/push/d"))),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = t
        .call(Method::POST, "/api/v1/push/test", Cred::Bearer(&tok), None)
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn without_vapid_key_web_push_is_not_available() {
    let t = TestApp::new().await;
    let (_web, cookie, _) = t.web_login(None).await;
    let r = t
        .call(
            Method::PUT,
            "/api/v1/push/subscription",
            Cred::Cookie(&cookie),
            Some(sub_body("https://web.push.apple.com/x")),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}
