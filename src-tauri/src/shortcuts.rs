//! v2 shortcut bar (PLAN §11): `shortcuts.json` store, open via shell/browser, icons, drag & drop.
//! STUB – implemented by the "backend-shortcuts" agent.

use tauri::{AppHandle, DragDropEvent};

use crate::model::{ShortcutList, ShortcutsData};

const TODO: &str = "shortcuts: not implemented yet";

pub fn init(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn list(_app: &AppHandle) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn pick(_app: &AppHandle, _folder: bool) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn add_bookmark(_app: &AppHandle, _name: &str, _url: &str) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn update(
    _app: &AppHandle,
    _id: &str,
    _name: &str,
    _target: Option<&str>,
) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn remove(_app: &AppHandle, _id: &str) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn reorder(
    _app: &AppHandle,
    _list: ShortcutList,
    _ids: &[String],
) -> Result<ShortcutsData, String> {
    Err(TODO.into())
}

pub fn open(_app: &AppHandle, _id: &str) -> Result<(), String> {
    Err(TODO.into())
}

pub fn icon(_app: &AppHandle, _id: &str) -> Result<Option<String>, String> {
    Ok(None)
}

/// OS file drag & drop on the notes window (`WindowEvent::DragDrop`).
pub fn on_drag_drop(_app: &AppHandle, _event: &DragDropEvent) {}
