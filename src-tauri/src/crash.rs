//! Startup diagnostics. Release builds have no console and `panic = "abort"`, so any
//! failure before the log plugin is up would be completely invisible. This module:
//! - appends a breadcrumb per launch and every panic / fatal error to
//!   `%LOCALAPPDATA%\de.displaybuddy.desktop\diagnostics.log` (no Tauri needed), and
//! - on Windows shows the error in a native message box.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const IDENTIFIER: &str = "de.displaybuddy.desktop";
const MAX_LOG_BYTES: u64 = 256 * 1024;

pub fn diagnostics_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join(IDENTIFIER).join("diagnostics.log"))
}

/// Appends one line (with unix timestamp) to the diagnostics log; never fails.
pub fn record(line: &str) {
    eprintln!("[display-buddy] {line}");
    let Some(path) = diagnostics_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

/// Shows a blocking error dialog (Windows) – used for fatal startup errors and panics.
pub fn show_error(text: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let wide = |s: &str| {
            s.encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        };
        let body = wide(&format!(
            "{text}\n\nDetails: {}",
            diagnostics_path()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        ));
        let title = wide("Display Buddy – Fehler beim Start");
        // SAFETY: both buffers are valid, NUL-terminated UTF-16 for the duration of the call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = text;
}

/// Installs the panic hook. Call first thing in `run()`.
pub fn install() {
    record(&format!(
        "start v{} args={:?}",
        env!("CARGO_PKG_VERSION"),
        std::env::args().skip(1).collect::<Vec<_>>()
    ));
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        record(&format!("PANIC at {at}: {msg}"));
        show_error(&format!("Display Buddy ist abgestürzt:\n{msg}"));
        default(info);
    }));
}

/// Fatal error outside a panic (e.g. building the Tauri app failed).
pub fn fatal(context: &str, error: &dyn std::fmt::Display) -> ! {
    record(&format!("FATAL {context}: {error}"));
    show_error(&format!("{context}:\n{error}"));
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    #[test]
    fn diagnostics_path_uses_identifier() {
        if let Some(p) = super::diagnostics_path() {
            assert!(
                p.ends_with("de.displaybuddy.desktop/diagnostics.log")
                    || p.ends_with(r"de.displaybuddy.desktop\diagnostics.log")
            );
        }
    }
}
