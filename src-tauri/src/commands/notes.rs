//! Notes storage commands. Run off the main thread (`async`) – they only do file I/O.

use tauri::State;

use crate::model::Note;
use crate::state::{AppState, lock};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command(async)]
pub fn list_notes(state: State<'_, AppState>) -> Result<Vec<Note>, String> {
    lock(&state.storage).list_notes().map_err(err)
}

#[tauri::command(async)]
pub fn load_note(state: State<'_, AppState>, id: String) -> Result<Note, String> {
    lock(&state.storage).load_note(&id).map_err(err)
}

#[tauri::command(async)]
pub fn save_note(state: State<'_, AppState>, note: Note) -> Result<Note, String> {
    lock(&state.storage).save_note(&note).map_err(err)
}

#[tauri::command(async)]
pub fn delete_note(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    lock(&state.storage).delete_note(&id).map_err(err)?;
    crate::reminders::on_note_deleted(&app, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn save_order(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    lock(&state.storage).save_order(&ids).map_err(err)
}
