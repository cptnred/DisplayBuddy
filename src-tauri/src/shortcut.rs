//! Global shortcut Ctrl+Alt+N → toggle notes (Rust-side only, decision D-07).

use tauri::{AppHandle, Wry, plugin::TauriPlugin};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::windows;

pub fn notes_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

/// Plugin with the handler; registration happens in [`apply`].
pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed
                && shortcut.id() == notes_shortcut().id()
                && let Err(e) = windows::toggle_notes(app)
            {
                log::warn!("toggle notes from shortcut failed: {e}");
            }
        })
        .build()
}

/// (Un)registers Ctrl+Alt+N. Failure (e.g. taken by another app) is logged, not fatal.
pub fn apply(app: &AppHandle, enabled: bool) {
    let gs = app.global_shortcut();
    let shortcut = notes_shortcut();
    let registered = gs.is_registered(shortcut);
    let result = match (enabled, registered) {
        (true, false) => gs.register(shortcut),
        (false, true) => gs.unregister(shortcut),
        _ => Ok(()),
    };
    match result {
        Ok(()) => log::info!(
            "global shortcut Ctrl+Alt+N {}",
            if enabled { "on" } else { "off" }
        ),
        Err(e) => log::warn!(
            "could not {} Ctrl+Alt+N: {e}",
            if enabled { "register" } else { "unregister" }
        ),
    }
}
