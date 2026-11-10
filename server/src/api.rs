//! HTTP handlers of API v1 (PLAN_V3_SYNC §6), mounted below `/api/v1`.

use axum::extract::{FromRequest, FromRequestParts, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use buddy_core::sync::{
    DeviceKind, DeviceLogin, DeviceLoginResponse, Me, MeUpdate, PushRequest, SessionLogin,
    SessionResponse, VapidPublicKey,
};
use buddy_core::zoned::{format_utc, parse_zone};
use chrono::Duration;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::{
    self, Auth, SESSION_DAYS, Via, clear_cookie_header, kind_str, random_secret, set_cookie_header,
    sha256_hex,
};
use crate::error::{ApiResult, AppError};
use crate::sync;

/// Body limit for `/sync/push` (200 notes with TipTap JSON); other endpoints keep axum's
/// 2 MB default.
pub const PUSH_BODY_LIMIT: usize = 16 * 1024 * 1024;
pub const MAX_DEVICE_NAME: usize = 100;
pub const MAX_USERNAME: usize = 64;

/// JSON body extractor whose rejections are `{error, message}`.
#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(AppError))]
pub struct ApiJson<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(AppError))]
pub struct ApiQuery<T>(pub T);

/// Routes of API v1 (without the `/api/v1` prefix).
///
/// `push::router()` (`PUT/DELETE /push/subscription`, `POST /push/test`) is merged next to it
/// in `build_app` (`lib.rs`).
pub fn router(state: AppState) -> Router<AppState> {
    let sync_routes = Router::new()
        .route("/sync/changes", get(sync_changes))
        .route(
            "/sync/push",
            post(sync_push).layer(axum::extract::DefaultBodyLimit::max(PUSH_BODY_LIMIT)),
        )
        .layer(middleware::from_fn_with_state(state, auth::extend_session));
    Router::new()
        .route("/health", get(health))
        .route("/devices", post(device_login))
        .route("/devices/current", axum::routing::delete(device_logout))
        .route("/session", post(session_login).delete(session_logout))
        .route("/me", get(me).put(put_me))
        .route("/push/vapid-public-key", get(vapid_public_key))
        .merge(sync_routes)
}

fn now_s(state: &AppState) -> String {
    format_utc(&state.clock.now())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "serverTime": now_s(&state) }))
}

pub fn check_device_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_DEVICE_NAME
        || name.chars().any(char::is_control)
    {
        return Err(AppError::bad_request(
            "deviceName must have 1–100 characters",
        ));
    }
    Ok(name.to_string())
}

fn check_username(name: &str) -> ApiResult<()> {
    if name.trim().is_empty() || name.len() > MAX_USERNAME {
        return Err(AppError::bad_credentials());
    }
    Ok(())
}

/// Request parts needed for the login brake.
pub struct ClientIp(pub std::net::IpAddr);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, AppError> {
        Ok(Self(auth::request_ip(
            state,
            &parts.extensions,
            &parts.headers,
        )))
    }
}

