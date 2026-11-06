//! Auth: device tokens, PWA sessions (cookie attributes, reuse, expiry), CSRF, login brake.

mod common;

use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::{Method, StatusCode};
use buddy_server::auth::sha256_hex;
use chrono::Duration;
use common::*;
use serde_json::json;

fn login_body(password: &str, kind: &str) -> serde_json::Value {
    json!({"username": USER, "password": password, "deviceName": "PC", "kind": kind})
}

#[tokio::test]
async fn health_is_public_and_not_cached() {
    let t = TestApp::new().await;
    let r = t
        .call(Method::GET, "/api/v1/health", Cred::None, None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["ok"], true);
    assert_eq!(r.body["serverTime"], START);
    assert_eq!(r.header("cache-control"), Some("no-store"));
}

#[tokio::test]
async fn device_kinds_and_token_storage() {
    let t = TestApp::new().await;
    let (desk, token) = t.device("desktop").await;
    let (mob, _) = t.device("mobile").await;
    assert_ne!(desk, mob);
    // the web app must use /session
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login_body(PASS, "web")),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["error"], "bad_request");
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login_body(PASS, "toaster")),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.body["error"], "bad_request");

    // only the SHA-256 of the token is stored
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM devices WHERE id = ?")
        .bind(&desk)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stored, sha256_hex(&token));
    assert_ne!(stored, token);

    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Bearer(&token), None)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["username"], USER);
    assert_eq!(r.body["deviceId"], desk.as_str());
    assert_eq!(r.body["timeZone"], "Europe/Berlin");
    let kinds: Vec<String> = sqlx::query_scalar("SELECT kind FROM devices ORDER BY kind")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert_eq!(kinds, ["desktop", "mobile"]);
}

