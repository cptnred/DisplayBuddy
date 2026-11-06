//! v3 sync commands (PLAN_V3_SYNC §8). Logic lives in `crate::sync`.

use tauri::AppHandle;

use crate::model::SyncStatus;
use crate::sync;

#[tauri::command]
pub fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    Ok(sync::status(&app))
}

/// Registers this PC (`POST /devices`), stores the token in the Credential Manager and
/// unites local data with the server. Errors start with a code (see `sync::connect`).
#[tauri::command]
pub async fn sync_connect(
    app: AppHandle,
    server_url: String,
    username: String,
    password: String,
    device_name: String,
) -> Result<SyncStatus, String> {
    sync::connect(app, server_url, username, password, device_name).await
}

#[tauri::command]
pub async fn sync_disconnect(app: AppHandle) -> Result<SyncStatus, String> {
    sync::disconnect(app).await
}

#[tauri::command]
pub fn sync_now(app: AppHandle) -> Result<SyncStatus, String> {
    sync::sync_now(&app)
}
