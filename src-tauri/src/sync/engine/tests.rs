//! Engine tests against an HTTP mock of the sync server (no real network): a tiny
//! in-memory server with server-side LWW (`buddy_core::lww`), seq cursor and
//! `stale` answers, plus in-memory local data on a temp dir.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use buddy_core::lww::{Winner, note_winner, order_winner, reminder_winner};
use buddy_core::sync::{
    NoteRecord, OrderRecord, PushRequest, PushResponse, PushResult, ReminderRecord, SyncChanges,
};
use buddy_core::zoned::parse_instant;
use serde_json::json;

use super::*;
use crate::model::{NoteColor, ReminderRepeat, ReminderState};
use crate::state::lock;
use crate::sync::client::tests::{MockServer, Seen, fake_clock};

const SERVER_TIME: &str = "2026-11-06T12:00:00.000Z";

#[derive(Default)]
struct ServerData {
    seq: i64,
    notes: BTreeMap<String, (NoteRecord, i64)>,
    reminders: BTreeMap<String, (ReminderRecord, i64)>,
    order: Option<(OrderRecord, i64)>,
    /// Answer `/sync/changes` with 410 once.
    gone_once: bool,
    /// Answer every request with this status.
    fail: Option<u16>,
}

fn same<T: PartialEq>(a: &T, b: &T) -> bool {
    a == b
}