#[tokio::test]
async fn wrong_password_and_unknown_token() {
    let t = TestApp::new().await;
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login_body("wrong password!", "desktop")),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.body["error"], "unauthorized");
    let r = t
        .call(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(json!({"username": "nobody", "password": PASS, "deviceName": "x", "kind": "desktop"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Bearer("nope"), None)
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.call(Method::GET, "/api/v1/me", Cred::None, None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn device_logout_and_revocation() {
    let t = TestApp::new().await;
    let (_, token) = t.device("desktop").await;
    let r = t
        .call(
            Method::DELETE,
            "/api/v1/devices/current",
            Cred::Bearer(&token),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Bearer(&token), None)
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // revoked via CLI
    let (dev, token) = t.device("mobile").await;
    buddy_server::cli::device_revoke(&t.state.db, chrono::Utc::now(), &dev)
        .await
        .unwrap();
    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Bearer(&token), None)
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_brake_per_ip_and_user() {
    let t = TestApp::new().await;
    let attacker: SocketAddr = "203.0.113.9:1234".parse().unwrap();
    let send = |pw: &'static str, addr: SocketAddr| {
        let mut req = request(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login_body(pw, "desktop")),
        );
        req.extensions_mut().insert(ConnectInfo(addr));
        req
    };
    for _ in 0..5 {
        assert_eq!(
            t.send(send("wrong password!", attacker)).await.status,
            StatusCode::UNAUTHORIZED
        );
    }
    // locked: even the right password is refused, with Retry-After
    let r = t.send(send(PASS, attacker)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.body["error"], "too_many_requests");
    assert_eq!(r.header("retry-after"), Some("30"));
    // another IP is not affected
    let other: SocketAddr = "203.0.113.10:1".parse().unwrap();
    assert_eq!(t.send(send(PASS, other)).await.status, StatusCode::OK);
    // exponential: after the lock, one more failure locks for 60 s
    t.clock.advance(Duration::seconds(31));
    assert_eq!(
        t.send(send("wrong password!", attacker)).await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = t.send(send(PASS, attacker)).await;
    assert_eq!(r.header("retry-after"), Some("60"));
    t.clock.advance(Duration::seconds(61));
    assert_eq!(t.send(send(PASS, attacker)).await.status, StatusCode::OK);
    // success reset the counter
    assert_eq!(
        t.send(send("wrong password!", attacker)).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(t.send(send(PASS, attacker)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn forwarded_for_only_counts_from_trusted_proxy() {
    let t = TestApp::with(|c| c.trusted_proxies = vec!["172.30.0.0/16".parse().unwrap()]).await;
    let proxy: SocketAddr = "172.30.0.2:5000".parse().unwrap();
    let send = |pw: &'static str, xff: &'static str| {
        let mut req = request(
            Method::POST,
            "/api/v1/devices",
            Cred::None,
            Some(login_body(pw, "desktop")),
        );
        req.headers_mut()
            .insert("x-forwarded-for", xff.parse().unwrap());
        req.extensions_mut().insert(ConnectInfo(proxy));
        req
    };
    for _ in 0..5 {
        t.send(send("wrong password!", "198.51.100.66")).await;
    }
    assert_eq!(
        t.send(send(PASS, "198.51.100.66")).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // a different client behind the same proxy can still sign in
    assert_eq!(
        t.send(send(PASS, "198.51.100.67")).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn session_cookie_attributes_and_logout() {
    let t = TestApp::new().await;
    let (dev, sid, set) = t.web_login(None).await;
    assert!(set.starts_with("__Host-buddy_session="), "{set}");
    for attr in [
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(
            set.split("; ").any(|a| a == attr),
            "{attr} missing in {set}"
        );
    }
    assert!(!set.contains("Domain"));
    // stored hashed, device kind web
    let (hash, kind): (String, String) = sqlx::query_as(
        "SELECT s.id_hash, d.kind FROM sessions s JOIN devices d ON d.id = s.device_id",
    )
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(hash, sha256_hex(&sid));
    assert_eq!(kind, "web");

    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["deviceId"], dev.as_str());

    // DELETE /devices/current is for bearer devices only
    let r = t
        .call(
            Method::DELETE,
            "/api/v1/devices/current",
            Cred::Cookie(&sid),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = t
        .call(Method::DELETE, "/api/v1/session", Cred::Cookie(&sid), None)
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(r.header("set-cookie").unwrap().contains("Max-Age=0"));
    let r = t
        .call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_reuses_device_and_rotates_id() {
    let t = TestApp::new().await;
    let (dev, sid1, _) = t.web_login(None).await;
    let (dev2, sid2, _) = t.web_login(Some(&dev)).await;
    assert_eq!(dev, dev2, "deviceId reused");
    assert_ne!(sid1, sid2, "new session id on every login");
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&sid1), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&sid2), None)
            .await
            .status,
        StatusCode::OK
    );
    // a foreign / non-web device id is not reused
    let (desk, _) = t.device("desktop").await;
    let (dev3, _, _) = t.web_login(Some(&desk)).await;
    assert_ne!(dev3, desk);
    assert_eq!(
        t.scalar_i64("SELECT COUNT(*) FROM devices WHERE kind = 'web'")
            .await,
        2
    );
}

#[tokio::test]
async fn session_expires_after_30_days_unless_synced() {
    let t = TestApp::new().await;
    let (_, sid, _) = t.web_login(None).await;
    // a sync after 20 days extends the session and re-sends the cookie
    t.clock.advance(Duration::days(20));
    let r = t
        .call(
            Method::GET,
            "/api/v1/sync/changes?since=0",
            Cred::Cookie(&sid),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let set = r.header("set-cookie").expect("cookie refreshed");
    assert!(set.contains(&sid) && set.contains("Max-Age=2592000"));
    // within the next hour no further write/cookie
    t.clock.advance(Duration::minutes(10));
    let r = t
        .call(
            Method::GET,
            "/api/v1/sync/changes?since=0",
            Cred::Cookie(&sid),
            None,
        )
        .await;
    assert!(r.header("set-cookie").is_none());
    // 29 days after the extension it still works, 31 days without sync it does not
    t.clock.advance(Duration::days(29));
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
            .await
            .status,
        StatusCode::OK
    );
    t.clock.advance(Duration::days(2));
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn csrf_rules_for_cookie_requests() {
    let t = TestApp::new().await;
    let (_, sid, _) = t.web_login(None).await;
    let push = || json!({"notes": [note_rec(NOTE_A, "x", START, "web")]});
    let build = |site: Option<&str>, origin: Option<&str>, custom: bool| {
        let mut b = axum::http::Request::builder()
            .method(Method::POST)
            .uri("/api/v1/sync/push")
            .header("content-type", "application/json")
            .header("cookie", format!("__Host-buddy_session={sid}"));
        if let Some(s) = site {
            b = b.header("sec-fetch-site", s);
        }
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        if custom {
            b = b.header("x-buddy-request", "1");
        }
        b.body(axum::body::Body::from(push().to_string())).unwrap()
    };
    let cases = [
        (
            Some("cross-site"),
            Some(ORIGIN),
            true,
            StatusCode::FORBIDDEN,
        ),
        (Some("same-site"), Some(ORIGIN), true, StatusCode::FORBIDDEN),
        (
            Some("same-origin"),
            Some(ORIGIN),
            false,
            StatusCode::FORBIDDEN,
        ),
        (
            None,
            Some("https://evil.example"),
            true,
            StatusCode::FORBIDDEN,
        ),
        (None, None, true, StatusCode::FORBIDDEN),
        (None, Some(ORIGIN), true, StatusCode::OK),
        (Some("same-origin"), None, true, StatusCode::OK),
    ];
    for (site, origin, custom, expected) in cases {
        let r = t.send(build(site, origin, custom)).await;
        assert_eq!(
            r.status, expected,
            "{site:?} {origin:?} {custom}: {}",
            r.text
        );
        if expected == StatusCode::FORBIDDEN {
            assert_eq!(r.body["error"], "forbidden");
        }
    }
    // cross-site login (login CSRF) is rejected too
    let mut req = pwa_request(
        Method::POST,
        "/api/v1/session",
        None,
        Some(json!({"username": USER, "password": PASS, "deviceName": "x"})),
    );
    req.headers_mut()
        .insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert_eq!(t.send(req).await.status, StatusCode::FORBIDDEN);
    // bearer requests are exempt (no cookie, no CSRF headers needed)
    let (_, token) = t.device("desktop").await;
    let mut req = request(
        Method::POST,
        "/api/v1/sync/push",
        Cred::Bearer(&token),
        Some(push()),
    );
    req.headers_mut()
        .insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert_eq!(t.send(req).await.status, StatusCode::OK);
}

#[tokio::test]
async fn me_time_zone() {
    let t = TestApp::new().await;
    let (_, token) = t.device("desktop").await;
    let r = t
        .call(
            Method::PUT,
            "/api/v1/me",
            Cred::Bearer(&token),
            Some(json!({"timeZone": "Asia/Calcutta"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["timeZone"], "Asia/Calcutta");
    let r = t
        .call(
            Method::PUT,
            "/api/v1/me",
            Cred::Bearer(&token),
            Some(json!({"timeZone": "Mars/Olympus"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        buddy_server::sync::user_time_zone(&t.state.db, t.user_id)
            .await
            .unwrap(),
        "Asia/Calcutta"
    );
}
