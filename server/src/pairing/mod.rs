//! QR pairing (PLAN_V4 §5.1/§5.2, §6.2, §6.3, §8.3 S4–S9): the desktop creates a short-lived
//! code (`POST /pairing`), polls its state (`GET /pairing/{id}`) or cancels it (`DELETE`);
//! a phone redeems it as a native device (`POST /devices/pairing`, bearer token) or as the
//! PWA (`POST /session/pairing`, session cookie, CSRF via `auth::csrf_guard`).
//!
//! Codes come only from `buddy_core::pairing` and only their SHA-256 is stored. Every failed
//! redemption is the same `400 pairing_invalid` (no oracle) and counts in the per-IP limiter
//! (`limits.pairing_failures`); `GET`/`DELETE` of another device's pairing is a 404. Logs
//! name only the pairing id and device ids, never the code.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use buddy_core::pairing::{
    PAIRING_TTL_SECS, PairedDevice, PairingAccess, PairingRedeem, PairingStart, PairingState,
    PairingStatus, SessionPairing, code_from_bytes, code_hash, normalize_code, pairing_url,
};
use buddy_core::sync::{DeviceKind, error_codes as codes};
use buddy_core::zoned::{format_utc, parse_instant};
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use sqlx::SqliteConnection;
use std::net::IpAddr;

use crate::AppState;
use crate::api::{ApiJson, ClientIp, check_device_name, open_web_session, session_response};
use crate::auth::{Auth, kind_str, parse_kind, random_secret, sha256_hex};
use crate::db::BEGIN_WRITE;
use crate::error::{ApiResult, AppError};

/// Open (pending) codes per account (PLAN_V4 §8.2).
pub const MAX_OPEN_PER_ACCOUNT: i64 = 3;

/// Routes (without the `/api/v1` prefix), merged in `build_app`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/pairing", post(start))
        .route("/pairing/{id}", get(status).delete(cancel))
        .route("/devices/pairing", post(redeem_device))
        .route("/session/pairing", post(redeem_session))
}

fn invalid() -> AppError {
    AppError::new(
        StatusCode::BAD_REQUEST,
        codes::PAIRING_INVALID,
        "the pairing code is invalid or expired",
    )
}

/// `POST /pairing`: desktop only. A new code of the same device cancels its open one.
async fn start(State(state): State<AppState>, auth: Auth) -> ApiResult<Json<PairingStart>> {
    if auth.kind != DeviceKind::Desktop {
        return Err(AppError::forbidden(
            "only a desktop can create pairing codes",
        ));
    }
    let now = state.clock.now();
    state
        .limits
        .pairing_starts
        .acquire(&auth.user_id, now)
        .map_err(|s| AppError::rate_limited(s, "too many pairing codes, try again later"))?;
    let now_s = format_utc(&now);
    let expires_at = format_utc(&(now + Duration::seconds(PAIRING_TTL_SECS)));
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    sqlx::query(
        "UPDATE pairings SET cancelled_at = ? WHERE created_by = ? \
         AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?",
    )
    .bind(&now_s)
    .bind(&auth.device_id)
    .bind(&now_s)
    .execute(&mut *tx)
    .await?;
    let (open, oldest): (i64, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*), MIN(expires_at) FROM pairings WHERE user_id = ? \
         AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? \
         AND created_by IN (SELECT id FROM devices WHERE revoked_at IS NULL)",
    )
    .bind(auth.user_id)
    .bind(&now_s)
    .fetch_one(&mut *tx)
    .await?;
    if open >= MAX_OPEN_PER_ACCOUNT {
        let secs = oldest
            .and_then(|t| parse_instant(&t))
            .map_or(PAIRING_TTL_SECS, |t| (t - now).num_seconds());
        return Err(AppError::rate_limited(
            u64::try_from(secs).unwrap_or(1),
            "too many open pairing codes",
        ));
    }
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    let code = code_from_bytes(&bytes);
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pairings (id, user_id, created_by, code_hash, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(auth.user_id)
    .bind(&auth.device_id)
    .bind(code_hash(&code))
    .bind(&now_s)
    .bind(&expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(pairing = %id, device = %auth.device_id, "pairing code created");
    Ok(Json(PairingStart {
        pairing_id: id,
        url: pairing_url(&state.config.public_origin, &code),
        code,
        expires_at,
        server_time: now_s,
    }))
}

/// `GET /pairing/{id}`: only for the creating device (others: 404, no oracle).
async fn status(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<PairingStatus>> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT p.expires_at, p.cancelled_at, p.redeemed_at, d.id, d.name, d.kind \
         FROM pairings p LEFT JOIN devices d ON d.id = p.redeemed_device_id \
         WHERE p.id = ? AND p.created_by = ?",
    )
    .bind(&id)
    .bind(&auth.device_id)
    .fetch_optional(&state.db)
    .await?;
    let (expires_at, cancelled_at, redeemed_at, dev_id, dev_name, dev_kind) =
        row.ok_or_else(|| AppError::not_found("unknown pairing"))?;
    let now = state.clock.now();
    let pairing_state = if redeemed_at.is_some() {
        PairingState::Redeemed
    } else if cancelled_at.is_some() {
        PairingState::Cancelled
    } else if expires_at <= format_utc(&now) {
        PairingState::Expired
    } else {
        PairingState::Pending
    };
    let device = match (dev_id, dev_name, dev_kind.as_deref().and_then(parse_kind)) {
        (Some(id), Some(name), Some(kind)) => Some(PairedDevice { id, name, kind }),
        _ => None,
    };
    Ok(Json(PairingStatus {
        pairing_id: id,
        state: pairing_state,
        expires_at,
        device,
        redeemed_at,
        server_time: format_utc(&now),
    }))
}

