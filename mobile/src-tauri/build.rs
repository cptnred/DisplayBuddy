//! Build script of the native shell.
//!
//! 1. App commands in an app manifest, so that the capability allows exactly them.
//! 2. `BUDDY_PUBLIC_URL` (default server origin, from the build environment) is validated and
//!    handed to the crate as `BUDDY_SERVER_ORIGIN`; without it the default is
//!    `https://buddy.pev-point.de` (PLAN_V4 §6.5, D-97). The user can choose another server
//!    at runtime (`server_set`).
//! 3. Android: exact-alarm permissions are added to the generated manifest with the
//!    official Tauri helper (`tauri_utils::build::update_android_manifest`, the same one
//!    tauri-build uses for file associations). Android docs ("Schedule alarms" →
//!    "Exact alarm permissions"): apps whose core function is alarms/reminders declare
//!    `USE_EXACT_ALARM` (granted automatically, API 33+) and `SCHEDULE_EXACT_ALARM` with
//!    `maxSdkVersion="32"` for Android 12/12L.
//! 4. Android: the barcode-scanner plugin declares `<uses-feature android.hardware.camera.any>`
//!    (implicitly required), which would hide the app from devices without a camera in a store.
//!    The QR scan is optional (code entry works everywhere, PLAN_V4 §7.2), so the app manifest
//!    replaces that element with `android:required="false"` (manifest merger marker
//!    `tools:node="replace"`, developer.android.com "Merge multiple manifest files"). CI checks
//!    the merged result with `aapt2 dump badging` (mobile-android.yml).
//! 5. Android: the native library is linked with 16 KB ELF alignment (see
//!    <https://developer.android.com/guide/practices/page-sizes>). NDK r27 and older link
//!    with 4 KB, so Android 15+ shows a "not 16 KB compatible" warning. Set here rather than in
//!    `.cargo/config.toml`, because the Tauri CLI and Gradle start cargo from different
//!    directories and not every one of them would read that file. NDK r28+ does this by default.

#[path = "src/server_url.rs"]
#[allow(dead_code)]
mod server_url;

const COMMANDS: &[&str] = &[
    "shell_config",
    "token_get",
    "token_set",
    "server_get",
    "server_set",
];

const ANDROID_PERMISSIONS: &str = r#"<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.USE_EXACT_ALARM" />"#;

// xmlns:tools on the element itself: the generated manifest root does not declare it
const ANDROID_CAMERA_FEATURE: &str = r#"<uses-feature xmlns:tools="http://schemas.android.com/tools" android:name="android.hardware.camera.any" android:required="false" tools:node="replace" />"#;

fn main() {
    println!("cargo:rerun-if-env-changed=BUDDY_PUBLIC_URL");
    let origin = match std::env::var("BUDDY_PUBLIC_URL") {
        Ok(raw) if !raw.trim().is_empty() => match server_url::normalize(&raw) {
            Ok(origin) => origin,
            Err(e) => panic!("{e}"),
        },
        _ => {
            println!(
                "cargo:warning=BUDDY_PUBLIC_URL is not set: default server {}",
                server_url::FALLBACK_ORIGIN
            );
            server_url::FALLBACK_ORIGIN.to_string()
        }
    };
    println!("cargo:rustc-env=BUDDY_SERVER_ORIGIN={origin}");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        tauri_utils::build::update_android_manifest(
            "display-buddy-exact-alarms",
            "manifest",
            ANDROID_PERMISSIONS.to_string(),
        )
        .expect("failed to update the Android manifest");
        tauri_utils::build::update_android_manifest(
            "display-buddy-camera-optional",
            "manifest",
            ANDROID_CAMERA_FEATURE.to_string(),
        )
        .expect("failed to update the Android manifest");

        for flag in ["max-page-size=16384", "common-page-size=16384"] {
            println!("cargo:rustc-cdylib-link-arg=-Wl,-z,{flag}");
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
