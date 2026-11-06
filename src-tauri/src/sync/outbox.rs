//! Outbox of local changes not yet accepted by the server (PLAN_V3_SYNC §8):
//! `sync/outbox.json`, written with `write_json_atomic` after every change.
//!
//! Only *which* document changed is stored (plus the deletion stamp of tombstones);
//! the payload is read from the local files at push time, so the newest local
//! version is always sent. Every entry carries a revision number: after a push an
//! entry is only removed if it was not touched again meanwhile.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub rev: u64,
    /// Deletion time (corrected device time, UTC) for tombstones; `None` for edits.
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOrder {
    pub rev: u64,
    /// Time the order was changed locally.
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Outbox {
    pub notes: BTreeMap<String, Pending>,
    pub reminders: BTreeMap<String, Pending>,
    pub order: Option<PendingOrder>,
    /// Last revision handed out.
    pub rev: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Note,
    Reminder,
}

impl Outbox {
    fn next_rev(&mut self) -> u64 {
        self.rev += 1;
        self.rev
    }

    fn map(&mut self, kind: Kind) -> &mut BTreeMap<String, Pending> {
        match kind {
            Kind::Note => &mut self.notes,
            Kind::Reminder => &mut self.reminders,
        }
    }

    /// A document was created or edited locally.
    pub fn changed(&mut self, kind: Kind, id: &str) {
        let rev = self.next_rev();
        self.map(kind).insert(
            id.to_string(),
            Pending {
                rev,
                deleted_at: None,
            },
        );
    }

    /// A document was deleted locally at `stamp`.
    pub fn deleted(&mut self, kind: Kind, id: &str, stamp: &str) {
        let rev = self.next_rev();
        self.map(kind).insert(
            id.to_string(),
            Pending {
                rev,
                deleted_at: Some(stamp.to_string()),
            },
        );
    }

    pub fn order_changed(&mut self, stamp: &str) {
        let rev = self.next_rev();
        self.order = Some(PendingOrder {
            rev,
            updated_at: stamp.to_string(),
        });
    }

    pub fn is_pending(&self, kind: Kind, id: &str) -> bool {
        match kind {
            Kind::Note => self.notes.contains_key(id),
            Kind::Reminder => self.reminders.contains_key(id),
        }
    }

    /// Removes the entry if it still has revision `rev` (not edited since the push).
    /// Returns whether it was removed.
    pub fn ack(&mut self, kind: Kind, id: &str, rev: u64) -> bool {
        let map = self.map(kind);
        if map.get(id).is_some_and(|p| p.rev == rev) {
            map.remove(id);
            true
        } else {
            false
        }
    }

    pub fn ack_order(&mut self, rev: u64) -> bool {
        if self.order.as_ref().is_some_and(|o| o.rev == rev) {
            self.order = None;
            true
        } else {
            false
        }
    }

    /// Number of waiting changes ("Offline – n Änderungen warten").
    pub fn len(&self) -> usize {
        self.notes.len() + self.reminders.len() + usize::from(self.order.is_some())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_and_tombstones_keep_the_latest_state() {
        let mut o = Outbox::default();
        o.changed(Kind::Note, "a");
        o.deleted(Kind::Note, "a", "2026-11-06T10:00:00.000Z");
        o.changed(Kind::Reminder, "a");
        o.order_changed("2026-11-06T10:00:01.000Z");
        assert_eq!(o.len(), 3);
        assert_eq!(
            o.notes["a"].deleted_at.as_deref(),
            Some("2026-11-06T10:00:00.000Z")
        );
        assert!(o.is_pending(Kind::Note, "a") && o.is_pending(Kind::Reminder, "a"));
        assert!(!o.is_pending(Kind::Note, "b"));
    }

    #[test]
    fn ack_only_removes_an_unchanged_entry() {
        let mut o = Outbox::default();
        o.changed(Kind::Note, "a");
        let pushed = o.notes["a"].rev;
        o.changed(Kind::Note, "a"); // edited again while the push was in flight
        assert!(!o.ack(Kind::Note, "a", pushed));
        assert!(o.is_pending(Kind::Note, "a"));
        let rev = o.notes["a"].rev;
        assert!(o.ack(Kind::Note, "a", rev));
        assert!(o.is_empty());

        o.order_changed("x");
        let r = o.order.as_ref().unwrap().rev;
        o.order_changed("y");
        assert!(!o.ack_order(r));
        let r = o.order.as_ref().unwrap().rev;
        assert!(o.ack_order(r));
        assert!(o.is_empty());
    }

    #[test]
    fn json_round_trip_and_tolerant_load() {
        let mut o = Outbox::default();
        o.changed(Kind::Note, "a");
        o.deleted(Kind::Reminder, "b", "2026-11-06T10:00:00.000Z");
        let v = serde_json::to_value(&o).unwrap();
        assert_eq!(v["reminders"]["b"]["deletedAt"], "2026-11-06T10:00:00.000Z");
        assert_eq!(serde_json::from_value::<Outbox>(v).unwrap(), o);
        let empty: Outbox = serde_json::from_str("{}").unwrap();
        assert!(empty.is_empty());
    }
}
