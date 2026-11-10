//! Authentication (PLAN_V3_SYNC §6, §7.5):
//! - desktop and native shell: opaque bearer token per device (`POST /devices`), only its
//!   SHA-256 is stored;
//! - PWA: server-side session (device kind `web`) in the cookie `__Host-buddy_session`,
//!   only its SHA-256 is stored; 30 days, extended by every sync, new id on every login.

pub mod csrf;
pub mod password;
pub mod throttle;

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_core::sync::DeviceKind;
use buddy_core::zoned::format_utc;
use chrono::Duration;
use rand::Rng;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::error::{ApiResult, AppError};

pub const SESSION_COOKIE: &str = "__Host-buddy_session";
pub const SESSION_DAYS: i64 = 30;
/// A session is extended at most this often (avoids a DB write per request).
const SESSION_REFRESH_AFTER_HOURS: i64 = 1;
/// `devices.last_seen_at` is written at most this often per device.
const LAST_SEEN_EVERY_MINUTES: i64 = 5;
/// Parallel Argon2 verifications (19 MiB each); further logins wait for a slot.
pub const MAX_PARALLEL_PASSWORD_CHECKS: usize = 4;

/// 256 random bits, base64url (43 characters). Used for bearer tokens and session ids.
pub fn random_secret() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Lower-case hex SHA-256 – the only form in which tokens and session ids are stored.
pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn kind_str(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::Desktop => "desktop",
        DeviceKind::Web => "web",
        DeviceKind::Mobile => "mobile",
    }
}

pub fn parse_kind(s: &str) -> Option<DeviceKind> {
    match s {
        "desktop" => Some(DeviceKind::Desktop),
        "web" => Some(DeviceKind::Web),
        "mobile" => Some(DeviceKind::Mobile),
        _ => None,
    }
}

pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    if v.len() > 7 && v[..7].eq_ignore_ascii_case("bearer ") {
        Some(v[7..].trim()).filter(|t| !t.is_empty())
    } else {
        None
    }
}

pub fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == SESSION_COOKIE)
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

/// `Set-Cookie` for a session (OWASP Session Management: `__Host-` prefix, Secure,
/// HttpOnly, SameSite=Strict, Path=/; no Domain).
pub fn set_cookie_header(session_id: &str) -> HeaderValue {
    let v = format!(
        "{SESSION_COOKIE}={session_id}; Max-Age={}; Path=/; Secure; HttpOnly; SameSite=Strict",
        SESSION_DAYS * 24 * 3600
    );
    HeaderValue::from_str(&v).expect("session ids are base64url")
}

pub fn clear_cookie_header() -> HeaderValue {
    HeaderValue::from_static(
        "__Host-buddy_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
    )
}

/// Client IP for the login brake (peer, or `X-Forwarded-For` from a trusted proxy).
pub fn request_ip(
    state: &AppState,
    parts_ext: &axum::http::Extensions,
    headers: &HeaderMap,
) -> IpAddr {
    let peer = parts_ext.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    throttle::client_ip(peer, headers, &state.config.trusted_proxies)
}

/// Checks username + password with the login brake. Returns the user id.
pub async fn verify_login(
    state: &AppState,
    ip: IpAddr,
    username: &str,
    password: &str,
) -> ApiResult<i64> {
    let now = state.clock.now();
    if let Err(secs) = state.throttle.check(ip, username, now) {
        tracing::warn!(%ip, "login blocked by throttle");
        return Err(AppError::too_many(secs));
    }
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
            .bind(username.trim())
            .fetch_optional(&state.db)
            .await?;
    let pw = password.to_string();
    let _permit = state
        .password_checks
        .acquire()
        .await
        .map_err(|e| anyhow::anyhow!("password check semaphore: {e}"))?;
    let ok_id = tokio::task::spawn_blocking(move || match row {
        Some((id, hash)) => password::verify_password(&pw, &hash).then_some(id),
        None => {
            password::verify_dummy(&pw);
            None
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("verify task: {e}"))?;
    match ok_id {
        Some(id) => {
            state.throttle.success(ip, username);
            Ok(id)
        }
        None => {
            state.throttle.fail(ip, username, state.clock.now());
            tracing::info!(%ip, "failed login");
            Err(AppError::bad_credentials())
        }
    }
}

/// How a request authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    Bearer,
    /// Session cookie; carries the hash of the session id.
    Session {
        id_hash: String,
    },
}

/// An authenticated device (extractor for every protected endpoint).
#[derive(Debug, Clone)]
pub struct Auth {
    pub user_id: i64,
    pub device_id: String,
    pub kind: DeviceKind,
    pub via: Via,
}

impl Auth {
    pub async fn from_headers(state: &AppState, headers: &HeaderMap) -> ApiResult<Self> {
        let now = format_utc(&state.clock.now());
        let (row, via): (Option<(i64, String, String)>, Via) = if let Some(token) =
            bearer_token(headers)
        {
            let row = sqlx::query_as(
                "SELECT user_id, id, kind FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
            )
            .bind(sha256_hex(token))
            .fetch_optional(&state.db)
            .await?;
            (row, Via::Bearer)
        } else if let Some(sid) = session_cookie(headers) {
            let id_hash = sha256_hex(sid);
            let row = sqlx::query_as(
                "SELECT d.user_id, d.id, d.kind FROM sessions s JOIN devices d ON d.id = s.device_id \
                 WHERE s.id_hash = ? AND s.expires_at > ? AND d.revoked_at IS NULL",
            )
            .bind(&id_hash)
            .bind(&now)
            .fetch_optional(&state.db)
            .await?;
            (row, Via::Session { id_hash })
        } else {
            return Err(AppError::unauthorized());
        };
        let (user_id, device_id, kind) = row.ok_or_else(AppError::unauthorized)?;
        let kind = parse_kind(&kind).ok_or_else(AppError::internal)?;
        let seen_before =
            format_utc(&(state.clock.now() - Duration::minutes(LAST_SEEN_EVERY_MINUTES)));
        sqlx::query(
            "UPDATE devices SET last_seen_at = ? \
             WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
        )
        .bind(&now)
        .bind(&device_id)
        .bind(seen_before)
        .execute(&state.db)
        .await?;
        Ok(Self {
            user_id,
            device_id,
            kind,
            via,
        })
    }
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        Self::from_headers(state, &parts.headers).await
    }
}

