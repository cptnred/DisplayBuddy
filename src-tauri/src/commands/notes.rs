//! Notes storage commands. Run off the main thread (`async`) – they only do file I/O.
//!
//! v3: every local write is recorded in the sync outbox while the storage lock is
//! still held, so a concurrent sync merge sees it (see `crate::sync`, lock order).

use tauri::{AppHandle, State};

use crate::model::Note;
use crate::state::{AppState, lock};
use crate::sync;

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
pub fn save_note(app: AppHandle, state: State<'_, AppState>, note: Note) -> Result<Note, String> {
    let storage = lock(&state.storage);
    let saved = storage.save_note(&note).map_err(err)?;
    sync::note_saved(&app, &saved.id);
    Ok(saved)
}

#[tauri::command(async)]
pub fn delete_note(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let storage = lock(&state.storage);
        storage.delete_note(&id).map_err(err)?;
        sync::note_deleted(&app, &id);
    }
    crate::reminders::on_note_deleted(&app, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn save_order(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let storage = lock(&state.storage);
    storage.save_order(&ids).map_err(err)?;
    sync::order_saved(&app);
    Ok(())
}
