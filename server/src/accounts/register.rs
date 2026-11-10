//! Registration (PLAN_V4 §6.1, D-86/D-87) and recovery (§6.4, D-89).
//!
//! `POST /accounts` checks in this order: mode → IP limit → challenge (valid, unused,
//! solved; used up afterwards) → invite → username → password → global daily limit. Then
//! one transaction writes `users`, `devices` and `invites`.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_core::accounts::{
    AccountAccess, AccountCreate, AccountRecover, RegistrationChallenge, RegistrationMode,
    normalize_recovery_code, recovery_code_hash, validate_new_username,
};
use buddy_core::pow;
use buddy_core::sync::error_codes as codes;
use buddy_core::zoned::{format_utc, parse_zone};
use chrono::{DateTime, Duration, Utc};
use rand::Rng;

use super::{new_code, new_password_ok, revoke_user_devices};
use crate::AppState;
use crate::api::{ApiJson, ClientIp, MAX_USERNAME, check_device_name};
use crate::auth::password::{hash_password, verify_dummy};
use crate::auth::{argon2, brake_check, brake_fail, random_secret, sha256_hex};
use crate::db::BEGIN_WRITE;
use crate::error::{ApiResult, AppError};

/// Open challenges kept in memory at most (S14); the oldest is dropped first.
pub const MAX_CHALLENGES: usize = 10_000;
pub const CHALLENGE_MINUTES: i64 = 10;

#[derive(Debug, Clone)]
struct OpenChallenge {
    challenge: String,
    bits: u32,
    expires_at: DateTime<Utc>,
}

/// Proof-of-work challenges in memory: 10 min valid, single use, at most 10 000.
#[derive(Debug, Default)]
pub struct ChallengeStore {
    map: Mutex<HashMap<String, OpenChallenge>>,
}

