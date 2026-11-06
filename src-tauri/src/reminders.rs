//! v2 reminders (PLAN §11/§12): `reminders.json` store, scheduler thread,
//! notification and sound.
//!
//! Reminders live in their own file (never inside a note), so a note autosave can
//! never overwrite reminder state. The pure logic is in [`schedule`] (repeat math,
//! state transitions) and [`text`] (TipTap → plain text); this module only adds
//! storage, locking, events and the scheduler thread.
//!
//! Lock order: the reminders lock is never held while taking an `AppState` lock
//! (note lookups happen before/after, never inside it).

pub use buddy_core::{schedule, text};

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::Duration;

use chrono_tz::Tz;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clock::corrected_now;
use crate::model::{
    Note, REMINDERS_SCHEMA_VERSION, Reminder, ReminderRepeat, RemindersFile, is_valid_note_id,
};
use crate::state::lock;
use crate::storage::{Read, read_json, write_json_atomic};

pub const REMINDERS_FILE: &str = "reminders.json";
pub const REMINDERS_CHANGED: &str = "reminders-changed";
pub const OPEN_NOTE: &str = "open-note";
/// Longest scheduler sleep; also bounds how late a wall-clock jump (sleep/hibernate,
/// clock change) is noticed.
pub const MAX_SLEEP: Duration = Duration::from_secs(30);
/// Longest wait for the sync start-up pull before missed reminders fire.
pub const START_PULL_WAIT: Duration = Duration::from_secs(8);
/// Characters of note text in the notification body.
pub const BODY_CHARS: usize = 100;
/// Windows toast sound (`ms-winsoundevent:Notification.Reminder`). Without a sound
/// name notify-rust sends a *silent* toast, so the setting maps exactly onto the toast.
#[cfg(windows)]
const TOAST_SOUND: &str = "Reminder";

/// Managed state of this module (registered in [`init`]).
pub struct RemindersState {
    path: PathBuf,
    reminders: Mutex<Vec<Reminder>>,
    /// Set when the scheduler should re-evaluate (a reminder changed / quit began).
    wake: Mutex<bool>,
    wake_cv: Condvar,
}

impl RemindersState {
    fn new(path: PathBuf, reminders: Vec<Reminder>) -> Self {
        Self {
            path,
            reminders: Mutex::new(reminders),
            wake: Mutex::new(false),
            wake_cv: Condvar::new(),
        }
    }

    fn notify(&self) {
        *lock(&self.wake) = true;
        self.wake_cv.notify_all();
    }

    /// Sleeps up to `timeout` or until [`Self::notify`].
    fn sleep(&self, timeout: Duration) {
        let guard = lock(&self.wake);
        let (mut guard, _) = self
            .wake_cv
            .wait_timeout_while(guard, timeout, |woken| !*woken)
            .unwrap_or_else(|e| e.into_inner());
        *guard = false;
    }

