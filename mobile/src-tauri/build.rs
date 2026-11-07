//! Build script of the native shell.
//!
//! 1. App commands in an app manifest, so that the capability allows exactly them.
//! 2. `BUDDY_PUBLIC_URL` (server origin, from the build environment – never committed) is
//!    validated and handed to the crate as `BUDDY_SERVER_ORIGIN` (HTTP scope, PLAN §10.2).
//! 3. Android: exact-alarm permissions are added to the generated manifest with the
//!    official Tauri helper (`tauri_utils::build::update_android_manifest`, the same one
//!    tauri-build uses for file associations). Android docs ("Schedule alarms" →
//!    "Exact alarm permissions"): apps whose core function is alarms/reminders declare
//!    `USE_EXACT_ALARM` (granted automatically, API 33+) and `SCHEDULE_EXACT_ALARM` with
//!    `maxSdkVersion="32"` for Android 12/12L.
//! 4. Android: the native library is linked with 16 KB ELF alignment (see
//!    <https://developer.android.com/guide/practices/page-sizes>). NDK r27 and older link
//!    with 4 KB, so Android 15+ shows a "not 16 KB compatible" warning. Set here rather than in
//!    `.cargo/config.toml`, because the Tauri CLI and Gradle start cargo from different
//!    directories and not every one of them would read that file. NDK r28+ does this by default.

#[path = "src/server_url.rs"]
#[allow(dead_code)]
mod server_url;

const COMMANDS: &[&str] = &["shell_config", "token_get", "token_set"];

const ANDROID_PERMISSIONS: &str = r#"<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.USE_EXACT_ALARM" />"#;

fn main() {
    println!("cargo:rerun-if-env-changed=BUDDY_PUBLIC_URL");
    match std::env::var("BUDDY_PUBLIC_URL") {
        Ok(raw) if !raw.trim().is_empty() => match server_url::normalize(&raw) {
            Ok(origin) => println!("cargo:rustc-env=BUDDY_SERVER_ORIGIN={origin}"),
            Err(e) => panic!("{e}"),
        },
        _ => println!(
            "cargo:warning=BUDDY_PUBLIC_URL is not set: the app cannot reach a server (login shows a hint)"
        ),
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        tauri_utils::build::update_android_manifest(
            "display-buddy-exact-alarms",
            "manifest",
            ANDROID_PERMISSIONS.to_string(),
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
