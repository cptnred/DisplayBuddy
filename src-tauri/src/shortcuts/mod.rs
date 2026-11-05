//! v2 shortcut bar (PLAN §11/§12): `shortcuts.json` store, open via shell/browser,
//! shell icons, OS drag & drop onto the notes window.
//!
//! The frontend only ever passes ids; paths and URLs come from the store, so a
//! compromised webview cannot make us open arbitrary targets.

pub mod icon;
pub mod paths;
pub mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::model::{ShortcutKind, ShortcutList, ShortcutsData};
use crate::state::lock;
use crate::windows::NOTES;

pub use store::ShortcutStore;

pub const SHORTCUTS_FILE: &str = "shortcuts.json";
pub const SHORTCUTS_CHANGED: &str = "shortcuts-changed";
pub const SHORTCUT_DRAG: &str = "shortcut-drag";

/// Managed state of this module (registered in [`init`]).
pub struct ShortcutsState {
    store: Mutex<ShortcutStore>,
    /// id → icon data URL (`None` = no icon available); filled lazily.
    icons: Mutex<HashMap<String, Option<String>>>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut store = ShortcutStore::new(root.join(SHORTCUTS_FILE));
    // Load eagerly so a corrupt file is quarantined (and logged) at startup.
    if let Err(e) = store.data() {
        log::warn!("could not load shortcuts: {e}");
    }
    app.manage(ShortcutsState {
        store: Mutex::new(store),
        icons: Mutex::new(HashMap::new()),
    });
    Ok(())
}

fn with_store<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut ShortcutStore) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<ShortcutsState>()
        .ok_or_else(|| "shortcuts not ready".to_string())?;
    let mut store = lock(&state.store);
    f(&mut store)
}

/// Runs a mutation and broadcasts the result (`shortcuts-changed`) if it changed anything.
fn mutate(
    app: &AppHandle,
    f: impl FnOnce(&mut ShortcutStore) -> Result<ShortcutsData, String>,
) -> Result<ShortcutsData, String> {
    let (before, after) = with_store(app, |store| {
        let before = store.snapshot()?;
        let after = f(store)?;
        Ok((before, after))
    })?;
    if before != after
        && let Err(e) = app.emit(SHORTCUTS_CHANGED, &after)
    {
        log::warn!("failed to emit {SHORTCUTS_CHANGED}: {e}");
    }
    Ok(after)
}

pub fn list(app: &AppHandle) -> Result<ShortcutsData, String> {
    with_store(app, ShortcutStore::snapshot)
}

/// Adds file-system paths to `items` (drop + picker).
pub fn add_paths(app: &AppHandle, paths: &[PathBuf]) -> Result<ShortcutsData, String> {
    mutate(app, |store| store.add_paths(paths))
}

/// Native picker: one folder, or several files/programs. Cancel → unchanged data.
pub fn pick(app: &AppHandle, folder: bool) -> Result<ShortcutsData, String> {
    let dialog = app.dialog().file();
    let picked: Vec<PathBuf> = if folder {
        dialog
            .set_title("Ordner hinzufügen")
            .blocking_pick_folder()
            .into_iter()
            .collect()
    } else {
        dialog
            .set_title("Programme oder Dateien hinzufügen")
            .blocking_pick_files()
            .unwrap_or_default()
    }
    .into_iter()
    .filter_map(|p| p.into_path().ok())
    .collect();
    if picked.is_empty() {
        return list(app);
    }
    add_paths(app, &picked)
}

pub fn add_bookmark(app: &AppHandle, name: &str, url: &str) -> Result<ShortcutsData, String> {
    mutate(app, |store| store.add_bookmark(name, url))
}

pub fn update(
    app: &AppHandle,
    id: &str,
    name: &str,
    target: Option<&str>,
) -> Result<ShortcutsData, String> {
    mutate(app, |store| store.update(id, name, target))
}

pub fn remove(app: &AppHandle, id: &str) -> Result<ShortcutsData, String> {
    let data = mutate(app, |store| store.remove(id))?;
    if let Some(state) = app.try_state::<ShortcutsState>() {
        lock(&state.icons).remove(id);
    }
    Ok(data)
}

pub fn reorder(
    app: &AppHandle,
    list: ShortcutList,
    ids: &[String],
) -> Result<ShortcutsData, String> {
    mutate(app, |store| store.reorder(list, ids))
}

/// Opens a stored entry: path → shell (program/file/folder), url → default browser.
pub fn open(app: &AppHandle, id: &str) -> Result<(), String> {
    let entry = with_store(app, |store| store.find(id))?
        .ok_or_else(|| format!("shortcut not found: {id}"))?;
    let opener = app.opener();
    match entry.kind {
        ShortcutKind::Url => {
            let (url, _) = paths::normalize_bookmark(&entry.target)?;
            opener.open_url(url, None::<&str>)
        }
        ShortcutKind::File | ShortcutKind::Folder | ShortcutKind::Program => {
            if !Path::new(&entry.target).exists() {
                return Err(format!("not found: {}", entry.target));
            }
            opener.open_path(entry.target, None::<&str>)
        }
    }
    .map_err(|e| e.to_string())
}

/// Shell icon (PNG data URL) of a stored path entry; cached per id.
/// Bookmarks, missing files and non-Windows hosts → `None`.
pub fn icon(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    let state = app
        .try_state::<ShortcutsState>()
        .ok_or_else(|| "shortcuts not ready".to_string())?;
    if let Some(cached) = lock(&state.icons).get(id) {
        return Ok(cached.clone());
    }
    let entry = lock(&state.store)
        .find(id)?
        .ok_or_else(|| format!("shortcut not found: {id}"))?;
    if entry.kind == ShortcutKind::Url {
        return Ok(None);
    }
    if !Path::new(&entry.target).exists() {
        // not cached: the file may come back (e.g. a USB drive)
        return Ok(None);
    }
    // extracted without holding any lock (may be slow)
    let url = icon::icon_data_url(&entry.target);
    lock(&state.icons).insert(id.to_string(), url.clone());
    Ok(url)
}

fn emit_drag(app: &AppHandle, state: &str) {
    if let Err(e) = app.emit_to(NOTES, SHORTCUT_DRAG, json!({ "state": state })) {
        log::warn!("failed to emit {SHORTCUT_DRAG}: {e}");
    }
}

/// OS file drag & drop on the notes window (`WindowEvent::DragDrop`).
pub fn on_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    match event {
        DragDropEvent::Enter { .. } => emit_drag(app, "enter"),
        DragDropEvent::Leave => emit_drag(app, "leave"),
        DragDropEvent::Drop { paths, .. } => {
            if let Err(e) = add_paths(app, paths) {
                log::warn!("could not add dropped paths: {e}");
            }
            emit_drag(app, "drop");
        }
        _ => {}
    }
}
