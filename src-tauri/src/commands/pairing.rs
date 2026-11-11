//! v4 QR pairing commands (PLAN_V4 §6.2, §7.1), settings window only.

use tauri::AppHandle;

use crate::model::{PairingInfo, PairingStatus};
use crate::sync::pairing;

#[tauri::command]
pub async fn pairing_start(app: AppHandle) -> Result<PairingInfo, String> {
    pairing::app_start(&app).await
}

#[tauri::command]
pub async fn pairing_status(app: AppHandle, pairing_id: String) -> Result<PairingStatus, String> {
    pairing::app_status(&app, &pairing_id).await
}

#[tauri::command]
pub async fn pairing_cancel(app: AppHandle, pairing_id: String) -> Result<(), String> {
    pairing::app_cancel(&app, &pairing_id).await
}
