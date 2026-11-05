//! v2 custom skins (PLAN §11): import (png/svg/gif/webp/lottie json) into `skins/`, list, load.
//! STUB – implemented by the "backend-shortcuts" agent (same agent as shortcuts).

use tauri::AppHandle;

use crate::model::{SkinData, SkinInfo};

const TODO: &str = "skins: not implemented yet";

pub fn init(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn list(_app: &AppHandle) -> Result<Vec<SkinInfo>, String> {
    Ok(Vec::new())
}

pub fn import(_app: &AppHandle) -> Result<Option<SkinInfo>, String> {
    Err(TODO.into())
}

pub fn delete(_app: &AppHandle, _id: &str) -> Result<(), String> {
    Err(TODO.into())
}

pub fn load(_app: &AppHandle, _id: &str) -> Result<SkinData, String> {
    Err(TODO.into())
}
