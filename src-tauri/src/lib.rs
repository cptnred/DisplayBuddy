//! Display Buddy – Tauri backend.

pub mod autostart;
pub mod clickthrough;
pub mod clock;
pub mod commands;
pub mod crash;
pub mod debounce;
pub mod model;
pub mod quit;
pub mod reminders;
pub mod shortcut;
pub mod shortcuts;
pub mod shutdown;
pub mod skins;
pub mod state;
pub mod storage;
pub mod sync;
pub mod tray;
pub mod windows;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use crate::state::AppState;
use crate::storage::Storage;

pub const AUTOSTART_ARG: &str = "--autostart";

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // Stdout for `tauri dev`, plus a file in the OS log dir
    // (%LOCALAPPDATA%\de.displaybuddy.desktop\logs) because release builds have no console.
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        // keep noisy dependencies quiet
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .build()
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let result = setup_inner(app);
    match &result {
        Ok(()) => crash::record("setup ok"),
        Err(e) => crash::record(&format!("setup failed: {e}")),
    }
    result
}

fn setup_inner(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?;
    log::info!("data dir: {}", root.display());
    if std::env::args().any(|a| a == AUTOSTART_ARG) {
        log::info!("started by autostart");
    }

    let storage = Storage::new(root);
    let settings = storage.load_settings().unwrap_or_else(|e| {
        log::warn!("could not load settings, using defaults: {e}");
        Default::default()
    });
    app.manage(AppState::new(storage, settings));

    // Tray first (so the autostart check item exists), then mirror the real autostart state.
    let initial = state::current_settings(app);
    tray::create(app, initial.autostart)?;
    autostart::sync_at_startup(app);
    let settings = state::current_settings(app);

    windows::init_buddy_move_persistence(app);
    if let Err(e) = windows::apply_notes_size(app, &settings) {
        log::warn!("could not restore notes size: {e}");
    }
    if let Err(e) = windows::setup_buddy(app, &settings) {
        log::error!("could not set up buddy window: {e}");
    }
    clickthrough::start(app);
    // v2 modules (each manages its own state; failures are logged, never fatal)
    if let Err(e) = reminders::init(app) {
        log::error!("reminders init failed: {e}");
    }
    // after reminders: the scheduler waits for the sync start-up pull (§8)
    if let Err(e) = sync::init(app) {
        log::error!("sync init failed: {e}");
        sync::release_start_gate();
    }
    if let Err(e) = shortcuts::init(app) {
        log::error!("shortcuts init failed: {e}");
    }
    if let Err(e) = skins::init(app) {
        log::error!("skins init failed: {e}");
    }
    shutdown::install(app);
    if settings.global_shortcut {
        shortcut::apply(app, true);
    }
    // While Tauri created the notes webview (before this setup), WebView2 pumped messages
    // and the buddy page may already have asked for settings/reminders/skins and got
    // defaults or "not ready". Send the real state once now.
    state::emit_settings_changed(app, &state::current_settings(app));
    reminders::announce(app);
    skins::announce(app);
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if !windows::handle_menu_event(app, id) && !tray::handle_menu_event(app, id) {
        log::debug!("unhandled menu id {id}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crash::install();
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch only shows the notes of the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(e) = windows::show_notes(app) {
                log::warn!("show notes for second instance failed: {e}");
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(shortcut::plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| setup(app.handle()))
        .on_window_event(windows::on_window_event)
        .on_menu_event(on_menu_event)
        .invoke_handler(tauri::generate_handler![
            commands::notes::list_notes,
            commands::notes::load_note,
            commands::notes::save_note,
            commands::notes::delete_note,
            commands::notes::save_order,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::get_autostart,
            commands::settings::set_autostart,
            commands::windows::toggle_notes,
            commands::windows::show_notes,
            commands::windows::hide_notes,
            commands::windows::open_settings,
            commands::windows::show_buddy_menu,
            commands::windows::flush_done,
            commands::windows::quit_app,
            commands::reminders::list_reminders,
            commands::reminders::set_reminder,
            commands::reminders::ack_reminder,
            commands::reminders::snooze_reminder,
            commands::reminders::open_note,
            commands::shortcuts::list_shortcuts,
            commands::shortcuts::pick_shortcuts,
            commands::shortcuts::add_bookmark,
            commands::shortcuts::update_shortcut,
            commands::shortcuts::remove_shortcut,
            commands::shortcuts::reorder_shortcuts,
            commands::shortcuts::open_shortcut,
            commands::shortcuts::shortcut_icon,
            commands::skins::list_skins,
            commands::skins::import_skin,
            commands::skins::delete_skin,
            commands::skins::load_skin,
            commands::sync::sync_status,
            commands::sync::sync_connect,
            commands::sync::sync_disconnect,
            commands::sync::sync_now,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| crash::fatal("Die App konnte nicht gestartet werden", &e));
    crash::record("tauri app built");

    app.run(|app, event| {
        // Last chance on any exit path (incl. Windows logoff/shutdown, where tao exits
        // without our flush handshake): persist window geometry synchronously.
        if let RunEvent::Exit = event {
            windows::persist_geometry_now(app);
            return;
        }
        // Windows are only ever hidden, so an exit request without an explicit code
        // (e.g. the last *visible* window was closed) must not end the app. Explicit
        // `app.exit(code)` from the quit flow carries a code and passes through.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
