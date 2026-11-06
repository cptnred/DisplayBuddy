//! Static hosting of the PWA (`BUDDY_WEB_DIR`) and the security/caching headers
//! (PLAN_V3_SYNC §7.5; vite-plugin-pwa `deployment/index.md`; axum example
//! `static-file-server`).
//!
//! - SPA fallback: unknown paths without a file extension get `index.html` (status 200);
//!   missing files with an extension and anything below `/assets/` are 404, so a stale
//!   client never caches `index.html` as a hashed asset.
//! - `Cache-Control`: `/assets/*` → `public, max-age=31536000, immutable`; everything else
//!   (`/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`, SPA routes) → `no-cache`;
//!   the API → `no-store`.
//! - `*.webmanifest` → `Content-Type: application/manifest+json`.
//! - CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on every response
//!   (HSTS is set by Caddy).

use std::convert::Infallible;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::error::AppError;

pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; \
frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

pub const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
pub const CACHE_NO_CACHE: &str = "no-cache";
pub const CACHE_NO_STORE: &str = "no-store";
pub const MANIFEST_MIME: &str = "application/manifest+json";

/// Adds CSP, nosniff and Referrer-Policy to every response.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

/// `Cache-Control: no-store` for every API response (including errors).
pub async fn no_store(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_NO_STORE),
    );
    res
}

fn has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
}

/// Serves `dir` with SPA fallback and the caching rules above.
pub async fn serve_static(dir: Option<PathBuf>, req: Request) -> Result<Response, Infallible> {
    let path = req.uri().path().to_string();
    let Some(dir) = dir else {
        return Ok(AppError::not_found("no web app configured").into_response());
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    let immutable = path.starts_with("/assets/");
    let res = if immutable || has_extension(&path) {
        ServeDir::new(&dir).oneshot(req).await
    } else {
        ServeDir::new(&dir)
            .fallback(ServeFile::new(dir.join("index.html")))
            .oneshot(req)
            .await
    };
    let mut res = match res {
        Ok(r) => r.map(Body::new),
        Err(never) => match never {},
    };
    let ok = res.status() == StatusCode::OK;
    let h = res.headers_mut();
    let cache = if immutable && ok {
        CACHE_IMMUTABLE
    } else {
        CACHE_NO_CACHE
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if path.ends_with(".webmanifest") && ok {
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(MANIFEST_MIME),
        );
    }
    Ok(res)
}

/// Warns at start-up if the web directory is unusable (the API still works).
pub fn check_web_dir(dir: &Path) {
    if !dir.join("index.html").is_file() {
        tracing::warn!(dir = %dir.display(), "BUDDY_WEB_DIR has no index.html; web app unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions() {
        assert!(has_extension("/sw.js"));
        assert!(has_extension("/assets/index-abc.js"));
        assert!(!has_extension(
            "/notes/0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f"
        ));
        assert!(!has_extension("/"));
        assert!(!has_extension("/v1.2/settings"));
    }
}
