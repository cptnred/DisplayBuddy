//! File-based persistence (no Tauri dependency, unit-testable).
//!
//! Layout below `root`:
//! ```text
//! settings.json
//! notes/index.json      ["uuid", …] (order)
//! notes/<uuid>.json     Note
//! ```
//! All writes are atomic (`<file>.tmp` + `sync_all` + `rename`). Corrupt JSON is
//! moved aside to `<file>.corrupt` (or `<file>.<unix_ts>.corrupt`) and skipped.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::model::{Note, Settings, is_valid_note_id};

const SETTINGS_FILE: &str = "settings.json";
const NOTES_DIR: &str = "notes";
const INDEX_FILE: &str = "index.json";

#[derive(Debug)]
pub enum StorageError {
    InvalidId(String),
    NotFound(String),
    Corrupt(String),
    NewerVersion(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId(id) => write!(f, "invalid note id: {id:?}"),
            Self::NotFound(id) => write!(f, "note not found: {id}"),
            Self::Corrupt(id) => write!(f, "note file is corrupt (moved aside): {id}"),
            Self::NewerVersion(id) => {
                write!(
                    f,
                    "note {id} was written by a newer app version; not overwritten"
                )
            }
            Self::Io(e) => write!(f, "i/o error: {e}"),
            Self::Json(e) => write!(f, "json error: {e}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<io::Error> for StorageError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Result of reading one JSON file.
enum Read<T> {
    Missing,
    /// Unparseable; the file has already been moved aside.
    Corrupt,
    Ok(T),
}

#[derive(Debug, Clone)]
pub struct Storage {
    root: PathBuf,
}

impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn notes_dir(&self) -> PathBuf {
        self.root.join(NOTES_DIR)
    }

    fn index_path(&self) -> PathBuf {
        self.notes_dir().join(INDEX_FILE)
    }

    fn settings_path(&self) -> PathBuf {
        self.root.join(SETTINGS_FILE)
    }

    /// The only way a note id becomes a path: rejects anything but a canonical UUID.
    fn note_path(&self, id: &str) -> Result<PathBuf> {
        if !is_valid_note_id(id) {
            return Err(StorageError::InvalidId(id.to_string()));
        }
        Ok(self.notes_dir().join(format!("{id}.json")))
    }

    // ---------------------------------------------------------------- notes

    /// All notes in index order. Ids whose file is missing/corrupt are dropped,
    /// orphan note files are appended (sorted by `createdAt`), and the index is
    /// rewritten if it changed.
    pub fn list_notes(&self) -> Result<Vec<Note>> {
        let index = self.read_index()?;
        let mut notes = Vec::new();
        let mut seen = HashSet::new();
        for id in index.iter().flatten() {
            if !is_valid_note_id(id) || !seen.insert(id.clone()) {
                continue;
            }
            if let Read::Ok(note) = self.read_note(id)? {
                notes.push(note);
            }
        }

        let mut orphans = Vec::new();
        for id in self.note_ids_on_disk()? {
            if seen.contains(&id) {
                continue;
            }
            if let Read::Ok(note) = self.read_note(&id)? {
                seen.insert(id);
                orphans.push(note);
            }
        }
        if !orphans.is_empty() {
            log::info!("appending {} note(s) missing from index", orphans.len());
        }
        orphans.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        notes.extend(orphans);

        let ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();
        let needs_write = match &index {
            Some(old) => *old != ids,
            None => !ids.is_empty(),
        };
        if needs_write {
            self.write_index(&ids)?;
        }
        Ok(notes)
    }

    pub fn load_note(&self, id: &str) -> Result<Note> {
        self.note_path(id)?;
        match self.read_note(id)? {
            Read::Ok(note) => Ok(note),
            Read::Missing => Err(StorageError::NotFound(id.to_string())),
            Read::Corrupt => Err(StorageError::Corrupt(id.to_string())),
        }
    }

    /// Writes the note atomically; appends its id to the index if unknown.
    pub fn save_note(&self, note: &Note) -> Result<Note> {
        let path = self.note_path(&note.id)?;
        // Never silently downgrade a note written by a newer app version.
        if let Ok(text) = fs::read_to_string(&path)
            && let Ok(existing) = serde_json::from_str::<serde_json::Value>(&text)
            && existing
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|v| v > u64::from(crate::model::NOTE_SCHEMA_VERSION))
        {
            return Err(StorageError::NewerVersion(note.id.clone()));
        }
        write_json_atomic(&path, note)?;
        let mut index = self.read_index()?.unwrap_or_default();
        if !index.contains(&note.id) {
            index.push(note.id.clone());
            self.write_index(&index)?;
        }
        Ok(note.clone())
    }

    /// Removes the note file (missing is fine) and its id from the index.
    pub fn delete_note(&self, id: &str) -> Result<()> {
        let path = self.note_path(id)?;
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if let Some(index) = self.read_index()? {
            let filtered: Vec<String> = index.iter().filter(|x| *x != id).cloned().collect();
            if filtered.len() != index.len() {
                self.write_index(&filtered)?;
            }
        }
        Ok(())
    }

    /// Stores a new order. Only valid ids of existing notes are kept (first
    /// occurrence wins); existing notes missing from `ids` are appended in their
    /// previous order, so a bad order can never lose a note.
    pub fn save_order(&self, ids: &[String]) -> Result<()> {
        let current: Vec<String> = self.list_notes()?.into_iter().map(|n| n.id).collect();
        let existing: HashSet<&String> = current.iter().collect();
        let mut seen = HashSet::new();
        let mut order: Vec<String> = Vec::with_capacity(current.len());
        for id in ids {
            if existing.contains(id) && seen.insert(id.clone()) {
                order.push(id.clone());
            }
        }
        for id in &current {
            if seen.insert(id.clone()) {
                order.push(id.clone());
            }
        }
        if order != current {
            self.write_index(&order)?;
        }
        Ok(())
    }

    fn read_note(&self, id: &str) -> Result<Read<Note>> {
        let path = self.note_path(id)?;
        Ok(match read_json::<Note>(&path)? {
            Read::Ok(mut note) => {
                if note.id != id {
                    log::warn!(
                        "note file {id}.json contains id {:?}; using file name",
                        note.id
                    );
                    note.id = id.to_string();
                }
                Read::Ok(note)
            }
            other => other,
        })
    }

    /// `None` if there is no index file (or it was corrupt and moved aside).
    fn read_index(&self) -> Result<Option<Vec<String>>> {
        Ok(match read_json::<Vec<String>>(&self.index_path())? {
            Read::Ok(ids) => Some(ids),
            Read::Missing | Read::Corrupt => None,
        })
    }

    fn write_index(&self, ids: &[String]) -> Result<()> {
        write_json_atomic(&self.index_path(), &ids)
    }

    /// Ids of all `<uuid>.json` files in the notes dir, sorted for determinism.
    fn note_ids_on_disk(&self) -> Result<Vec<String>> {
        let dir = match fs::read_dir(self.notes_dir()) {
            Ok(dir) => dir,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut ids = Vec::new();
        for entry in dir {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str())
                && is_valid_note_id(stem)
            {
                ids.push(stem.to_string());
            }
        }
        ids.sort();
        Ok(ids)
    }

    // ------------------------------------------------------------- settings

    /// Missing file → defaults. Corrupt file → moved aside, defaults.
    /// Wrong-typed keys fall back to their defaults individually.
    pub fn load_settings(&self) -> Result<Settings> {
        Ok(match read_json::<Value>(&self.settings_path())? {
            Read::Ok(value) if value.is_object() => Settings::from_value_lenient(&value),
            Read::Ok(_) => {
                quarantine(&self.settings_path());
                Settings::default()
            }
            Read::Missing | Read::Corrupt => Settings::default(),
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        write_json_atomic(&self.settings_path(), settings)
    }
}

/// Reads and parses a JSON file; unparseable files are moved aside.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Read<T>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Read::Missing),
        Err(e) => return Err(e.into()),
    };
    match serde_json::from_slice::<T>(&bytes) {
        Ok(v) => Ok(Read::Ok(v)),
        Err(e) => {
            log::warn!("corrupt JSON in {}: {e}", path.display());
            quarantine(path);
            Ok(Read::Corrupt)
        }
    }
}

/// Moves a broken file to `<file>.corrupt`, or `<file>.<unix_ts>.corrupt` if that
/// already exists (plus a counter if even that is taken).
fn quarantine(path: &Path) {
    let target = corrupt_target(path);
    match fs::rename(path, &target) {
        Ok(()) => log::warn!("moved {} to {}", path.display(), target.display()),
        Err(e) => log::warn!("could not move corrupt file {}: {e}", path.display()),
    }
}

fn corrupt_target(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let simple = path.with_file_name(format!("{name}.corrupt"));
    if !simple.exists() {
        return simple;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamped = path.with_file_name(format!("{name}.{ts}.corrupt"));
    if !stamped.exists() {
        return stamped;
    }
    (1u32..)
        .map(|n| path.with_file_name(format!("{name}.{ts}-{n}.corrupt")))
        .find(|p| !p.exists())
        .unwrap_or(stamped)
}

/// `<file>.tmp` + `sync_all` + `rename` (replaces the target atomically, also on
/// Windows where `std::fs::rename` uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`).
fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp"));
    let result = (|| -> io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(result?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NoteColor, WindowPosition};
    use serde_json::json;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Storage) {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path());
        (dir, storage)
    }