fn handle(data: &Mutex<ServerData>, req: &Seen) -> (u16, String) {
    let mut d = lock(data);
    if let Some(code) = d.fail {
        return (code, json!({"error": "x", "message": "x"}).to_string());
    }
    if req.auth.as_deref() != Some("Bearer tok") {
        return (
            401,
            json!({"error": "unauthorized", "message": "x"}).to_string(),
        );
    }
    if req.method == "POST" && req.path == "/api/v1/sync/push" {
        let push: PushRequest = serde_json::from_str(&req.body).unwrap();
        let mut results = Vec::new();
        for n in push.notes {
            let current = d.notes.get(&n.id).map(|(r, _)| r.clone());
            let accept = current
                .as_ref()
                .is_none_or(|c| same(c, &n) || note_winner(c, &n) == Winner::Remote);
            if accept {
                d.seq += 1;
                let seq = d.seq;
                d.notes.insert(n.id.clone(), (n.clone(), seq));
                results.push(PushResult {
                    kind: buddy_core::sync::RecordKind::Note,
                    id: n.id.clone(),
                    status: PushStatus::Applied,
                    note: Some(n),
                    reminder: None,
                    order: None,
                    clamped_updated_at: None,
                    message: None,
                });
            } else {
                results.push(PushResult {
                    kind: buddy_core::sync::RecordKind::Note,
                    id: n.id.clone(),
                    status: PushStatus::Stale,
                    note: current,
                    reminder: None,
                    order: None,
                    clamped_updated_at: None,
                    message: None,
                });
            }
        }
        for r in push.reminders {
            let current = d.reminders.get(&r.note_id).map(|(x, _)| x.clone());
            let accept = current
                .as_ref()
                .is_none_or(|c| same(c, &r) || reminder_winner(c, &r) == Winner::Remote);
            let status = if accept {
                d.seq += 1;
                let seq = d.seq;
                d.reminders.insert(r.note_id.clone(), (r.clone(), seq));
                PushStatus::Applied
            } else {
                PushStatus::Stale
            };
            results.push(PushResult {
                kind: buddy_core::sync::RecordKind::Reminder,
                id: r.note_id.clone(),
                status,
                note: None,
                reminder: if accept { Some(r) } else { current },
                order: None,
                clamped_updated_at: None,
                message: None,
            });
        }
        if let Some(o) = push.order {
            let current = d.order.as_ref().map(|(x, _)| x.clone());
            let accept = current
                .as_ref()
                .is_none_or(|c| same(c, &o) || order_winner(c, &o) == Winner::Remote);
            if accept {
                d.seq += 1;
                let seq = d.seq;
                d.order = Some((o.clone(), seq));
            }
            results.push(PushResult {
                kind: buddy_core::sync::RecordKind::Order,
                id: "order".into(),
                status: if accept {
                    PushStatus::Applied
                } else {
                    PushStatus::Stale
                },
                note: None,
                reminder: None,
                order: if accept { Some(o) } else { current },
                clamped_updated_at: None,
                message: None,
            });
        }
        let resp = PushResponse {
            results,
            cursor: d.seq,
            server_time: SERVER_TIME.into(),
        };
        return (200, serde_json::to_string(&resp).unwrap());
    }
    if req.method == "GET" && req.path.starts_with("/api/v1/sync/changes") {
        if d.gone_once {
            d.gone_once = false;
            return (
                410,
                json!({"error": "full_resync_required", "message": "x"}).to_string(),
            );
        }
        let since: i64 = req
            .path
            .split("since=")
            .nth(1)
            .and_then(|s| s.split('&').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let resp = SyncChanges {
            cursor: d.seq,
            has_more: false,
            notes: d
                .notes
                .values()
                .filter(|(_, s)| *s > since)
                .map(|(r, _)| r.clone())
                .collect(),
            reminders: d
                .reminders
                .values()
                .filter(|(_, s)| *s > since)
                .map(|(r, _)| r.clone())
                .collect(),
            order: d
                .order
                .as_ref()
                .filter(|(_, s)| *s > since)
                .map(|(o, _)| o.clone()),
            server_time: SERVER_TIME.into(),
        };
        return (200, serde_json::to_string(&resp).unwrap());
    }
    (
        404,
        json!({"error": "not_found", "message": "x"}).to_string(),
    )
}

struct FakeServer {
    data: Arc<Mutex<ServerData>>,
    mock: MockServer,
}

fn server() -> FakeServer {
    let data = Arc::new(Mutex::new(ServerData::default()));
    let d2 = data.clone();
    let mock = MockServer::start(Arc::new(move |req| handle(&d2, req)));
    FakeServer { data, mock }
}

struct TestLocal {
    _dir: tempfile::TempDir,
    storage: Mutex<Storage>,
    reminders: Mutex<Vec<Reminder>>,
    changed: Mutex<Vec<NotesChangedPayload>>,
    alerts: Mutex<Vec<String>>,
    offset: Mutex<i64>,
    now: Mutex<DateTime<Utc>>,
    core: SyncCore,
}

impl TestLocal {
    fn new(device: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path().to_path_buf());
        let core = SyncCore::load(dir.path());
        core.meta_update(|m| m.device_id = Some(device.into()));
        Self {
            storage: Mutex::new(storage),
            _dir: dir,
            reminders: Mutex::new(Vec::new()),
            changed: Mutex::new(Vec::new()),
            alerts: Mutex::new(Vec::new()),
            offset: Mutex::new(0),
            now: Mutex::new(parse_instant(SERVER_TIME).unwrap()),
            core,
        }
    }

    /// A local edit: write the file and record it in the outbox (like the hook does).
    fn edit(&self, id: &str, title: &str, at: &str) {
        let s = lock(&self.storage);
        s.save_note(&note(id, title, at)).unwrap();
        self.core.outbox_update(|o| o.changed(Kind::Note, id));
    }

    fn delete(&self, id: &str, at: &str) {
        let s = lock(&self.storage);
        s.delete_note(id).unwrap();
        self.core.outbox_update(|o| o.deleted(Kind::Note, id, at));
    }

    fn title(&self, id: &str) -> Option<String> {
        lock(&self.storage).load_note(id).ok().map(|n| n.title)
    }

    fn run(&self, srv: &FakeServer) -> Result<Report, SyncError> {
        let clock = fake_clock(SERVER_TIME, 10);
        let client = Client::new(&srv.mock.url, Some("tok".into()), clock).unwrap();
        let engine = Engine {
            local: self,
            core: &self.core,
            client: &client,
        };
        tauri::async_runtime::block_on(engine.run(Duration::from_secs(5)))
    }
}

impl LocalData for TestLocal {
    fn with_storage<T>(&self, f: impl FnOnce(&Storage) -> T) -> Result<T, String> {
        Ok(f(&lock(&self.storage)))
    }
    fn with_reminders<T>(&self, f: impl FnOnce(&mut Vec<Reminder>) -> T) -> Result<T, String> {
        Ok(f(&mut lock(&self.reminders)))
    }
    fn notes_changed(&self, payload: &NotesChangedPayload) {
        lock(&self.changed).push(payload.clone());
    }
    fn alert(&self, note_id: &str) {
        lock(&self.alerts).push(note_id.into());
    }
    fn now(&self) -> DateTime<Utc> {
        *lock(&self.now)
    }
    fn set_clock_offset(&self, offset_ms: i64) {
        *lock(&self.offset) = offset_ms;
    }
    fn default_zone(&self) -> Tz {
        chrono_tz::Europe::Berlin
    }
}

const A: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";
const B: &str = "1b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";

