//! v2 shortcut-bar commands (PLAN §11). Logic lives in `crate::shortcuts`.

use tauri::AppHandle;

use crate::model::{ShortcutList, ShortcutsData};
use crate::shortcuts;

#[tauri::command]
pub fn list_shortcuts(app: AppHandle) -> Result<ShortcutsData, String> {
    shortcuts::list(&app)
}

/// Async: the native dialog must not block the main thread.
#[tauri::command]
pub async fn pick_shortcuts(app: AppHandle, folder: bool) -> Result<ShortcutsData, String> {
    shortcuts::pick(&app, folder)
}

#[tauri::command]
pub fn add_bookmark(app: AppHandle, name: String, url: String) -> Result<ShortcutsData, String> {
    shortcuts::add_bookmark(&app, &name, &url)
}

#[tauri::command]
pub fn update_shortcut(
    app: AppHandle,
    id: String,
    name: String,
    target: Option<String>,
) -> Result<ShortcutsData, String> {
    shortcuts::update(&app, &id, &name, target.as_deref())
}

#[tauri::command]
pub fn remove_shortcut(app: AppHandle, id: String) -> Result<ShortcutsData, String> {
    shortcuts::remove(&app, &id)
}

#[tauri::command]
pub fn reorder_shortcuts(
    app: AppHandle,
    list: ShortcutList,
    ids: Vec<String>,
) -> Result<ShortcutsData, String> {
    shortcuts::reorder(&app, list, &ids)
}

#[tauri::command]
pub fn open_shortcut(app: AppHandle, id: String) -> Result<(), String> {
    shortcuts::open(&app, &id)
}

/// Async: icon extraction touches the shell and may be slow.
#[tauri::command]
pub async fn shortcut_icon(app: AppHandle, id: String) -> Result<Option<String>, String> {
    shortcuts::icon(&app, &id)
}
