//! Pure merge decisions (PLAN_V3_SYNC §5.4, §8). The only comparison of versions is
//! `buddy_core::lww`; nothing here compares timestamps itself.
//!
//! Rule: the server only ever hands out its LWW winner. A remote record therefore
//! replaces the local copy unless the local copy has an unsent change (outbox), in
//! which case LWW decides. Taking a remote record over never creates an outbox entry.

use chrono::{DateTime, Duration, Utc};

use buddy_core::lww::{Winner, note_winner, order_winner, reminder_winner};
use buddy_core::sync::{NoteRecord, OrderRecord, ReminderRecord};
use buddy_core::zoned::parse_instant;

use super::outbox::{Pending, PendingOrder};
use crate::model::{Note, Reminder, ReminderState, is_valid_note_id};

/// Stamp of data from before v3 without `updatedAt` (sorts as old as possible).
pub const EPOCH: &str = "1970-01-01T00:00:00.000Z";
/// A `due` transition learned through the sync only alarms if it fired this recently.
pub const REMOTE_ALERT_WINDOW_MIN: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Take the remote record over.
    Apply,
    /// Keep the local copy (echo, older, or invalid remote record).
    Keep,
}

/// The record we push for a pending note: the current file, or a tombstone.
pub fn push_note_record(
    id: &str,
    local: Option<&Note>,
    pending: &Pending,
    device_id: &str,
    now: &str,
) -> NoteRecord {
    match local {
        Some(n) => NoteRecord {
            id: id.to_string(),
            updated_at: n.updated_at.clone(),
            updated_by: device_id.to_string(),
            deleted: false,
            note: Some(n.clone()),
        },
        None => NoteRecord {
            id: id.to_string(),
            updated_at: pending
                .deleted_at
                .clone()
                .unwrap_or_else(|| now.to_string()),
            updated_by: device_id.to_string(),
            deleted: true,
            note: None,
        },
    }
}

/// The record we push for a pending reminder: the current one, or a tombstone.
pub fn push_reminder_record(
    note_id: &str,
    local: Option<&Reminder>,
    pending: &Pending,
    device_id: &str,
    now: &str,
) -> ReminderRecord {
    match local {
        Some(r) => ReminderRecord {
            note_id: note_id.to_string(),
            updated_at: r.updated_at.clone().unwrap_or_else(|| EPOCH.to_string()),
            updated_by: device_id.to_string(),
            deleted: false,
            reminder: Some(r.clone()),
        },
        None => ReminderRecord {
            note_id: note_id.to_string(),
            updated_at: pending
                .deleted_at
                .clone()
                .unwrap_or_else(|| now.to_string()),
            updated_by: device_id.to_string(),
            deleted: true,
            reminder: None,
        },
    }
}

pub fn push_order_record(ids: Vec<String>, pending: &PendingOrder, device_id: &str) -> OrderRecord {
    OrderRecord {
        updated_at: pending.updated_at.clone(),
        updated_by: device_id.to_string(),
        ids,
    }
}

fn valid_note_record(r: &NoteRecord) -> bool {
    is_valid_note_id(&r.id)
        && parse_instant(&r.updated_at).is_some()
        && (r.deleted || r.note.as_ref().is_some_and(|n| n.id == r.id))
}

fn valid_reminder_record(r: &ReminderRecord) -> bool {
    is_valid_note_id(&r.note_id)
        && parse_instant(&r.updated_at).is_some()
        && (r.deleted
            || r.reminder
                .as_ref()
                .is_some_and(|x| x.note_id == r.note_id && parse_instant(&x.at).is_some()))
}

