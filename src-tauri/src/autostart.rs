//! Autostart via `tauri-plugin-autostart` (Rust-side only, decision D-07).
//! The plugin (OS registration) is the source of truth; `settings.autostart` mirrors it.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::{state, tray};

pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enables/disables autostart, then mirrors the real state into settings, the
/// tray check item and `settings-changed`. Returns the real state.
pub fn set(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    let real = is_enabled(app);
    // Mirror whatever the OS state is now, even if the change failed.
    if let Ok(real) = real {
        mirror(app, real, true);
    }
    result.map_err(|e| e.to_string())?;
    real
}

/// Startup: copy the plugin's real state into the settings.
pub fn sync_at_startup(app: &AppHandle) {
    match is_enabled(app) {
        Ok(real) => mirror(app, real, false),
        Err(e) => log::warn!("could not read autostart state: {e}"),
    }
}

fn mirror(app: &AppHandle, real: bool, emit: bool) {
    let result = state::update_settings(app, |s| {
        let mut s = s.clone();
        s.autostart = real;
        Ok(s)
    });
    match result {
        Ok((_, new)) => {
            if emit {
                state::emit_settings_changed(app, &new);
            }
        }
        Err(e) => log::warn!("failed to persist autostart state: {e}"),
    }
    tray::set_autostart_checked(app, real);
}
