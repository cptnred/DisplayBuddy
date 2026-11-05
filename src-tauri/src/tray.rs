//! Tray icon + menu (PLAN §7).

use tauri::AppHandle;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::state::lock;
use crate::{autostart, quit, windows};

const TRAY_ID: &str = "main";
pub const MENU_OPEN_NOTES: &str = "tray.open-notes";
pub const MENU_NEW_NOTE: &str = "tray.new-note";
pub const MENU_TOGGLE_BUDDY: &str = "tray.toggle-buddy";
pub const MENU_SETTINGS: &str = "tray.settings";
pub const MENU_AUTOSTART: &str = "tray.autostart";
pub const MENU_QUIT: &str = "tray.quit";

pub fn create(app: &AppHandle, autostart_enabled: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN_NOTES, "Notizen öffnen", true, None::<&str>)?;
    let new_note = MenuItem::with_id(app, MENU_NEW_NOTE, "Neue Notiz", true, None::<&str>)?;
    let toggle_buddy = MenuItem::with_id(
        app,
        MENU_TOGGLE_BUDDY,
        "Buddy ein-/ausblenden",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Einstellungen", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        MENU_AUTOSTART,
        "Mit Windows starten",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_note,
            &toggle_buddy,
            &settings,
            &sep1,
            &autostart_item,
            &sep2,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Display Buddy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Err(e) = windows::toggle_notes(tray.app_handle())
            {
                log::warn!("toggle notes from tray failed: {e}");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    // The tray icon is registered in the app manager and lives until exit.
    builder.build(app)?;

    if let Some(state) = crate::state::try_app_state(app) {
        *lock(&state.autostart_item) = Some(autostart_item);
    }
    Ok(())
}

/// Keeps the "Mit Windows starten" check mark in sync with the real state.
pub fn set_autostart_checked(app: &AppHandle, checked: bool) {
    let Some(state) = crate::state::try_app_state(app) else {
        return;
    };
    if let Some(item) = lock(&state.autostart_item).as_ref()
        && let Err(e) = item.set_checked(checked)
    {
        log::warn!("failed to update autostart check item: {e}");
    }
}

/// Handles tray-menu ids; returns false for ids it does not own.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let result = match id {
        MENU_OPEN_NOTES => windows::show_notes(app),
        MENU_NEW_NOTE => windows::request_new_note(app),
        MENU_TOGGLE_BUDDY => windows::toggle_buddy(app),
        MENU_SETTINGS => windows::open_settings(app),
        MENU_AUTOSTART => {
            // The check item toggles itself on click; derive the wish from the
            // real OS state instead and then force the item to match the outcome.
            let wanted = !autostart::is_enabled(app).unwrap_or(false);
            if let Err(e) = autostart::set(app, wanted) {
                log::warn!("toggle autostart failed: {e}");
                set_autostart_checked(app, autostart::is_enabled(app).unwrap_or(false));
            }
            Ok(())
        }
        MENU_QUIT => {
            quit::request_quit(app);
            Ok(())
        }
        _ => return false,
    };
    if let Err(e) = result {
        log::warn!("tray action {id} failed: {e}");
    }
    true
}
