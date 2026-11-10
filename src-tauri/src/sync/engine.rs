//! One sync cycle (PLAN_V3_SYNC §8): push the outbox in packages of ≤ 200, then pull
//! from the cursor and merge. Generic over [`LocalData`] so it runs against the real
//! app and against in-memory test data with the same code.
//!
//! No lock is held across an `.await`: the outbox is snapshotted, local data is read
//! inside short closures, and merges run in one closure per page.

use std::time::Duration;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use buddy_core::schedule;
use buddy_core::sync::{
    NoteRecord, PUSH_BATCH_MAX, PushRequest, PushStatus, RecordKind, ReminderRecord, SyncChanges,
};
use buddy_core::zoned::format_utc;

use super::client::{Client, ClientError};
use super::core::SyncCore;
use super::merge::{
    self, Decision, decide_note, decide_order, decide_reminder, push_note_record,
    push_reminder_record,
};
use super::outbox::{Kind, Pending};
use crate::model::{Note, NotesChangedPayload, Reminder};
use crate::storage::{Storage, StorageError};

/// Local data the engine reads and changes.
pub trait LocalData {
    /// Runs `f` under the notes storage lock.
    fn with_storage<T>(&self, f: impl FnOnce(&Storage) -> T) -> Result<T, String>;
    /// Runs `f` on the reminder list under its lock; persists and emits
    /// `reminders-changed` if the list changed. Never creates outbox entries.
    fn with_reminders<T>(&self, f: impl FnOnce(&mut Vec<Reminder>) -> T) -> Result<T, String>;
    /// `notes-changed` to the notes window.
    fn notes_changed(&self, payload: &NotesChangedPayload);
    /// Toast/sound for a reminder that became due remotely.
    fn alert(&self, note_id: &str);
    /// Corrected device time.
    fn now(&self) -> DateTime<Utc>;
    fn set_clock_offset(&self, offset_ms: i64);
    /// Zone for reminders that arrive without one (legacy data of other devices).
    fn default_zone(&self) -> Tz;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Net(ClientError),
    /// Not connected (no device id / token).
    NotConnected,
    Local(String),
}

impl From<ClientError> for SyncError {
    fn from(e: ClientError) -> Self {
        Self::Net(e)
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Net(e) => e.fmt(f),
            Self::NotConnected => write!(f, "not connected"),
            Self::Local(e) => write!(f, "local: {e}"),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub pushed: usize,
    /// Local changes replaced by a newer server version ("stale").
    pub stale: usize,
    pub invalid: usize,
    pub pulled: usize,
}

pub struct Engine<'a, L: LocalData> {
    pub local: &'a L,
    pub core: &'a SyncCore,
    pub client: &'a Client,
}

