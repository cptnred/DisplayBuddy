//! Display Buddy – native shell for Android and iOS (PLAN_V3_SYNC §10).
//!
//! The UI, data layer (IndexedDB), sync engine and the local reminder planning live in
//! the web frontend (`src/web`, entry `mobile/src/main.tsx`). This crate only adds:
//! - `tauri-plugin-notification` (local scheduling, actions, channels),
//! - `tauri-plugin-http` with a scope limited to `BUDDY_PUBLIC_URL/api/v1/*`,
//! - secure token storage (`token.rs`),
//! - `shell_config` (server origin from the build),
//! - native push (phase N2, Android/FCM only, D-55): the own plugin `buddy-push`
//!   (`mobile/plugins/buddy-push`); token registration, wake-up sync and re-planning live
//!   in the web layer (`src/web/notify/native-push.ts`).

// normalize() is used by build.rs and the tests; the app only needs api_scope()
#[cfg_attr(not(test), allow(dead_code))]
mod server_url;
mod token;

use serde::Serialize;
use tauri::Manager;
use tauri::ipc::CapabilityBuilder;

use token::TokenVault;

/// Server origin validated by build.rs (None if the build had no BUDDY_PUBLIC_URL).
pub const SERVER_ORIGIN: Option<&str> = option_env!("BUDDY_SERVER_ORIGIN");

/// Event sent to the webview when the app comes back to the foreground.
pub const RESUMED_EVENT: &str = "buddy://resumed";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    /// e.g. "https://buddy.example.org"; null → the UI explains that the build lacks it.
    server_url: Option<&'static str>,
    /// "android" | "ios" | "desktop" (development machine).
    platform: &'static str,
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

#[tauri::command]
fn shell_config() -> ShellConfig {
    ShellConfig {
        server_url: SERVER_ORIGIN,
        platform: platform(),
    }
}

#[tauri::command]
fn token_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let vault = app
        .try_state::<TokenVault>()
        .ok_or_else(|| "token storage not ready".to_string())?;
    vault.get()
}

#[tauri::command]
fn token_set(app: tauri::AppHandle, token: Option<String>) -> Result<(), String> {
    let vault = app
        .try_state::<TokenVault>()
        .ok_or_else(|| "token storage not ready".to_string())?;
    vault.set(token.as_deref())
}

/// HTTP plugin scope: only the API of the configured server (no wildcard hosts).
fn http_capability(origin: &str) -> CapabilityBuilder {
    #[derive(Serialize)]
    struct UrlScope {
        url: String,
    }
    CapabilityBuilder::new("http-server")
        .window("main")
        .permission_scoped(
            "http:default",
            vec![UrlScope {
                url: server_url::api_scope(origin),
            }],
            vec![],
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TokenVault::platform())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_buddy_push::init())
        .setup(|app| {
            if let Some(origin) = SERVER_ORIGIN {
                app.add_capability(http_capability(origin))?;
            } else {
                log::warn!("built without BUDDY_PUBLIC_URL: no server access");
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            // Resume (Android onResume / iOS applicationWillEnterForeground) → the web
            // layer re-plans local notifications (PLAN §10.3 „beim Fortsetzen“).
            #[cfg(mobile)]
            if let tauri::WindowEvent::Resumed = _event {
                use tauri::Emitter;
                let _ = _window.emit(RESUMED_EVENT, ());
            }
        })
        .invoke_handler(tauri::generate_handler![shell_config, token_get, token_set])
        .run(tauri::generate_context!())
        .expect("error while running the Display Buddy shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_config_serialises_camel_case() {
        let v = serde_json::to_value(ShellConfig {
            server_url: Some("https://buddy.example.org"),
            platform: "android",
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"serverUrl": "https://buddy.example.org", "platform": "android"})
        );
    }

    /// The patched plugin (mobile/patches) hands `Schedule.at` dates to the native side as
    /// UTC with milliseconds – the only form both native parsers read correctly.
    #[test]
    fn patched_plugin_serialises_schedule_dates_as_utc_millis() {
        for (input, expected) in [
            ("2026-11-06T10:00:00.000Z", "2026-11-06T10:00:00.000Z"),
            ("2026-11-06T10:00:00.123456789Z", "2026-11-06T10:00:00.123Z"),
            ("2026-11-06T11:00:05.5+01:00", "2026-11-06T10:00:05.500Z"),
        ] {
            let s: tauri_plugin_notification::Schedule = serde_json::from_value(
                serde_json::json!({"at": {"date": input, "repeating": false, "allowWhileIdle": true}}),
            )
            .unwrap();
            let v = serde_json::to_value(&s).unwrap();
            assert_eq!(v["at"]["date"], expected, "input {input}");
        }
    }

    #[test]
    fn baked_origin_is_valid() {
        if let Some(o) = SERVER_ORIGIN {
            assert_eq!(server_url::normalize(o).as_deref(), Ok(o));
        }
    }
}
