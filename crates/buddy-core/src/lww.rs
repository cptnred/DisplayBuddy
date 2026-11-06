//! Last-writer-wins per document (PLAN_V3_SYNC §5.4, D-29). TypeScript mirror:
//! `src/lib/sync/lww.ts`; both pass `tests/fixtures/lww_vectors.json`.
//!
//! Order of comparison:
//! 1. `updatedAt` as an instant (unparseable sorts as the oldest possible time);
//! 2. reminders only: state rank `scheduled < due < done` (a reminder firing does not
//!    change `updatedAt`, so the due copy must beat the scheduled copy of the same edit);
//! 3. `updatedBy` (byte-wise string order, larger wins);
//! 4. complete tie → the local copy stays (nothing to apply).

use std::cmp::Ordering;

use chrono::{DateTime, Duration, Utc};

use crate::model::ReminderState;
use crate::sync::{NoteRecord, OrderRecord, ReminderRecord};
use crate::zoned::{format_utc, parse_instant};

/// Timestamps more than this far in the server's future are clamped to the server time.
pub const MAX_FUTURE_MS: i64 = 2 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    Local,
    Remote,
}

fn instant(s: &str) -> DateTime<Utc> {
    parse_instant(s).unwrap_or(DateTime::<Utc>::MIN_UTC)
}

fn cmp_time(a: &str, b: &str) -> Ordering {
    instant(a).cmp(&instant(b))
}

fn decide(ord: Ordering) -> Winner {
    if ord == Ordering::Greater {
        Winner::Remote
    } else {
        Winner::Local
    }
}

/// Compares two stamps; `Greater` means `remote` is newer.
pub fn cmp_stamp(remote_at: &str, remote_by: &str, local_at: &str, local_by: &str) -> Ordering {
    cmp_time(remote_at, local_at).then_with(|| remote_by.cmp(local_by))
}

pub fn note_winner(local: &NoteRecord, remote: &NoteRecord) -> Winner {
    decide(cmp_stamp(
        &remote.updated_at,
        &remote.updated_by,
        &local.updated_at,
        &local.updated_by,
    ))
}

pub fn order_winner(local: &OrderRecord, remote: &OrderRecord) -> Winner {
    decide(cmp_stamp(
        &remote.updated_at,
        &remote.updated_by,
        &local.updated_at,
        &local.updated_by,
    ))
}

fn state_rank(r: &ReminderRecord) -> u8 {
    match r.reminder.as_ref().map(|r| r.state) {
        // tombstones carry no state; they only meet live copies with a newer/older stamp
        None => 0,
        Some(ReminderState::Scheduled) => 0,
        Some(ReminderState::Due) => 1,
        Some(ReminderState::Done) => 2,
    }
}

pub fn reminder_winner(local: &ReminderRecord, remote: &ReminderRecord) -> Winner {
    decide(
        cmp_time(&remote.updated_at, &local.updated_at)
            .then_with(|| state_rank(remote).cmp(&state_rank(local)))
            .then_with(|| remote.updated_by.cmp(&local.updated_by)),
    )
}

/// Server rule (§5.3.2): a timestamp more than [`MAX_FUTURE_MS`] after `server_now`
/// becomes `server_now`; any other valid timestamp is kept **verbatim**.
/// `None` if `ts` is not an RFC 3339 instant.
pub fn clamp_future(ts: &str, server_now: &DateTime<Utc>) -> Option<String> {
    let t = parse_instant(ts)?;
    if t > *server_now + Duration::milliseconds(MAX_FUTURE_MS) {
        Some(format_utc(server_now))
    } else {
        Some(ts.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Reminder, ReminderRepeat};
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Side {
        updated_at: String,
        updated_by: String,
        #[serde(default)]
        deleted: bool,
        #[serde(default)]
        state: Option<ReminderState>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        local: Side,
        remote: Side,
        winner: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ClampCase {
        name: String,
        ts: String,
        server_now: String,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    struct Vectors {
        notes: Vec<Case>,
        reminders: Vec<Case>,
        order: Vec<Case>,
        clamp: Vec<ClampCase>,
    }

    const ID: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../tests/fixtures/lww_vectors.json")).unwrap()
    }

    fn expected(c: &Case) -> Winner {
        match c.winner.as_str() {
            "local" => Winner::Local,
            "remote" => Winner::Remote,
            other => panic!("{}: bad winner {other}", c.name),
        }
    }

    fn note(s: &Side) -> NoteRecord {
        NoteRecord {
            id: ID.into(),
            updated_at: s.updated_at.clone(),
            updated_by: s.updated_by.clone(),
            deleted: s.deleted,
            note: None,
        }
    }

    fn reminder(s: &Side) -> ReminderRecord {
        ReminderRecord {
            note_id: ID.into(),
            updated_at: s.updated_at.clone(),
            updated_by: s.updated_by.clone(),
            deleted: s.deleted,
            reminder: (!s.deleted).then(|| Reminder {
                note_id: ID.into(),
                at: "2026-11-07T08:00:00.000Z".into(),
                repeat: ReminderRepeat::None,
                state: s.state.unwrap_or_default(),
                fired_at: None,
                updated_at: Some(s.updated_at.clone()),
                time_zone: Some("Europe/Berlin".into()),
            }),
        }
    }

    fn order(s: &Side) -> OrderRecord {
        OrderRecord {
            updated_at: s.updated_at.clone(),
            updated_by: s.updated_by.clone(),
            ids: vec![],
        }
    }

    #[test]
    fn shared_lww_vectors() {
        let v = vectors();
        assert!(!v.notes.is_empty() && !v.reminders.is_empty() && !v.order.is_empty());
        for c in &v.notes {
            assert_eq!(
                note_winner(&note(&c.local), &note(&c.remote)),
                expected(c),
                "{}",
                c.name
            );
        }
        for c in &v.reminders {
            assert_eq!(
                reminder_winner(&reminder(&c.local), &reminder(&c.remote)),
                expected(c),
                "{}",
                c.name
            );
        }
        for c in &v.order {
            assert_eq!(
                order_winner(&order(&c.local), &order(&c.remote)),
                expected(c),
                "{}",
                c.name
            );
        }
        for c in &v.clamp {
            let now = parse_instant(&c.server_now).unwrap();
            assert_eq!(clamp_future(&c.ts, &now), c.expected, "{}", c.name);
        }
    }

    #[test]
    fn vectors_file_has_no_unknown_keys() {
        let raw: Value =
            serde_json::from_str(include_str!("../tests/fixtures/lww_vectors.json")).unwrap();
        let mut keys: Vec<_> = raw.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["$comment", "clamp", "notes", "order", "reminders"]);
    }
}