/// What to do with a remote note record. `local` is the note file (if any),
/// `pending` its outbox entry.
pub fn decide_note(
    local: Option<&Note>,
    pending: Option<&Pending>,
    remote: &NoteRecord,
    device_id: &str,
    now: &str,
) -> Decision {
    if !valid_note_record(remote) {
        return Decision::Keep;
    }
    if let Some(p) = pending {
        let mine = push_note_record(&remote.id, local, p, device_id, now);
        return match note_winner(&mine, remote) {
            Winner::Remote => Decision::Apply,
            Winner::Local => Decision::Keep,
        };
    }
    match (local, remote.deleted) {
        (None, true) => Decision::Keep,
        (Some(l), false) if remote.note.as_ref() == Some(l) => Decision::Keep, // echo
        _ => Decision::Apply,
    }
}

pub fn decide_reminder(
    local: Option<&Reminder>,
    pending: Option<&Pending>,
    remote: &ReminderRecord,
    device_id: &str,
    now: &str,
) -> Decision {
    if !valid_reminder_record(remote) {
        return Decision::Keep;
    }
    if let Some(p) = pending {
        let mine = push_reminder_record(&remote.note_id, local, p, device_id, now);
        return match reminder_winner(&mine, remote) {
            Winner::Remote => Decision::Apply,
            Winner::Local => Decision::Keep,
        };
    }
    match (local, remote.deleted) {
        (None, true) => Decision::Keep,
        (Some(l), false) if remote.reminder.as_ref() == Some(l) => Decision::Keep,
        _ => Decision::Apply,
    }
}

pub fn decide_order(
    local_ids: &[String],
    pending: Option<&PendingOrder>,
    remote: &OrderRecord,
    device_id: &str,
) -> Decision {
    if parse_instant(&remote.updated_at).is_none() {
        return Decision::Keep;
    }
    if let Some(p) = pending {
        let mine = push_order_record(local_ids.to_vec(), p, device_id);
        return match order_winner(&mine, remote) {
            Winner::Remote => Decision::Apply,
            Winner::Local => Decision::Keep,
        };
    }
    if remote.ids == local_ids {
        Decision::Keep
    } else {
        Decision::Apply
    }
}

