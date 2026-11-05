//! Settings + autostart commands.

use serde_json::Value;
use tauri::AppHandle;

use crate::model::Settings;
use crate::{autostart, shortcut, state, windows};

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(state::current_settings(&app))
}

/// JSON-merge patch → sanitize → persist → emit `settings-changed` → side effects
/// (buddy window size, global shortcut). `schemaVersion`/`autostart` keys are ignored
/// (see `Settings::with_patch`).
#[tauri::command]
pub fn save_settings(app: AppHandle, patch: Value) -> Result<Settings, String> {
    let (old, new) = state::patch_settings(&app, &patch)?;
    state::emit_settings_changed(&app, &new);
    if old.buddy.size != new.buddy.size
        && let Err(e) = windows::resize_buddy(&app, new.buddy.size)
    {
        log::warn!("failed to resize buddy: {e}");
    }
    if old.global_shortcut != new.global_shortcut {
        shortcut::apply(&app, new.global_shortcut);
    }
    Ok(new)
}

#[tauri::command(async)]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    autostart::is_enabled(&app)
}

#[tauri::command(async)]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    autostart::set(&app, enabled)
}