    fn persist(&self, list: &[Reminder]) {
        let file = RemindersFile {
            schema_version: REMINDERS_SCHEMA_VERSION,
            reminders: list.to_vec(),
        };
        if let Err(e) = write_json_atomic(&self.path, &file) {
            log::error!("could not save {}: {e}", self.path.display());
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenNotePayload<'a> {
    note_id: &'a str,
}

fn load_file(path: &std::path::Path) -> Vec<Reminder> {
    match read_json::<RemindersFile>(path) {
        Ok(Read::Ok(file)) => {
            if file.schema_version > REMINDERS_SCHEMA_VERSION {
                log::warn!(
                    "{} has newer schema version {}",
                    path.display(),
                    file.schema_version
                );
            }
            schedule::sanitize(file.reminders, device_zone())
        }
        Ok(Read::Missing) | Ok(Read::Corrupt) => Vec::new(),
        Err(e) => {
            log::error!("could not read {}: {e}", path.display());
            Vec::new()
        }
    }
}

fn reminders_state(app: &AppHandle) -> Result<tauri::State<'_, RemindersState>, String> {
    app.try_state::<RemindersState>()
        .ok_or_else(|| "reminders not ready".to_string())
}

/// IANA zone of this PC (`iana-time-zone` also maps Windows zone ids); UTC if it
/// cannot be determined. Default zone for new reminders and data from before v3.
pub fn device_zone() -> Tz {
    zone_from(
        std::env::var("TZ").ok().as_deref(),
        iana_time_zone::get_timezone().map_err(|e| e.to_string()),
    )
}

/// The device zone from the `TZ` variable (an IANA name like `Europe/Berlin`; as
/// `chrono::Local` used it before v3) or else the OS setting; UTC if neither is known.
pub fn zone_from(tz_env: Option<&str>, system: Result<String, String>) -> Tz {
    if let Some(tz) = tz_env.map(|s| s.trim_start_matches(':'))
        && let Some(zone) = buddy_core::zoned::parse_zone(tz)
    {
        return zone;
    }
    match system {
        Ok(name) => buddy_core::zoned::parse_zone(&name).unwrap_or_else(|| {
            log::warn!("unknown system time zone {name:?}, using UTC");
            Tz::UTC
        }),
        Err(e) => {
            log::warn!("could not determine the system time zone ({e}), using UTC");
            Tz::UTC
        }
    }
}

/// Zone of a `set_reminder` call (D-61): the requested one (unknown name = error),
/// else the zone of the existing reminder, else the device zone.
pub fn pick_zone(
    requested: Option<&str>,
    existing: Option<&Reminder>,
    device: Tz,
) -> Result<Tz, String> {
    match requested {
        Some(name) => {
            buddy_core::zoned::parse_zone(name).ok_or_else(|| format!("unknown time zone: {name}"))
        }
        None => Ok(existing.map_or(device, |r| schedule::reminder_zone(r, device))),
    }
}

/// Called from `setup` after `AppState` is managed.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = root.join(REMINDERS_FILE);
    let list = load_file(&path);
    log::info!("{} reminder(s) loaded", list.len());
    app.manage(RemindersState::new(path, list));

    let app = app.clone();
    thread::Builder::new()
        .name("reminders".into())
        .spawn(move || scheduler(&app))
        .map_err(|e| format!("could not start reminder scheduler: {e}"))?;
    Ok(())
}

/// Wakes the scheduler so it notices that the app is quitting.
pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<RemindersState>() {
        state.notify();
    }
}

fn quitting(app: &AppHandle) -> bool {
    crate::state::try_app_state(app).is_some_and(|s| s.quit.is_quitting())
}

fn emit_changed(app: &AppHandle, list: &[Reminder]) {
    if let Err(e) = app.emit(REMINDERS_CHANGED, list) {
        log::warn!("failed to emit {REMINDERS_CHANGED}: {e}");
    }
}

/// Applies a user action `f` to the list, persists and emits if it changed, and
/// records the change in the sync outbox. The emit happens under the reminders lock
/// so events always reach the windows in modification order.
fn modify<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Vec<Reminder>) -> Result<T, String>,
) -> Result<T, String> {
    modify_inner(app, true, f)
}

/// Like [`modify`] for changes taken over from the sync: never an outbox entry.
pub(crate) fn apply_from_sync<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Vec<Reminder>) -> T,
) -> Result<T, String> {
    modify_inner(app, false, |list| Ok(f(list)))
}

fn modify_inner<T>(
    app: &AppHandle,
    record: bool,
    f: impl FnOnce(&mut Vec<Reminder>) -> Result<T, String>,
) -> Result<T, String> {
    let state = reminders_state(app)?;
    let mut list = lock(&state.reminders);
    let before = list.clone();
    let result = f(&mut list)?;
    if *list != before {
        state.persist(&list);
        emit_changed(app, &list);
        state.notify();
        if record {
            // outbox lock is a leaf lock (see crate::sync)
            crate::sync::reminders_edited(app, &before, &list);
        }
    }
    Ok(result)
}

