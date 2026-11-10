//! Signed-in account endpoints (PLAN_V4 §5.2, D-89, D-91–D-93). Bearer and cookie alike;
//! cookie requests pass the CSRF guard. Only cookie requests ever get a `Set-Cookie`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use buddy_core::accounts::{
    AccountDelete, AccountExport, AccountInfo, DeviceInfo, DeviceList, DeviceRevoke, EXPORT_FORMAT,
    ExportAccount, ExportDevice, PasswordChange, RecoveryCodeRequest, RecoveryCodeResponse,
    RevisionExport, RevisionReason,
};
use buddy_core::sync::{DeviceKind, error_codes as codes};
use buddy_core::zoned::format_utc;
use chrono::Duration;
use sqlx::SqliteConnection;

use super::register::password_weak;
use super::{new_code, new_password_ok, parse_created_via, quota, revoke_user_devices};
use crate::AppState;
use crate::api::{ApiJson, ClientIp, revoke_device};
use crate::auth::password::hash_password;
use crate::auth::{Auth, Via, argon2, clear_cookie_header, confirm_password, parse_kind};
use crate::db::BEGIN_WRITE;
use crate::error::{ApiResult, AppError};
use crate::sync::{load_order, note_from_row, reminder_from_row};

/// Without the current password only devices this old may set a new one (D-89).
pub const PASSWORD_RESET_DEVICE_AGE_HOURS: i64 = 24;

fn password_required() -> AppError {
    AppError::new(
        StatusCode::FORBIDDEN,
        codes::PASSWORD_REQUIRED,
        "this action needs the account password",
    )
}

/// Live devices of an account, oldest first (`GET /me/devices`, export).
pub async fn list_devices(c: &mut SqliteConnection, user: i64) -> ApiResult<Vec<ExportDevice>> {
    type Row = (String, String, String, String, Option<String>, String, bool);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT d.id, d.kind, d.name, d.created_at, d.last_seen_at, d.created_via, \
             (d.native_push_token IS NOT NULL OR EXISTS \
              (SELECT 1 FROM push_subscriptions p WHERE p.device_id = d.id)) \
             FROM devices d WHERE d.user_id = ? AND d.revoked_at IS NULL \
             ORDER BY d.created_at, d.id",
    )
    .bind(user)
    .fetch_all(&mut *c)
    .await?;
    rows.into_iter()
        .map(|(id, kind, name, created_at, last_seen_at, via, push)| {
            Ok(ExportDevice {
                id,
                kind: parse_kind(&kind).ok_or_else(AppError::internal)?,
                name,
                created_at,
                last_seen_at,
                created_via: parse_created_via(&via),
                push,
            })
        })
        .collect()
}

/// `GET /me/account`.
pub async fn account(State(state): State<AppState>, auth: Auth) -> ApiResult<Json<AccountInfo>> {
    let mut c = state.db.acquire().await?;
    let (username, created_at, time_zone, content_format, recovery): (
        String,
        String,
        String,
        i64,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT username, created_at, time_zone, content_format, recovery_created_at \
         FROM users WHERE id = ?",
    )
    .bind(auth.user_id)
    .fetch_one(&mut *c)
    .await?;
    let usage = quota::measure(&mut c, auth.user_id).await?.usage();
    let quota = quota::effective(&mut c, &state.config.quota, auth.user_id).await?;
    Ok(Json(AccountInfo {
        username,
        created_at,
        time_zone,
        content_format: u32::try_from(content_format).unwrap_or(u32::MAX),
        usage,
        quota,
        recovery_code_created_at: recovery,
        server_time: format_utc(&state.clock.now()),
    }))
}

/// `GET /me/devices`.
pub async fn devices(State(state): State<AppState>, auth: Auth) -> ApiResult<Json<DeviceList>> {
    let mut c = state.db.acquire().await?;
    let devices = list_devices(&mut c, auth.user_id)
        .await?
        .into_iter()
        .map(|d| DeviceInfo {
            current: d.id == auth.device_id,
            id: d.id,
            kind: d.kind,
            name: d.name,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
            created_via: d.created_via,
            push: d.push,
        })
        .collect();
    Ok(Json(DeviceList {
        devices,
        server_time: format_utc(&state.clock.now()),
    }))
}

