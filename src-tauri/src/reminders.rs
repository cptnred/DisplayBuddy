//! v2 reminders (PLAN §11): `reminders.json` store, scheduler thread, notification/sound.
//! STUB – implemented by the "backend-reminders" agent.

use tauri::AppHandle;

use crate::model::{Reminder, ReminderRepeat};

const TODO: &str = "reminders: not implemented yet";

/// Called from `setup` after `AppState` is managed.
pub fn init(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn list(_app: &AppHandle) -> Result<Vec<Reminder>, String> {
    Err(TODO.into())
}

pub fn set(
    _app: &AppHandle,
    _note_id: &str,
    _at: Option<&str>,
    _repeat: ReminderRepeat,
) -> Result<Option<Reminder>, String> {
    Err(TODO.into())
}

pub fn ack(_app: &AppHandle, _note_id: &str) -> Result<Option<Reminder>, String> {
    Err(TODO.into())
}

pub fn snooze(_app: &AppHandle, _note_id: &str, _minutes: u32) -> Result<Reminder, String> {
    Err(TODO.into())
}

pub fn open_note(_app: &AppHandle, _note_id: &str) -> Result<(), String> {
    Err(TODO.into())
}

/// Called by `delete_note` so a deleted note's reminder disappears too.
pub fn on_note_deleted(_app: &AppHandle, _note_id: &str) {}
