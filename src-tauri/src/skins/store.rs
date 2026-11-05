//! Imported skins below `skins/` (no Tauri dependency, unit-testable).
//!
//! ```text
//! skins/index.json      [SkinInfo, …]
//! skins/<uuid>.<ext>    the imported file (png/svg/gif/webp/json)
//! ```

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;

use crate::model::{SkinData, SkinInfo, SkinKind, is_valid_note_id};
use crate::storage::{Read, read_json, write_json_atomic};

/// Max size of an imported file.
pub const MAX_SKIN_BYTES: u64 = 5 * 1024 * 1024;
/// Max length (chars) of a skin name.
pub const NAME_MAX_CHARS: usize = 60;
const INDEX_FILE: &str = "index.json";

/// File extension (without dot) for a stored skin of `mime`.
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/svg+xml" => "svg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/json" => "json",
        _ => return None,
    })
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_ascii_lowercase().contains(needle)
}

/// Validates an imported file by extension *and* content.
/// Returns `(kind, mime, ext)`.
pub fn detect_skin(
    file_name: &str,
    bytes: &[u8],
) -> Result<(SkinKind, &'static str, &'static str), String> {
    if bytes.len() as u64 > MAX_SKIN_BYTES {
        return Err("file is larger than 5 MB".into());
    }
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let bad = |what: &str| Err(format!("not a valid {what} file"));
    match ext.as_str() {
        "png" => {
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return bad("PNG");
            }
            Ok((SkinKind::Image, "image/png", "png"))
        }
        "gif" => {
            if !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
                return bad("GIF");
            }
            Ok((SkinKind::Image, "image/gif", "gif"))
        }
        "webp" => {
            if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return bad("WebP");
            }
            Ok((SkinKind::Image, "image/webp", "webp"))
        }
        "svg" => {
            let text =
                std::str::from_utf8(bytes).map_err(|_| "SVG is not UTF-8 text".to_string())?;
            if !contains_ci(text, "<svg") {
                return bad("SVG");
            }
            for forbidden in ["<script", "javascript:", "<foreignobject"] {
                if contains_ci(text, forbidden) {
                    return Err(format!("SVG must not contain {forbidden}"));
                }
            }
            Ok((SkinKind::Image, "image/svg+xml", "svg"))
        }
        "json" => {
            let value: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|e| format!("invalid JSON: {e}"))?;
            let obj = value
                .as_object()
                .ok_or_else(|| "Lottie JSON must be an object".to_string())?;
            for key in ["v", "fr", "ip", "op", "layers"] {
                if !obj.contains_key(key) {
                    return Err(format!("not a Lottie animation (missing \"{key}\")"));
                }
            }
            if !obj["layers"].is_array() {
                return Err("not a Lottie animation (\"layers\" is not an array)".into());
            }
            for key in ["fr", "ip", "op"] {
                if !obj[key].is_number() {
                    return Err(format!(
                        "not a Lottie animation (\"{key}\" is not a number)"
                    ));
                }
            }
            Ok((SkinKind::Lottie, "application/json", "json"))
        }
        _ => Err(format!("unsupported file type: .{ext}")),
    }
}

/// Skin name from the file name: stem, control chars removed, ≤ 60 chars.
pub fn skin_name(file_name: &str) -> String {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => file_name,
    };
    let cleaned: String = stem.chars().filter(|c| !c.is_control()).collect();
    let name: String = cleaned.trim().chars().take(NAME_MAX_CHARS).collect();
    match name.trim() {
        "" => "Skin".to_string(),
        n => n.to_string(),
    }
}

pub struct SkinStore {
    dir: PathBuf,
}

