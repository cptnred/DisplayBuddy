// App commands are registered in an app manifest so that each window's
// capability can allow exactly the commands it needs (see capabilities/*.json).
const COMMANDS: &[&str] = &[
    "list_notes",
    "load_note",
    "save_note",
    "delete_note",
    "save_order",
    "load_settings",
    "save_settings",
    "get_autostart",
    "set_autostart",
    "toggle_notes",
    "show_notes",
    "hide_notes",
    "open_settings",
    "show_buddy_menu",
    "flush_done",
    "quit_app",
    // v2
    "list_reminders",
    "set_reminder",
    "ack_reminder",
    "snooze_reminder",
    "open_note",
    "list_shortcuts",
    "pick_shortcuts",
    "add_bookmark",
    "update_shortcut",
    "remove_shortcut",
    "reorder_shortcuts",
    "open_shortcut",
    "shortcut_icon",
    "list_skins",
    "import_skin",
    "delete_skin",
    "load_skin",
    // v3
    "sync_status",
    "sync_connect",
    "sync_disconnect",
    "sync_now",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