/// `DELETE /pairing/{id}`: cancels an open code of the creating device (others: 404).
/// A redeemed code stays redeemed (signing that device out is `/me/devices/{id}/revoke`).
async fn cancel(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let r = sqlx::query(
        "UPDATE pairings SET cancelled_at = \
         CASE WHEN redeemed_at IS NULL AND cancelled_at IS NULL THEN ? ELSE cancelled_at END \
         WHERE id = ? AND created_by = ?",
    )
    .bind(format_utc(&state.clock.now()))
    .bind(&id)
    .bind(&auth.device_id)
    .execute(&state.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::not_found("unknown pairing"));
    }
    tracing::info!(pairing = %id, device = %auth.device_id, "pairing cancelled");
    Ok(StatusCode::NO_CONTENT)
}

/// A code redeemed inside the caller's transaction.
struct Claim {
    pairing_id: String,
    user_id: i64,
    username: String,
}

fn check_ip(state: &AppState, ip: IpAddr, now: DateTime<Utc>) -> ApiResult<()> {
    state
        .limits
        .pairing_failures
        .check(&ip, now)
        .map_err(|s| AppError::rate_limited(s, "too many failed pairing attempts, try again later"))
}

/// Redeems `code` (S5): one conditional `UPDATE` – not expired, not cancelled, not redeemed,
/// creating device still signed in – that must hit exactly one row. Every miss is
/// `pairing_invalid` and counts for the IP. A disabled account is `403 account_disabled`.
/// The caller creates the device and commits; dropping `tx` rolls the redemption back.
async fn claim(
    state: &AppState,
    tx: &mut SqliteConnection,
    ip: IpAddr,
    code: &str,
    now: DateTime<Utc>,
) -> ApiResult<Claim> {
    let row: Option<(String, i64, String, bool)> = match normalize_code(code) {
        Some(code) => {
            sqlx::query_as(
                "UPDATE pairings SET redeemed_at = ?1 WHERE code_hash = ?2 \
                 AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1 \
                 AND created_by IN (SELECT id FROM devices WHERE revoked_at IS NULL) \
                 RETURNING id, user_id, \
                 (SELECT username FROM users WHERE users.id = pairings.user_id), \
                 (SELECT disabled_at IS NOT NULL FROM users WHERE users.id = pairings.user_id)",
            )
            .bind(format_utc(&now))
            .bind(code_hash(&code))
            .fetch_optional(&mut *tx)
            .await?
        }
        None => None,
    };
    let Some((pairing_id, user_id, username, disabled)) = row else {
        state.limits.pairing_failures.hit(&ip, now);
        tracing::info!(%ip, "failed pairing attempt");
        return Err(invalid());
    };
    if disabled {
        return Err(AppError::account_disabled());
    }
    Ok(Claim {
        pairing_id,
        user_id,
        username,
    })
}

async fn mark_redeemed(
    tx: &mut SqliteConnection,
    pairing_id: &str,
    device_id: &str,
) -> ApiResult<()> {
    sqlx::query("UPDATE pairings SET redeemed_device_id = ? WHERE id = ?")
        .bind(device_id)
        .bind(pairing_id)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

/// `POST /devices/pairing`: the native app becomes a `mobile` device with a bearer token.
async fn redeem_device(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<PairingRedeem>,
) -> ApiResult<Json<PairingAccess>> {
    let now = state.clock.now();
    check_ip(&state, ip, now)?;
    if body.kind != DeviceKind::Mobile {
        return Err(AppError::bad_request("kind must be mobile"));
    }
    let name = check_device_name(&body.device_name)?;
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    let c = claim(&state, &mut tx, ip, &body.code, now).await?;
    crate::accounts::quota::check_device_limit(&mut tx, &state.config.quota, c.user_id).await?;
    let device_id = uuid::Uuid::new_v4().to_string();
    let token = random_secret();
    let now_s = format_utc(&now);
    sqlx::query(
        "INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen_at, created_via) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pairing')",
    )
    .bind(&device_id)
    .bind(c.user_id)
    .bind(kind_str(DeviceKind::Mobile))
    .bind(&name)
    .bind(sha256_hex(&token))
    .bind(&now_s)
    .bind(&now_s)
    .execute(&mut *tx)
    .await?;
    mark_redeemed(&mut tx, &c.pairing_id, &device_id).await?;
    tx.commit().await?;
    tracing::info!(pairing = %c.pairing_id, device = %device_id, "pairing redeemed (mobile)");
    Ok(Json(PairingAccess {
        device_id,
        token,
        username: c.username,
        server_time: now_s,
    }))
}

/// `POST /session/pairing`: the PWA gets a session cookie; `deviceId` is reused like in
/// `POST /session`. CSRF is checked by `auth::csrf_guard` (login CSRF, §6.3).
async fn redeem_session(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<SessionPairing>,
) -> ApiResult<Response> {
    let now = state.clock.now();
    check_ip(&state, ip, now)?;
    let name = check_device_name(&body.device_name)?;
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    let c = claim(&state, &mut tx, ip, &body.code, now).await?;
    let (device_id, sid) = open_web_session(
        &mut tx,
        &state,
        c.user_id,
        body.device_id.as_deref(),
        &name,
        "pairing",
        now,
    )
    .await?;
    mark_redeemed(&mut tx, &c.pairing_id, &device_id).await?;
    tx.commit().await?;
    tracing::info!(pairing = %c.pairing_id, device = %device_id, "pairing redeemed (web)");
    Ok(session_response(device_id, &sid, now))
}
