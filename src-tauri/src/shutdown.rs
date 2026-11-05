//! v2: flush on Windows logoff/shutdown (PLAN §11, closes D-20).
//! STUB – implemented by the "backend-reminders" agent.

use tauri::AppHandle;

/// Called from `setup`. Windows: subclass a window for WM_QUERYENDSESSION/WM_ENDSESSION.
pub fn install(_app: &AppHandle) {}
