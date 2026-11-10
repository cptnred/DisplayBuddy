//! v4 account commands (PLAN_V4 §7.1), settings window only. Logic in `crate::sync::account`.
//! Errors are `code: detail` strings; the UI maps the code to German texts.

use tauri::AppHandle;

use crate::model::{AccountInfo, AccountRegistered, DeviceInfo, ServerInfo, SyncStatus};
use crate::sync::account::{self, NewAccount};
use crate::sync::signed_in_client;

/// `serverUrl` `""` = standard server.
#[tauri::command]
pub async fn account_server_info(server_url: String) -> Result<ServerInfo, String> {
    account::app_server_info(&server_url).await
}

/// Challenge → proof-of-work (≤ 60 s) → `POST /accounts`, then like `sync_connect`.
#[tauri::command]
pub async fn account_register(
    app: AppHandle,
    server_url: String,
    username: String,
    password: String,
    device_name: String,
    invite_code: Option<String>,
) -> Result<AccountRegistered, String> {
    let new = NewAccount {
        username,
        password,
        device_name,
        invite_code,
        time_zone: None,
    };
    account::app_register(&app, &server_url, new).await
}

#[tauri::command]
pub async fn account_recover(
    app: AppHandle,
    server_url: String,
    username: String,
    recovery_code: String,
    new_password: String,
    device_name: String,
) -> Result<AccountRegistered, String> {
    account::app_recover(
        &app,
        &server_url,
        &username,
        &recovery_code,
        new_password,
        &device_name,
    )
    .await
}

#[tauri::command]
pub async fn account_info(app: AppHandle) -> Result<AccountInfo, String> {
    account::info(&signed_in_client(&app)?).await
}

#[tauri::command]
pub async fn account_devices(app: AppHandle) -> Result<Vec<DeviceInfo>, String> {
    account::devices(&signed_in_client(&app)?).await
}

/// Returns the device list after revoking.
#[tauri::command]
pub async fn account_revoke_device(
    app: AppHandle,
    device_id: String,
    password: Option<String>,
) -> Result<Vec<DeviceInfo>, String> {
    let client = signed_in_client(&app)?;
    account::revoke_device(&client, &device_id, password).await?;
    account::devices(&client).await
}

#[tauri::command]
pub async fn account_change_password(
    app: AppHandle,
    current_password: Option<String>,
    new_password: String,
) -> Result<(), String> {
    account::change_password(&signed_in_client(&app)?, current_password, new_password).await
}

#[tauri::command]
pub async fn account_new_recovery_code(app: AppHandle, password: String) -> Result<String, String> {
    account::new_recovery_code(&signed_in_client(&app)?, password).await
}

/// Path of the saved file, `null` if the dialog was cancelled.
#[tauri::command]
pub async fn account_export(app: AppHandle) -> Result<Option<String>, String> {
    account::app_export(&app).await
}

/// Deletes the account on the server; sync off, local notes stay.
#[tauri::command]
pub async fn account_delete(
    app: AppHandle,
    password: String,
    confirm_username: String,
) -> Result<SyncStatus, String> {
    account::app_delete(&app, password, confirm_username).await
}

/// `kind` = imprint | privacy | terms; opens the https link from `ServerInfo`.
#[tauri::command]
pub async fn account_open_link(app: AppHandle, kind: String) -> Result<(), String> {
    account::app_open_link(&app, &kind).await
}
