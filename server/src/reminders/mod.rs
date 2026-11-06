//! Reminder scheduler (PLAN_V3_SYNC §5.5, §7.3), same pattern as
//! `src-tauri/src/reminders.rs`:
//!
//! - one task sleeps until the earliest scheduled `at` (at most [`MAX_SLEEP`]) and is woken
//!   by `AppState::reminders_changed` (`tokio::sync::Notify`) after sync pushes and new
//!   push subscriptions;
//! - every round ([`tick`]): `scheduled` reminders with `at ≤ now` become `due` with
//!   `firedAt = now` and a new `seq` (**`updatedAt` stays**, D-30; `buddy_core::schedule`);
//!   then every occurrence `(noteId, at)` in state `scheduled`/`due` with
//!   `now − 24 h ≤ at ≤ now` is dispatched per device (`push::dispatch`, §7.4);
//! - the first round after start fires what was missed while the server was off (once,
//!   thanks to `push_log`); older than 24 h is only marked due, not pushed.
//!
//! "Now" comes from the injected `AppState::clock`; `at` is always compared as an instant
//! (UTC), never in SQL and never in a zone. The scheduler never computes a new `at`
//! (repetition is the acting device's job, §5.5).

use std::time::Duration as StdDuration;

use buddy_core::model::{Note, Reminder, ReminderState};
use buddy_core::schedule::{due_now, earliest_scheduled, fire};
use buddy_core::zoned::{format_utc, parse_instant};
use chrono::{DateTime, Duration, Utc};
use tokio::task::JoinSet;

use crate::AppState;
use crate::db::BEGIN_WRITE;
use crate::error::ApiResult;
use crate::push::dispatch::{self, Occurrence};
use crate::sync::{bump_seq, effective_zone};

/// Longest sleep between rounds.
pub const MAX_SLEEP: StdDuration = StdDuration::from_secs(30);
/// Occurrences older than this are not pushed any more.
pub const PUSH_WINDOW: Duration = Duration::hours(24);

/// Reminders that may still ring (missing state = `scheduled`).
const ACTIVE_ROWS: &str = "SELECT user_id, note_id, payload, at_seq, seq FROM reminders \
     WHERE deleted = 0 AND payload IS NOT NULL \
       AND COALESCE(json_extract(payload, '$.state'), 'scheduled') IN ('scheduled', 'due') \
     ORDER BY user_id, note_id";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickReport {
    /// Reminders that became due in this round.
    pub fired: usize,
    /// Deliveries started in this round.
    pub dispatched: usize,
    /// Earliest `at` still scheduled (the next wake-up).
    pub next: Option<DateTime<Utc>>,
}

struct Row {
    user_id: i64,
    note_id: String,
    reminder: Reminder,
    at_seq: i64,
}

async fn active_rows(c: &mut sqlx::SqliteConnection) -> ApiResult<Vec<Row>> {
    let rows: Vec<(i64, String, String, Option<i64>, i64)> =
        sqlx::query_as(ACTIVE_ROWS).fetch_all(&mut *c).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(user_id, note_id, payload, at_seq, seq)| {
            let reminder: Reminder = serde_json::from_str(&payload).ok()?;
            Some(Row {
                user_id,
                note_id,
                reminder,
                at_seq: at_seq.unwrap_or(seq),
            })
        })
        .collect())
}