fn note(id: &str, title: &str, at: &str) -> Note {
    Note {
        id: id.into(),
        title: title.into(),
        color: NoteColor::Blue,
        content: json!({"type": "doc", "content": []}),
        created_at: "2026-11-01T00:00:00.000Z".into(),
        updated_at: at.into(),
        schema_version: 1,
    }
}

#[test]
fn edit_on_one_pc_reaches_the_other() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    pc1.edit(A, "Einkauf", "2026-11-06T10:00:00.000Z");
    let r = pc1.run(&srv).unwrap();
    assert_eq!(r.pushed, 1);
    assert_eq!(pc1.core.pending_count(), 0, "outbox emptied after applied");
    assert!(lock(&pc1.changed).is_empty(), "own echo is skipped");

    pc2.run(&srv).unwrap();
    assert_eq!(pc2.title(A).as_deref(), Some("Einkauf"));
    let changed = lock(&pc2.changed);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].notes[0].id, A);
    assert_eq!(
        pc2.core.pending_count(),
        0,
        "taken-over data is not in the outbox"
    );
    assert!(pc2.core.meta().cursor > 0);
    assert!(pc2.core.meta().last_sync_at.is_some());
}

#[test]
fn a_remote_note_that_cannot_be_written_is_pulled_again() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    pc1.edit(A, "Einkauf", "2026-11-06T10:00:00.000Z");
    pc1.run(&srv).unwrap();

    // e.g. a virus scanner holds the file: the rename onto `<id>.json` fails
    let blocked = lock(&pc2.storage)
        .root()
        .join("notes")
        .join(format!("{A}.json"));
    std::fs::create_dir_all(&blocked).unwrap();
    std::fs::write(blocked.join("x"), "x").unwrap();
    assert!(matches!(pc2.run(&srv), Err(SyncError::Local(_))));
    assert_eq!(pc2.core.meta().cursor, 0, "cursor kept for the retry");

    std::fs::remove_dir_all(&blocked).unwrap();
    pc2.run(&srv).unwrap();
    assert_eq!(pc2.title(A).as_deref(), Some("Einkauf"));
}

/// §13 16a/16b: the newer edit wins, regardless of who arrives last.
#[test]
fn offline_edits_newest_wins_in_both_orders() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let phone = TestLocal::new("phone");
    pc1.edit(A, "v0", "2026-11-06T09:00:00.000Z");
    pc1.run(&srv).unwrap();
    phone.run(&srv).unwrap();

    // both offline: phone edits at 10:00, pc at 11:00; phone comes online FIRST
    phone.edit(A, "phone", "2026-11-06T10:00:00.000Z");
    pc1.edit(A, "pc", "2026-11-06T11:00:00.000Z");
    phone.run(&srv).unwrap();
    let r = pc1.run(&srv).unwrap();
    assert_eq!(r.stale, 0);
    phone.run(&srv).unwrap();
    assert_eq!(phone.title(A).as_deref(), Some("pc"));
    assert_eq!(pc1.title(A).as_deref(), Some("pc"));

    // now the later edit (phone, 13:00) arrives after the earlier one (pc, 12:00)
    pc1.edit(A, "pc2", "2026-11-06T12:00:00.000Z");
    phone.edit(A, "phone2", "2026-11-06T13:00:00.000Z");
    pc1.run(&srv).unwrap();
    phone.run(&srv).unwrap();
    pc1.run(&srv).unwrap();
    assert_eq!(pc1.title(A).as_deref(), Some("phone2"));
    assert_eq!(phone.title(A).as_deref(), Some("phone2"));

    // older offline edit → server answers stale, the PC takes the server version over
    pc1.edit(A, "late but old", "2026-11-06T12:30:00.000Z");
    let r = pc1.run(&srv).unwrap();
    assert_eq!(r.stale, 1);
    assert_eq!(pc1.title(A).as_deref(), Some("phone2"));
    assert_eq!(pc1.core.pending_count(), 0);
}

#[test]
fn deletion_is_a_tombstone_and_a_later_edit_resurrects() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    pc1.edit(A, "x", "2026-11-06T09:00:00.000Z");
    pc1.run(&srv).unwrap();
    pc2.run(&srv).unwrap();
    pc1.delete(A, "2026-11-06T10:00:00.000Z");
    pc1.run(&srv).unwrap();
    assert!(lock(&srv.data).notes[A].0.deleted);
    pc2.run(&srv).unwrap();
    assert_eq!(pc2.title(A), None);
    assert_eq!(
        lock(&pc2.changed).last().unwrap().deleted_ids,
        vec![A.to_string()]
    );

    pc2.edit(A, "zurück", "2026-11-06T11:00:00.000Z");
    pc2.run(&srv).unwrap();
    pc1.run(&srv).unwrap();
    assert_eq!(pc1.title(A).as_deref(), Some("zurück"));
}