/// The scheduler loop: fire everything due, then sleep until the earliest
/// scheduled time (at most [`MAX_SLEEP`], woken early on any change).
/// Missed reminders (app was closed) are due at the first pass and fire once.
fn scheduler(app: &AppHandle) {
    log::debug!("reminder scheduler started");
    // v3 (§8): with sync on, the start-up pull runs first so reminders that were
    // acknowledged elsewhere meanwhile do not fire again here.
    crate::sync::wait_for_start_pull(START_PULL_WAIT);
    loop {
        if quitting(app) {
            break;
        }
        let Some(state) = app.try_state::<RemindersState>() else {
            break;
        };
        let now = corrected_now();
        let fired = {
            let mut list = lock(&state.reminders);
            let due = schedule::due_now(&list, &now);
            if !due.is_empty() {
                schedule::fire(&mut list, &due, &now);
                state.persist(&list);
                emit_changed(app, &list);
            }
            due.iter()
                .filter_map(|&i| list.get(i).map(|r| r.note_id.clone()))
                .collect::<Vec<_>>()
        };
        for note_id in &fired {
            log::info!("reminder for note {note_id} is due");
            alert(app, note_id);
        }

        let wait = {
            let list = lock(&state.reminders);
            schedule::earliest_scheduled(&list)
                .and_then(|at| (at - corrected_now()).to_std().ok())
                .map_or(MAX_SLEEP, |d| d.min(MAX_SLEEP))
        };
        // Wake slightly after the target so `at <= now` holds on the next pass.
        state.sleep(wait + Duration::from_millis(5));
    }
    log::debug!("reminder scheduler stopped");
}

fn load_note(app: &AppHandle, note_id: &str) -> Result<Note, String> {
    let state =
        crate::state::try_app_state(app).ok_or_else(|| "app state not ready".to_string())?;
    lock(&state.storage)
        .load_note(note_id)
        .map_err(|e| e.to_string())
}

/// Notification title for a note title.
pub fn notification_title(note_title: &str) -> String {
    let t = note_title.trim();
    format!("Erinnerung: {}", if t.is_empty() { "Notiz" } else { t })
}

/// Toast and/or sound for a due reminder, according to the settings.
pub(crate) fn alert(app: &AppHandle, note_id: &str) {
    let settings = crate::state::current_settings(app);
    if settings.reminder_notification {
        let (title, body) = match load_note(app, note_id) {
            Ok(note) => (
                notification_title(&note.title),
                text::truncate_chars(&text::plain_text(&note.content), BODY_CHARS),
            ),
            Err(e) => {
                log::warn!("reminder note {note_id} not readable: {e}");
                (notification_title(""), String::new())
            }
        };
        show_toast(app, &title, &body, settings.reminder_sound);
    } else if settings.reminder_sound {
        beep();
    }
}

fn show_toast(app: &AppHandle, title: &str, body: &str, sound: bool) {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    #[cfg(windows)]
    {
        if sound {
            builder = builder.sound(TOAST_SOUND);
        }
    }
    #[cfg(not(windows))]
    let _ = sound;
    if let Err(e) = builder.show() {
        log::warn!("could not show reminder notification: {e}");
    }
}

/// System "asterisk" sound (used when the toast is off but the sound is on).
#[cfg(windows)]
fn beep() {
    use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONASTERISK;
    // SAFETY: plain Win32 call without pointers.
    if unsafe { MessageBeep(MB_ICONASTERISK) } == 0 {
        log::warn!("MessageBeep failed");
    }
}

#[cfg(not(windows))]
fn beep() {}

fn check_note_id(note_id: &str) -> Result<(), String> {
    if is_valid_note_id(note_id) {
        Ok(())
    } else {
        Err(format!("invalid note id: {note_id}"))
    }
}

pub fn list(app: &AppHandle) -> Result<Vec<Reminder>, String> {
    let state = reminders_state(app)?;
    Ok(lock(&state.reminders).clone())
}

/// `at = None` removes the reminder. Otherwise the note must exist; a time in the
/// past is allowed (the reminder fires right away). `time_zone` (IANA) is the zone
/// of the reminder; `None` keeps the current one (new reminder: the PC's zone).
pub fn set(
    app: &AppHandle,
    note_id: &str,
    at: Option<&str>,
    repeat: ReminderRepeat,
    time_zone: Option<&str>,
) -> Result<Option<Reminder>, String> {
    check_note_id(note_id)?;
    // validate the name before anything else
    pick_zone(time_zone, None, Tz::UTC)?;
    let at = match at {
        None => None,
        Some(s) => {
            let parsed =
                schedule::parse_time(s).ok_or_else(|| format!("invalid time (RFC 3339): {s}"))?;
            // checked before taking the reminders lock (lock order)
            load_note(app, note_id).map_err(|e| format!("note not found: {e}"))?;
            Some(parsed)
        }
    };
    let now = corrected_now();
    let device = device_zone();
    modify(app, |list| {
        let zone = pick_zone(
            time_zone,
            list.iter().find(|r| r.note_id == note_id),
            device,
        )?;
        Ok(schedule::set(
            list,
            note_id,
            at.as_ref(),
            repeat,
            zone,
            &now,
        ))
    })
}

