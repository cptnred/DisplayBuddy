//! v2 custom skins (PLAN §11): import (png/svg/gif/webp/lottie json) into `skins/`,
//! list, load, delete.

pub mod store;

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::model::{DEFAULT_SKIN, SkinData, SkinInfo};
use crate::state::{current_settings, emit_settings_changed, lock, update_settings};

pub use store::{SkinStore, detect_skin};

pub const SKINS_DIR: &str = "skins";
pub const SKINS_CHANGED: &str = "skins-changed";

/// Managed state of this module; the mutex serialises all index writes.
pub struct SkinsState {
    store: Mutex<SkinStore>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app.manage(SkinsState {
        store: Mutex::new(SkinStore::new(root.join(SKINS_DIR))),
    });
    Ok(())
}

fn with_store<T>(
    app: &AppHandle,
    f: impl FnOnce(&SkinStore) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<SkinsState>()
        .ok_or_else(|| "skins not ready".to_string())?;
    let store = lock(&state.store);
    f(&store)
}

fn emit_changed(app: &AppHandle, skins: &[SkinInfo]) {
    if let Err(e) = app.emit(SKINS_CHANGED, skins) {
        log::warn!("failed to emit {SKINS_CHANGED}: {e}");
    }
}

/// Broadcasts the current list (end of `setup`: lets windows retry a failed early load).
pub fn announce(app: &AppHandle) {
    match list(app) {
        Ok(all) => emit_changed(app, &all),
        Err(e) => log::warn!("could not list skins: {e}"),
    }
}

pub fn list(app: &AppHandle) -> Result<Vec<SkinInfo>, String> {
    with_store(app, SkinStore::list)
}

/// Native file dialog → validate → copy. Cancel → `None`.
pub fn import(app: &AppHandle) -> Result<Option<SkinInfo>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Skin importieren")
        .add_filter(
            "Bilder & Animationen",
            &["png", "svg", "gif", "webp", "json"],
        )
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let (info, all) = with_store(app, |store| {
        let info = store.import_file(&path)?;
        Ok((info, store.list()?))
    })?;
    emit_changed(app, &all);
    Ok(Some(info))
}

/// Deletes an imported skin; if it is the active one, falls back to the smiley.
pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let (removed, all) = with_store(app, |store| Ok((store.delete(id)?, store.list()?)))?;
    if current_settings(app).buddy.skin == id {
        let (_, new) = update_settings(app, |s| {
            let mut next = s.clone();
            next.buddy.skin = DEFAULT_SKIN.to_string();
            Ok(next)
        })?;
        emit_settings_changed(app, &new);
    }
    if removed {
        emit_changed(app, &all);
    }
    Ok(())
}

pub fn load(app: &AppHandle, id: &str) -> Result<SkinData, String> {
    with_store(app, |store| store.load(id))
}
