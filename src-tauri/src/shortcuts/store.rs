//! `shortcuts.json` store (no Tauri dependency, unit-testable with `tempfile`).
//!
//! Keeps an in-memory copy; every change is written atomically first and only
//! then applied to the cache, so a failed write never leaves the cache ahead of
//! the file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::model::{
    SHORTCUTS_SCHEMA_VERSION, Shortcut, ShortcutKind, ShortcutList, ShortcutsData, is_valid_note_id,
};
use crate::storage::{Read, read_json, write_json_atomic};

use super::paths::{classify_path, clean_name, display_name, normalize_bookmark, path_key};

/// Max entries per list (`items`, `bookmarks`).
pub const MAX_PER_LIST: usize = 100;

pub struct ShortcutStore {
    path: PathBuf,
    cache: Option<ShortcutsData>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

fn list_mut(data: &mut ShortcutsData, list: ShortcutList) -> &mut Vec<Shortcut> {
    match list {
        ShortcutList::Items => &mut data.items,
        ShortcutList::Bookmarks => &mut data.bookmarks,
    }
}

/// Drops invalid/duplicate entries (bad ids, wrong kind for the list, unusable
/// targets, duplicate targets) and caps both lists. Used on load.
pub fn sanitize(data: ShortcutsData) -> ShortcutsData {
    let mut ids = HashSet::new();
    let mut item_keys = HashSet::new();
    let mut items = Vec::new();
    for mut s in data.items {
        if items.len() >= MAX_PER_LIST
            || !is_valid_note_id(&s.id)
            || s.kind == ShortcutKind::Url
            || s.target.trim().is_empty()
            || !item_keys.insert(path_key(&s.target))
            || !ids.insert(s.id.clone())
        {
            continue;
        }
        s.name = clean_name(&s.name);
        if s.name.is_empty() {
            s.name = display_name(&s.target, s.kind == ShortcutKind::Folder);
        }
        items.push(s);
    }
    let mut url_keys = HashSet::new();
    let mut bookmarks = Vec::new();
    for mut s in data.bookmarks {
        if bookmarks.len() >= MAX_PER_LIST
            || !is_valid_note_id(&s.id)
            || s.kind != ShortcutKind::Url
        {
            continue;
        }
        let Ok((url, host)) = normalize_bookmark(&s.target) else {
            continue;
        };
        if !url_keys.insert(url.clone()) || !ids.insert(s.id.clone()) {
            continue;
        }
        s.target = url;
        s.name = clean_name(&s.name);
        if s.name.is_empty() {
            s.name = host;
        }
        bookmarks.push(s);
    }
    ShortcutsData {
        schema_version: SHORTCUTS_SCHEMA_VERSION,
        items,
        bookmarks,
    }
}

/// `save_order` semantics: known ids in the given order (unknown/duplicate ids
/// dropped), then every entry missing from `ids` in its previous order.
pub fn reorder_list(list: &[Shortcut], ids: &[String]) -> Vec<Shortcut> {
    let mut used = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for id in ids {
        if let Some(s) = list.iter().find(|s| &s.id == id)
            && used.insert(id.clone())
        {
            out.push(s.clone());
        }
    }
    out.extend(list.iter().filter(|s| !used.contains(&s.id)).cloned());
    out
}

impl ShortcutStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Current data (loaded on first use; missing/corrupt file → empty lists).
    pub fn data(&mut self) -> Result<&ShortcutsData, String> {
        if self.cache.is_none() {
            let data = match read_json::<ShortcutsData>(&self.path).map_err(|e| e.to_string())? {
                Read::Ok(d) => sanitize(d),
                Read::Missing | Read::Corrupt => ShortcutsData::default(),
            };
            self.cache = Some(data);
        }
        Ok(self.cache.get_or_insert_with(ShortcutsData::default))
    }

    pub fn snapshot(&mut self) -> Result<ShortcutsData, String> {
        self.data().cloned()
    }

    pub fn find(&mut self, id: &str) -> Result<Option<Shortcut>, String> {
        let data = self.data()?;
        Ok(data
            .items
            .iter()
            .chain(&data.bookmarks)
            .find(|s| s.id == id)
            .cloned())
    }