impl ChallengeStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new challenge (16 bytes from the CSPRNG). Returns (id, challenge, expiresAt).
    pub fn issue(&self, now: DateTime<Utc>, bits: u32) -> (String, String, DateTime<Utc>) {
        let mut bytes = [0u8; pow::CHALLENGE_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        let challenge = URL_SAFE_NO_PAD.encode(bytes);
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = now + Duration::minutes(CHALLENGE_MINUTES);
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_CHALLENGES {
            map.retain(|_, c| c.expires_at > now);
        }
        while map.len() >= MAX_CHALLENGES {
            // shortcut: O(n) scan, only when 10 000 are open (IP limits make that rare)
            let Some(oldest) = map
                .iter()
                .min_by_key(|(_, c)| c.expires_at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(
            id.clone(),
            OpenChallenge {
                challenge: challenge.clone(),
                bits,
                expires_at,
            },
        );
        (id, challenge, expires_at)
    }

    /// Removes the challenge (single use, also when the nonce turns out wrong) and returns
    /// (challenge, bits) if it was still valid.
    pub fn take(&self, id: &str, now: DateTime<Utc>) -> Option<(String, u32)> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(id)
            .filter(|c| c.expires_at > now)
            .map(|c| (c.challenge, c.bits))
    }

    pub fn prune(&self, now: DateTime<Utc>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| c.expires_at > now);
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn closed() -> AppError {
    AppError::new(
        StatusCode::FORBIDDEN,
        codes::REGISTRATION_CLOSED,
        "registration is closed on this server",
    )
}

fn limited(secs: u64) -> AppError {
    AppError::rate_limited(secs, "too many registrations, try again later")
}

fn invite_invalid() -> AppError {
    AppError::new(
        StatusCode::FORBIDDEN,
        codes::INVITE_INVALID,
        "invite code invalid, used or expired",
    )
}

fn username_taken() -> AppError {
    AppError::new(
        StatusCode::CONFLICT,
        codes::USERNAME_TAKEN,
        "this username is taken",
    )
}

pub fn password_weak() -> AppError {
    AppError::new(
        StatusCode::BAD_REQUEST,
        codes::PASSWORD_WEAK,
        "password too short, too common or equal to the username",
    )
}

/// `POST /accounts/challenge` (body `{}`): 10 per hour and IP.
pub async fn challenge(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
) -> ApiResult<Json<RegistrationChallenge>> {
    if state.config.registration == RegistrationMode::Closed {
        return Err(closed());
    }
    let now = state.clock.now();
    state.limits.challenges.acquire(&ip, now).map_err(limited)?;
    let bits = state.config.registration_pow_bits;
    let (id, challenge, expires_at) = state.challenges.issue(now, bits);
    Ok(Json(RegistrationChallenge {
        id,
        challenge,
        bits,
        expires_at: format_utc(&expires_at),
        server_time: format_utc(&now),
    }))
}

/// `POST /accounts`: account + desktop device in one transaction (D-86).
pub async fn create(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<AccountCreate>,
) -> ApiResult<Json<AccountAccess>> {
    let now = state.clock.now();
    let now_s = format_utc(&now);
    let mode = state.config.registration;
    // 1. mode
    if mode == RegistrationMode::Closed {
        return Err(closed());
    }
    let device_name = check_device_name(&body.device_name)?;
    let zone = match body.time_zone.as_deref().map(str::trim) {
        None | Some("") => "UTC".to_string(),
        Some(z) if parse_zone(z).is_some() => z.to_string(),
        Some(_) => return Err(AppError::bad_request("unknown timeZone")),
    };
    // 2. IP limit (counts successful registrations)
    let l = &state.limits;
    l.registrations_hour.check(&ip, now).map_err(limited)?;
    l.registrations_day.check(&ip, now).map_err(limited)?;
    // 3. challenge: valid, unused, solved – used up in any case
    let solved = state
        .challenges
        .take(&body.challenge_id, now)
        .is_some_and(|(c, bits)| pow::verify(&c, bits, body.nonce));
    if !solved {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            codes::CHALLENGE_INVALID,
            "challenge unknown, expired, used or not solved",
        ));
    }
    // 4. invite
    let invite_hash = if mode == RegistrationMode::Invite {
        let code = body
            .invite_code
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::FORBIDDEN,
                    codes::INVITE_REQUIRED,
                    "this server needs an invite code",
                )
            })?;
        let hash = normalize_recovery_code(code)
            .map(|c| recovery_code_hash(&c))
            .ok_or_else(invite_invalid)?;
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM invites WHERE code_hash = ? AND used_at IS NULL \
             AND (expires_at IS NULL OR expires_at > ?))",
        )
        .bind(&hash)
        .bind(&now_s)
        .fetch_one(&state.db)
        .await?;
        if !valid {
            return Err(invite_invalid());
        }
        Some(hash)
    } else {
        None
    };
    // 5. username
    let username = validate_new_username(body.username.trim()).ok_or_else(|| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            codes::USERNAME_INVALID,
            "username: 3–32 characters a–z, 0–9, . _ - (not reserved)",
        )
    })?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = ?)")
        .bind(&username)
        .fetch_one(&state.db)
        .await?;
    if taken {
        return Err(username_taken());
    }
    // 6. password
    if !new_password_ok(&body.password, &username) {
        return Err(password_weak());
    }
    // 7. global daily limit
    l.registrations_global.check(&(), now).map_err(limited)?;

    let pw = body.password.clone();
    let hash = argon2(&state, move || hash_password(&pw)).await??;
    let (recovery, recovery_hash) = new_code();
    let token = random_secret();
    let device_id = uuid::Uuid::new_v4().to_string();
    let via = if invite_hash.is_some() {
        "invite"
    } else {
        "register"
    };
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, time_zone, created_at, created_via, \
         recovery_hash, recovery_created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&username)
    .bind(hash)
    .bind(&zone)
    .bind(&now_s)
    .bind(via)
    .bind(&recovery_hash)
    .bind(&now_s)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => username_taken(),
        e => e.into(),
    })?;
    sqlx::query(
        "INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen_at, created_via) \
         VALUES (?, ?, 'desktop', ?, ?, ?, ?, 'register')",
    )
    .bind(&device_id)
    .bind(user_id)
    .bind(&device_name)
    .bind(sha256_hex(&token))
    .bind(&now_s)
    .bind(&now_s)
    .execute(&mut *tx)
    .await?;
    if let Some(h) = &invite_hash {
        let used = sqlx::query(
            "UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL \
             AND (expires_at IS NULL OR expires_at > ?)",
        )
        .bind(&now_s)
        .bind(user_id)
        .bind(h)
        .bind(&now_s)
        .execute(&mut *tx)
        .await?;
        if used.rows_affected() != 1 {
            // used by a parallel registration in the meantime; dropping tx rolls back
            return Err(invite_invalid());
        }
    }
    tx.commit().await?;
    l.registrations_hour.hit(&ip, now);
    l.registrations_day.hit(&ip, now);
    l.registrations_global.hit(&(), now);
    tracing::info!(user = user_id, device = %device_id, via, "account registered");
    Ok(Json(AccountAccess {
        device_id,
        token,
        recovery_code: recovery,
        server_time: now_s,
    }))
}