async fn device_login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<DeviceLogin>,
) -> ApiResult<Json<DeviceLoginResponse>> {
    if body.kind == DeviceKind::Web {
        return Err(AppError::bad_request(
            "kind must be desktop or mobile; the web app uses /session",
        ));
    }
    let name = check_device_name(&body.device_name)?;
    check_username(&body.username)?;
    let user_id = auth::verify_login(&state, ip, &body.username, &body.password).await?;
    let device_id = uuid::Uuid::new_v4().to_string();
    let token = random_secret();
    let mut tx = state.db.begin_with(crate::db::BEGIN_WRITE).await?;
    crate::accounts::quota::check_device_limit(&mut tx, &state.config.quota, user_id).await?;
    sqlx::query(
        "INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&device_id)
    .bind(user_id)
    .bind(kind_str(body.kind))
    .bind(&name)
    .bind(sha256_hex(&token))
    .bind(now_s(&state))
    .bind(now_s(&state))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(device = %device_id, kind = kind_str(body.kind), "device registered");
    Ok(Json(DeviceLoginResponse {
        device_id,
        token,
        server_time: now_s(&state),
    }))
}

/// Revokes a device: no token, no sessions, no push subscription (§7.4 stops sending).
pub async fn revoke_device(db: &crate::db::Db, device_id: &str, now: &str) -> ApiResult<bool> {
    let mut tx = db.begin_with(crate::db::BEGIN_WRITE).await?;
    let r = sqlx::query(
        "UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL, \
         native_push_token = NULL WHERE id = ?",
    )
    .bind(now)
    .bind(device_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE device_id = ?")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM push_subscriptions WHERE device_id = ?")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(r.rows_affected() == 1)
}

async fn device_logout(State(state): State<AppState>, auth: Auth) -> ApiResult<StatusCode> {
    if auth.via != Via::Bearer {
        return Err(AppError::bad_request(
            "the web app signs out with DELETE /session",
        ));
    }
    revoke_device(&state.db, &auth.device_id, &now_s(&state)).await?;
    tracing::info!(device = %auth.device_id, "device signed out");
    Ok(StatusCode::NO_CONTENT)
}

async fn session_login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<SessionLogin>,
) -> ApiResult<Response> {
    let name = check_device_name(&body.device_name)?;
    check_username(&body.username)?;
    let user_id = auth::verify_login(&state, ip, &body.username, &body.password).await?;
    let now = state.clock.now();
    let now_str = format_utc(&now);
    let mut tx = state.db.begin_with(crate::db::BEGIN_WRITE).await?;
    // Reuse the PWA's device if it is a live web device of this user (§6).
    let reuse: Option<String> = match body.device_id.as_deref() {
        Some(id) => sqlx::query_scalar(
            "SELECT id FROM devices WHERE id = ? AND user_id = ? AND kind = 'web' AND revoked_at IS NULL",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?,
        None => None,
    };
    let device_id = match reuse {
        Some(id) => {
            sqlx::query("UPDATE devices SET name = ?, last_seen_at = ? WHERE id = ?")
                .bind(&name)
                .bind(&now_str)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            // A login always issues a new session id (session fixation).
            sqlx::query("DELETE FROM sessions WHERE device_id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            crate::accounts::quota::check_device_limit(&mut tx, &state.config.quota, user_id)
                .await?;
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO devices (id, user_id, kind, name, created_at, last_seen_at) \
                 VALUES (?, ?, 'web', ?, ?, ?)",
            )
            .bind(&id)
            .bind(user_id)
            .bind(&name)
            .bind(&now_str)
            .bind(&now_str)
            .execute(&mut *tx)
            .await?;
            id
        }
    };
    let sid = random_secret();
    sqlx::query(
        "INSERT INTO sessions (id_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(sha256_hex(&sid))
    .bind(user_id)
    .bind(&device_id)
    .bind(&now_str)
    .bind(format_utc(&(now + Duration::days(SESSION_DAYS))))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(device = %device_id, "web session started");
    let mut res = Json(SessionResponse {
        device_id,
        server_time: now_str,
    })
    .into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, set_cookie_header(&sid));
    Ok(res)
}

async fn session_logout(State(state): State<AppState>, auth: Auth) -> ApiResult<Response> {
    if !matches!(auth.via, Via::Session { .. }) {
        return Err(AppError::bad_request(
            "devices sign out with DELETE /devices/current",
        ));
    }
    revoke_device(&state.db, &auth.device_id, &now_s(&state)).await?;
    tracing::info!(device = %auth.device_id, "web session ended");
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, clear_cookie_header());
    Ok(res)
}

async fn me_for(state: &AppState, auth: &Auth) -> ApiResult<Me> {
    let (username, time_zone): (String, String) =
        sqlx::query_as("SELECT username, time_zone FROM users WHERE id = ?")
            .bind(auth.user_id)
            .fetch_one(&state.db)
            .await?;
    Ok(Me {
        username,
        time_zone,
        device_id: auth.device_id.clone(),
        server_time: now_s(state),
    })
}

async fn me(State(state): State<AppState>, auth: Auth) -> ApiResult<Json<Me>> {
    Ok(Json(me_for(&state, &auth).await?))
}

async fn put_me(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(body): ApiJson<MeUpdate>,
) -> ApiResult<Json<Me>> {
    let zone = body.time_zone.trim();
    if parse_zone(zone).is_none() {
        return Err(AppError::bad_request("unknown timeZone"));
    }
    sqlx::query("UPDATE users SET time_zone = ? WHERE id = ?")
        .bind(zone)
        .bind(auth.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(me_for(&state, &auth).await?))
}

#[derive(Deserialize)]
pub struct ChangesQuery {
    #[serde(default)]
    since: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

async fn sync_changes(
    State(state): State<AppState>,
    auth: Auth,
    ApiQuery(q): ApiQuery<ChangesQuery>,
) -> ApiResult<Json<buddy_core::sync::SyncChanges>> {
    let out = sync::changes(
        &state.db,
        state.clock.now(),
        auth.user_id,
        &auth.device_id,
        q.since.unwrap_or(0),
        sync::clamp_limit(q.limit),
    )
    .await?;
    Ok(Json(out))
}

async fn sync_push(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(body): ApiJson<PushRequest>,
) -> ApiResult<Json<buddy_core::sync::PushResponse>> {
    let out = sync::push(
        &state.db,
        state.clock.now(),
        auth.user_id,
        &auth.device_id,
        auth.kind,
        &state.config.quota,
        body,
    )
    .await?;
    if out.reminders_changed {
        // Wakes the phase-D scheduler (a stored permit if it is not waiting right now).
        state.reminders_changed.notify_one();
    }
    Ok(Json(out.response))
}

async fn vapid_public_key(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<Json<VapidPublicKey>> {
    let v = state
        .vapid
        .as_ref()
        .ok_or_else(|| AppError::not_found("web push is not configured on this server"))?;
    Ok(Json(VapidPublicKey {
        key: v.public_key().to_string(),
    }))
}

/// JSON 404 for unknown API paths (never the SPA's index.html).
pub async fn api_not_found() -> AppError {
    AppError::not_found("unknown API endpoint")
}