fn no_content(auth: &Auth, clear_cookie: bool) -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    if clear_cookie && matches!(auth.via, Via::Session { .. }) {
        res.headers_mut()
            .insert(header::SET_COOKIE, clear_cookie_header());
    }
    res
}

/// `POST /me/devices/{id}/revoke`: the own or a younger device without password, an older
/// one only with the password (D-91, S11).
pub async fn revoke(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    auth: Auth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DeviceRevoke>,
) -> ApiResult<Response> {
    let target: Option<String> = sqlx::query_scalar(
        "SELECT created_at FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(&id)
    .bind(auth.user_id)
    .fetch_optional(&state.db)
    .await?;
    let target_created = target.ok_or_else(|| AppError::not_found("no such device"))?;
    let own = id == auth.device_id;
    if !own {
        let own_created: String = sqlx::query_scalar("SELECT created_at FROM devices WHERE id = ?")
            .bind(&auth.device_id)
            .fetch_one(&state.db)
            .await?;
        // fixed-width UTC stamps written by the server: text order = time order
        if target_created <= own_created {
            match body.password.as_deref().filter(|p| !p.is_empty()) {
                None => return Err(password_required()),
                Some(pw) => confirm_password(&state, ip, auth.user_id, pw).await?,
            }
        }
    }
    revoke_device(&state.db, &id, &format_utc(&state.clock.now())).await?;
    tracing::info!(device = %id, by = %auth.device_id, "device revoked by the account");
    Ok(no_content(&auth, own))
}

/// `PUT /me/password` (D-89).
pub async fn change_password(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    auth: Auth,
    ApiJson(body): ApiJson<PasswordChange>,
) -> ApiResult<StatusCode> {
    let (username, created_at): (String, String) = sqlx::query_as(
        "SELECT u.username, d.created_at FROM users u JOIN devices d ON d.user_id = u.id \
         WHERE u.id = ? AND d.id = ?",
    )
    .bind(auth.user_id)
    .bind(&auth.device_id)
    .fetch_one(&state.db)
    .await?;
    if !new_password_ok(&body.new_password, &username) {
        return Err(password_weak());
    }
    let now = state.clock.now();
    let sign_out_others = match body.current_password.as_deref().filter(|p| !p.is_empty()) {
        Some(pw) => {
            confirm_password(&state, ip, auth.user_id, pw).await?;
            body.sign_out_others
        }
        None => {
            let old_enough =
                created_at <= format_utc(&(now - Duration::hours(PASSWORD_RESET_DEVICE_AGE_HOURS)));
            let kind_ok = matches!(auth.kind, DeviceKind::Desktop | DeviceKind::Mobile);
            if !(old_enough && kind_ok) {
                return Err(password_required());
            }
            true
        }
    };
    let pw = body.new_password.clone();
    let hash = argon2(&state, move || hash_password(&pw)).await??;
    let now_s = format_utc(&now);
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    sqlx::query("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?")
        .bind(hash)
        .bind(&now_s)
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    if sign_out_others {
        revoke_user_devices(&mut tx, auth.user_id, Some(&auth.device_id), &now_s).await?;
    }
    tx.commit().await?;
    tracing::info!(user = auth.user_id, sign_out_others, "password changed");
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /me/recovery-code`: needs the password (a device alone must not replace the
/// trust anchor, D-89); the old code stops working.
pub async fn recovery_code(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    auth: Auth,
    ApiJson(body): ApiJson<RecoveryCodeRequest>,
) -> ApiResult<Json<RecoveryCodeResponse>> {
    confirm_password(&state, ip, auth.user_id, &body.password).await?;
    let (code, hash) = new_code();
    let now_s = format_utc(&state.clock.now());
    sqlx::query("UPDATE users SET recovery_hash = ?, recovery_created_at = ? WHERE id = ?")
        .bind(hash)
        .bind(&now_s)
        .bind(auth.user_id)
        .execute(&state.db)
        .await?;
    tracing::info!(user = auth.user_id, "new recovery code");
    Ok(Json(RecoveryCodeResponse {
        recovery_code: code,
        server_time: now_s,
    }))
}

/// File name without anything a header could misread (old CLI names may contain `@`).
fn export_file_name(username: &str, date: &str) -> String {
    let safe: String = username
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("display-buddy-export-{safe}-{date}.json")
}

/// `GET /me/export` (PLAN_V4 §5.4, D-93): no hashes, tokens or push endpoints; 1/min.
pub async fn export(State(state): State<AppState>, auth: Auth) -> ApiResult<Response> {
    let now = state.clock.now();
    state
        .limits
        .exports
        .acquire(&auth.user_id, now)
        .map_err(|s| AppError::rate_limited(s, "one export per minute"))?;
    let user = auth.user_id;
    // one read transaction: a consistent snapshot
    let mut tx = state.db.begin().await?;
    let (username, created_at, time_zone, content_format): (String, String, String, i64) =
        sqlx::query_as(
            "SELECT username, created_at, time_zone, content_format FROM users WHERE id = ?",
        )
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    let devices = list_devices(&mut tx, user).await?;
    type Row = (String, Option<String>, String, String, bool, i64);
    let notes: Vec<Row> = sqlx::query_as(
        "SELECT id, payload, updated_at, updated_by, deleted, seq FROM notes \
         WHERE user_id = ? AND deleted = 0 ORDER BY seq",
    )
    .bind(user)
    .fetch_all(&mut *tx)
    .await?;
    let reminders: Vec<Row> = sqlx::query_as(
        "SELECT note_id, payload, updated_at, updated_by, deleted, seq FROM reminders \
         WHERE user_id = ? AND deleted = 0 ORDER BY seq",
    )
    .bind(user)
    .fetch_all(&mut *tx)
    .await?;
    let order = load_order(&mut tx, user).await?.map(|(o, _)| o);
    let revisions: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT note_id, reason, stored_at, payload FROM note_revisions WHERE user_id = ? ORDER BY id",
    )
    .bind(user)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let body = AccountExport {
        format: EXPORT_FORMAT.into(),
        exported_at: format_utc(&now),
        account: ExportAccount {
            username: username.clone(),
            created_at,
            time_zone,
            content_format: u32::try_from(content_format).unwrap_or(u32::MAX),
        },
        devices,
        notes: notes
            .into_iter()
            .map(|(id, p, a, b, d, s)| note_from_row(&id, (p, a, b, d, s)))
            .collect(),
        reminders: reminders
            .into_iter()
            .map(|(id, p, a, b, d, s)| reminder_from_row(&id, (p, a, b, d, s)))
            .collect(),
        order,
        revisions: revisions
            .into_iter()
            .map(|(note_id, reason, stored_at, payload)| RevisionExport {
                note_id,
                reason: if reason == "rejected" {
                    RevisionReason::Rejected
                } else {
                    RevisionReason::Replaced
                },
                stored_at,
                note: payload.and_then(|p| serde_json::from_str(&p).ok()),
            })
            .collect(),
    };
    let name = export_file_name(&username, &now.format("%Y-%m-%d").to_string());
    let mut res = Json(body).into_response();
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .map_err(|e| anyhow::anyhow!("content-disposition: {e}"))?;
    res.headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    tracing::info!(user, "account exported");
    Ok(res)
}

/// `POST /me/delete` (D-92): password + username, then `DELETE FROM users` (cascade).
pub async fn delete(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    auth: Auth,
    ApiJson(body): ApiJson<AccountDelete>,
) -> ApiResult<Response> {
    let username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = ?")
        .bind(auth.user_id)
        .fetch_one(&state.db)
        .await?;
    if !body.confirm_username.trim().eq_ignore_ascii_case(&username) {
        return Err(AppError::bad_request(
            "confirmUsername does not match the account",
        ));
    }
    confirm_password(&state, ip, auth.user_id, &body.password).await?;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(auth.user_id)
        .execute(&state.db)
        .await?;
    tracing::info!(user = auth.user_id, "account deleted");
    Ok(no_content(&auth, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names() {
        assert_eq!(
            export_file_name("anna", "2026-11-10"),
            "display-buddy-export-anna-2026-11-10.json"
        );
        assert_eq!(
            export_file_name("a\"b;c@x", "2026-11-10"),
            "display-buddy-export-a_b_c@x-2026-11-10.json"
        );
    }
}