/// Middleware on `/sync/*`: a valid session cookie is extended to 30 days from now (at
/// most once per hour) and the cookie is re-sent with a fresh `Max-Age`.
pub async fn extend_session(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let sid = if bearer_token(req.headers()).is_none() {
        session_cookie(req.headers()).map(str::to_string)
    } else {
        None
    };
    let mut extended = false;
    if let Some(sid) = &sid {
        let now = state.clock.now();
        let new_exp = now + Duration::days(SESSION_DAYS);
        let threshold = new_exp - Duration::hours(SESSION_REFRESH_AFTER_HOURS);
        let res = sqlx::query(
            "UPDATE sessions SET expires_at = ? WHERE id_hash = ? AND expires_at > ? AND expires_at < ?",
        )
        .bind(format_utc(&new_exp))
        .bind(sha256_hex(sid))
        .bind(format_utc(&now))
        .bind(format_utc(&threshold))
        .execute(&state.db)
        .await;
        extended = matches!(res, Ok(r) if r.rows_affected() == 1);
    }
    let mut res = next.run(req).await;
    if extended
        && res.status().is_success()
        && let Some(sid) = sid
    {
        res.headers_mut()
            .append(header::SET_COOKIE, set_cookie_header(&sid));
    }
    res
}

/// Paths that set the session cookie (login CSRF, D-104): `/session` and everything under
/// `/session/` (e.g. `/session/pairing`). The guard sits on the nested API router: routed
/// requests arrive without the `/api/v1` prefix, unrouted ones (fallback) with it.
pub fn is_session_path(path: &str) -> bool {
    let p = path.strip_prefix("/api/v1").unwrap_or(path);
    p == "/session" || p.starts_with("/session/")
}

/// Middleware on the whole API: CSRF rules for requests that carry the session cookie and
/// for the `/session*` endpoints (which set it). Bearer clients (`POST /devices`,
/// `POST /devices/pairing`, sync with token) send neither cookie nor `Origin` and are not
/// affected. Runs before routing, so it also guards routes that do not exist (yet).
pub async fn csrf_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let applies = session_cookie(req.headers()).is_some() || is_session_path(req.uri().path());
    if !applies {
        return next.run(req).await;
    }
    match csrf::check(req.method(), req.headers(), &state.config.public_origin) {
        Ok(()) => next.run(req).await,
        Err(e) => {
            tracing::warn!(method = %req.method(), "CSRF check failed");
            axum::response::IntoResponse::into_response(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_paths() {
        for p in [
            "/session",
            "/session/pairing",
            "/session/x/y",
            "/api/v1/session",
            "/api/v1/session/pairing",
        ] {
            assert!(is_session_path(p), "{p}");
        }
        for p in [
            "/sessions",
            "/sessionx",
            "/devices/pairing",
            "/me",
            "/x/session",
        ] {
            assert!(!is_session_path(p), "{p}");
        }
    }

    #[test]
    fn secrets_and_hashes() {
        let a = random_secret();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_secret());
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn header_parsing() {
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer tok"),
        );
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; __Host-buddy_session=sid ; b=2"),
        );
        assert_eq!(bearer_token(&h), Some("tok"));
        assert_eq!(session_cookie(&h), Some("sid"));
        let c = set_cookie_header("sid").to_str().unwrap().to_string();
        assert!(c.contains("Secure") && c.contains("HttpOnly") && c.contains("SameSite=Strict"));
        assert!(c.contains("Path=/") && !c.contains("Domain"));
    }
}
