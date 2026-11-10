//! Quotas (PLAN_V4 §4, §5.2, D-94): measured inside the write transaction, no extra
//! columns. Effective limit = `users.quota_*` (set by the CLI) or the server default
//! (`BUDDY_QUOTA_*`); `None` = unlimited.
//!
//! Push rule (net rule): a push is refused (`413 quota_exceeded`, transaction rolled back)
//! only if it *increases* the live data and the account is over its limit afterwards.
//! "Increases" looks at live notes and reminders, not at revisions: a shortened note also
//! stores the old copy as a revision (30 days), and shortening must always go through.

use axum::http::StatusCode;
use buddy_core::accounts::{Quota, Usage};
use buddy_core::sync::error_codes as codes;
use sqlx::SqliteConnection;

use crate::error::{ApiResult, AppError};

/// Current occupancy of an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Measure {
    /// Bytes of notes + reminders (what a push can grow).
    pub live_bytes: u64,
    /// `live_bytes` + revisions (shown as usage, compared with the byte quota).
    pub bytes: u64,
    /// Live notes.
    pub notes: u64,
    /// Devices that are not revoked.
    pub devices: u64,
}

impl Measure {
    pub fn usage(&self) -> Usage {
        Usage {
            bytes: self.bytes,
            notes: self.notes,
            devices: self.devices,
        }
    }
}

fn u(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Bytes are UTF-8 bytes (`length(CAST(… AS BLOB))`); SQLite's `length()` of TEXT counts
/// characters.
pub async fn measure(c: &mut SqliteConnection, user: i64) -> ApiResult<Measure> {
    let (notes_b, rem_b, rev_b, notes, devices): (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM notes WHERE user_id = ?1), \
         (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM reminders WHERE user_id = ?1), \
         (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM note_revisions WHERE user_id = ?1), \
         (SELECT COUNT(*) FROM notes WHERE user_id = ?1 AND deleted = 0), \
         (SELECT COUNT(*) FROM devices WHERE user_id = ?1 AND revoked_at IS NULL)",
    )
    .bind(user)
    .fetch_one(&mut *c)
    .await?;
    let live_bytes = u(notes_b) + u(rem_b);
    Ok(Measure {
        live_bytes,
        bytes: live_bytes + u(rev_b),
        notes: u(notes),
        devices: u(devices),
    })
}

/// The account's limits: its own override, else the server default.
pub async fn effective(c: &mut SqliteConnection, defaults: &Quota, user: i64) -> ApiResult<Quota> {
    let (b, n, d): (Option<i64>, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT quota_bytes, quota_notes, quota_devices FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&mut *c)
            .await?;
    Ok(Quota {
        bytes: b.map(u).or(defaults.bytes),
        notes: n.map(u).or(defaults.notes),
        devices: d.map(u).or(defaults.devices),
    })
}

/// Net rule of D-94 (see module docs).
pub fn push_exceeds(before: &Measure, after: &Measure, q: &Quota) -> bool {
    let bytes = after.live_bytes > before.live_bytes && q.bytes.is_some_and(|m| after.bytes > m);
    let notes = after.notes > before.notes && q.notes.is_some_and(|m| after.notes > m);
    bytes || notes
}

pub fn quota_exceeded() -> AppError {
    AppError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        codes::QUOTA_EXCEEDED,
        "the account's storage quota is exhausted",
    )
}

/// Device limit for every endpoint that creates a device (`POST /devices`,
/// `POST /session` without reuse, `POST /devices/pairing`, `POST /session/pairing`):
/// `409 device_limit` when the account already has `quota.devices` live devices. Call it
/// inside the transaction that inserts the device (`BEGIN IMMEDIATE`), so two parallel
/// logins cannot both pass.
pub async fn check_device_limit(
    c: &mut SqliteConnection,
    defaults: &Quota,
    user: i64,
) -> ApiResult<()> {
    let Some(max) = effective(c, defaults, user).await?.devices else {
        return Ok(());
    };
    let live: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE user_id = ? AND revoked_at IS NULL")
            .bind(user)
            .fetch_one(&mut *c)
            .await?;
    if u(live) >= max {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            codes::DEVICE_LIMIT,
            "too many devices; sign out an old device first",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(live: u64, rev: u64, notes: u64) -> Measure {
        Measure {
            live_bytes: live,
            bytes: live + rev,
            notes,
            devices: 1,
        }
    }

    #[test]
    fn net_rule() {
        let q = Quota {
            bytes: Some(1000),
            notes: Some(10),
            devices: None,
        };
        // growth over the limit
        assert!(push_exceeds(&m(900, 0, 5), &m(1001, 0, 5), &q));
        // growth that stays below
        assert!(!push_exceeds(&m(900, 0, 5), &m(1000, 0, 5), &q));
        // shortening while over (revision grows): always allowed
        assert!(!push_exceeds(&m(1200, 0, 5), &m(1100, 300, 5), &q));
        // deleting
        assert!(!push_exceeds(&m(1200, 0, 11), &m(900, 300, 10), &q));
        // one note too many
        assert!(push_exceeds(&m(10, 0, 10), &m(11, 0, 11), &q));
        // unlimited
        assert!(!push_exceeds(
            &m(0, 0, 0),
            &m(u64::MAX, 0, 1_000_000),
            &Quota::default()
        ));
    }
}
