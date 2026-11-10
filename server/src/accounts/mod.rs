//! Accounts (PLAN_V4 §4–§6, §8): public `GET /info`, registration with proof-of-work,
//! recovery, the signed-in `/me/*` endpoints and quotas. Messages come only from
//! `buddy_core::accounts`; codes (recovery, invites) only from its Crockford helpers.
//!
//! Secrets (passwords, tokens, recovery and invite codes) never appear in paths, logs or
//! error messages; the database keeps only hashes (Argon2id for passwords, SHA-256 for
//! everything with high entropy).

pub mod me;
pub mod quota;
pub mod register;

use std::collections::HashSet;
use std::sync::LazyLock;

use axum::extract::State;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use buddy_core::accounts::{
    API_LEVEL, DeviceCreatedVia, FEATURES, PASSWORD_MIN_CHARS, ServerInfo, password_acceptable,
    recovery_code_from_bytes, recovery_code_hash,
};
use buddy_core::zoned::format_utc;
use rand::Rng;
use sqlx::SqliteConnection;

use crate::AppState;
use crate::error::ApiResult;

pub use register::ChallengeStore;

/// The 10 000 most common passwords (SecLists, MIT – see `README.md` next to the file).
const COMMON_PASSWORDS: &str = include_str!("common-passwords.txt");

static COMMON: LazyLock<HashSet<String>> = LazyLock::new(|| {
    COMMON_PASSWORDS
        .lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect()
});

/// In the common-password list (case-insensitive, D-88).
pub fn is_common_password(password: &str) -> bool {
    COMMON.contains(&password.to_lowercase())
}

/// Rules for a new password (registration, recovery, change): length, not the username,
/// not in the common list. No composition rules (NIST SP 800-63B §3.1.1.2).
pub fn new_password_ok(password: &str, username: &str) -> bool {
    password_acceptable(password, username) && !is_common_password(password)
}

/// A fresh 24-character code (120 bits from the CSPRNG) and its SHA-256: recovery codes
/// and invite codes use the same format.
pub fn new_code() -> (String, String) {
    let mut bytes = [0u8; 15];
    rand::rng().fill_bytes(&mut bytes);
    let code = recovery_code_from_bytes(&bytes);
    let hash = recovery_code_hash(&code);
    (code, hash)
}

pub fn created_via_str(v: DeviceCreatedVia) -> &'static str {
    match v {
        DeviceCreatedVia::Password => "password",
        DeviceCreatedVia::Register => "register",
        DeviceCreatedVia::Pairing => "pairing",
        DeviceCreatedVia::Recovery => "recovery",
    }
}

pub fn parse_created_via(s: &str) -> DeviceCreatedVia {
    match s {
        "register" => DeviceCreatedVia::Register,
        "pairing" => DeviceCreatedVia::Pairing,
        "recovery" => DeviceCreatedVia::Recovery,
        _ => DeviceCreatedVia::Password,
    }
}

/// Signs out every device of `user` except `keep` (tokens, sessions, push subscriptions)
/// and cancels open pairing codes of those devices. Runs inside the caller's transaction.
pub async fn revoke_user_devices(
    c: &mut SqliteConnection,
    user: i64,
    keep: Option<&str>,
    now: &str,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND device_id IS NOT ?")
        .bind(user)
        .bind(keep)
        .execute(&mut *c)
        .await?;
    sqlx::query(
        "DELETE FROM push_subscriptions WHERE device_id IN \
         (SELECT id FROM devices WHERE user_id = ? AND id IS NOT ?)",
    )
    .bind(user)
    .bind(keep)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        "UPDATE devices SET revoked_at = ?, token_hash = NULL, native_push_token = NULL \
         WHERE user_id = ? AND id IS NOT ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(user)
    .bind(keep)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        "UPDATE pairings SET cancelled_at = ? WHERE user_id = ? AND created_by IS NOT ? \
         AND redeemed_at IS NULL AND cancelled_at IS NULL",
    )
    .bind(now)
    .bind(user)
    .bind(keep)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Routes of the account feature (without the `/api/v1` prefix), merged in `build_app`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/accounts/challenge", post(register::challenge))
        .route("/accounts", post(register::create))
        .route("/accounts/recover", post(register::recover))
        .route("/me/account", get(me::account))
        .route("/me/devices", get(me::devices))
        .route("/me/devices/{id}/revoke", post(me::revoke))
        .route("/me/password", put(me::change_password))
        .route("/me/recovery-code", post(me::recovery_code))
        .route("/me/export", get(me::export))
        .route("/me/delete", post(me::delete))
}

/// `GET /info` (public, D-100): what this server offers; clients detect a v3 server by 404.
async fn info(State(state): State<AppState>) -> Json<ServerInfo> {
    let c = &state.config;
    Json(ServerInfo {
        server_time: format_utc(&state.clock.now()),
        version: env!("CARGO_PKG_VERSION").into(),
        api_level: API_LEVEL,
        registration: c.registration,
        features: FEATURES.iter().map(|f| (*f).to_string()).collect(),
        password_min_chars: PASSWORD_MIN_CHARS as u32,
        legal: c.legal.clone(),
        operator: c.operator_name.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buddy_core::accounts::normalize_recovery_code;

    #[test]
    fn common_password_list() {
        // SecLists 10k-most-common, commit 913b327 (D-109)
        assert_eq!(COMMON_PASSWORDS.lines().count(), 10_001);
        assert!(is_common_password("password"));
        assert!(is_common_password("Unbelievable"), "case-insensitive");
        assert!(!new_password_ok("unbelievable", "anna"));
        assert!(!new_password_ok("anna.example", "Anna.Example"));
        assert!(!new_password_ok("short", "anna"));
        assert!(new_password_ok("correct horse battery", "anna"));
    }

    #[test]
    fn codes_are_random_and_hashed() {
        let (a, ha) = new_code();
        let (b, _) = new_code();
        assert_ne!(a, b);
        assert_eq!(a.len(), 24);
        assert_eq!(normalize_recovery_code(&a).as_deref(), Some(a.as_str()));
        assert_eq!(ha, recovery_code_hash(&a));
        assert_ne!(ha, a);
    }

    #[test]
    fn created_via_round_trip() {
        for v in [
            DeviceCreatedVia::Password,
            DeviceCreatedVia::Register,
            DeviceCreatedVia::Pairing,
            DeviceCreatedVia::Recovery,
        ] {
            assert_eq!(parse_created_via(created_via_str(v)), v);
        }
    }
}