impl SkinStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_FILE)
    }

    /// The only way an id becomes a path: canonical uuid + known mime.
    fn file_path(&self, info: &SkinInfo) -> Result<PathBuf, String> {
        if !is_valid_note_id(&info.id) {
            return Err(format!("invalid skin id: {:?}", info.id));
        }
        let ext = ext_for_mime(&info.mime).ok_or_else(|| format!("unknown mime {}", info.mime))?;
        Ok(self.dir.join(format!("{}.{ext}", info.id)))
    }

    fn read_index(&self) -> Result<Vec<SkinInfo>, String> {
        Ok(
            match read_json::<Vec<SkinInfo>>(&self.index_path()).map_err(|e| e.to_string())? {
                Read::Ok(v) => v,
                Read::Missing | Read::Corrupt => Vec::new(),
            },
        )
    }

    fn write_index(&self, index: &[SkinInfo]) -> Result<(), String> {
        write_json_atomic(&self.index_path(), index).map_err(|e| e.to_string())
    }

    /// Index entries with a valid id, a known mime and an existing file.
    pub fn list(&self) -> Result<Vec<SkinInfo>, String> {
        let mut seen = HashSet::new();
        Ok(self
            .read_index()?
            .into_iter()
            .filter(|s| {
                self.file_path(s).is_ok_and(|p| p.is_file())
                    && ext_for_mime(&s.mime)
                        .is_some_and(|ext| (s.kind == SkinKind::Lottie) == (ext == "json"))
                    && seen.insert(s.id.clone())
            })
            .collect())
    }

    /// Validates and stores a file, returns its new index entry.
    pub fn import_bytes(&self, file_name: &str, bytes: &[u8]) -> Result<SkinInfo, String> {
        let (kind, mime, _ext) = detect_skin(file_name, bytes)?;
        let info = SkinInfo {
            id: uuid::Uuid::new_v4().hyphenated().to_string(),
            name: skin_name(file_name),
            kind,
            mime: mime.to_string(),
        };
        let path = self.file_path(&info)?;
        let mut index = self.list()?;
        // write the file atomically too (tmp + rename) so a crash never leaves half a skin
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes)
            .and_then(|()| fs::rename(&tmp, &path))
            .map_err(|e| {
                let _ = fs::remove_file(&tmp);
                e.to_string()
            })?;
        index.push(info.clone());
        if let Err(e) = self.write_index(&index) {
            let _ = fs::remove_file(&path);
            return Err(e);
        }
        Ok(info)
    }

    /// Imports a file from disk (size checked before reading).
    pub fn import_file(&self, path: &Path) -> Result<SkinInfo, String> {
        let meta = fs::metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_SKIN_BYTES {
            return Err("file is larger than 5 MB".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.import_bytes(&file_name, &bytes)
    }

    /// Removes the index entry and the file. Unknown (valid) ids are a no-op;
    /// returns whether anything was removed.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        if !is_valid_note_id(id) {
            return Err(format!("invalid skin id: {id:?}"));
        }
        let index = self.read_index()?;
        let (removed, kept): (Vec<_>, Vec<_>) = index.into_iter().partition(|s| s.id == id);
        if removed.is_empty() {
            return Ok(false);
        }
        self.write_index(&kept)?;
        for info in &removed {
            if let Ok(p) = self.file_path(info) {
                match fs::remove_file(&p) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => log::warn!("could not remove {}: {e}", p.display()),
                }
            }
        }
        Ok(true)
    }

    /// image → data URL; lottie → JSON text.
    pub fn load(&self, id: &str) -> Result<SkinData, String> {
        let info = self
            .list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("skin not found: {id}"))?;
        let bytes = fs::read(self.file_path(&info)?).map_err(|e| e.to_string())?;
        let data = match info.kind {
            SkinKind::Lottie => {
                String::from_utf8(bytes).map_err(|_| "skin is not UTF-8".to_string())?
            }
            SkinKind::Image => format!(
                "data:{};base64,{}",
                info.mime,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        };
        Ok(SkinData { info, data })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const LOTTIE: &str = r#"{"v":"5.7.4","fr":30,"ip":0,"op":60,"w":100,"h":100,"layers":[]}"#;

    #[test]
    fn detects_valid_files() {
        assert_eq!(
            detect_skin("a.PNG", PNG).unwrap(),
            (SkinKind::Image, "image/png", "png")
        );
        assert_eq!(detect_skin("a.gif", b"GIF89a....").unwrap().1, "image/gif");
        assert_eq!(detect_skin("a.gif", b"GIF87a....").unwrap().1, "image/gif");
        assert_eq!(
            detect_skin("a.webp", b"RIFF\x10\0\0\0WEBPVP8 ").unwrap().1,
            "image/webp"
        );
        assert_eq!(
            detect_skin(
                "a.svg",
                br#"<?xml version="1.0"?><SVG xmlns="http://www.w3.org/2000/svg"></SVG>"#
            )
            .unwrap(),
            (SkinKind::Image, "image/svg+xml", "svg")
        );
        assert_eq!(
            detect_skin("anim.json", LOTTIE.as_bytes()).unwrap(),
            (SkinKind::Lottie, "application/json", "json")
        );
    }

    #[test]
    fn rejects_invalid_files() {
        let cases: &[(&str, &[u8])] = &[
            ("a.png", b"GIF89a"),
            ("a.gif", PNG),
            ("a.webp", b"RIFF\0\0\0\0WAVE"),
            ("a.webp", b"RIFF"),
            ("a.svg", b"<html></html>"),
            ("a.svg", b"<svg><script>alert(1)</script></svg>"),
            ("a.svg", b"<svg><SCRIPT src=x /></svg>"),
            ("a.svg", b"<svg><a href=\"JavaScript:alert(1)\"/></svg>"),
            ("a.svg", b"<svg><foreignObject></foreignObject></svg>"),
            ("a.svg", b"<svg>\xff\xfe</svg>"),
            ("a.json", b"{nope"),
            ("a.json", b"[]"),
            ("a.json", br#"{"v":"5","fr":30,"ip":0,"op":60}"#),
            ("a.json", br#"{"v":"5","fr":30,"ip":0,"op":60,"layers":{}}"#),
            (
                "a.json",
                br#"{"v":"5","fr":"30","ip":0,"op":60,"layers":[]}"#,
            ),
            ("a.exe", PNG),
            ("noext", PNG),
            ("a.jpg", b"\xff\xd8\xff"),
        ];
        for (name, bytes) in cases {
            assert!(detect_skin(name, bytes).is_err(), "{name} {bytes:?}");
        }
        let big = vec![0u8; MAX_SKIN_BYTES as usize + 1];
        assert!(detect_skin("a.png", &big).is_err());
    }

    #[test]
    fn names_from_file_names() {
        assert_eq!(skin_name("Mein Kater.png"), "Mein Kater");
        assert_eq!(skin_name("a.b.json"), "a.b");
        assert_eq!(skin_name(".png"), ".png");
        assert_eq!(skin_name("  .svg"), "Skin");
        assert_eq!(
            skin_name(&format!("{}.gif", "ü".repeat(80)))
                .chars()
                .count(),
            60
        );
    }

    #[test]
    fn import_list_load_delete() {
        let dir = TempDir::new().unwrap();
        let store = SkinStore::new(dir.path().join("skins"));
        assert!(store.list().unwrap().is_empty());

        let png = store.import_bytes("Kater.png", PNG).unwrap();
        let lottie = store.import_bytes("Tanz.json", LOTTIE.as_bytes()).unwrap();
        assert_eq!(png.name, "Kater");
        assert_eq!(lottie.kind, SkinKind::Lottie);
        assert!(dir.path().join(format!("skins/{}.png", png.id)).is_file());
        assert_eq!(store.list().unwrap(), vec![png.clone(), lottie.clone()]);

        let data = store.load(&png.id).unwrap();
        assert!(data.data.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert_eq!(store.load(&lottie.id).unwrap().data, LOTTIE);
        assert!(store.load("11111111-1111-4111-8111-111111111111").is_err());
        assert!(store.load("../index").is_err());

        assert!(
            store
                .import_bytes("evil.svg", b"<svg><script/></svg>")
                .is_err()
        );
        assert_eq!(store.list().unwrap().len(), 2);

        assert!(store.delete(&png.id).unwrap());
        assert!(!dir.path().join(format!("skins/{}.png", png.id)).exists());
        assert!(!store.delete(&png.id).unwrap());
        assert!(store.delete("../../x").is_err());
        assert_eq!(store.list().unwrap(), vec![lottie]);
    }

    #[test]
    fn list_drops_entries_without_file() {
        let dir = TempDir::new().unwrap();
        let store = SkinStore::new(dir.path());
        let a = store.import_bytes("a.png", PNG).unwrap();
        let b = store.import_bytes("b.png", PNG).unwrap();
        fs::remove_file(dir.path().join(format!("{}.png", a.id))).unwrap();
        assert_eq!(store.list().unwrap(), vec![b]);
    }

    #[test]
    fn import_file_checks_size_first() {
        let dir = TempDir::new().unwrap();
        let store = SkinStore::new(dir.path().join("skins"));
        let big = dir.path().join("big.png");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_SKIN_BYTES + 1).unwrap();
        assert!(store.import_file(&big).is_err());
        let ok = dir.path().join("ok.gif");
        fs::write(&ok, b"GIF89a").unwrap();
        assert_eq!(store.import_file(&ok).unwrap().name, "ok");
    }
}