fn recovery_failed() -> AppError {
    AppError::new(
        StatusCode::UNAUTHORIZED,
        codes::UNAUTHORIZED,
        "wrong username or recovery code",
    )
}

/// `POST /accounts/recover`: same brake as the login, one error for every failure, the
/// same Argon2 work whether the account exists or not (S2, OWASP Forgot Password).
pub async fn recover(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<AccountRecover>,
) -> ApiResult<Json<AccountAccess>> {
    let username = body.username.trim().to_string();
    if username.is_empty() || username.len() > MAX_USERNAME {
        return Err(recovery_failed());
    }
    brake_check(&state, ip, &username)?;
    let device_name = check_device_name(&body.device_name)?;
    if !new_password_ok(&body.new_password, &username) {
        return Err(password_weak());
    }
    let row: Option<(i64, Option<String>, bool)> = sqlx::query_as(
        "SELECT id, recovery_hash, disabled_at IS NOT NULL FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    let given = normalize_recovery_code(&body.recovery_code).map(|c| recovery_code_hash(&c));
    let matched = match (row, given) {
        (Some((id, Some(stored), disabled)), Some(given)) if stored == given => {
            Some((id, disabled, stored))
        }
        _ => None,
    };
    let pw = body.new_password.clone();
    let found = matched.is_some();
    let new_hash = argon2(&state, move || {
        if found {
            hash_password(&pw).map(Some)
        } else {
            verify_dummy(&pw);
            Ok(None)
        }
    })
    .await??;
    let (Some((user_id, disabled, old_hash)), Some(new_hash)) = (matched, new_hash) else {
        brake_fail(&state, ip, &username);
        tracing::info!(%ip, "failed account recovery");
        return Err(recovery_failed());
    };
    state.throttle.success(ip, &username);
    if disabled {
        return Err(AppError::account_disabled());
    }
    let now = state.clock.now();
    let now_s = format_utc(&now);
    let (recovery, recovery_hash) = new_code();
    let token = random_secret();
    let device_id = uuid::Uuid::new_v4().to_string();
    let mut tx = state.db.begin_with(BEGIN_WRITE).await?;
    // `recovery_hash = old` makes the code single-use also against a parallel request.
    let r = sqlx::query(
        "UPDATE users SET password_hash = ?, password_changed_at = ?, recovery_hash = ?, \
         recovery_created_at = ? WHERE id = ? AND recovery_hash = ?",
    )
    .bind(new_hash)
    .bind(&now_s)
    .bind(&recovery_hash)
    .bind(&now_s)
    .bind(user_id)
    .bind(&old_hash)
    .execute(&mut *tx)
    .await?;
    if r.rows_affected() != 1 {
        return Err(recovery_failed());
    }
    revoke_user_devices(&mut tx, user_id, None, &now_s).await?;
    sqlx::query(
        "INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen_at, created_via) \
         VALUES (?, ?, 'desktop', ?, ?, ?, ?, 'recovery')",
    )
    .bind(&device_id)
    .bind(user_id)
    .bind(&device_name)
    .bind(sha256_hex(&token))
    .bind(&now_s)
    .bind(&now_s)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(user = user_id, device = %device_id, "account recovered, all other devices signed out");
    Ok(Json(AccountAccess {
        device_id,
        token,
        recovery_code: recovery,
        server_time: now_s,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        buddy_core::zoned::parse_instant(s).unwrap()
    }

    #[test]
    fn challenges_are_single_use_and_expire() {
        let s = ChallengeStore::new();
        let t0 = t("2026-11-10T10:00:00Z");
        let (id, ch, exp) = s.issue(t0, 8);
        assert_eq!(exp, t0 + Duration::minutes(10));
        assert_eq!(pow::decode_challenge(&ch).unwrap().len(), 16);
        assert_eq!(s.take(&id, t0), Some((ch, 8)));
        assert_eq!(s.take(&id, t0), None, "single use");
        let (id, _, _) = s.issue(t0, 8);
        assert_eq!(s.take(&id, t0 + Duration::minutes(10)), None, "expired");
        s.issue(t0, 8);
        s.prune(t0 + Duration::minutes(11));
        assert!(s.is_empty());
    }

    #[test]
    fn store_is_bounded() {
        let s = ChallengeStore::new();
        let t0 = t("2026-11-10T10:00:00Z");
        let (first, _, _) = s.issue(t0, 8);
        for i in 1..=MAX_CHALLENGES {
            s.issue(t0 + Duration::milliseconds(i as i64), 8);
        }
        assert_eq!(s.len(), MAX_CHALLENGES);
        assert_eq!(s.take(&first, t0), None, "oldest dropped");
    }
}