/// Step 1: `scheduled` with `at ≤ now` → `due` (new `seq`, `updatedAt` unchanged).
/// Returns the number of fired reminders and the earliest remaining scheduled `at`.
pub async fn fire_due(
    db: &crate::db::Db,
    now: DateTime<Utc>,
) -> ApiResult<(usize, Option<DateTime<Utc>>)> {
    let mut tx = db.begin_with(BEGIN_WRITE).await?;
    let rows = active_rows(&mut tx).await?;
    let mut list: Vec<Reminder> = rows.iter().map(|r| r.reminder.clone()).collect();
    let due = due_now(&list, &now);
    fire(&mut list, &due, &now);
    for &i in &due {
        let row = &rows[i];
        let seq = bump_seq(&mut tx, row.user_id).await?;
        let payload = serde_json::to_string(&list[i])
            .map_err(|e| anyhow::anyhow!("serialising reminder: {e}"))?;
        sqlx::query("UPDATE reminders SET payload = ?, seq = ? WHERE user_id = ? AND note_id = ?")
            .bind(payload)
            .bind(seq)
            .bind(row.user_id)
            .bind(&row.note_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if !due.is_empty() {
        tracing::info!(count = due.len(), "reminders due");
    }
    Ok((due.len(), earliest_scheduled(&list)))
}

/// Step 2: the occurrences to push right now (`now − 24 h ≤ at ≤ now`).
pub async fn occurrences(db: &crate::db::Db, now: DateTime<Utc>) -> ApiResult<Vec<Occurrence>> {
    let mut c = db.acquire().await?;
    let rows = active_rows(&mut c).await?;
    let oldest = now - PUSH_WINDOW;
    let mut out = Vec::new();
    for row in rows {
        let Some(at) = parse_instant(&row.reminder.at) else {
            continue;
        };
        if at > now || at < oldest {
            continue;
        }
        if !matches!(
            row.reminder.state,
            ReminderState::Scheduled | ReminderState::Due
        ) {
            continue;
        }
        let user_zone: String = sqlx::query_scalar("SELECT time_zone FROM users WHERE id = ?")
            .bind(row.user_id)
            .fetch_one(&mut *c)
            .await?;
        let note: Option<String> = sqlx::query_scalar(
            "SELECT payload FROM notes WHERE user_id = ? AND id = ? AND deleted = 0",
        )
        .bind(row.user_id)
        .bind(&row.note_id)
        .fetch_optional(&mut *c)
        .await?
        .flatten();
        let note: Option<Note> = note.and_then(|p| serde_json::from_str(&p).ok());
        out.push(Occurrence {
            user_id: row.user_id,
            note_id: row.note_id,
            at: format_utc(&at),
            at_seq: row.at_seq,
            zone: effective_zone(&row.reminder, &user_zone).name().to_string(),
            reminder: row.reminder,
            note,
        });
    }
    Ok(out)
}

/// One scheduler round: fire, then dispatch (deliveries are spawned into `tasks`).
pub async fn tick(state: &AppState, tasks: &mut JoinSet<()>) -> ApiResult<TickReport> {
    let now = state.clock.now();
    let (fired, next) = fire_due(&state.db, now).await?;
    let mut dispatched = 0;
    for occ in occurrences(&state.db, now).await? {
        dispatched += dispatch::dispatch(state, &occ, tasks).await?;
    }
    Ok(TickReport {
        fired,
        dispatched,
        next,
    })
}

/// Drops `pending` claims left by a crash or shutdown; the next round re-sends them while
/// they are younger than 24 h.
pub async fn release_pending(db: &crate::db::Db) -> ApiResult<u64> {
    Ok(sqlx::query("DELETE FROM push_log WHERE status = 'pending'")
        .execute(db)
        .await?
        .rows_affected())
}

/// How long to sleep after a round.
pub fn sleep_for(next: Option<DateTime<Utc>>, now: DateTime<Utc>) -> StdDuration {
    match next {
        Some(t) => (t - now)
            .to_std()
            .unwrap_or(StdDuration::ZERO)
            .min(MAX_SLEEP),
        None => MAX_SLEEP,
    }
}

/// The scheduler task (spawned by `serve`), until `shutdown` turns true. Running
/// deliveries are aborted on shutdown; their `pending` rows are released at the next start.
pub async fn run(state: AppState, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    match release_pending(&state.db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(count = n, "released unfinished push claims"),
        Err(e) => tracing::error!(error = ?e.message, "releasing push claims failed"),
    }
    let mut tasks = JoinSet::new();
    loop {
        if *shutdown.borrow() {
            break;
        }
        while tasks.try_join_next().is_some() {}
        let next = match tick(&state, &mut tasks).await {
            Ok(r) => r.next,
            Err(e) => {
                tracing::error!(error = ?e.message, "reminder round failed");
                None
            }
        };
        let wait = sleep_for(next, state.clock.now());
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = state.reminders_changed.notified() => {}
            r = shutdown.changed() => if r.is_err() { break },
        }
    }
    tasks.shutdown().await;
    tracing::info!("reminder scheduler stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        parse_instant(s).unwrap()
    }

    #[test]
    fn sleep_is_capped_and_never_negative() {
        let now = t("2026-11-06T10:00:00Z");
        assert_eq!(sleep_for(None, now), MAX_SLEEP);
        assert_eq!(
            sleep_for(Some(t("2026-11-06T10:00:05Z")), now),
            StdDuration::from_secs(5)
        );
        assert_eq!(sleep_for(Some(t("2026-11-06T11:00:00Z")), now), MAX_SLEEP);
        assert_eq!(
            sleep_for(Some(t("2026-11-06T09:00:00Z")), now),
            StdDuration::ZERO
        );
    }
}
