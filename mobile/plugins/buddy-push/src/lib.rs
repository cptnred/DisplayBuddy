//! Minimal push plugin of the Display Buddy shell (PLAN_V3_SYNC §10.5, D-55: Android/FCM
//! only), written after the Tauri guide „Mobile Plugin Development“.
//!
//! Everything happens in Kotlin (`android/`, class `de.displaybuddy.push.PushPlugin`):
//! - `get_token` → `FirebaseMessaging.getInstance().token` (rejects with code
//!   `NOT_CONFIGURED` when the app was built without `google-services.json`);
//! - `take_launch_data` → data of the FCM notification the app was opened from (once);
//! - events `token` (`onNewToken`), `message` (`onMessageReceived`, app in the foreground)
//!   and `opened` (notification tapped while the app was running).
//!
//! The Rust side only registers the Kotlin class. On iOS and desktop the plugin is a
//! no-op: there is no native part, the web layer only uses it on Android.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

/// Plugin name (`plugin:buddy-push|…`).
pub const NAME: &str = "buddy-push";

#[cfg(target_os = "android")]
const ANDROID_PACKAGE: &str = "de.displaybuddy.push";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new(NAME)
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(ANDROID_PACKAGE, "PushPlugin")?;
                _app.manage(PushHandle(handle));
            }
            Ok(())
        })
        .build()
}

/// Keeps the Kotlin plugin handle alive (managed state).
#[cfg(target_os = "android")]
pub struct PushHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);