fn load_opt(s: &Storage, id: &str) -> Result<Option<Note>, StorageError> {
    match s.load_note(id) {
        Ok(n) => Ok(Some(n)),
        Err(StorageError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Puts every local note, reminder and the order into the outbox (first connect,
/// 410 full re-sync): the union with the server, decided by LWW per id.
pub fn enqueue_all<L: LocalData>(local: &L, core: &SyncCore) -> Result<(), String> {
    let ids = local
        .with_storage(|s| {
            s.list_notes()
                .map(|n| n.into_iter().map(|n| n.id).collect::<Vec<_>>())
        })?
        .map_err(|e| e.to_string())?;
    let reminder_ids =
        local.with_reminders(|l| l.iter().map(|r| r.note_id.clone()).collect::<Vec<_>>())?;
    let now = format_utc(&local.now());
    core.outbox_update(|o| {
        for id in &ids {
            if !o.notes.contains_key(id) {
                o.changed(Kind::Note, id);
            }
        }
        for id in &reminder_ids {
            if !o.reminders.contains_key(id) {
                o.changed(Kind::Reminder, id);
            }
        }
        if o.order.is_none() {
            o.order_changed(&now);
        }
    });
    Ok(())
}

impl<L: LocalData> Engine<'_, L> {
    fn device_id(&self) -> Result<String, SyncError> {
        self.core.meta().device_id.ok_or(SyncError::NotConnected)
    }

    fn sample(&self, offset: Option<i64>) {
        if let Some(o) = offset {
            let ms = self.core.meta_update(|m| {
                m.clock_offsets.push(o);
                m.clock_offsets.offset_ms()
            });
            self.local.set_clock_offset(ms);
        }
    }

    /// Push, then pull. `pull_timeout` is shorter for the start-up pull.
    pub async fn run(&self, pull_timeout: Duration) -> Result<Report, SyncError> {
        let mut report = Report::default();
        self.push(&mut report).await?;
        self.pull(pull_timeout, &mut report).await?;
        Ok(report)
    }

    /// Pull only (start-up, before the scheduler fires).
    pub async fn pull_only(&self, timeout: Duration) -> Result<Report, SyncError> {
        let mut report = Report::default();
        self.pull(timeout, &mut report).await?;
        Ok(report)
    }

    pub async fn push(&self, report: &mut Report) -> Result<(), SyncError> {
        let device = self.device_id()?;
        let snap = self.core.outbox();
        if snap.is_empty() {
            return Ok(());
        }
        let now = format_utc(&self.local.now());

        // read the newest local versions (short storage lock)
        let notes: Vec<(NoteRecord, u64)> = self
            .local
            .with_storage(|s| {
                snap.notes
                    .iter()
                    .filter_map(|(id, p)| match load_opt(s, id) {
                        Ok(n) => Some((push_note_record(id, n.as_ref(), p, &device, &now), p.rev)),
                        Err(e) => {
                            // corrupt file: never send a tombstone for it
                            log::warn!("note {id} not readable, not pushed: {e}");
                            None
                        }
                    })
                    .collect()
            })
            .map_err(SyncError::Local)?;
        let reminders: Vec<(ReminderRecord, u64)> = self
            .local
            .with_reminders(|list| {
                snap.reminders
                    .iter()
                    .map(|(id, p)| {
                        let r = list.iter().find(|r| &r.note_id == id);
                        (push_reminder_record(id, r, p, &device, &now), p.rev)
                    })
                    .collect()
            })
            .map_err(SyncError::Local)?;
        let order = match &snap.order {
            Some(p) => {
                let ids = self
                    .local
                    .with_storage(|s| {
                        s.list_notes()
                            .map(|l| l.into_iter().map(|n| n.id).collect())
                    })
                    .map_err(SyncError::Local)?
                    .map_err(|e| SyncError::Local(e.to_string()))?;
                Some((merge::push_order_record(ids, p, &device), p.rev))
            }
            None => None,
        };

        let batches = notes
            .len()
            .max(reminders.len())
            .div_ceil(PUSH_BATCH_MAX)
            .max(1);
        let mut order = order;
        for b in 0..batches {
            let range =
                |len: usize| (b * PUSH_BATCH_MAX).min(len)..((b + 1) * PUSH_BATCH_MAX).min(len);
            let n = &notes[range(notes.len())];
            let r = &reminders[range(reminders.len())];
            let o = order.take();
            if n.is_empty() && r.is_empty() && o.is_none() {
                continue;
            }
            let req = PushRequest {
                notes: n.iter().map(|(x, _)| x.clone()).collect(),
                reminders: r.iter().map(|(x, _)| x.clone()).collect(),
                order: o.as_ref().map(|(x, _)| x.clone()),
                device_state: None,
            };
            let resp = self.client.push(&req).await?;
            self.sample(resp.offset_sample);
            let rev_of = |kind: RecordKind, id: &str| -> Option<u64> {
                match kind {
                    RecordKind::Note => n.iter().find(|(x, _)| x.id == id).map(|(_, r)| *r),
                    RecordKind::Reminder => {
                        r.iter().find(|(x, _)| x.note_id == id).map(|(_, r)| *r)
                    }
                    RecordKind::Order => o.as_ref().map(|(_, r)| *r),
                }
            };
            for res in &resp.value.results {
                let Some(rev) = rev_of(res.kind, &res.id) else {
                    continue;
                };
                match res.status {
                    PushStatus::Applied => {
                        report.pushed += 1;
                        self.ack(res.kind, &res.id, rev);
                    }
                    PushStatus::Invalid => {
                        report.invalid += 1;
                        log::warn!("server rejected {:?} {} as invalid", res.kind, res.id);
                        self.ack(res.kind, &res.id, rev);
                    }
                    PushStatus::Stale => {
                        report.stale += 1;
                        self.take_stale(res, rev)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn ack(&self, kind: RecordKind, id: &str, rev: u64) {
        self.core.outbox_update(|o| match kind {
            RecordKind::Note => o.ack(Kind::Note, id, rev),
            RecordKind::Reminder => o.ack(Kind::Reminder, id, rev),
            RecordKind::Order => o.ack_order(rev),
        });
    }

    /// A pushed record lost against a newer server version: take the server version
    /// over, unless the user changed the document again meanwhile.
    fn take_stale(&self, res: &buddy_core::sync::PushResult, rev: u64) -> Result<(), SyncError> {
        // check and drop in one step: an edit saved meanwhile (new rev) keeps its entry
        let take = |kind: Kind| self.core.outbox_update(|o| o.ack(kind, &res.id, rev));
        match res.kind {
            RecordKind::Note => {
                if let Some(remote) = &res.note
                    && take(Kind::Note)
                {
                    let page = SyncChanges {
                        cursor: 0,
                        has_more: false,
                        notes: vec![remote.clone()],
                        reminders: vec![],
                        order: None,
                        server_time: String::new(),
                    };
                    self.merge_notes(&page)?;
                }
            }
            RecordKind::Reminder => {
                if let Some(remote) = &res.reminder
                    && take(Kind::Reminder)
                {
                    self.merge_reminders(std::slice::from_ref(remote))?;
                }
            }
            RecordKind::Order => {
                // the ack runs first, so it also happens when the answer carries no order
                if self.core.outbox_update(|o| o.ack_order(rev))
                    && let Some(remote) = &res.order
                {
                    let page = SyncChanges {
                        cursor: 0,
                        has_more: false,
                        notes: vec![],
                        reminders: vec![],
                        order: Some(remote.clone()),
                        server_time: String::new(),
                    };
                    self.merge_notes(&page)?;
                }
            }
        }
        Ok(())
    }

    async fn pull(&self, timeout: Duration, report: &mut Report) -> Result<(), SyncError> {
        self.device_id()?;
        let mut resynced = false;
        loop {
            let cursor = self.core.meta().cursor;
            let page = match self.client.changes(cursor, timeout).await {
                Ok(p) => p,
                Err(ClientError::ResyncRequired) if !resynced => {
                    // 410: our cursor is older than the server keeps tombstones →
                    // load everything again; the outbox stays and gets all local data.
                    log::info!("server requires a full re-sync");
                    resynced = true;
                    enqueue_all(self.local, self.core).map_err(SyncError::Local)?;
                    self.core.meta_update(|m| m.cursor = 0);
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            self.sample(page.offset_sample);
            let page = page.value;
            report.pulled +=
                page.notes.len() + page.reminders.len() + usize::from(page.order.is_some());
            self.merge_notes(&page)?;
            self.merge_reminders(&page.reminders)?;
            self.core
                .meta_update(|m| m.cursor = page.cursor.max(m.cursor));
            if !page.has_more {
                break;
            }
        }
        let now = format_utc(&self.local.now());
        self.core.meta_update(|m| {
            m.last_sync_at = Some(now);
            m.last_error = None;
        });
        Ok(())
    }

    /// Merges notes and order of one page under the storage lock and emits one
    /// `notes-changed`.
    fn merge_notes(&self, page: &SyncChanges) -> Result<(), SyncError> {
        if page.notes.is_empty() && page.order.is_none() {
            return Ok(());
        }
        let device = self.device_id()?;
        let now = format_utc(&self.local.now());
        let (payload, failed) = self
            .local
            .with_storage(|s| {
                let mut payload = NotesChangedPayload::default();
                let mut failed = 0usize;
                for remote in &page.notes {
                    let pending: Option<Pending> = self.core.pending(Kind::Note, &remote.id);
                    let local = match load_opt(s, &remote.id) {
                        Ok(n) => n,
                        Err(e) => {
                            log::warn!("note {} not readable: {e}", remote.id);
                            None
                        }
                    };
                    if decide_note(local.as_ref(), pending.as_ref(), remote, &device, &now)
                        == Decision::Keep
                    {
                        continue;
                    }
                    let result = match (&remote.note, remote.deleted) {
                        (_, true) => s.delete_note(&remote.id).map(|()| {
                            payload.deleted_ids.push(remote.id.clone());
                        }),
                        (Some(n), false) => s.save_note(n).map(|n| payload.notes.push(n)),
                        (None, false) => Ok(()),
                    };
                    match result {
                        Ok(()) => {
                            if pending.is_some() {
                                self.core.drop_pending(Kind::Note, &remote.id);
                            }
                        }
                        Err(e) => {
                            log::warn!("could not apply remote note {}: {e}", remote.id);
                            // a newer-version file is refused forever; retrying would block the sync
                            if !matches!(e, StorageError::NewerVersion(_)) {
                                failed += 1;
                            }
                        }
                    }
                }
                if let Some(remote) = &page.order {
                    let ids: Vec<String> = s
                        .list_notes()
                        .map(|l| l.into_iter().map(|n| n.id).collect())
                        .unwrap_or_default();
                    let pending = self.core.pending_order();
                    if decide_order(&ids, pending.as_ref(), remote, &device) == Decision::Apply {
                        match s.save_order(&remote.ids) {
                            Ok(()) => {
                                if let Some(p) = pending {
                                    self.core.outbox_update(|o| o.ack_order(p.rev));
                                }
                                let ids = s
                                    .list_notes()
                                    .map(|l| l.into_iter().map(|n| n.id).collect())
                                    .unwrap_or_default();
                                payload.order = Some(ids);
                            }
                            Err(e) => {
                                log::warn!("could not apply remote order: {e}");
                                failed += 1;
                            }
                        }
                    }
                }
                (payload, failed)
            })
            .map_err(SyncError::Local)?;
        if !payload.notes.is_empty() || !payload.deleted_ids.is_empty() || payload.order.is_some() {
            self.local.notes_changed(&payload);
        }
        if failed > 0 {
            // keep the cursor: the page is pulled again next cycle (applied records are echoes)
            return Err(SyncError::Local(format!(
                "{failed} remote change(s) not written"
            )));
        }
        Ok(())
    }

    /// Merges reminder records under the reminders lock; alarms afterwards.
    fn merge_reminders(&self, records: &[ReminderRecord]) -> Result<(), SyncError> {
        if records.is_empty() {
            return Ok(());
        }
        let device = self.device_id()?;
        let now_t = self.local.now();
        let now = format_utc(&now_t);
        let zone = self.local.default_zone();
        let alerts = self
            .local
            .with_reminders(|list| {
                let mut alerts = Vec::new();
                for remote in records {
                    let id = &remote.note_id;
                    let pending = self.core.pending(Kind::Reminder, id);
                    let pos = list.iter().position(|r| &r.note_id == id);
                    let before = pos.map(|i| list[i].clone());
                    if decide_reminder(before.as_ref(), pending.as_ref(), remote, &device, &now)
                        == Decision::Keep
                    {
                        continue;
                    }
                    match (&remote.reminder, remote.deleted) {
                        (_, true) => {
                            schedule::remove(list, id);
                        }
                        (Some(r), false) => {
                            let mut r = r.clone();
                            if r.time_zone
                                .as_deref()
                                .and_then(buddy_core::zoned::parse_zone)
                                .is_none()
                            {
                                r.time_zone = Some(zone.name().to_string());
                            }
                            if merge::should_alert(before.as_ref(), &r, &now_t) {
                                alerts.push(r.note_id.clone());
                            }
                            match pos {
                                Some(i) => list[i] = r,
                                None => list.push(r),
                            }
                        }
                        (None, false) => continue,
                    }
                    if pending.is_some() {
                        self.core.drop_pending(Kind::Reminder, id);
                    }
                }
                alerts
            })
            .map_err(SyncError::Local)?;
        for id in alerts {
            self.local.alert(&id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
