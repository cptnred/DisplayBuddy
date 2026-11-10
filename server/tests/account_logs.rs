//! Abnahme Nr. 26 (server): no secrets in the log. A test binary of its own: `tracing`
//! caches per-callsite interest process-wide, so parallel tests without a subscriber
//! would hide events from the capturing one.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::{Method, StatusCode};
use buddy_core::accounts::format_recovery_code;
use buddy_server::cli;
use common::*;
use serde_json::json;

const IP: &str = "198.51.100.20";

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

/// Abnahme Nr. 26 (server): no password, token, recovery or invite code in the log of a
/// run through every account endpoint (TRACE level, including the request trace layer).
#[tokio::test]
async fn logs_contain_no_secrets() {
    let buf = LogBuf::default();
    let sub = tracing_subscriber::fmt()
        .with_writer(buf.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(sub);

    let t =
        TestApp::with(|c| c.registration = buddy_core::accounts::RegistrationMode::Invite).await;
    let invite = cli::invite_create(&t.state.db, t.clock_now(), None, None)
        .await
        .unwrap();
    let mut b = account_body("anna", "anna's secret passphrase");
    b["inviteCode"] = json!(invite);
    let r = t.register(IP, b).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token = r.body["token"].as_str().unwrap().to_string();
    let code = r.body["recoveryCode"].as_str().unwrap().to_string();
    let r = t
        .call(
            Method::POST,
            "/api/v1/me/recovery-code",
            Cred::Bearer(&token),
            Some(json!({"password": "anna's secret passphrase"})),
        )
        .await;
    let code2 = r.body["recoveryCode"].as_str().unwrap().to_string();
    t.call(
        Method::PUT,
        "/api/v1/me/password",
        Cred::Bearer(&token),
        Some(json!({"currentPassword": "anna's secret passphrase", "newPassword": "second secret phrase", "signOutOthers": false})),
    )
    .await;
    let r = t
        .post_at(
            IP,
            "/api/v1/accounts/recover",
            json!({"username": "anna", "recoveryCode": code2, "newPassword": "third secret phrase", "deviceName": "PC"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token2 = r.body["token"].as_str().unwrap().to_string();
    let code3 = r.body["recoveryCode"].as_str().unwrap().to_string();
    t.call(
        Method::GET,
        "/api/v1/me/export",
        Cred::Bearer(&token2),
        None,
    )
    .await;
    t.post_at(
        IP,
        "/api/v1/accounts/recover",
        json!({"username": "anna", "recoveryCode": code, "newPassword": "fourth secret phrase", "deviceName": "PC"}),
    )
    .await;
    let r = t
        .call(
            Method::POST,
            "/api/v1/me/delete",
            Cred::Bearer(&token2),
            Some(json!({"password": "third secret phrase", "confirmUsername": "anna"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);

    let log = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("account registered"),
        "the capture works: {log}"
    );
    assert!(log.contains("/api/v1/accounts"), "request traces captured");
    for secret in [
        "secret passphrase",
        "secret phrase",
        &token,
        &token2,
        &code,
        &code2,
        &code3,
        &invite,
        &format_recovery_code(&code),
        &format_recovery_code(&invite),
    ] {
        assert!(!log.contains(secret), "log leaks {secret}");
    }
}
