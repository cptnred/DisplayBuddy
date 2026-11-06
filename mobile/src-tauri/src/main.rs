// The shell targets Android and iOS. The desktop binary only exists so that
// `cargo check`/`cargo test` and `tauri dev` work on the development machine.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    display_buddy_mobile_lib::run()
}