pub fn ack(app: &AppHandle, note_id: &str) -> Result<Option<Reminder>, String> {
    check_note_id(note_id)?;
    let now = corrected_now();
    modify(app, |list| {
        schedule::ack(list, note_id, &now, device_zone())
    })
}

pub fn snooze(app: &AppHandle, note_id: &str, minutes: u32) -> Result<Reminder, String> {
    check_note_id(note_id)?;
    let now = corrected_now();
    modify(app, |list| schedule::snooze(list, note_id, minutes, &now))
}

/// Shows the notes window and asks it to select the note.
pub fn open_note(app: &AppHandle, note_id: &str) -> Result<(), String> {
    check_note_id(note_id)?;
    crate::windows::show_notes(app).map_err(|e| e.to_string())?;
    app.emit_to(
        crate::windows::NOTES,
        OPEN_NOTE,
        OpenNotePayload { note_id },
    )
    .map_err(|e| e.to_string())
}

/// Called by `delete_note` so a deleted note's reminder disappears too.
pub fn on_note_deleted(app: &AppHandle, note_id: &str) {
    if let Err(e) = modify(app, |list| Ok(schedule::remove(list, note_id))) {
        log::warn!("could not remove reminder of deleted note {note_id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ReminderState;

    #[test]
    fn title_falls_back_to_notiz() {
        assert_eq!(notification_title("  Einkauf "), "Erinnerung: Einkauf");
        assert_eq!(notification_title("  "), "Erinnerung: Notiz");
    }

    #[test]
    fn open_note_payload_is_camel_case() {
        let v = serde_json::to_value(OpenNotePayload { note_id: "x" }).unwrap();
        assert_eq!(v, serde_json::json!({ "noteId": "x" }));
    }

    #[test]
    fn store_round_trip_and_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(REMINDERS_FILE);
        assert!(load_file(&path).is_empty());

        let r = Reminder {
            note_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            at: "2026-11-05T09:00:00+01:00".into(),
            repeat: ReminderRepeat::Daily,
            state: ReminderState::Due,
            fired_at: Some("2026-11-05T09:00:01+01:00".into()),
            updated_at: Some("2026-11-05T07:00:00.000Z".into()),
            time_zone: Some("Europe/Berlin".into()),
        };
        let state = RemindersState::new(path.clone(), Vec::new());
        state.persist(std::slice::from_ref(&r));
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["schemaVersion"], 1);
        assert_eq!(raw["reminders"][0]["noteId"], r.note_id.as_str());
        assert_eq!(load_file(&path), vec![r]);

        std::fs::write(&path, "{ nope").unwrap();
        assert!(load_file(&path).is_empty());
        assert!(!path.exists(), "corrupt file is quarantined");
    }

    fn at(s: &str) -> chrono::DateTime<chrono::Utc> {
        schedule::parse_time(s).unwrap()
    }

    const NOTE: &str = "123e4567-e89b-42d3-a456-426614174000";

    #[test]
    fn device_zone_prefers_tz_variable() {
        assert_eq!(
            zone_from(Some("Europe/Berlin"), Ok("Asia/Tokyo".into())),
            chrono_tz::Europe::Berlin
        );
        assert_eq!(
            zone_from(Some(":America/New_York"), Err("x".into())),
            chrono_tz::America::New_York
        );
        // POSIX strings like "CET-1CEST" are not IANA names → OS setting
        assert_eq!(
            zone_from(Some("CET-1CEST,M3.5.0"), Ok("Asia/Tokyo".into())),
            chrono_tz::Asia::Tokyo
        );
        assert_eq!(zone_from(None, Err("x".into())), Tz::UTC);
        assert_eq!(zone_from(None, Ok("Mars/Base".into())), Tz::UTC);
    }

    #[test]
    fn set_zone_rules() {
        let berlin = chrono_tz::Europe::Berlin;
        let ny = Reminder {
            note_id: NOTE.into(),
            at: "2026-11-06T14:00:00.000Z".into(),
            repeat: ReminderRepeat::Daily,
            state: ReminderState::Scheduled,
            fired_at: None,
            updated_at: None,
            time_zone: Some("America/New_York".into()),
        };
        assert_eq!(pick_zone(None, None, berlin).unwrap(), berlin);
        assert_eq!(
            pick_zone(None, Some(&ny), berlin).unwrap(),
            chrono_tz::America::New_York,
            "null keeps the reminder's zone"
        );
        assert_eq!(
            pick_zone(Some("Asia/Tokyo"), Some(&ny), berlin).unwrap(),
            chrono_tz::Asia::Tokyo
        );
        assert!(pick_zone(Some("Mars/Base"), None, berlin).is_err());
    }

    /// PC in Berlin, reminder "daily 09:00 New York": acknowledging gives the next day
    /// 09:00 New York – also in the week where the US already left DST and the EU did
    /// not (2026-11-01 US, 2026-10-25 EU → both standard time here) and around the US
    /// switch (2026-10-31 → 2026-11-01).
    #[test]
    fn ack_in_foreign_zone_from_berlin_pc() {
        let berlin = chrono_tz::Europe::Berlin;
        let mut list = vec![Reminder {
            note_id: NOTE.into(),
            // 2026-10-31 09:00 EDT (UTC−4)
            at: "2026-10-31T13:00:00.000Z".into(),
            repeat: ReminderRepeat::Daily,
            state: ReminderState::Due,
            fired_at: Some("2026-10-31T13:00:00.000Z".into()),
            updated_at: None,
            time_zone: Some("America/New_York".into()),
        }];
        let now = at("2026-10-31T13:01:00.000Z");
        let r = schedule::ack(&mut list, NOTE, &now, berlin)
            .unwrap()
            .unwrap();
        // 2026-11-01 09:00 EST (UTC−5) = 15:00 Berlin (CET)
        assert_eq!(r.at, "2026-11-01T14:00:00.000Z");
        assert_eq!(r.time_zone.as_deref(), Some("America/New_York"));
        assert_eq!(r.updated_at.as_deref(), Some("2026-10-31T13:01:00.000Z"));
    }

    /// And the other way round: PC in New York, reminder "daily 09:00 Berlin" across
    /// the EU switch (2026-10-25): stays 09:00 Berlin, i.e. 03:00 → 04:00 New York.
    #[test]
    fn ack_in_foreign_zone_from_new_york_pc() {
        let ny = chrono_tz::America::New_York;
        let mut list = vec![Reminder {
            note_id: NOTE.into(),
            // 2026-10-24 09:00 CEST (UTC+2)
            at: "2026-10-24T07:00:00.000Z".into(),
            repeat: ReminderRepeat::Daily,
            state: ReminderState::Due,
            fired_at: None,
            updated_at: None,
            time_zone: Some("Europe/Berlin".into()),
        }];
        let now = at("2026-10-24T07:00:30.000Z");
        let r = schedule::ack(&mut list, NOTE, &now, ny).unwrap().unwrap();
        assert_eq!(r.at, "2026-10-25T08:00:00.000Z"); // 09:00 CET
        // a legacy reminder without zone falls back to the PC zone (New York)
        list[0].time_zone = None;
        list[0].at = "2026-10-24T13:00:00.000Z".into(); // 09:00 EDT
        let r = schedule::ack(&mut list, NOTE, &now, ny).unwrap().unwrap();
        assert_eq!(r.at, "2026-10-25T13:00:00.000Z");
        assert_eq!(r.time_zone.as_deref(), Some("America/New_York"));
        // sanitize fills missing zones with the PC zone
        let mut legacy = list[0].clone();
        legacy.time_zone = None;
        let filled = schedule::sanitize(vec![legacy], ny);
        assert_eq!(filled[0].time_zone.as_deref(), Some("America/New_York"));
    }

    #[test]
    fn notify_wakes_sleeper() {
        let state = std::sync::Arc::new(RemindersState::new(PathBuf::new(), Vec::new()));
        let s2 = state.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            s2.notify();
        });
        let start = std::time::Instant::now();
        state.sleep(Duration::from_secs(10));
        assert!(start.elapsed() < Duration::from_secs(5));
        t.join().unwrap();
        // the flag was consumed: the next sleep times out normally
        let start = std::time::Instant::now();
        state.sleep(Duration::from_millis(20));
        assert!(start.elapsed() >= Duration::from_millis(20));
    }
}
