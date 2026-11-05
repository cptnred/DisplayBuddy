//! v2 reminder commands (PLAN §11). Logic lives in `crate::reminders`.

use tauri::AppHandle;

use crate::model::{Reminder, ReminderRepeat};
use crate::reminders;

#[tauri::command]
pub fn list_reminders(app: AppHandle) -> Result<Vec<Reminder>, String> {
    reminders::list(&app)
}

#[tauri::command]
pub fn set_reminder(
    app: AppHandle,
    note_id: String,
    at: Option<String>,
    repeat: ReminderRepeat,
) -> Result<Option<Reminder>, String> {
    reminders::set(&app, &note_id, at.as_deref(), repeat)
}

#[tauri::command]
pub fn ack_reminder(app: AppHandle, note_id: String) -> Result<Option<Reminder>, String> {
    reminders::ack(&app, &note_id)
}

#[tauri::command]
pub fn snooze_reminder(app: AppHandle, note_id: String, minutes: u32) -> Result<Reminder, String> {
    reminders::snooze(&app, &note_id, minutes)
}

#[tauri::command]
pub fn open_note(app: AppHandle, note_id: String) -> Result<(), String> {
    reminders::open_note(&app, &note_id)
}