#[test]
fn pending_local_edit_survives_an_older_remote_version() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    pc1.edit(A, "remote", "2026-11-06T10:00:00.000Z");
    pc1.run(&srv).unwrap();
    // pc2 edits *later* while offline; the pull of the older remote must not overwrite it
    pc2.edit(A, "local", "2026-11-06T10:05:00.000Z");
    let clock = fake_clock(SERVER_TIME, 10);
    let client = Client::new(&srv.mock.url, Some("tok".into()), clock).unwrap();
    let engine = Engine {
        local: &pc2,
        core: &pc2.core,
        client: &client,
    };
    tauri::async_runtime::block_on(engine.pull_only(Duration::from_secs(5))).unwrap();
    assert_eq!(pc2.title(A).as_deref(), Some("local"));
    assert_eq!(pc2.core.pending_count(), 1);
    pc2.run(&srv).unwrap();
    assert_eq!(
        lock(&srv.data).notes[A].0.note.as_ref().unwrap().title,
        "local"
    );
}

#[test]
fn edit_during_push_stays_in_the_outbox() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    pc1.edit(A, "one", "2026-11-06T10:00:00.000Z");
    let rev = pc1.core.pending(Kind::Note, A).unwrap().rev;
    pc1.edit(A, "two", "2026-11-06T10:00:01.000Z"); // simulates an edit racing the push ack
    assert!(!pc1.core.outbox_update(|o| o.ack(Kind::Note, A, rev)));
    pc1.run(&srv).unwrap();
    assert_eq!(pc1.core.pending_count(), 0);
}

#[test]
fn first_connect_unites_both_sides_and_order_syncs() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    lock(&pc1.storage)
        .save_note(&note(A, "pc1", "2026-11-06T08:00:00.000Z"))
        .unwrap();
    lock(&pc2.storage)
        .save_note(&note(B, "pc2", "2026-11-06T08:00:00.000Z"))
        .unwrap();
    enqueue_all(&pc1, &pc1.core).unwrap();
    enqueue_all(&pc2, &pc2.core).unwrap();
    assert_eq!(pc1.core.pending_count(), 2, "note + order");
    pc1.run(&srv).unwrap();
    pc2.run(&srv).unwrap();
    pc1.run(&srv).unwrap();
    assert_eq!(pc1.title(B).as_deref(), Some("pc2"));
    assert_eq!(pc2.title(A).as_deref(), Some("pc1"));
    // both have both notes, in the same order
    let ids = |l: &TestLocal| {
        lock(&l.storage)
            .list_notes()
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&pc1), ids(&pc2));
}

#[test]
fn reminders_sync_with_tombstones_and_due_alert() {
    let srv = server();
    let pc1 = TestLocal::new("pc1");
    let pc2 = TestLocal::new("pc2");
    pc1.edit(A, "x", "2026-11-06T09:00:00.000Z");
    let r = Reminder {
        note_id: A.into(),
        at: "2026-11-06T11:55:00.000Z".into(),
        repeat: ReminderRepeat::Daily,
        state: ReminderState::Scheduled,
        fired_at: None,
        updated_at: Some("2026-11-06T09:00:00.000Z".into()),
        time_zone: Some("America/New_York".into()),
    };
    lock(&pc1.reminders).push(r.clone());
    pc1.core.outbox_update(|o| o.changed(Kind::Reminder, A));
    pc1.run(&srv).unwrap();
    pc2.run(&srv).unwrap();
    assert_eq!(lock(&pc2.reminders).clone(), vec![r.clone()]);
    assert!(lock(&pc2.alerts).is_empty());

    // the server's scheduler marked it due (updatedAt unchanged, D-30) → pc2 alarms once
    {
        let mut d = lock(&srv.data);
        d.seq += 1;
        let seq = d.seq;
        let entry = d.reminders.get_mut(A).unwrap();
        let rr = entry.0.reminder.as_mut().unwrap();
        rr.state = ReminderState::Due;
        rr.fired_at = Some("2026-11-06T11:55:00.000Z".into());
        entry.1 = seq;
    }
    pc2.run(&srv).unwrap();
    assert_eq!(lock(&pc2.alerts).clone(), vec![A.to_string()]);
    assert_eq!(lock(&pc2.reminders)[0].state, ReminderState::Due);
    pc2.run(&srv).unwrap();
    assert_eq!(lock(&pc2.alerts).len(), 1, "no second alarm");

    // removed on pc1 → tombstone → gone on pc2
    lock(&pc1.reminders).clear();
    pc1.core
        .outbox_update(|o| o.deleted(Kind::Reminder, A, "2026-11-06T12:00:00.000Z"));
    pc1.run(&srv).unwrap();
    pc2.run(&srv).unwrap();
    assert!(lock(&pc2.reminders).is_empty());
}

