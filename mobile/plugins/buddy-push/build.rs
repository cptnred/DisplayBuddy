// Commands of the Kotlin plugin (de.displaybuddy.push.PushPlugin). tauri-plugin generates
// one `allow-<command>` permission each; the IPC layer forwards `get_token` to the Kotlin
// method `getToken` (lower camel case, tauri 2.12 webview/mod.rs).
const COMMANDS: &[&str] = &[
    "get_token",
    "take_launch_data",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
