//! Server origin chosen at runtime (PLAN_V4 §6.5, D-97): `app_config_dir/server.json`.
//!
//! The build default (`BUDDY_PUBLIC_URL`, else `https://buddy.pev-point.de`) applies while
//! the file is missing, unreadable or invalid. Choosing the default removes the file, so a
//! later build with another default is followed again. Writes are atomic (temp file +
//! rename): a crash leaves the old or the new file, never half of one.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::server_url;

pub const FILE_NAME: &str = "server.json";

#[derive(Debug, Serialize, Deserialize)]
struct ServerFile {
    origin: String,
}

/// Effective origin: a valid `server.json` before the build default.
pub fn load(dir: &Path, default_origin: &str) -> String {
    let path = dir.join(FILE_NAME);
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return default_origin.to_string(),
        Err(e) => {
            log::warn!(
                "server.json unreadable ({}), using the default server",
                e.kind()
            );
            return default_origin.to_string();
        }
    };
    match serde_json::from_slice::<ServerFile>(&raw)
        .ok()
        .and_then(|f| server_url::normalize(&f.origin).ok())
    {
        Some(origin) => origin,
        None => {
            log::warn!("server.json invalid, using the default server");
            default_origin.to_string()
        }
    }
}

/// Validates and stores the choice (`None` or the default = remove the file). Returns the
/// new effective origin. Errors start with `invalid_url` or `storage`.
pub fn save(dir: &Path, origin: Option<&str>, default_origin: &str) -> Result<String, String> {
    let origin = match origin {
        Some(raw) => server_url::normalize(raw).map_err(|e| format!("invalid_url: {e}"))?,
        None => default_origin.to_string(),
    };
    let path = dir.join(FILE_NAME);
    if origin == default_origin {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("storage: {}", e.kind())),
        }
        return Ok(origin);
    }
    let json = serde_json::to_vec(&ServerFile {
        origin: origin.clone(),
    })
    .map_err(|e| format!("storage: {e}"))?;
    write_atomic(dir, &path, &json).map_err(|e| format!("storage: {}", e.kind()))?;
    Ok(origin)
}

fn write_atomic(dir: &Path, path: &Path, data: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const DEFAULT: &str = "https://buddy.pev-point.de";

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("buddy-server-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_means_default() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir, DEFAULT), DEFAULT);
    }

    #[test]
    fn saved_origin_is_normalised_and_loaded() {
        let dir = temp_dir("saved");
        let o = save(&dir, Some(" https://Notes.Example.NET/ "), DEFAULT).unwrap();
        assert_eq!(o, "https://notes.example.net");
        assert_eq!(load(&dir, DEFAULT), "https://notes.example.net");
        assert!(!dir.join("server.json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn default_or_null_removes_the_file() {
        let dir = temp_dir("reset");
        save(&dir, Some("https://notes.example.net"), DEFAULT).unwrap();
        assert_eq!(save(&dir, None, DEFAULT).unwrap(), DEFAULT);
        assert!(!dir.join(FILE_NAME).exists());
        save(&dir, Some("https://notes.example.net"), DEFAULT).unwrap();
        assert_eq!(
            save(&dir, Some("https://buddy.pev-point.de/"), DEFAULT).unwrap(),
            DEFAULT
        );
        assert!(!dir.join(FILE_NAME).exists());
        assert_eq!(load(&dir, DEFAULT), DEFAULT);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_origins_are_refused_and_nothing_is_written() {
        let dir = temp_dir("invalid");
        for bad in [
            "http://beispiel.de",
            "https://beispiel.de/pfad",
            "https://beispiel.de?x=1",
            "https://beispiel.de#c=1",
            "https://user@beispiel.de",
            "notes.example.net",
        ] {
            let e = save(&dir, Some(bad), DEFAULT).unwrap_err();
            assert!(e.starts_with("invalid_url"), "{bad}: {e}");
        }
        assert!(!dir.join(FILE_NAME).exists());
        assert_eq!(
            save(&dir, Some("http://10.0.2.2:8080"), DEFAULT).unwrap(),
            "http://10.0.2.2:8080"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_or_tampered_file_falls_back_to_default() {
        let dir = temp_dir("broken");
        fs::create_dir_all(&dir).unwrap();
        for content in [
            "not json",
            r#"{"origin":"http://evil.example"}"#,
            r#"{"origin":"https://x.example/api"}"#,
            r#"{}"#,
        ] {
            fs::write(dir.join(FILE_NAME), content).unwrap();
            assert_eq!(load(&dir, DEFAULT), DEFAULT, "{content}");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
