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
    if enabled && result.is_ok() {
        quote_run_entry(app);
    }
    let real = is_enabled(app);
    // Mirror whatever the OS state is now, even if the change failed.
    if let Ok(real) = real {
        mirror(app, real, true);
    }
    result.map_err(|e| e.to_string())?;
    real
}

/// `"C:\path with spaces\app.exe" --arg`: the exe path is always quoted.
pub fn quoted_run_command(exe: &str, args: &[&str]) -> String {
    let mut cmd = format!("\"{}\"", exe.trim_matches('"'));
    for a in args {
        cmd.push(' ');
        cmd.push_str(a);
    }
    cmd
}

/// The autostart plugin writes the HKCU Run value **unquoted**; the install path
/// („…\Display Buddy\…“) contains a space, which makes the command ambiguous. Rewrite the
/// value the plugin just created (same name, so plugin `is_enabled`/`disable` and the
/// uninstaller keep working). Only touches an existing HKCU value.
#[cfg(windows)]
fn quote_run_entry(app: &AppHandle) {
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let name = app.package_info().name.clone();
    let result = (|| -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let key = windows_registry::CURRENT_USER
            .create(RUN)
            .map_err(|e| e.to_string())?;
        if key.get_string(&name).is_err() {
            return Ok(()); // plugin wrote elsewhere (e.g. HKLM when elevated) – leave it
        }
        let cmd = quoted_run_command(&exe.display().to_string(), &[crate::AUTOSTART_ARG]);
        key.set_string(&name, &cmd).map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        log::warn!("could not quote autostart entry: {e}");
    }
}

#[cfg(not(windows))]
fn quote_run_entry(_app: &AppHandle) {}

/// Startup: copy the plugin's real state into the settings.
pub fn sync_at_startup(app: &AppHandle) {
    match is_enabled(app) {
        Ok(real) => {
            if real {
                // Repairs entries written unquoted by earlier versions.
                quote_run_entry(app);
            }
            mirror(app, real, false)
        }
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

#[cfg(test)]
mod tests {
    use super::quoted_run_command;

    #[test]
    fn run_command_quotes_path_with_spaces() {
        assert_eq!(
            quoted_run_command(
                r"C:\Users\A B\AppData\Local\Display Buddy\display-buddy.exe",
                &["--autostart"]
            ),
            r#""C:\Users\A B\AppData\Local\Display Buddy\display-buddy.exe" --autostart"#
        );
        assert_eq!(quoted_run_command(r#""C:\x.exe""#, &[]), r#""C:\x.exe""#);
    }
}