/// Whether a reminder taken over from the sync should alarm on this PC (§5.5): it
/// became `due` (for this `at`) and fired at most 10 minutes ago.
pub fn should_alert(before: Option<&Reminder>, after: &Reminder, now: &DateTime<Utc>) -> bool {
    if after.state != ReminderState::Due {
        return false;
    }
    if before.is_some_and(|b| b.state == ReminderState::Due && b.at == after.at) {
        return false; // already alarmed here
    }
    let Some(fired) = after.fired_at.as_deref().and_then(parse_instant) else {
        return false;
    };
    let age = *now - fired;
    age <= Duration::minutes(REMOTE_ALERT_WINDOW_MIN) && age >= -Duration::minutes(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NoteColor, ReminderRepeat};
    use serde_json::json;

    const ID: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";
    const ME: &str = "dev-me";
    const OTHER: &str = "dev-other";
    const NOW: &str = "2026-11-06T12:00:00.000Z";

    fn note(text: &str, at: &str) -> Note {
        Note {
            id: ID.into(),
            title: text.into(),
            color: NoteColor::Yellow,
            content: json!({"type": "doc"}),
            created_at: "2026-11-01T00:00:00.000Z".into(),
            updated_at: at.into(),
            schema_version: 1,
        }
    }

    fn rec(n: Option<Note>, at: &str, by: &str) -> NoteRecord {
        NoteRecord {
            id: ID.into(),
            updated_at: at.into(),
            updated_by: by.into(),
            deleted: n.is_none(),
            note: n,
        }
    }

    fn pending(deleted_at: Option<&str>) -> Pending {
        Pending {
            rev: 1,
            deleted_at: deleted_at.map(str::to_string),
        }
    }

    fn reminder(state: ReminderState, at: &str, updated: Option<&str>) -> Reminder {
        Reminder {
            note_id: ID.into(),
            at: at.into(),
            repeat: ReminderRepeat::None,
            state,
            fired_at: None,
            updated_at: updated.map(str::to_string),
            time_zone: Some("Europe/Berlin".into()),
        }
    }

    #[test]
    fn remote_replaces_a_clean_local_copy() {
        let local = note("old", "2026-11-06T10:00:00.000Z");
        // even an "older" stamp: the server only sends its winner (e.g. after a clamp)
        let remote = rec(
            Some(note("new", "2026-11-06T09:00:00.000Z")),
            "2026-11-06T09:00:00.000Z",
            OTHER,
        );
        assert_eq!(
            decide_note(Some(&local), None, &remote, ME, NOW),
            Decision::Apply
        );
        // new note, remote deletion of an existing note
        assert_eq!(decide_note(None, None, &remote, ME, NOW), Decision::Apply);
        let tomb = rec(None, "2026-11-06T11:00:00.000Z", OTHER);
        assert_eq!(
            decide_note(Some(&local), None, &tomb, ME, NOW),
            Decision::Apply
        );
        // nothing to delete, identical echo
        assert_eq!(decide_note(None, None, &tomb, ME, NOW), Decision::Keep);
        let echo = rec(Some(local.clone()), &local.updated_at, ME);
        assert_eq!(
            decide_note(Some(&local), None, &echo, ME, NOW),
            Decision::Keep
        );
    }

    #[test]
    fn pending_local_change_is_decided_by_lww() {
        let local = note("mine", "2026-11-06T10:00:00.000Z");
        let older = rec(
            Some(note("theirs", "2026-11-06T09:59:59.999Z")),
            "2026-11-06T09:59:59.999Z",
            OTHER,
        );
        let newer = rec(
            Some(note("theirs", "2026-11-06T10:00:00.001Z")),
            "2026-11-06T10:00:00.001Z",
            OTHER,
        );
        let p = pending(None);
        assert_eq!(
            decide_note(Some(&local), Some(&p), &older, ME, NOW),
            Decision::Keep
        );
        assert_eq!(
            decide_note(Some(&local), Some(&p), &newer, ME, NOW),
            Decision::Apply
        );
        // local tombstone (deleted at 10:00) vs remote edit at 09:00 → stays deleted
        let p = pending(Some("2026-11-06T10:00:00.000Z"));
        let edit = rec(
            Some(note("x", "2026-11-06T09:00:00.000Z")),
            "2026-11-06T09:00:00.000Z",
            OTHER,
        );
        assert_eq!(decide_note(None, Some(&p), &edit, ME, NOW), Decision::Keep);
        // …but a later edit elsewhere brings the note back
        let later = rec(
            Some(note("x", "2026-11-06T10:30:00.000Z")),
            "2026-11-06T10:30:00.000Z",
            OTHER,
        );
        assert_eq!(
            decide_note(None, Some(&p), &later, ME, NOW),
            Decision::Apply
        );
    }

    #[test]
    fn invalid_remote_records_are_ignored() {
        let mut bad = rec(Some(note("x", NOW)), NOW, OTHER);
        bad.id = "../settings".into();
        assert_eq!(decide_note(None, None, &bad, ME, NOW), Decision::Keep);
        let mut bad = rec(Some(note("x", NOW)), "yesterday", OTHER);
        bad.updated_at = "yesterday".into();
        assert_eq!(decide_note(None, None, &bad, ME, NOW), Decision::Keep);
        let missing = NoteRecord {
            note: None,
            deleted: false,
            ..rec(None, NOW, OTHER)
        };
        assert_eq!(decide_note(None, None, &missing, ME, NOW), Decision::Keep);
    }

    #[test]
    fn push_records() {
        let p = pending(Some("2026-11-06T10:00:00.000Z"));
        let t = push_note_record(ID, None, &p, ME, NOW);
        assert!(t.deleted && t.note.is_none());
        assert_eq!(t.updated_at, "2026-11-06T10:00:00.000Z");
        let n = note("x", "2026-11-06T11:00:00.000Z");
        let live = push_note_record(ID, Some(&n), &pending(None), ME, NOW);
        assert_eq!(live.updated_at, n.updated_at);
        assert_eq!(live.updated_by, ME);
        // legacy reminder without updatedAt
        let r = reminder(ReminderState::Scheduled, NOW, None);
        assert_eq!(
            push_reminder_record(ID, Some(&r), &pending(None), ME, NOW).updated_at,
            EPOCH
        );
        let t = push_reminder_record(ID, None, &pending(None), ME, NOW);
        assert!(t.deleted && t.updated_at == NOW);
    }

    /// D-58: firing does not change `updatedAt`; the due copy beats the scheduled copy
    /// of the same edit, and a newer user action beats both.
    #[test]
    fn reminder_due_state_and_pending_actions() {
        let edit = "2026-11-06T08:00:00.000Z";
        let local = reminder(
            ReminderState::Scheduled,
            "2026-11-06T11:00:00.000Z",
            Some(edit),
        );
        let mut due = local.clone();
        due.state = ReminderState::Due;
        due.fired_at = Some("2026-11-06T11:00:00.100Z".into());
        let remote = ReminderRecord {
            note_id: ID.into(),
            updated_at: edit.into(),
            updated_by: OTHER.into(),
            deleted: false,
            reminder: Some(due.clone()),
        };
        assert_eq!(
            decide_reminder(Some(&local), None, &remote, ME, NOW),
            Decision::Apply
        );
        assert_eq!(
            decide_reminder(Some(&local), Some(&pending(None)), &remote, ME, NOW),
            Decision::Apply,
            "same edit, due > scheduled"
        );
        let mut snoozed = local.clone();
        snoozed.updated_at = Some("2026-11-06T11:05:00.000Z".into());
        assert_eq!(
            decide_reminder(Some(&snoozed), Some(&pending(None)), &remote, ME, NOW),
            Decision::Keep
        );
        assert_eq!(
            decide_reminder(Some(&due), None, &remote, ME, NOW),
            Decision::Keep,
            "echo"
        );
    }

    #[test]
    fn order_decisions() {
        let ids = vec!["a".to_string(), "b".to_string()];
        let remote = OrderRecord {
            updated_at: "2026-11-06T10:00:00.000Z".into(),
            updated_by: OTHER.into(),
            ids: vec!["b".into(), "a".into()],
        };
        assert_eq!(decide_order(&ids, None, &remote, ME), Decision::Apply);
        assert_eq!(decide_order(&remote.ids, None, &remote, ME), Decision::Keep);
        let newer = PendingOrder {
            rev: 1,
            updated_at: "2026-11-06T10:00:01.000Z".into(),
        };
        assert_eq!(
            decide_order(&ids, Some(&newer), &remote, ME),
            Decision::Keep
        );
        let older = PendingOrder {
            rev: 1,
            updated_at: "2026-11-06T09:00:00.000Z".into(),
        };
        assert_eq!(
            decide_order(&ids, Some(&older), &remote, ME),
            Decision::Apply
        );
    }

    #[test]
    fn alert_only_for_fresh_remote_due() {
        let now = parse_instant(NOW).unwrap();
        let before = reminder(ReminderState::Scheduled, "2026-11-06T11:55:00.000Z", None);
        let mut after = before.clone();
        after.state = ReminderState::Due;
        after.fired_at = Some("2026-11-06T11:55:00.000Z".into());
        assert!(should_alert(Some(&before), &after, &now));
        assert!(should_alert(None, &after, &now));
        assert!(
            !should_alert(Some(&after), &after, &now),
            "already due here"
        );
        after.fired_at = Some("2026-11-06T11:49:59.000Z".into());
        assert!(
            !should_alert(Some(&before), &after, &now),
            "older than 10 min"
        );
        after.fired_at = None;
        assert!(!should_alert(Some(&before), &after, &now));
        assert!(!should_alert(None, &before, &now), "not due");
    }
}