    /// Applies `f` to a copy, persists it and updates the cache.
    /// `f` returns `false` for "nothing changed" (no write).
    fn modify(
        &mut self,
        f: impl FnOnce(&mut ShortcutsData) -> Result<bool, String>,
    ) -> Result<ShortcutsData, String> {
        let mut next = self.snapshot()?;
        if f(&mut next)? {
            write_json_atomic(&self.path, &next).map_err(|e| e.to_string())?;
            self.cache = Some(next.clone());
        }
        Ok(next)
    }

    /// Adds absolute paths to `items` (kind from the file system, name = stem);
    /// duplicates and entries beyond the limit are skipped.
    pub fn add_paths(&mut self, paths: &[PathBuf]) -> Result<ShortcutsData, String> {
        self.modify(|data| {
            let mut keys: HashSet<String> =
                data.items.iter().map(|s| path_key(&s.target)).collect();
            let mut changed = false;
            for path in paths {
                if data.items.len() >= MAX_PER_LIST {
                    log::info!("shortcut limit reached, skipping remaining paths");
                    break;
                }
                let Some(target) = path.to_str() else {
                    log::warn!("skipping non-UTF-8 path {}", path.display());
                    continue;
                };
                if !path.is_absolute() || !keys.insert(path_key(target)) {
                    continue;
                }
                let is_dir = path.is_dir();
                data.items.push(Shortcut {
                    id: new_id(),
                    kind: classify_path(target, is_dir),
                    name: display_name(target, is_dir),
                    target: target.to_string(),
                });
                changed = true;
            }
            Ok(changed)
        })
    }

    /// Adds a web link; an empty name becomes the host. A URL that is already
    /// stored is not added twice.
    pub fn add_bookmark(&mut self, name: &str, url: &str) -> Result<ShortcutsData, String> {
        let (url, host) = normalize_bookmark(url)?;
        let name = match clean_name(name) {
            n if n.is_empty() => host,
            n => n,
        };
        self.modify(|data| {
            if data.bookmarks.iter().any(|s| s.target == url) {
                return Ok(false);
            }
            if data.bookmarks.len() >= MAX_PER_LIST {
                return Err(format!("too many bookmarks (max {MAX_PER_LIST})"));
            }
            data.bookmarks.push(Shortcut {
                id: new_id(),
                kind: ShortcutKind::Url,
                name,
                target: url,
            });
            Ok(true)
        })
    }

