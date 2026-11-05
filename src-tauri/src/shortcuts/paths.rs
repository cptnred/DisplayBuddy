//! Pure helpers for shortcut targets (no I/O, no Tauri). Paths are handled as
//! strings with both `\` and `/` as separators, so Windows paths can be tested on
//! any host.

use tauri::Url;

use crate::model::ShortcutKind;

/// Extensions (lowercase) that are started rather than opened as a document.
const PROGRAM_EXTENSIONS: &[&str] = &[
    "exe",
    "lnk",
    "bat",
    "cmd",
    "msi",
    "appref-ms",
    "url",
    "ps1",
    "com",
];

/// Max length (chars) of a display name.
pub const NAME_MAX_CHARS: usize = 80;
/// Max length (bytes) of a bookmark URL.
pub const URL_MAX_LEN: usize = 2048;

fn is_separator(c: char) -> bool {
    c == '\\' || c == '/'
}

/// Last path segment (trailing separators ignored).
fn last_segment(path: &str) -> &str {
    let trimmed = path.trim_end_matches(is_separator);
    trimmed.rsplit(is_separator).next().unwrap_or(trimmed)
}

/// `"C:"` / `"c:"` → `Some('C')`.
fn drive_letter(s: &str) -> Option<char> {
    let mut chars = s.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(letter), Some(':'), None) if letter.is_ascii_alphabetic() => {
            Some(letter.to_ascii_uppercase())
        }
        _ => None,
    }
}

/// Lowercase extension of the last segment (`None` for `.hidden` or no dot).
fn extension(path: &str) -> Option<String> {
    let name = last_segment(path);
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// dir → folder; program extensions (case-insensitive) → program; else file.
pub fn classify_path(path: &str, is_dir: bool) -> ShortcutKind {
    if is_dir {
        return ShortcutKind::Folder;
    }
    match extension(path) {
        Some(ext) if PROGRAM_EXTENSIONS.contains(&ext.as_str()) => ShortcutKind::Program,
        _ => ShortcutKind::File,
    }
}

/// Display name for a path: file stem for files, the folder name for folders,
/// „Laufwerk C:“ for drive roots.
pub fn display_name(path: &str, is_dir: bool) -> String {
    let trimmed = path.trim().trim_end_matches(is_separator);
    if let Some(letter) = drive_letter(trimmed) {
        return format!("Laufwerk {letter}:");
    }
    let name = last_segment(trimmed);
    let name = if is_dir {
        name
    } else {
        match name.rsplit_once('.') {
            Some((stem, _)) if !stem.is_empty() => stem,
            _ => name,
        }
    };
    let name = if name.is_empty() { path.trim() } else { name };
    truncate_chars(name, NAME_MAX_CHARS)
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Cleans a user-entered display name (trim, control chars removed, length capped).
pub fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    truncate_chars(cleaned.trim(), NAME_MAX_CHARS)
        .trim()
        .to_string()
}

/// Key used to detect duplicate path targets: case-insensitive with uniform
/// separators on Windows, verbatim elsewhere; trailing separators ignored
/// (but a drive root keeps its backslash).
pub fn path_key(path: &str) -> String {
    if cfg!(windows) {
        let unified = path.replace('/', "\\").to_lowercase();
        let trimmed = unified.trim_end_matches('\\');
        if drive_letter(trimmed).is_some() || trimmed.is_empty() {
            format!("{trimmed}\\")
        } else {
            trimmed.to_string()
        }
    } else {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            path.to_string()
        } else {
            trimmed.to_string()
        }
    }
}

