//! `PUT/DELETE /devices/current/push` (PLAN_V3_SYNC §6, §10.5): the native shell registers
//! its push token (`NativePushToken {platform, token}`, Bearer only, kind `mobile`).
//!
//! - one token = one device: a token moves to the device that registers it (reinstall,
//!   new login on the same phone), like Web Push subscriptions;
//! - after storing, the scheduler is woken, so occurrences of the last 24 h without a
//!   `push_log` row reach the new token (dedupe rule §7.4 still applies);
//! - `apns` tokens are accepted by the contract but cannot be delivered (D-55); they are
//!   refused with 400 so the shell does not believe it has push;
//! - the token is never logged.

use axum::extract::State;
use axum::http::StatusCode;
use buddy_core::sync::{DeviceKind, NativePushPlatform, NativePushToken};

use crate::AppState;
use crate::api::ApiJson;
use crate::auth::{Auth, Via};
use crate::error::{ApiResult, AppError};
use crate::push::native::platform_str;
use crate::push::native_fcm::valid_token;

fn require_native(auth: &Auth) -> ApiResult<()> {
    if auth.kind == DeviceKind::Mobile && matches!(auth.via, Via::Bearer) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "the native push token belongs to the native app (kind mobile, Bearer token)",
        ))
    }
}

pub async fn put_token(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(body): ApiJson<NativePushToken>,
) -> ApiResult<StatusCode> {
    require_native(&auth)?;
    if body.platform != NativePushPlatform::Fcm {
        return Err(AppError::bad_request(
            "only platform \"fcm\" (Android) is supported by this server",
        ));
    }
    if !state.push.native.supports(body.platform) {
        return Err(AppError::not_found(
            "native push is not configured on this server",
        ));
    }
    let token = body.token.trim();
    if !valid_token(token) {
        return Err(AppError::bad_request(
            "token must have 1–4096 characters of A–Z, a–z, 0–9, _ - : .",
        ));
    }
    let mut tx = state.db.begin_with(crate::db::BEGIN_WRITE).await?;
    sqlx::query(
        "UPDATE devices SET native_push_token = NULL, native_push_platform = NULL \
         WHERE native_push_token = ? AND id <> ?",
    )
    .bind(token)
    .bind(&auth.device_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE devices SET native_push_platform = ?, native_push_token = ? WHERE id = ?")
        .bind(platform_str(body.platform))
        .bind(token)
        .bind(&auth.device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(device = %auth.device_id, platform = platform_str(body.platform), "native push token stored");
    state.reminders_changed.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_token(State(state): State<AppState>, auth: Auth) -> ApiResult<StatusCode> {
    require_native(&auth)?;
    sqlx::query(
        "UPDATE devices SET native_push_token = NULL, native_push_platform = NULL WHERE id = ?",
    )
    .bind(&auth.device_id)
    .execute(&state.db)
    .await?;
    tracing::info!(device = %auth.device_id, "native push token removed");
    Ok(StatusCode::NO_CONTENT)
}
