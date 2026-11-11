//! Display Buddy – native shell for Android and iOS (PLAN_V3_SYNC §10).
//!
//! The UI, data layer (IndexedDB), sync engine and the local reminder planning live in
//! the web frontend (`src/web`, entry `mobile/src/main.tsx`). This crate only adds:
//! - `tauri-plugin-notification` (local scheduling, actions, channels),
//! - `tauri-plugin-http` with a scope limited to `<origin>/api/v1/*` of the effective server,
//! - `tauri-plugin-barcode-scanner` (QR login, PLAN_V4 §6.2),
//! - secure token storage (`token.rs`),
//! - `shell_config` (effective server origin), `server_get`/`server_set` (server chosen at
//!   runtime, `server_store.rs`, PLAN_V4 §6.5, D-97),
//! - native push (phase N2, Android/FCM only, D-55): the own plugin `buddy-push`
//!   (`mobile/plugins/buddy-push`); token registration, wake-up sync and re-planning live
//!   in the web layer (`src/web/notify/native-push.ts`).

mod server_store;
mod server_url;
mod token;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;
use tauri::ipc::CapabilityBuilder;

use token::TokenVault;

/// Default server origin validated by build.rs (`BUDDY_PUBLIC_URL`, else
/// `https://buddy.pev-point.de`).
pub const DEFAULT_ORIGIN: &str = env!("BUDDY_SERVER_ORIGIN");

/// Effective server origin of this process (`server.json` before the default).
struct ServerState {
    dir: PathBuf,
    origin: Mutex<String>,
}

impl ServerState {
    fn origin(&self) -> String {
        self.origin
            .lock()
            .map(|o| o.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }
}

/// Event sent to the webview when the app comes back to the foreground.
pub const RESUMED_EVENT: &str = "buddy://resumed";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    /// Effective origin, e.g. "https://buddy.pev-point.de".
    server_url: String,
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

fn server_state(app: &tauri::AppHandle) -> Result<tauri::State<'_, ServerState>, String> {
    app.try_state::<ServerState>()
        .ok_or_else(|| "server config not ready".to_string())
}

#[tauri::command]
fn shell_config(app: tauri::AppHandle) -> Result<ShellConfig, String> {
    Ok(ShellConfig {
        server_url: server_state(&app)?.origin(),
        platform: platform(),
    })
}

/// `server_get` (PLAN_V4 §6.5).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerChoice {
    origin: String,
    default_origin: String,
    is_default: bool,
}

fn server_choice(origin: String) -> ServerChoice {
    ServerChoice {
        is_default: origin == DEFAULT_ORIGIN,
        origin,
        default_origin: DEFAULT_ORIGIN.to_string(),
    }
}

#[tauri::command]
fn server_get(app: tauri::AppHandle) -> Result<ServerChoice, String> {
    Ok(server_choice(server_state(&app)?.origin()))
}

/// Stores the choice only while no token is stored (the token belongs to one server).
fn choose_server(
    dir: &std::path::Path,
    signed_in: bool,
    origin: Option<&str>,
) -> Result<String, String> {
    if signed_in {
        return Err("signed_in: sign out before changing the server".to_string());
    }
    server_store::save(dir, origin, DEFAULT_ORIGIN)
}

/// `server_set(origin | null)`: the web layer reloads afterwards (D-97). Tauri cannot
/// remove a capability, so the previous origin stays in scope until the next app start.
#[tauri::command]
fn server_set(app: tauri::AppHandle, origin: Option<String>) -> Result<(), String> {
    let vault = app
        .try_state::<TokenVault>()
        .ok_or_else(|| "token storage not ready".to_string())?;
    let state = server_state(&app)?;
    let new_origin = choose_server(&state.dir, vault.get()?.is_some(), origin.as_deref())?;
    if new_origin != state.origin() {
        app.add_capability(http_capability(&new_origin))
            .map_err(|e| format!("scope: {e}"))?;
    }
    *state.origin.lock().unwrap_or_else(|p| p.into_inner()) = new_origin;
    Ok(())
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
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .manage(TokenVault::platform())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_buddy_push::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let origin = server_store::load(&dir, DEFAULT_ORIGIN);
            // exactly one HTTP capability per start: the effective origin
            app.add_capability(http_capability(&origin))?;
            app.manage(ServerState {
                dir,
                origin: Mutex::new(origin),
            });
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
        .invoke_handler(tauri::generate_handler![
            shell_config,
            token_get,
            token_set,
            server_get,
            server_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Display Buddy shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_config_serialises_camel_case() {
        let v = serde_json::to_value(ShellConfig {
            server_url: "https://buddy.example.org".to_string(),
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
        assert_eq!(
            server_url::normalize(DEFAULT_ORIGIN).as_deref(),
            Ok(DEFAULT_ORIGIN)
        );
    }

    #[test]
    fn server_choice_serialises_camel_case() {
        let v = serde_json::to_value(server_choice(DEFAULT_ORIGIN.to_string())).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"origin": DEFAULT_ORIGIN, "defaultOrigin": DEFAULT_ORIGIN, "isDefault": true})
        );
        let v = serde_json::to_value(server_choice("https://notes.example.net".into())).unwrap();
        assert_eq!(v["isDefault"], false);
    }

    #[test]
    fn server_can_only_change_while_signed_out() {
        let dir = std::env::temp_dir().join(format!("buddy-choose-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let e = choose_server(&dir, true, Some("https://notes.example.net")).unwrap_err();
        assert!(e.starts_with("signed_in"), "{e}");
        assert!(!dir.join(server_store::FILE_NAME).exists());
        let e = choose_server(&dir, true, None).unwrap_err();
        assert!(e.starts_with("signed_in"), "{e}");
        assert_eq!(
            choose_server(&dir, false, Some("https://notes.example.net")).unwrap(),
            "https://notes.example.net"
        );
        assert_eq!(
            server_store::load(&dir, DEFAULT_ORIGIN),
            "https://notes.example.net"
        );
        let e = choose_server(&dir, false, Some("http://beispiel.de")).unwrap_err();
        assert!(e.starts_with("invalid_url"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