/// Validates a bookmark URL: trimmed; `https://` prepended if it has no scheme;
/// only http/https with a host; no whitespace or control characters.
/// Returns `(normalized url, host)`.
pub fn normalize_bookmark(url: &str) -> Result<(String, String), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("url is empty".into());
    }
    if url.len() > URL_MAX_LEN {
        return Err("url is too long".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("url must not contain spaces or control characters".into());
    }
    let with_scheme = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    let parsed = Url::parse(&with_scheme).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url scheme: {}", parsed.scheme()));
    }
    // `user:pass@host` is a classic phishing disguise (and catches `mailto:x@host`).
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("url must not contain credentials".into());
    }
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "url has no host".to_string())?
        .to_string();
    Ok((parsed.to_string(), host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_folders_programs_files() {
        assert_eq!(classify_path(r"C:\Users\me", true), ShortcutKind::Folder);
        assert_eq!(classify_path(r"C:\Users\me.d", true), ShortcutKind::Folder);
        for p in [
            r"C:\Tools\app.exe",
            r"C:\Tools\APP.EXE",
            r"C:\Desktop\Word.lnk",
            r"C:\x\run.bat",
            r"C:\x\run.CMD",
            r"C:\x\setup.msi",
            r"C:\x\ClickOnce.appref-ms",
            r"C:\x\site.url",
            r"C:\x\script.ps1",
            r"C:\x\old.com",
            "/home/me/tool.exe",
        ] {
            assert_eq!(classify_path(p, false), ShortcutKind::Program, "{p}");
        }
        for p in [
            r"C:\docs\report.pdf",
            r"C:\docs\noext",
            r"C:\docs\.exe",
            r"C:\docs\exe",
            r"C:\docs\a.exe.txt",
        ] {
            assert_eq!(classify_path(p, false), ShortcutKind::File, "{p}");
        }
    }

    #[test]
    fn display_names() {
        assert_eq!(display_name(r"C:\Tools\App.exe", false), "App");
        assert_eq!(display_name(r"C:\docs\a.tar.gz", false), "a.tar");
        assert_eq!(display_name(r"C:\docs\.gitignore", false), ".gitignore");
        assert_eq!(display_name(r"C:\docs\README", false), "README");
        assert_eq!(display_name(r"C:\Users\me\My.Folder", true), "My.Folder");
        assert_eq!(display_name(r"C:\Users\me\Projects\", true), "Projects");
        assert_eq!(display_name("/home/me/notes.txt", false), "notes");
        assert_eq!(display_name(r"C:\", true), "Laufwerk C:");
        assert_eq!(display_name("d:", true), "Laufwerk D:");
        assert_eq!(display_name("D:/", true), "Laufwerk D:");
        assert_eq!(display_name(r"\\server\share", true), "share");
        let long = format!(r"C:\{}.txt", "x".repeat(200));
        assert_eq!(display_name(&long, false).chars().count(), NAME_MAX_CHARS);
    }

    #[test]
    fn clean_names() {
        assert_eq!(clean_name("  Hallo\tWelt \n"), "HalloWelt");
        assert_eq!(clean_name("   "), "");
        assert_eq!(clean_name(&"ä".repeat(100)).chars().count(), NAME_MAX_CHARS);
    }

    #[test]
    fn path_keys_detect_duplicates() {
        if cfg!(windows) {
            assert_eq!(path_key(r"C:\Tools\App.exe"), path_key("c:/tools/app.EXE"));
            assert_eq!(path_key(r"C:\Data\"), path_key(r"c:\data"));
            assert_eq!(path_key("C:"), path_key(r"C:\"));
        } else {
            assert_eq!(path_key("/home/me/dir/"), path_key("/home/me/dir"));
            assert_ne!(path_key("/home/me/A"), path_key("/home/me/a"));
            assert_eq!(path_key("/"), "/");
        }
    }

    #[test]
    fn bookmarks_are_normalized() {
        assert_eq!(
            normalize_bookmark("  example.com  ").unwrap(),
            (
                "https://example.com/".to_string(),
                "example.com".to_string()
            )
        );
        assert_eq!(
            normalize_bookmark("http://Example.com/a?b=c#d").unwrap(),
            (
                "http://example.com/a?b=c#d".to_string(),
                "example.com".to_string()
            )
        );
        assert_eq!(
            normalize_bookmark("HTTPS://www.example.org:8443/x")
                .unwrap()
                .1,
            "www.example.org"
        );
        assert_eq!(
            normalize_bookmark("localhost:3000").unwrap().0,
            "https://localhost:3000/"
        );
    }

    #[test]
    fn bad_bookmarks_are_rejected() {
        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "file:///C:/Windows/system32/calc.exe",
            "ftp://example.com",
            "mailto:me@example.com",
            "https://exa mple.com",
            "https://example.com/a b",
            "https://example.com/\u{7}",
            "https://",
            "data:text/html,<b>x</b>",
        ] {
            assert!(normalize_bookmark(bad).is_err(), "{bad:?} must be rejected");
        }
        assert!(normalize_bookmark(&format!("https://e.com/{}", "a".repeat(3000))).is_err());
    }
}
