//! Window / app-lifecycle commands (thin wrappers around `crate::windows` / `crate::quit`).

use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::{quit, windows};

fn err(e: tauri::Error) -> String {
    e.to_string()
}

#[tauri::command]
pub fn toggle_notes(app: AppHandle) -> Result<(), String> {
    windows::toggle_notes(&app).map_err(err)
}

#[tauri::command]
pub fn show_notes(app: AppHandle) -> Result<(), String> {
    windows::show_notes(&app).map_err(err)
}

#[tauri::command]
pub fn hide_notes(app: AppHandle) -> Result<(), String> {
    windows::hide_notes(&app).map_err(err)
}

/// Async on purpose: creating a window from a sync command deadlocks WebView2.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    windows::open_settings(&app).map_err(err)
}

#[tauri::command]
pub fn show_buddy_menu(app: AppHandle) -> Result<(), String> {
    windows::show_buddy_menu(&app).map_err(err)
}

#[tauri::command]
pub fn flush_done(app: AppHandle) -> Result<(), String> {
    app.state::<AppState>().quit.mark_flushed();
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    quit::request_quit(&app);
    Ok(())
}
