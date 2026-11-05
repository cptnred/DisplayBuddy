//! Managed application state and the single code path for changing settings.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::debounce::Debouncer;
use crate::model::{Settings, WindowPosition};
use crate::quit::QuitState;
use crate::storage::Storage;

pub const SETTINGS_CHANGED: &str = "settings-changed";

pub struct AppState {
    /// Serialises all file writes.
    pub storage: Mutex<Storage>,
    /// In-memory copy of `settings.json` (always sanitized).
    /// Lock order: `settings` before `storage`.
    pub settings: Mutex<Settings>,
    /// When the notes window was last hidden because it lost focus (see `windows::toggle_notes`).
    pub last_blur_hide: Mutex<Option<Instant>>,
    /// Tray "Mit Windows starten" item, kept in sync with the plugin state.
    pub autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// Debounced persistence of the buddy position (300 ms).
    pub buddy_moves: Mutex<Option<Debouncer<WindowPosition>>>,
    pub quit: QuitState,
}

impl AppState {
    pub fn new(storage: Storage, settings: Settings) -> Self {
        Self {
            storage: Mutex::new(storage),
            settings: Mutex::new(settings),
            last_blur_hide: Mutex::new(None),
            autostart_item: Mutex::new(None),
            buddy_moves: Mutex::new(None),
            quit: QuitState::default(),
        }
    }
}

/// Locks a mutex, recovering from poisoning (a panicked holder must not brick the app).
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn current_settings(app: &AppHandle) -> Settings {
    lock(&app.state::<AppState>().settings).clone()
}

/// Applies `f` to the settings, sanitizes, persists and updates the cache.
/// Returns `(old, new)`. Does **not** emit `settings-changed`.
pub fn update_settings(
    app: &AppHandle,
    f: impl FnOnce(&Settings) -> Result<Settings, String>,
) -> Result<(Settings, Settings), String> {
    let state = app.state::<AppState>();
    let mut cached = lock(&state.settings);
    let new = f(&cached)?.sanitized();
    if new != *cached {
        lock(&state.storage)
            .save_settings(&new)
            .map_err(|e| e.to_string())?;
    }
    let old = std::mem::replace(&mut *cached, new.clone());
    Ok((old, new))
}

/// JSON-merge-patch entry point used by the `save_settings` command.
pub fn patch_settings(app: &AppHandle, patch: &Value) -> Result<(Settings, Settings), String> {
    update_settings(app, |current| current.with_patch(patch))
}

pub fn emit_settings_changed(app: &AppHandle, settings: &Settings) {
    if let Err(e) = app.emit(SETTINGS_CHANGED, settings) {
        log::warn!("failed to emit {SETTINGS_CHANGED}: {e}");
    }
}

/// Remembers that the notes window was just hidden by focus loss.
pub fn mark_blur_hide(app: &AppHandle) {
    *lock(&app.state::<AppState>().last_blur_hide) = Some(Instant::now());
}

/// True if the notes window was hidden by focus loss within `window`.
/// Consumes the mark.
pub fn take_recent_blur_hide(app: &AppHandle, window: Duration) -> bool {
    lock(&app.state::<AppState>().last_blur_hide)
        .take()
        .is_some_and(|t| t.elapsed() < window)
}