    fn note(id: &str, created: &str) -> Note {
        Note {
            id: id.to_string(),
            title: format!("t-{id}"),
            color: NoteColor::Blue,
            content: json!({"type": "doc", "content": [{"type": "paragraph"}]}),
            created_at: created.to_string(),
            updated_at: created.to_string(),
            schema_version: 1,
        }
    }

    fn new_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn ids(notes: &[Note]) -> Vec<String> {
        notes.iter().map(|n| n.id.clone()).collect()
    }

    fn index_on_disk(s: &Storage) -> Vec<String> {
        serde_json::from_slice(&fs::read(s.index_path()).unwrap()).unwrap()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn empty_storage() {
        let (_d, s) = setup();
        assert!(s.list_notes().unwrap().is_empty());
        assert!(
            !s.index_path().exists(),
            "no index written for empty storage"
        );
        assert_eq!(s.load_settings().unwrap(), Settings::default());
    }

    #[test]
    fn note_roundtrip_and_index() {
        let (_d, s) = setup();
        let a = note(&new_id(), "2026-01-01T00:00:00Z");
        let b = note(&new_id(), "2026-01-02T00:00:00Z");
        assert_eq!(s.save_note(&a).unwrap(), a);
        s.save_note(&b).unwrap();
        assert_eq!(s.load_note(&a.id).unwrap(), a);
        assert_eq!(s.list_notes().unwrap(), vec![a.clone(), b.clone()]);
        assert_eq!(index_on_disk(&s), vec![a.id.clone(), b.id.clone()]);

        // updating does not duplicate the index entry
        let mut a2 = a.clone();
        a2.title = "changed".into();
        s.save_note(&a2).unwrap();
        assert_eq!(index_on_disk(&s), vec![a.id.clone(), b.id.clone()]);
        assert_eq!(s.load_note(&a.id).unwrap().title, "changed");
    }

    #[test]
    fn delete_note() {
        let (_d, s) = setup();
        let a = note(&new_id(), "1");
        let b = note(&new_id(), "2");
        s.save_note(&a).unwrap();
        s.save_note(&b).unwrap();
        s.delete_note(&a.id).unwrap();
        assert_eq!(ids(&s.list_notes().unwrap()), vec![b.id.clone()]);
        assert_eq!(index_on_disk(&s), vec![b.id.clone()]);
        assert!(matches!(s.load_note(&a.id), Err(StorageError::NotFound(_))));
        // deleting again / unknown id is fine
        s.delete_note(&a.id).unwrap();
        s.delete_note(&new_id()).unwrap();
    }

    #[test]
    fn save_order_reorders() {
        let (_d, s) = setup();
        let (a, b, c) = (
            note(&new_id(), "1"),
            note(&new_id(), "2"),
            note(&new_id(), "3"),
        );
        for n in [&a, &b, &c] {
            s.save_note(n).unwrap();
        }
        s.save_order(&[c.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );
    }

    #[test]
    fn save_order_bad_input_never_loses_notes() {
        let (_d, s) = setup();
        let (a, b, c) = (
            note(&new_id(), "1"),
            note(&new_id(), "2"),
            note(&new_id(), "3"),
        );
        for n in [&a, &b, &c] {
            s.save_note(n).unwrap();
        }
        s.save_order(&[
            "../../etc/passwd".into(),
            c.id.clone(),
            new_id(),     // unknown
            c.id.clone(), // duplicate
            "".into(),
            a.id.to_uppercase(),
        ])
        .unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );

        s.save_order(&[]).unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );
    }

