//! Sync store: `/sync/push` (the only write path) and `/sync/changes`
//! (PLAN_V3_SYNC §5.3, §5.4, §6, §7.2; messages in `buddy_core::sync`, D-63).
//!
//! Rules:
//! - device timestamps are stored **verbatim**; the only change is the future clamp
//!   (`buddy_core::lww::clamp_future`, > 2 min after server time → server time), reported
//!   as `clampedUpdatedAt`;
//! - conflicts are decided only by `buddy_core::lww::{note,reminder,order}_winner`
//!   (server copy = "local", incoming = "remote");
//! - an identical re-send (same instant and `updatedBy`) is `applied` without a write
//!   (idempotent); a losing incoming record is `stale` and the winner is returned;
//! - every stored version gets `seq = ++users.seq` inside one `BEGIN IMMEDIATE` transaction;
//! - note losers are kept 30 days in `note_revisions` (`replaced` = old server copy that
//!   lost, `rejected` = incoming copy that lost);
//! - reminders without `timeZone` are stored as sent; computations use the account zone
//!   ([`effective_zone`]).
//! - v4 quotas (D-94): a push that grows the live data and leaves the account over its
//!   quota is refused as a whole (`413 quota_exceeded`, rollback; [`crate::accounts::quota`]).
//!   No rate limit here (D-103: the Android background sync polls every 3 min).

use buddy_core::accounts::Quota;
use buddy_core::lww::{
    Winner, clamp_future, cmp_stamp, note_winner, order_winner, reminder_winner,
};
use buddy_core::model::{Note, Reminder, is_valid_note_id};
use buddy_core::schedule::reminder_zone;
use buddy_core::sync::{
    DeviceKind, DeviceState, LocalNotifications, NoteRecord, OrderRecord, PUSH_BATCH_MAX,
    PushRequest, PushResponse, PushResult, PushStatus, RecordKind, ReminderRecord, Seq,
    SyncChanges,
};
use buddy_core::zoned::{format_utc, parse_instant, parse_zone};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use sqlx::SqliteConnection;

use crate::accounts::quota;
use crate::db::{BEGIN_WRITE, Db};
use crate::error::{ApiResult, AppError};

pub const DEFAULT_LIMIT: i64 = 500;
pub const MAX_LIMIT: i64 = 1000;
pub const MAX_ORDER_IDS: usize = 10_000;
pub const MAX_UPDATED_BY: usize = 128;

/// Zone used for a reminder: its own `timeZone`, else the account zone, else UTC (§5.1).
pub fn effective_zone(r: &Reminder, user_zone: &str) -> Tz {
    reminder_zone(r, parse_zone(user_zone).unwrap_or(Tz::UTC))
}