#[test]
fn legacy_remote_reminder_gets_the_default_zone() {
    let srv = server();
    let pc = TestLocal::new("pc1");
    {
        let mut d = lock(&srv.data);
        d.seq = 1;
        d.reminders.insert(
            A.into(),
            (
                ReminderRecord {
                    note_id: A.into(),
                    updated_at: "2026-11-06T09:00:00.000Z".into(),
                    updated_by: "web".into(),
                    deleted: false,
                    reminder: Some(Reminder {
                        note_id: A.into(),
                        at: "2026-11-07T08:00:00.000Z".into(),
                        repeat: ReminderRepeat::None,
                        state: ReminderState::Scheduled,
                        fired_at: None,
                        updated_at: Some("2026-11-06T09:00:00.000Z".into()),
                        time_zone: None,
                    }),
                },
                1,
            ),
        );
    }
    pc.run(&srv).unwrap();
    assert_eq!(
        lock(&pc.reminders)[0].time_zone.as_deref(),
        Some("Europe/Berlin")
    );
}

#[test]
fn errors_keep_the_outbox_and_410_triggers_full_resync() {
    let srv = server();
    let pc = TestLocal::new("pc1");
    pc.edit(A, "x", "2026-11-06T10:00:00.000Z");

    lock(&srv.data).fail = Some(503);
    assert!(matches!(
        pc.run(&srv),
        Err(SyncError::Net(ClientError::Server { status: 503, .. }))
    ));
    assert_eq!(pc.core.pending_count(), 1);
    lock(&srv.data).fail = Some(401);
    assert_eq!(pc.run(&srv), Err(SyncError::Net(ClientError::Unauthorized)));
    assert_eq!(pc.core.pending_count(), 1, "401 keeps the outbox");
    lock(&srv.data).fail = None;
    pc.run(&srv).unwrap();
    assert_eq!(pc.core.pending_count(), 0);

    // server lost its data (e.g. restored backup) and answers 410
    {
        let mut d = lock(&srv.data);
        *d = ServerData {
            gone_once: true,
            ..Default::default()
        };
    }
    pc.run(&srv).unwrap();
    assert_eq!(
        pc.core.pending_count(),
        2,
        "everything re-queued (note + order)"
    );
    assert_eq!(pc.core.meta().cursor, 0);
    pc.run(&srv).unwrap();
    assert!(lock(&srv.data).notes.contains_key(A));
}

#[test]
fn clock_offset_is_measured_and_handed_to_the_clock() {
    let srv = server();
    let pc = TestLocal::new("pc1");
    pc.run(&srv).unwrap();
    // fake device clock starts at SERVER_TIME and advances 10 ms per reading:
    // offset = server − (sent + rtt/2) = −5 ms
    assert_eq!(*lock(&pc.offset), -5);
    assert_eq!(pc.core.meta().clock_offsets.0, vec![-5]);
}

#[test]
fn not_connected_without_device_id() {
    let srv = server();
    let pc = TestLocal::new("pc1");
    pc.core.meta_update(|m| m.device_id = None);
    assert_eq!(pc.run(&srv), Err(SyncError::NotConnected));
}

#[test]
fn large_outbox_goes_in_packages_of_200() {
    let srv = server();
    let pc = TestLocal::new("pc1");
    for i in 0..450u32 {
        let id = format!("{:08x}-0000-4000-8000-000000000000", i);
        pc.edit(&id, "n", "2026-11-06T10:00:00.000Z");
    }
    pc.run(&srv).unwrap();
    assert_eq!(pc.core.pending_count(), 0);
    let pushes = srv
        .mock
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path == "/api/v1/sync/push")
        .map(|s| {
            serde_json::from_str::<PushRequest>(&s.body)
                .unwrap()
                .notes
                .len()
        })
        .collect::<Vec<_>>();
    assert_eq!(pushes, vec![200, 200, 50]);
}