    #[test]
    fn list_reconciles_missing_and_orphans() {
        let (_d, s) = setup();
        let a = note(&new_id(), "2026-01-03T00:00:00Z");
        let b = note(&new_id(), "2026-01-01T00:00:00Z");
        s.save_note(&a).unwrap();
        // b is an orphan (written without index), c is an older orphan
        let c = note(&new_id(), "2026-01-02T00:00:00Z");
        write_json_atomic(&s.note_path(&b.id).unwrap(), &b).unwrap();
        write_json_atomic(&s.note_path(&c.id).unwrap(), &c).unwrap();
        // index references a missing note, an invalid id and a duplicate
        let ghost = new_id();
        s.write_index(&[ghost.clone(), a.id.clone(), "bad".into(), a.id.clone()])
            .unwrap();
        // a non-uuid json file and a corrupt-marker are ignored
        fs::write(s.notes_dir().join("readme.json"), "{}").unwrap();

        let listed = ids(&s.list_notes().unwrap());
        assert_eq!(listed, vec![a.id.clone(), b.id.clone(), c.id.clone()]);
        assert_eq!(index_on_disk(&s), listed, "index rewritten");
    }

    #[test]
    fn missing_index_is_rebuilt_from_files() {
        let (_d, s) = setup();
        let a = note(&new_id(), "2");
        let b = note(&new_id(), "1");
        s.save_note(&a).unwrap();
        s.save_note(&b).unwrap();
        fs::remove_file(s.index_path()).unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![b.id.clone(), a.id.clone()]
        );
        assert_eq!(index_on_disk(&s), vec![b.id.clone(), a.id.clone()]);
    }

    #[test]
    fn corrupt_note_is_moved_aside_and_skipped() {
        let (_d, s) = setup();
        let a = note(&new_id(), "1");
        let b = note(&new_id(), "2");
        s.save_note(&a).unwrap();
        s.save_note(&b).unwrap();
        let path = s.note_path(&a.id).unwrap();
        fs::write(&path, "{ not json").unwrap();

        assert_eq!(ids(&s.list_notes().unwrap()), vec![b.id.clone()]);
        assert!(!path.exists());
        let corrupt = s.notes_dir().join(format!("{}.json.corrupt", a.id));
        assert_eq!(fs::read_to_string(&corrupt).unwrap(), "{ not json");
        assert_eq!(index_on_disk(&s), vec![b.id.clone()]);

        // second corruption of the same file gets a timestamped name
        fs::write(&path, "[]").unwrap();
        assert!(matches!(s.load_note(&a.id), Err(StorageError::Corrupt(_))));
        let names = files_in(&s.notes_dir());
        let prefix = format!("{}.json.", a.id);
        let stamped: Vec<_> = names
            .iter()
            .filter(|n| {
                n.starts_with(&prefix)
                    && n.ends_with(".corrupt")
                    && **n != format!("{}.json.corrupt", a.id)
            })
            .collect();
        assert_eq!(stamped.len(), 1, "{names:?}");
        assert!(corrupt.exists(), "first quarantine file kept");
    }

    #[test]
    fn note_with_missing_required_field_counts_as_corrupt() {
        let (_d, s) = setup();
        let id = new_id();
        fs::create_dir_all(s.notes_dir()).unwrap();
        fs::write(
            s.note_path(&id).unwrap(),
            json!({"id": id, "title": "x"}).to_string(),
        )
        .unwrap();
        assert!(s.list_notes().unwrap().is_empty());
        assert!(s.notes_dir().join(format!("{id}.json.corrupt")).exists());
    }

    #[test]
    fn note_unknown_and_missing_optional_fields() {
        let (_d, s) = setup();
        let id = new_id();
        fs::create_dir_all(s.notes_dir()).unwrap();
        fs::write(
            s.note_path(&id).unwrap(),
            json!({
                "id": id, "content": {"type": "doc"}, "createdAt": "x", "updatedAt": "y",
                "color": "magenta", "futureField": [1, 2, 3]
            })
            .to_string(),
        )
        .unwrap();
        let n = s.load_note(&id).unwrap();
        assert_eq!(n.title, "");
        assert_eq!(n.color, NoteColor::Yellow);
        assert_eq!(n.schema_version, 1);
    }

    #[test]
    fn note_file_id_mismatch_uses_file_name() {
        let (_d, s) = setup();
        let id = new_id();
        let mut n = note(&new_id(), "1");
        write_json_atomic(&s.note_path(&id).unwrap(), &n).unwrap();
        n.id = id.clone();
        assert_eq!(s.load_note(&id).unwrap(), n);
    }

    #[test]
    fn corrupt_index_is_moved_aside_and_rebuilt() {
        let (_d, s) = setup();
        let a = note(&new_id(), "1");
        let b = note(&new_id(), "2");
        s.save_note(&a).unwrap();
        s.save_note(&b).unwrap();
        fs::write(s.index_path(), "garbage").unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![a.id.clone(), b.id.clone()]
        );
        assert!(s.notes_dir().join("index.json.corrupt").exists());
        assert_eq!(index_on_disk(&s), vec![a.id.clone(), b.id.clone()]);

        // wrong JSON type is corrupt as well
        fs::write(s.index_path(), r#"{"a": 1}"#).unwrap();
        let c = note(&new_id(), "3");
        s.save_note(&c).unwrap();
        assert_eq!(
            ids(&s.list_notes().unwrap()),
            vec![c.id.clone(), a.id.clone(), b.id.clone()]
        );
    }

    #[test]
    fn invalid_ids_are_rejected_before_fs_use() {
        let (dir, s) = setup();
        fs::write(dir.path().join("secret.json"), "{}").unwrap();
        for bad in [
            "../secret",
            "..\\secret",
            "/etc/passwd",
            "",
            "abc",
            "C:\\x",
            "../settings",
        ] {
            assert!(
                matches!(s.load_note(bad), Err(StorageError::InvalidId(_))),
                "{bad}"
            );
            assert!(
                matches!(s.delete_note(bad), Err(StorageError::InvalidId(_))),
                "{bad}"
            );
            let mut n = note(&new_id(), "1");
            n.id = bad.to_string();
            assert!(
                matches!(s.save_note(&n), Err(StorageError::InvalidId(_))),
                "{bad}"
            );
        }
        assert!(dir.path().join("secret.json").exists());
        assert!(!s.notes_dir().exists(), "nothing was written");
    }

    #[test]
    fn load_missing_note() {
        let (_d, s) = setup();
        assert!(matches!(
            s.load_note(&new_id()),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn atomic_write_leaves_no_tmp() {
        let (dir, s) = setup();
        let a = note(&new_id(), "1");
        s.save_note(&a).unwrap();
        s.save_settings(&Settings::default()).unwrap();
        s.save_order(std::slice::from_ref(&a.id)).unwrap();
        assert_eq!(
            files_in(&s.notes_dir()),
            vec![format!("{}.json", a.id), "index.json".into()]
        );
        assert_eq!(
            files_in(dir.path()),
            vec!["notes".to_string(), "settings.json".into()]
        );
    }

    #[test]
    fn atomic_write_replaces_existing_and_cleans_up_on_error() {
        let (dir, _s) = setup();
        let path = dir.path().join("x.json");
        write_json_atomic(&path, &json!({"v": 1})).unwrap();
        write_json_atomic(&path, &json!({"v": 2})).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(v, json!({"v": 2}));

        // target is a directory → rename fails, tmp is removed
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("child"), "x").unwrap();
        assert!(write_json_atomic(&blocked, &json!(1)).is_err());
        assert!(!dir.path().join("blocked.tmp").exists());
    }

    #[test]
    fn settings_roundtrip() {
        let (_d, s) = setup();
        let mut settings = Settings::default();
        settings.buddy.size = 150;
        settings.buddy_position = Some(WindowPosition { x: -1920, y: 300 });
        settings.global_shortcut = false;
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let (dir, s) = setup();
        fs::write(s.settings_path(), "{{{").unwrap();
        assert_eq!(s.load_settings().unwrap(), Settings::default());
        assert!(dir.path().join("settings.json.corrupt").exists());
        assert!(!s.settings_path().exists());

        fs::write(s.settings_path(), "[1,2]").unwrap();
        assert_eq!(s.load_settings().unwrap(), Settings::default());
        assert!(
            !s.settings_path().exists(),
            "non-object settings moved aside"
        );
    }

    #[test]
    fn settings_unknown_missing_and_wrong_fields_default() {
        let (_d, s) = setup();
        fs::write(
            s.settings_path(),
            json!({
                "buddy": {"size": 300, "faceColor": "#123456", "eyeStyle": "laser"},
                "hideNotesOnBlur": true,
                "notesSize": "big",
                "fromTheFuture": 1
            })
            .to_string(),
        )
        .unwrap();
        let loaded = s.load_settings().unwrap();
        let mut expected = Settings::default();
        expected.buddy.size = 192; // clamped
        expected.buddy.face_color = "#123456".into();
        expected.hide_notes_on_blur = true;
        assert_eq!(loaded, expected);
        assert!(
            s.settings_path().exists(),
            "partially valid file is not quarantined"
        );
    }

    #[test]
    fn save_refuses_to_downgrade_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let st = Storage::new(dir.path().to_path_buf());
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        let future = serde_json::json!({
            "id": id, "title": "", "color": "yellow", "content": {"type": "doc"},
            "createdAt": "x", "updatedAt": "x", "schemaVersion": 99
        });
        let path = dir.path().join("notes").join(format!("{id}.json"));
        std::fs::write(&path, future.to_string()).unwrap();
        let mut note: Note = serde_json::from_value(future).unwrap();
        note.schema_version = 1;
        assert!(matches!(
            st.save_note(&note),
            Err(StorageError::NewerVersion(_))
        ));
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["schemaVersion"], 99);
    }

    /// Same document as the frontend roundtrip test (`src/components/editor/extensions.test.ts`):
    /// real `editor.getJSON()` output with textStyle color/fontSize marks, a 3-level
    /// nested task list, emoji, umlauts, quotes and backslashes.
    const RICH_CONTENT: &str = include_str!("../../../src/test/fixtures/rich-note-content.json");

    #[test]
    fn rich_tiptap_note_roundtrips_verbatim() {
        let (_d, s) = setup();
        let content: Value = serde_json::from_str(RICH_CONTENT).unwrap();
        let id = new_id();
        let note = Note {
            id: id.clone(),
            title: "Einkauf – Freitag 😀".into(),
            color: NoteColor::Purple,
            content: content.clone(),
            created_at: "2026-11-05T10:00:00.000Z".into(),
            updated_at: "2026-11-05T10:05:30.123Z".into(),
            schema_version: 1,
        };
        assert_eq!(s.save_note(&note).unwrap(), note);

        // what the frontend gets back is identical (content stored verbatim)
        assert_eq!(s.load_note(&id).unwrap(), note);
        assert_eq!(s.list_notes().unwrap(), vec![note.clone()]);

        // file on disk: camelCase keys, UTF-8 (not \u-escaped), same content
        let raw = fs::read_to_string(s.notes_dir().join(format!("{id}.json"))).unwrap();
        assert!(raw.contains("vom Bäcker") && raw.contains("😀"));
        let on_disk: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk["content"], content);
        assert_eq!(on_disk["color"], "purple");
        assert_eq!(on_disk["updatedAt"], "2026-11-05T10:05:30.123Z");
        let nested = &on_disk["content"]["content"][2]["content"][1]["content"][1]["content"][0];
        assert_eq!(nested["attrs"]["checked"], true);
        assert_eq!(
            on_disk["content"]["content"][1]["content"][0]["marks"][0],
            json!({"type": "textStyle", "attrs": {"color": "#B8232A", "fontSize": "18px"}})
        );

        // a second save (autosave of an edit) over the existing file stays loadable
        let mut edited = note.clone();
        edited.content["content"][0]["content"][0]["text"] = json!("Einkauf am ");
        s.save_note(&edited).unwrap();
        assert_eq!(s.load_note(&id).unwrap(), edited);
        assert_eq!(index_on_disk(&s), vec![id]);
    }
}