pub async fn user_time_zone(db: &Db, user_id: i64) -> ApiResult<String> {
    Ok(
        sqlx::query_scalar("SELECT time_zone FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}

// ---------------------------------------------------------------- rows ↔ records

pub(crate) type DocRow = (Option<String>, String, String, bool, i64);

pub(crate) fn note_from_row(id: &str, (payload, at, by, deleted, _): DocRow) -> NoteRecord {
    NoteRecord {
        id: id.to_string(),
        updated_at: at,
        updated_by: by,
        deleted,
        note: if deleted {
            None
        } else {
            payload.and_then(|p| serde_json::from_str(&p).ok())
        },
    }
}

pub(crate) fn reminder_from_row(id: &str, (payload, at, by, deleted, _): DocRow) -> ReminderRecord {
    ReminderRecord {
        note_id: id.to_string(),
        updated_at: at,
        updated_by: by,
        deleted,
        reminder: if deleted {
            None
        } else {
            payload.and_then(|p| serde_json::from_str(&p).ok())
        },
    }
}

async fn load_note(c: &mut SqliteConnection, user: i64, id: &str) -> ApiResult<Option<NoteRecord>> {
    let row: Option<DocRow> = sqlx::query_as(
        "SELECT payload, updated_at, updated_by, deleted, seq FROM notes WHERE user_id = ? AND id = ?",
    )
    .bind(user)
    .bind(id)
    .fetch_optional(&mut *c)
    .await?;
    Ok(row.map(|r| note_from_row(id, r)))
}

async fn load_reminder(
    c: &mut SqliteConnection,
    user: i64,
    id: &str,
) -> ApiResult<Option<ReminderRecord>> {
    let row: Option<DocRow> = sqlx::query_as(
        "SELECT payload, updated_at, updated_by, deleted, seq FROM reminders WHERE user_id = ? AND note_id = ?",
    )
    .bind(user)
    .bind(id)
    .fetch_optional(&mut *c)
    .await?;
    Ok(row.map(|r| reminder_from_row(id, r)))
}

pub(crate) async fn load_order(
    c: &mut SqliteConnection,
    user: i64,
) -> ApiResult<Option<(OrderRecord, Seq)>> {
    let row: Option<(String, String, String, i64)> =
        sqlx::query_as("SELECT ids, updated_at, updated_by, seq FROM note_order WHERE user_id = ?")
            .bind(user)
            .fetch_optional(&mut *c)
            .await?;
    Ok(row.map(|(ids, at, by, seq)| {
        (
            OrderRecord {
                updated_at: at,
                updated_by: by,
                ids: serde_json::from_str(&ids).unwrap_or_default(),
            },
            seq,
        )
    }))
}

/// `users.seq += 1`, returns the new value.
pub async fn bump_seq(c: &mut SqliteConnection, user: i64) -> ApiResult<Seq> {
    Ok(
        sqlx::query_scalar("UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq")
            .bind(user)
            .fetch_one(&mut *c)
            .await?,
    )
}

fn json<T: serde::Serialize>(v: &T) -> ApiResult<String> {
    serde_json::to_string(v).map_err(|e| anyhow::anyhow!("serialising record: {e}").into())
}

pub async fn write_note(
    c: &mut SqliteConnection,
    user: i64,
    rec: &NoteRecord,
    now: &str,
) -> ApiResult<Seq> {
    let seq = bump_seq(c, user).await?;
    let payload = match (&rec.note, rec.deleted) {
        (Some(n), false) => Some(json(n)?),
        _ => None,
    };
    sqlx::query(
        "INSERT INTO notes (user_id, id, payload, updated_at, updated_by, deleted, seq, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (user_id, id) DO UPDATE SET payload = excluded.payload, \
         updated_at = excluded.updated_at, updated_by = excluded.updated_by, \
         deleted = excluded.deleted, seq = excluded.seq, received_at = excluded.received_at",
    )
    .bind(user)
    .bind(&rec.id)
    .bind(payload)
    .bind(&rec.updated_at)
    .bind(&rec.updated_by)
    .bind(rec.deleted)
    .bind(seq)
    .bind(now)
    .execute(&mut *c)
    .await?;
    Ok(seq)
}

async fn write_reminder(
    c: &mut SqliteConnection,
    user: i64,
    rec: &ReminderRecord,
    now: &str,
) -> ApiResult<Seq> {
    let seq = bump_seq(c, user).await?;
    let payload = match (&rec.reminder, rec.deleted) {
        (Some(r), false) => Some(json(r)?),
        _ => None,
    };
    sqlx::query(
        "INSERT INTO reminders (user_id, note_id, payload, updated_at, updated_by, deleted, seq, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (user_id, note_id) DO UPDATE SET payload = excluded.payload, \
         updated_at = excluded.updated_at, updated_by = excluded.updated_by, \
         deleted = excluded.deleted, seq = excluded.seq, received_at = excluded.received_at",
    )
    .bind(user)
    .bind(&rec.note_id)
    .bind(payload)
    .bind(&rec.updated_at)
    .bind(&rec.updated_by)
    .bind(rec.deleted)
    .bind(seq)
    .bind(now)
    .execute(&mut *c)
    .await?;
    Ok(seq)
}

async fn write_order(c: &mut SqliteConnection, user: i64, rec: &OrderRecord) -> ApiResult<Seq> {
    let seq = bump_seq(c, user).await?;
    sqlx::query(
        "INSERT INTO note_order (user_id, ids, updated_at, updated_by, seq) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (user_id) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at, \
         updated_by = excluded.updated_by, seq = excluded.seq",
    )
    .bind(user)
    .bind(json(&rec.ids)?)
    .bind(&rec.updated_at)
    .bind(&rec.updated_by)
    .bind(seq)
    .execute(&mut *c)
    .await?;
    Ok(seq)
}

/// Stores a losing note version (skips tombstones and exact duplicates).
pub async fn store_revision(
    c: &mut SqliteConnection,
    user: i64,
    rec: &NoteRecord,
    reason: &str,
    now: &str,
) -> ApiResult<()> {
    let Some(note) = rec.note.as_ref().filter(|_| !rec.deleted) else {
        return Ok(());
    };
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM note_revisions WHERE user_id = ? AND note_id = ? AND updated_at = ? \
         AND updated_by = ? AND reason = ?",
    )
    .bind(user)
    .bind(&rec.id)
    .bind(&rec.updated_at)
    .bind(&rec.updated_by)
    .bind(reason)
    .fetch_optional(&mut *c)
    .await?;
    if exists.is_some() {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO note_revisions (user_id, note_id, payload, updated_at, updated_by, reason, stored_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user)
    .bind(&rec.id)
    .bind(json(note)?)
    .bind(&rec.updated_at)
    .bind(&rec.updated_by)
    .bind(reason)
    .bind(now)
    .execute(&mut *c)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- push

fn result(kind: RecordKind, id: &str, status: PushStatus) -> PushResult {
    PushResult {
        kind,
        id: id.to_string(),
        status,
        note: None,
        reminder: None,
        order: None,
        clamped_updated_at: None,
        message: None,
    }
}

fn invalid(kind: RecordKind, id: &str, message: &str) -> PushResult {
    PushResult {
        message: Some(message.to_string()),
        ..result(kind, id, PushStatus::Invalid)
    }
}

fn valid_by(by: &str) -> bool {
    !by.trim().is_empty() && by.len() <= MAX_UPDATED_BY
}

/// Clamps an optional inner timestamp (payload `updatedAt`); `Err` if unparseable.
fn clamp_opt(ts: &Option<String>, now: &DateTime<Utc>) -> Result<Option<String>, ()> {
    match ts {
        None => Ok(None),
        Some(t) => clamp_future(t, now).map(Some).ok_or(()),
    }
}

fn same_stamp(a_at: &str, a_by: &str, b_at: &str, b_by: &str) -> bool {
    cmp_stamp(a_at, a_by, b_at, b_by) == std::cmp::Ordering::Equal
}

struct Applied {
    result: PushResult,
    changed: bool,
}

async fn push_note(
    c: &mut SqliteConnection,
    user: i64,
    now: &DateTime<Utc>,
    rec: NoteRecord,
) -> ApiResult<Applied> {
    let k = RecordKind::Note;
    let bad = |m: &str| {
        Ok(Applied {
            result: invalid(k, &rec.id, m),
            changed: false,
        })
    };
    if !is_valid_note_id(&rec.id) {
        return bad("invalid note id");
    }
    if !valid_by(&rec.updated_by) {
        return bad("invalid updatedBy");
    }
    let Some(stamp) = clamp_future(&rec.updated_at, now) else {
        return bad("invalid updatedAt");
    };
    let note: Option<Note> = if rec.deleted {
        None
    } else {
        let Some(mut n) = rec.note.clone() else {
            return bad("missing note");
        };
        if n.id != rec.id {
            return bad("note id mismatch");
        }
        match clamp_future(&n.updated_at, now) {
            Some(t) => n.updated_at = t,
            None => return bad("invalid note.updatedAt"),
        }
        Some(n)
    };
    let incoming = NoteRecord {
        id: rec.id.clone(),
        updated_at: stamp.clone(),
        updated_by: rec.updated_by.clone(),
        deleted: rec.deleted,
        note,
    };
    let clamped = (stamp != rec.updated_at).then_some(stamp);
    let now_s = format_utc(now);
    let current = load_note(c, user, &rec.id).await?;
    let mut res = result(k, &rec.id, PushStatus::Applied);
    res.clamped_updated_at = clamped;
    let changed = match current {
        None => {
            write_note(c, user, &incoming, &now_s).await?;
            true
        }
        Some(cur) => match note_winner(&cur, &incoming) {
            Winner::Remote => {
                if cur.note != incoming.note {
                    store_revision(c, user, &cur, "replaced", &now_s).await?;
                }
                write_note(c, user, &incoming, &now_s).await?;
                true
            }
            Winner::Local
                if same_stamp(
                    &cur.updated_at,
                    &cur.updated_by,
                    &incoming.updated_at,
                    &incoming.updated_by,
                ) =>
            {
                false // identical re-send
            }
            Winner::Local => {
                if cur.note != incoming.note {
                    store_revision(c, user, &incoming, "rejected", &now_s).await?;
                }
                res.status = PushStatus::Stale;
                res.note = Some(cur);
                false
            }
        },
    };
    Ok(Applied {
        result: res,
        changed,
    })
}

async fn push_reminder(
    c: &mut SqliteConnection,
    user: i64,
    now: &DateTime<Utc>,
    rec: ReminderRecord,
) -> ApiResult<Applied> {
    let k = RecordKind::Reminder;
    let bad = |m: &str| {
        Ok(Applied {
            result: invalid(k, &rec.note_id, m),
            changed: false,
        })
    };
    if !is_valid_note_id(&rec.note_id) {
        return bad("invalid note id");
    }
    if !valid_by(&rec.updated_by) {
        return bad("invalid updatedBy");
    }
    let Some(stamp) = clamp_future(&rec.updated_at, now) else {
        return bad("invalid updatedAt");
    };
    let reminder: Option<Reminder> = if rec.deleted {
        None
    } else {
        let Some(mut r) = rec.reminder.clone() else {
            return bad("missing reminder");
        };
        if r.note_id != rec.note_id {
            return bad("reminder noteId mismatch");
        }
        if parse_instant(&r.at).is_none() {
            return bad("invalid at");
        }
        if r.fired_at
            .as_deref()
            .is_some_and(|f| parse_instant(f).is_none())
        {
            return bad("invalid firedAt");
        }
        if r.time_zone
            .as_deref()
            .is_some_and(|z| parse_zone(z).is_none())
        {
            return bad("unknown timeZone");
        }
        match clamp_opt(&r.updated_at, now) {
            Ok(t) => r.updated_at = t,
            Err(()) => return bad("invalid reminder.updatedAt"),
        }
        Some(r)
    };
    let incoming = ReminderRecord {
        note_id: rec.note_id.clone(),
        updated_at: stamp.clone(),
        updated_by: rec.updated_by.clone(),
        deleted: rec.deleted,
        reminder,
    };
    let clamped = (stamp != rec.updated_at).then_some(stamp);
    let now_s = format_utc(now);
    let mut res = result(k, &rec.note_id, PushStatus::Applied);
    res.clamped_updated_at = clamped;
    let changed = match load_reminder(c, user, &rec.note_id).await? {
        None => {
            write_reminder(c, user, &incoming, &now_s).await?;
            true
        }
        Some(cur) => match reminder_winner(&cur, &incoming) {
            Winner::Remote => {
                write_reminder(c, user, &incoming, &now_s).await?;
                true
            }
            Winner::Local
                if same_stamp(
                    &cur.updated_at,
                    &cur.updated_by,
                    &incoming.updated_at,
                    &incoming.updated_by,
                ) && cur.reminder.as_ref().map(|r| r.state)
                    == incoming.reminder.as_ref().map(|r| r.state) =>
            {
                false
            }
            Winner::Local => {
                res.status = PushStatus::Stale;
                res.reminder = Some(cur);
                false
            }
        },
    };
    Ok(Applied {
        result: res,
        changed,
    })
}

async fn push_order(
    c: &mut SqliteConnection,
    user: i64,
    now: &DateTime<Utc>,
    rec: OrderRecord,
) -> ApiResult<Applied> {
    let k = RecordKind::Order;
    let bad = |m: &str| {
        Ok(Applied {
            result: invalid(k, "order", m),
            changed: false,
        })
    };
    if !valid_by(&rec.updated_by) {
        return bad("invalid updatedBy");
    }
    if rec.ids.len() > MAX_ORDER_IDS || !rec.ids.iter().all(|i| is_valid_note_id(i)) {
        return bad("invalid ids");
    }
    let Some(stamp) = clamp_future(&rec.updated_at, now) else {
        return bad("invalid updatedAt");
    };
    let incoming = OrderRecord {
        updated_at: stamp.clone(),
        updated_by: rec.updated_by.clone(),
        ids: rec.ids.clone(),
    };
    let mut res = result(k, "order", PushStatus::Applied);
    res.clamped_updated_at = (stamp != rec.updated_at).then_some(stamp);
    let changed = match load_order(c, user).await? {
        None => {
            write_order(c, user, &incoming).await?;
            true
        }
        Some((cur, _)) => match order_winner(&cur, &incoming) {
            Winner::Remote => {
                write_order(c, user, &incoming).await?;
                true
            }
            Winner::Local
                if same_stamp(
                    &cur.updated_at,
                    &cur.updated_by,
                    &incoming.updated_at,
                    &incoming.updated_by,
                ) =>
            {
                false
            }
            Winner::Local => {
                res.status = PushStatus::Stale;
                res.order = Some(cur);
                false
            }
        },
    };
    Ok(Applied {
        result: res,
        changed,
    })
}

/// Outcome of a push for the caller (HTTP layer wakes the scheduler on reminder changes).
pub struct PushOutcome {
    pub response: PushResponse,
    pub reminders_changed: bool,
}

pub async fn push(
    db: &Db,
    now: DateTime<Utc>,
    user: i64,
    device_id: &str,
    kind: DeviceKind,
    quota_defaults: &Quota,
    req: PushRequest,
) -> ApiResult<PushOutcome> {
    if req.notes.len() > PUSH_BATCH_MAX || req.reminders.len() > PUSH_BATCH_MAX {
        return Err(AppError::bad_request(format!(
            "at most {PUSH_BATCH_MAX} notes and {PUSH_BATCH_MAX} reminders per push"
        )));
    }
    let mut tx = db.begin_with(BEGIN_WRITE).await?;
    // Quota (D-94): measured in this transaction; skipped when the account is unlimited.
    let q = quota::effective(&mut tx, quota_defaults, user).await?;
    let before = if q.bytes.is_some() || q.notes.is_some() {
        Some(quota::measure(&mut tx, user).await?)
    } else {
        None
    };
    let mut results = Vec::with_capacity(req.notes.len() + req.reminders.len() + 1);
    let mut reminders_changed = false;
    for rec in req.notes {
        results.push(push_note(&mut tx, user, &now, rec).await?.result);
    }
    for rec in req.reminders {
        let a = push_reminder(&mut tx, user, &now, rec).await?;
        reminders_changed |= a.changed;
        results.push(a.result);
    }
    if let Some(rec) = req.order {
        results.push(push_order(&mut tx, user, &now, rec).await?.result);
    }
    if let Some(ds) = req.device_state {
        store_device_state(&mut tx, device_id, kind, ds).await?;
    }
    if let Some(before) = before {
        let after = quota::measure(&mut tx, user).await?;
        if quota::push_exceeds(&before, &after, &q) {
            // nothing is applied: dropping `tx` rolls back; the client keeps its outbox
            tracing::info!(user, "push refused: quota exceeded");
            return Err(quota::quota_exceeded());
        }
    }
    let cursor: Seq = sqlx::query_scalar("SELECT seq FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(PushOutcome {
        response: PushResponse {
            results,
            cursor,
            server_time: format_utc(&now),
        },
        reminders_changed,
    })
}

/// `deviceState` comes from the native shell only (§6); other kinds are ignored.
async fn store_device_state(
    c: &mut SqliteConnection,
    device_id: &str,
    kind: DeviceKind,
    ds: DeviceState,
) -> ApiResult<()> {
    if kind != DeviceKind::Mobile {
        return Ok(());
    }
    let ln = match ds.local_notifications {
        LocalNotifications::Granted => "granted",
        LocalNotifications::Denied => "denied",
    };
    sqlx::query("UPDATE devices SET scheduled_seq = ?, local_notifications = ? WHERE id = ?")
        .bind(ds.scheduled_seq.max(0))
        .bind(ln)
        .bind(device_id)
        .execute(&mut *c)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------- changes

pub fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

enum Item {
    Note(NoteRecord),
    Reminder(ReminderRecord),
    Order(OrderRecord),
}

pub async fn changes(
    db: &Db,
    now: DateTime<Utc>,
    user: i64,
    device_id: &str,
    since: Seq,
    limit: i64,
) -> ApiResult<SyncChanges> {
    if since < 0 {
        return Err(AppError::bad_request("since must be ≥ 0"));
    }
    let mut tx = db.begin().await?;
    let (seq, min_cursor): (Seq, Seq) =
        sqlx::query_as("SELECT seq, min_cursor FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
    // Cursor older than purged tombstones, or from a different/restored database.
    if since > seq || (since > 0 && since < min_cursor) {
        return Err(AppError::full_resync());
    }
    let fetch = limit + 1;
    let notes: Vec<(String, Option<String>, String, String, bool, i64)> = sqlx::query_as(
        "SELECT id, payload, updated_at, updated_by, deleted, seq FROM notes \
         WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(user)
    .bind(since)
    .bind(fetch)
    .fetch_all(&mut *tx)
    .await?;
    let reminders: Vec<(String, Option<String>, String, String, bool, i64)> = sqlx::query_as(
        "SELECT note_id, payload, updated_at, updated_by, deleted, seq FROM reminders \
         WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(user)
    .bind(since)
    .bind(fetch)
    .fetch_all(&mut *tx)
    .await?;
    let order = load_order(&mut tx, user).await?;
    tx.commit().await?;

    let mut items: Vec<(Seq, Item)> = Vec::with_capacity(notes.len() + reminders.len() + 1);
    for (id, p, at, by, del, s) in notes {
        items.push((s, Item::Note(note_from_row(&id, (p, at, by, del, s)))));
    }
    for (id, p, at, by, del, s) in reminders {
        items.push((
            s,
            Item::Reminder(reminder_from_row(&id, (p, at, by, del, s))),
        ));
    }
    if let Some((o, s)) = order
        && s > since
    {
        items.push((s, Item::Order(o)));
    }
    items.sort_by_key(|(s, _)| *s);
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = items.len() > limit_usize;
    items.truncate(limit_usize);
    let cursor = if has_more {
        items.last().map_or(since, |(s, _)| *s)
    } else {
        seq
    };

    let mut out = SyncChanges {
        cursor,
        has_more,
        notes: Vec::new(),
        reminders: Vec::new(),
        order: None,
        server_time: format_utc(&now),
    };
    for (_, item) in items {
        match item {
            Item::Note(n) => out.notes.push(n),
            Item::Reminder(r) => out.reminders.push(r),
            Item::Order(o) => out.order = Some(o),
        }
    }
    if !has_more {
        sqlx::query("UPDATE devices SET synced_seq = ? WHERE id = ?")
            .bind(cursor)
            .bind(device_id)
            .execute(db)
            .await?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zone_fallbacks() {
        let mut r: Reminder = serde_json::from_value(json!({
            "noteId": "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
            "at": "2026-11-07T08:00:00.000Z"
        }))
        .unwrap();
        assert_eq!(effective_zone(&r, "Europe/Berlin").name(), "Europe/Berlin");
        assert_eq!(effective_zone(&r, "garbage").name(), "UTC");
        r.time_zone = Some("Asia/Tokyo".into());
        assert_eq!(effective_zone(&r, "Europe/Berlin").name(), "Asia/Tokyo");
    }

    #[test]
    fn limits() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT);
    }
}
