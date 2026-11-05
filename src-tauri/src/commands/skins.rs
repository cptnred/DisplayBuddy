//! v2 skin commands (PLAN §11). Logic lives in `crate::skins`.

use tauri::AppHandle;

use crate::model::{SkinData, SkinInfo};
use crate::skins;

#[tauri::command]
pub fn list_skins(app: AppHandle) -> Result<Vec<SkinInfo>, String> {
    skins::list(&app)
}

/// Async: the native dialog must not block the main thread.
#[tauri::command]
pub async fn import_skin(app: AppHandle) -> Result<Option<SkinInfo>, String> {
    skins::import(&app)
}

#[tauri::command]
pub fn delete_skin(app: AppHandle, id: String) -> Result<(), String> {
    skins::delete(&app, &id)
}

#[tauri::command]
pub fn load_skin(app: AppHandle, id: String) -> Result<SkinData, String> {
    skins::load(&app, &id)
}
