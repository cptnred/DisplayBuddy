//! PWA hosting: SPA fallback, cache headers, manifest MIME, CSP; API 404s; VAPID endpoint
//! and CLI helpers; backups.

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use buddy_server::clock::Clock;
use buddy_server::web::{CSP, MANIFEST_MIME};
use chrono::Duration;
use common::*;

fn write(dir: &std::path::Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

async fn web_app() -> TestApp {
    let t = TestApp::with(|c| c.web_dir = Some(c.db_path.parent().unwrap().join("web"))).await;
    let web = t.dir.path().join("web");
    write(
        &web,
        "index.html",
        "<!doctype html><title>Display Buddy</title>",
    );
    write(&web, "sw.js", "self.addEventListener('push', () => {});");
    write(&web, "manifest.webmanifest", r#"{"name":"Display Buddy"}"#);
    write(&web, "assets/index-abc123.js", "console.log(1)");
    write(&web, "icons/icon-192.png", "png");
    t
}

async fn get(t: &TestApp, path: &str) -> Resp {
    t.send(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
}

#[tokio::test]
async fn cache_headers_and_spa_fallback() {
    let t = web_app().await;
    for path in [
        "/",
        "/index.html",
        "/notes/0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
        "/settings",
    ] {
        let r = get(&t, path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert!(r.text.contains("Display Buddy"), "{path}");
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
        assert!(
            r.header("content-type").unwrap().starts_with("text/html"),
            "{path}"
        );
    }
    let r = get(&t, "/sw.js").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("cache-control"), Some("no-cache"));
    assert!(r.header("content-type").unwrap().contains("javascript"));

    let r = get(&t, "/manifest.webmanifest").await;
    assert_eq!(r.header("content-type"), Some(MANIFEST_MIME));
    assert_eq!(r.header("cache-control"), Some("no-cache"));

    let r = get(&t, "/assets/index-abc123.js").await;
    assert_eq!(
        r.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );

    // missing hashed assets and files are 404, never index.html
    for path in ["/assets/index-old.js", "/assets/sub", "/missing.png"] {
        let r = get(&t, path).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
    }
    let r = get(&t, "/icons/icon-192.png").await;
    assert_eq!(r.status, StatusCode::OK);
    // no directory traversal
    let r = get(&t, "/../buddy.db").await;
    assert_ne!(r.status, StatusCode::OK);
    let r = t
        .send(
            Request::builder()
                .method(Method::POST)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn security_headers_everywhere() {
    let t = web_app().await;
    for path in [
        "/",
        "/assets/index-abc123.js",
        "/api/v1/health",
        "/api/v1/nope",
        "/missing.js",
    ] {
        let r = get(&t, path).await;
        assert_eq!(r.header("content-security-policy"), Some(CSP), "{path}");
        assert_eq!(
            r.header("x-content-type-options"),
            Some("nosniff"),
            "{path}"
        );
        assert_eq!(r.header("referrer-policy"), Some("no-referrer"), "{path}");
    }
    assert!(CSP.contains("frame-ancestors 'none'") && CSP.contains("script-src 'self';"));
}

#[tokio::test]
async fn api_paths_are_json_and_no_store() {
    let t = web_app().await;
    for path in [
        "/api/v1/nope",
        "/api/v2/health",
        "/api",
        "/api/v1/sync/nope",
    ] {
        let r = get(&t, path).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(r.body["error"], "not_found", "{path}");
        assert_eq!(r.header("cache-control"), Some("no-store"), "{path}");
    }
    // unauthorised API answers are not cached either
    let r = get(&t, "/api/v1/me").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.header("cache-control"), Some("no-store"));
}

#[tokio::test]
async fn without_web_dir_only_the_api_is_served() {
    let t = TestApp::new().await;
    let r = get(&t, "/").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&t, "/api/v1/health").await.status, StatusCode::OK);
}

#[tokio::test]
async fn vapid_public_key_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("vapid.pem");
    let public = buddy_server::vapid::generate(&key, false).unwrap();
    let t = TestApp::with(|c| c.vapid_private_key_file = Some(key.clone())).await;
    let (_, token) = t.device("mobile").await;
    let r = t
        .call(
            Method::GET,
            "/api/v1/push/vapid-public-key",
            Cred::None,
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t
        .call(
            Method::GET,
            "/api/v1/push/vapid-public-key",
            Cred::Bearer(&token),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["key"], public.as_str());
    assert!(!r.text.contains("PRIVATE"));

    let t = TestApp::new().await;
    let (_, token) = t.device("mobile").await;
    let r = t
        .call(
            Method::GET,
            "/api/v1/push/vapid-public-key",
            Cred::Bearer(&token),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cli_user_and_device_admin() {
    let t = TestApp::new().await;
    let db = &t.state.db;
    let now = t.clock.now();
    use buddy_server::cli::*;
    assert!(
        user_add(db, now, USER, PASS, "UTC").await.is_err(),
        "duplicate"
    );
    assert!(
        user_add(db, now, "MARTIN", PASS, "UTC").await.is_err(),
        "case-insensitive"
    );
    assert!(
        user_add(db, now, "bob", "short", "UTC").await.is_err(),
        "≥ 12 chars"
    );
    assert!(
        user_add(db, now, "bob", PASS, "Mars/Olympus")
            .await
            .is_err()
    );
    assert!(user_add(db, now, "bob smith", PASS, "UTC").await.is_err());

    let (dev, token) = t.device("desktop").await;
    let (_, sid, _) = t.web_login(None).await;
    let list = device_list(db).await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|d| d.revoked_at.is_none()));

    // password change ends web sessions, keeps device tokens
    user_passwd(db, now, USER, "a brand new passphrase", false)
        .await
        .unwrap();
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Cookie(&sid), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Bearer(&token), None)
            .await
            .status,
        StatusCode::OK
    );
    user_passwd(db, now, USER, "another new passphrase", true)
        .await
        .unwrap();
    assert_eq!(
        t.call(Method::GET, "/api/v1/me", Cred::Bearer(&token), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert!(device_revoke(db, now, "no-such-device").await.is_err());
    let list = device_list(db).await.unwrap();
    assert!(
        list.iter()
            .find(|d| d.id == dev)
            .unwrap()
            .revoked_at
            .is_some()
    );
}

#[tokio::test]
async fn nightly_backup_keeps_14() {
    let t = TestApp::new().await;
    let dir = t.state.config.backup_dir.clone();
    let mut now = t.clock.now();
    let first = buddy_server::housekeeping::backup(&t.state.db, &dir, now)
        .await
        .unwrap();
    assert_eq!(first.unwrap().file_name().unwrap(), "buddy-20261106.db");
    assert!(
        buddy_server::housekeeping::backup(&t.state.db, &dir, now)
            .await
            .unwrap()
            .is_none()
    );
    for _ in 0..20 {
        now += Duration::days(1);
        buddy_server::housekeeping::backup(&t.state.db, &dir, now)
            .await
            .unwrap();
    }
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files.len(), 14);
    assert_eq!(files.last().unwrap(), "buddy-20261126.db");
    // the backup is a usable database
    let copy = buddy_server::db::open(&dir.join("buddy-20261126.db"))
        .await
        .unwrap();
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(users, 1);
}