    /// Renames an entry; `target` may only be changed for bookmarks (validated).
    /// An empty name falls back to the derived name (stem / host).
    pub fn update(
        &mut self,
        id: &str,
        name: &str,
        target: Option<&str>,
    ) -> Result<ShortcutsData, String> {
        self.modify(|data| {
            let is_bookmark = data.bookmarks.iter().any(|s| s.id == id);
            let new_target = match target {
                Some(t) if is_bookmark => {
                    let (url, host) = normalize_bookmark(t)?;
                    if data.bookmarks.iter().any(|s| s.id != id && s.target == url) {
                        return Err("bookmark already exists".into());
                    }
                    Some((url, host))
                }
                Some(t) => {
                    let current = data.items.iter().find(|s| s.id == id);
                    if current.is_some_and(|s| s.target != t) {
                        return Err("the target of a file/folder shortcut cannot be changed".into());
                    }
                    None
                }
                None => None,
            };
            let list = if is_bookmark {
                &mut data.bookmarks
            } else {
                &mut data.items
            };
            let entry = list
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| format!("shortcut not found: {id}"))?;
            if let Some((url, _)) = &new_target {
                entry.target = url.clone();
            }
            let mut name = clean_name(name);
            if name.is_empty() {
                name = match &new_target {
                    Some((_, host)) => host.clone(),
                    None if is_bookmark => normalize_bookmark(&entry.target)
                        .map(|(_, h)| h)
                        .unwrap_or_else(|_| entry.target.clone()),
                    None => display_name(&entry.target, entry.kind == ShortcutKind::Folder),
                };
            }
            entry.name = name;
            Ok(true)
        })
    }

    /// Removes an entry from either list (unknown id = no change).
    pub fn remove(&mut self, id: &str) -> Result<ShortcutsData, String> {
        self.modify(|data| {
            let before = data.items.len() + data.bookmarks.len();
            data.items.retain(|s| s.id != id);
            data.bookmarks.retain(|s| s.id != id);
            Ok(data.items.len() + data.bookmarks.len() != before)
        })
    }

    pub fn reorder(&mut self, list: ShortcutList, ids: &[String]) -> Result<ShortcutsData, String> {
        self.modify(|data| {
            let entries = list_mut(data, list);
            let next = reorder_list(entries, ids);
            let changed = next != *entries;
            *entries = next;
            Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, ShortcutStore) {
        let dir = TempDir::new().unwrap();
        let store = ShortcutStore::new(dir.path().join("shortcuts.json"));
        (dir, store)
    }

    fn on_disk(store: &ShortcutStore) -> ShortcutsData {
        serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap()
    }

    fn sc(id: &str, kind: ShortcutKind, name: &str, target: &str) -> Shortcut {
        Shortcut {
            id: id.into(),
            kind,
            name: name.into(),
            target: target.into(),
        }
    }

    #[test]
    fn missing_file_is_empty_and_not_written() {
        let (_d, mut store) = setup();
        assert_eq!(store.snapshot().unwrap(), ShortcutsData::default());
        assert!(!store.path().exists());
    }

    #[test]
    fn corrupt_file_is_quarantined() {
        let (d, mut store) = setup();
        fs::write(store.path(), b"{nope").unwrap();
        assert_eq!(store.snapshot().unwrap(), ShortcutsData::default());
        assert!(d.path().join("shortcuts.json.corrupt").exists());
    }

    #[test]
    fn add_paths_classifies_dedups_and_persists() {
        let (d, mut store) = setup();
        let folder = d.path().join("Projects");
        fs::create_dir(&folder).unwrap();
        let file = d.path().join("report.pdf");
        fs::write(&file, b"x").unwrap();
        let prog = d.path().join("Tool.EXE");
        fs::write(&prog, b"x").unwrap();

        let data = store
            .add_paths(&[
                folder.clone(),
                file.clone(),
                prog.clone(),
                file.clone(),
                PathBuf::from("relative.txt"),
            ])
            .unwrap();
        let summary: Vec<_> = data
            .items
            .iter()
            .map(|s| (s.kind, s.name.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (ShortcutKind::Folder, "Projects"),
                (ShortcutKind::File, "report"),
                (ShortcutKind::Program, "Tool"),
            ]
        );
        assert!(data.items.iter().all(|s| is_valid_note_id(&s.id)));
        assert_eq!(on_disk(&store), data);

        // adding the same paths again changes nothing
        let again = store.add_paths(&[folder, file]).unwrap();
        assert_eq!(again, data);

        // a fresh store reads the file back
        let mut reopened = ShortcutStore::new(store.path());
        assert_eq!(reopened.snapshot().unwrap(), data);
    }

    #[test]
    fn add_paths_respects_limit() {
        let (d, mut store) = setup();
        let paths: Vec<PathBuf> = (0..MAX_PER_LIST + 5)
            .map(|i| d.path().join(format!("f{i}.txt")))
            .collect();
        let data = store.add_paths(&paths).unwrap();
        assert_eq!(data.items.len(), MAX_PER_LIST);
    }

    #[test]
    fn bookmarks_add_dedup_and_default_name() {
        let (_d, mut store) = setup();
        let data = store.add_bookmark("  ", "example.com").unwrap();
        assert_eq!(data.bookmarks.len(), 1);
        assert_eq!(data.bookmarks[0].name, "example.com");
        assert_eq!(data.bookmarks[0].target, "https://example.com/");
        assert_eq!(data.bookmarks[0].kind, ShortcutKind::Url);
        let data = store.add_bookmark("Dup", "https://example.com").unwrap();
        assert_eq!(data.bookmarks.len(), 1);
        assert!(store.add_bookmark("x", "javascript:alert(1)").is_err());
        let data = store.add_bookmark("Docs", "http://docs.rs/x").unwrap();
        assert_eq!(data.bookmarks[1].name, "Docs");
        assert_eq!(on_disk(&store), data);
    }

    #[test]
    fn bookmark_limit_is_an_error() {
        let (_d, mut store) = setup();
        for i in 0..MAX_PER_LIST {
            store.add_bookmark("", &format!("e{i}.com")).unwrap();
        }
        assert!(store.add_bookmark("", "one-more.com").is_err());
    }

    #[test]
    fn update_renames_and_changes_bookmark_target() {
        let (d, mut store) = setup();
        let file = d.path().join("a.txt");
        let data = store.add_paths(std::slice::from_ref(&file)).unwrap();
        let item_id = data.items[0].id.clone();
        let data = store.add_bookmark("Ex", "example.com").unwrap();
        let bm_id = data.bookmarks[0].id.clone();

        let data = store.update(&item_id, " Neu ", None).unwrap();
        assert_eq!(data.items[0].name, "Neu");
        let data = store.update(&item_id, "", None).unwrap();
        assert_eq!(data.items[0].name, "a");
        // same target is fine, a different one is not
        assert!(
            store
                .update(&item_id, "x", Some(file.to_str().unwrap()))
                .is_ok()
        );
        assert!(store.update(&item_id, "x", Some("/etc/passwd")).is_err());

        let data = store
            .update(&bm_id, "", Some("rust-lang.org/learn"))
            .unwrap();
        assert_eq!(data.bookmarks[0].target, "https://rust-lang.org/learn");
        assert_eq!(data.bookmarks[0].name, "rust-lang.org");
        assert!(store.update(&bm_id, "x", Some("ftp://x")).is_err());
        assert!(store.update("nope", "x", None).is_err());
        assert_eq!(on_disk(&store), store.snapshot().unwrap());
    }

    #[test]
    fn update_rejects_duplicate_bookmark_target() {
        let (_d, mut store) = setup();
        store.add_bookmark("", "a.com").unwrap();
        let data = store.add_bookmark("", "b.com").unwrap();
        let b = data.bookmarks[1].id.clone();
        assert!(store.update(&b, "", Some("https://a.com/")).is_err());
    }

    #[test]
    fn remove_from_either_list() {
        let (d, mut store) = setup();
        store.add_paths(&[d.path().join("a.txt")]).unwrap();
        let data = store.add_bookmark("", "a.com").unwrap();
        let data = store.remove(&data.items[0].id.clone()).unwrap();
        assert!(data.items.is_empty());
        let data = store.remove(&data.bookmarks[0].id.clone()).unwrap();
        assert!(data.bookmarks.is_empty());
        assert_eq!(store.remove("unknown").unwrap(), data);
        assert_eq!(on_disk(&store), data);
    }

    #[test]
    fn reorder_like_save_order() {
        let (d, mut store) = setup();
        let data = store
            .add_paths(&[
                d.path().join("a.txt"),
                d.path().join("b.txt"),
                d.path().join("c.txt"),
            ])
            .unwrap();
        let ids: Vec<String> = data.items.iter().map(|s| s.id.clone()).collect();
        let data = store
            .reorder(
                ShortcutList::Items,
                &[
                    ids[2].clone(),
                    "unknown".into(),
                    ids[2].clone(),
                    ids[0].clone(),
                ],
            )
            .unwrap();
        let names: Vec<_> = data.items.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["c", "a", "b"]);
        assert_eq!(on_disk(&store), data);
        // other list untouched / empty order keeps everything
        let data = store.reorder(ShortcutList::Bookmarks, &[]).unwrap();
        assert!(data.bookmarks.is_empty());
        assert_eq!(data.items.len(), 3);
    }

    #[test]
    fn sanitize_drops_invalid_entries() {
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        let c = "33333333-3333-4333-8333-333333333333";
        let e = "55555555-5555-4555-8555-555555555555";
        let raw = ShortcutsData {
            schema_version: 0,
            items: vec![
                sc(a, ShortcutKind::File, "", "/x/a.txt"),
                sc("not-a-uuid", ShortcutKind::File, "x", "/x/b.txt"),
                sc(b, ShortcutKind::Url, "x", "https://e.com"),
                sc(c, ShortcutKind::File, "dup", "/x/a.txt"),
            ],
            bookmarks: vec![
                sc(a, ShortcutKind::Url, "dup id", "https://other.com"),
                sc(e, ShortcutKind::Url, "", "javascript:alert(1)"),
                sc(c, ShortcutKind::Url, "", "e.com"),
            ],
        };
        let clean = sanitize(raw);
        assert_eq!(clean.schema_version, SHORTCUTS_SCHEMA_VERSION);
        assert_eq!(
            clean.items,
            vec![sc(a, ShortcutKind::File, "a", "/x/a.txt")]
        );
        assert_eq!(
            clean.bookmarks,
            vec![sc(c, ShortcutKind::Url, "e.com", "https://e.com/")]
        );
    }
}
