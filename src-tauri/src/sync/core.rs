//! Tauri-free sync bookkeeping: outbox (`sync/outbox.json`) and meta
//! (`sync/state.json`), both persisted atomically after every change.
//!
//! **Lock order:** `outbox` and `meta` are leaf locks. They may be taken while the
//! storage lock (`AppState.storage`) or the reminders lock is held, but no other lock
//! is ever taken while holding them, and they are never held across each other or a
//! network call.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::meta::SyncMeta;
use super::outbox::{Kind, Outbox, Pending, PendingOrder};
use crate::state::lock;
use crate::storage::{Read, read_json, write_json_atomic};

pub const SYNC_DIR: &str = "sync";
pub const OUTBOX_FILE: &str = "outbox.json";
pub const META_FILE: &str = "state.json";

pub struct SyncCore {
    dir: PathBuf,
    outbox: Mutex<Outbox>,
    meta: Mutex<SyncMeta>,
}

fn load<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match read_json::<T>(path) {
        Ok(Read::Ok(v)) => v,
        Ok(Read::Missing) | Ok(Read::Corrupt) => T::default(),
        Err(e) => {
            log::error!("could not read {}: {e}", path.display());
            T::default()
        }
    }
}

impl SyncCore {
    /// Loads `<app data>/sync/{outbox,state}.json` (missing/corrupt → empty).
    pub fn load(app_data: &Path) -> Self {
        let dir = app_data.join(SYNC_DIR);
        let outbox = load::<Outbox>(&dir.join(OUTBOX_FILE));
        let meta = load::<SyncMeta>(&dir.join(META_FILE));
        Self {
            dir,
            outbox: Mutex::new(outbox),
            meta: Mutex::new(meta),
        }
    }

    fn save_outbox(&self, o: &Outbox) {
        let path = self.dir.join(OUTBOX_FILE);
        if let Err(e) = write_json_atomic(&path, o) {
            log::error!("could not save {}: {e}", path.display());
        }
    }

    fn save_meta(&self, m: &SyncMeta) {
        let path = self.dir.join(META_FILE);
        if let Err(e) = write_json_atomic(&path, m) {
            log::error!("could not save {}: {e}", path.display());
        }
    }

    /// Changes the outbox and persists it if it changed.
    pub fn outbox_update<T>(&self, f: impl FnOnce(&mut Outbox) -> T) -> T {
        let mut o = lock(&self.outbox);
        let before = o.clone();
        let r = f(&mut o);
        if *o != before {
            self.save_outbox(&o);
        }
        r
    }

    pub fn outbox(&self) -> Outbox {
        lock(&self.outbox).clone()
    }

    pub fn pending(&self, kind: Kind, id: &str) -> Option<Pending> {
        let o = lock(&self.outbox);
        match kind {
            Kind::Note => o.notes.get(id).cloned(),
            Kind::Reminder => o.reminders.get(id).cloned(),
        }
    }

    pub fn pending_order(&self) -> Option<PendingOrder> {
        lock(&self.outbox).order.clone()
    }

    /// Drops an outbox entry because the remote version won.
    pub fn drop_pending(&self, kind: Kind, id: &str) {
        self.outbox_update(|o| match kind {
            Kind::Note => {
                o.notes.remove(id);
            }
            Kind::Reminder => {
                o.reminders.remove(id);
            }
        });
    }

    pub fn pending_count(&self) -> usize {
        lock(&self.outbox).len()
    }

    pub fn meta(&self) -> SyncMeta {
        lock(&self.meta).clone()
    }

    pub fn meta_update<T>(&self, f: impl FnOnce(&mut SyncMeta) -> T) -> T {
        let mut m = lock(&self.meta);
        let before = m.clone();
        let r = f(&mut m);
        if *m != before {
            self.save_meta(&m);
        }
        r
    }

    /// Forgets the connection (disconnect): empty outbox and meta.
    pub fn reset(&self) {
        self.outbox_update(|o| *o = Outbox::default());
        self.meta_update(|m| *m = SyncMeta::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let core = SyncCore::load(dir.path());
        assert_eq!(core.pending_count(), 0);
        core.outbox_update(|o| o.changed(Kind::Note, "a"));
        core.meta_update(|m| m.cursor = 9);
        let again = SyncCore::load(dir.path());
        assert!(again.pending(Kind::Note, "a").is_some());
        assert_eq!(again.meta().cursor, 9);
        again.drop_pending(Kind::Note, "a");
        assert_eq!(SyncCore::load(dir.path()).pending_count(), 0);

        std::fs::write(dir.path().join(SYNC_DIR).join(OUTBOX_FILE), "{ nope").unwrap();
        assert_eq!(
            SyncCore::load(dir.path()).pending_count(),
            0,
            "corrupt → empty"
        );
        again.reset();
        assert_eq!(SyncCore::load(dir.path()).meta(), SyncMeta::default());
    }
}
