//! Contract tests that read source/config files as text and check that the
//! different places naming the same thing agree (PLAN §3, §5):
//!
//! * `build.rs` COMMANDS == `generate_handler!` list in `lib.rs` == PLAN §5,
//!   every command is a `#[tauri::command]` with the PLAN argument names,
//!   every `allow-*` permission in `capabilities/*.json` names a known command.
//! * `Settings::default()` / `BuddyConfig` / `Note` / enums serialise to exactly
//!   the keys and values declared in `src/types.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use display_buddy_lib::model::{EyeStyle, MouthStyle, Note, NoteColor, Settings};
use serde_json::{Value, json};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(rel: impl AsRef<Path>) -> String {
    let path = manifest_dir().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// Text between `start` (exclusive) and the first following `end`.
fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("marker {start:?} not found"))
        + start.len();
    let len = text[from..]
        .find(end)
        .unwrap_or_else(|| panic!("end marker {end:?} after {start:?} not found"));
    &text[from..from + len]
}

/// Removes `//` line comments (good enough for the files parsed here).
fn strip_line_comments(text: &str) -> String {
    text.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// PLAN §5: command → argument names on the JS side (camelCase; all single words).
fn plan_commands() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([
        ("list_notes", vec![]),
        ("load_note", vec!["id"]),
        ("save_note", vec!["note"]),
        ("delete_note", vec!["id"]),
        ("save_order", vec!["ids"]),
        ("load_settings", vec![]),
        ("save_settings", vec!["patch"]),
        ("get_autostart", vec![]),
        ("set_autostart", vec!["enabled"]),
        ("toggle_notes", vec![]),
        ("show_notes", vec![]),
        ("hide_notes", vec![]),
        ("open_settings", vec!["section"]), // v4: + section
        ("show_buddy_menu", vec![]),
        ("flush_done", vec![]),
        ("quit_app", vec![]),
        // v2 (Rust parameter names; JS uses camelCase, e.g. noteId)
        ("list_reminders", vec![]),
        ("set_reminder", vec!["note_id", "at", "repeat", "time_zone"]), // v3: + time_zone
        ("ack_reminder", vec!["note_id"]),
        ("snooze_reminder", vec!["note_id", "minutes"]),
        ("open_note", vec!["note_id"]),
        ("list_shortcuts", vec![]),
        ("pick_shortcuts", vec!["folder"]),
        ("add_bookmark", vec!["name", "url"]),
        ("update_shortcut", vec!["id", "name", "target"]),
        ("remove_shortcut", vec!["id"]),
        ("reorder_shortcuts", vec!["list", "ids"]),
        ("open_shortcut", vec!["id"]),
        ("shortcut_icon", vec!["id"]),
        ("list_skins", vec![]),
        ("import_skin", vec![]),
        ("delete_skin", vec!["id"]),
        ("load_skin", vec!["id"]),
        // v3 (PLAN_V3_SYNC §8)
        ("sync_status", vec![]),
        (
            "sync_connect",
            vec!["server_url", "username", "password", "device_name"],
        ),
        ("sync_disconnect", vec![]),
        ("sync_now", vec![]),
        // v4 (PLAN_V4 §7.1)
        ("account_server_info", vec!["server_url"]),
        (
            "account_register",
            vec![
                "server_url",
                "username",
                "password",
                "device_name",
                "invite_code",
            ],
        ),
        (
            "account_recover",
            vec![
                "server_url",
                "username",
                "recovery_code",
                "new_password",
                "device_name",
            ],
        ),
        ("account_info", vec![]),
        ("account_devices", vec![]),
        ("account_revoke_device", vec!["device_id", "password"]),
        (
            "account_change_password",
            vec!["current_password", "new_password"],
        ),
        ("account_new_recovery_code", vec!["password"]),
        ("account_export", vec![]),
        ("account_delete", vec!["password", "confirm_username"]),
        ("account_open_link", vec!["kind"]),
        ("pairing_start", vec![]),
        ("pairing_status", vec!["pairing_id"]),
        ("pairing_cancel", vec!["pairing_id"]),
    ])
}

fn build_rs_commands() -> Vec<String> {
    let src = strip_line_comments(&read("build.rs"));
    let list = between(&src, "const COMMANDS: &[&str] = &[", "];");
    list.split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Full paths from `tauri::generate_handler![...]`, e.g. `commands::notes::list_notes`.
fn handler_paths() -> Vec<String> {
    let src = strip_line_comments(&read("src/lib.rs"));
    let list = between(&src, "generate_handler![", "]");
    list.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn last_segment(path: &str) -> &str {
    path.rsplit("::").next().unwrap()
}

fn sorted(v: impl IntoIterator<Item = impl Into<String>>) -> Vec<String> {
    let mut v: Vec<String> = v.into_iter().map(Into::into).collect();
    v.sort();
    v
}

/// Splits on commas that are not nested inside `<...>`.
fn split_top_level(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in s.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

fn kebab(command: &str) -> String {
    command.replace('_', "-")
}

#[test]
fn build_rs_commands_match_plan_without_duplicates() {
    let cmds = build_rs_commands();
    let unique: BTreeSet<&String> = cmds.iter().collect();
    assert_eq!(
        unique.len(),
        cmds.len(),
        "duplicate entry in build.rs COMMANDS"
    );
    assert_eq!(sorted(cmds), sorted(plan_commands().into_keys()));
}

#[test]
fn generate_handler_matches_build_rs() {
    let handlers: Vec<String> = handler_paths()
        .iter()
        .map(|p| last_segment(p).to_string())
        .collect();
    let unique: BTreeSet<&String> = handlers.iter().collect();
    assert_eq!(
        unique.len(),
        handlers.len(),
        "duplicate entry in generate_handler!"
    );
    assert_eq!(sorted(handlers), sorted(build_rs_commands()));
}

/// Every handler is a `#[tauri::command]` fn in the referenced module, and its
/// non-injected parameters are exactly the PLAN argument names.
#[test]
fn command_functions_exist_with_plan_argument_names() {
    let plan = plan_commands();
    for path in handler_paths() {
        let segments: Vec<&str> = path.split("::").collect();
        assert!(
            segments.len() == 3 && segments[0] == "commands",
            "unexpected handler path {path}"
        );
        let (module, name) = (segments[1], segments[2]);
        let src = read(format!("src/commands/{module}.rs"));

        let sig_start = [format!("pub fn {name}("), format!("pub async fn {name}(")]
            .iter()
            .find_map(|needle| src.find(needle.as_str()))
            .unwrap_or_else(|| panic!("{path}: function not found in commands/{module}.rs"));
        let before = &src[..sig_start];
        let attr = before.rfind("#[tauri::command").expect("attribute");
        assert!(
            !before[attr..].contains("pub fn") && !before[attr..].contains("pub async fn"),
            "{path}: missing #[tauri::command] directly above"
        );

        let params = between(&src[sig_start..], "(", ")");
        let args: Vec<&str> = split_top_level(params)
            .into_iter()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .filter(|p| !p.contains("State<") && !p.contains("AppHandle") && !p.contains("Window"))
            .map(|p| p.split(':').next().unwrap().trim())
            .collect();
        assert_eq!(
            args, plan[name],
            "{path}: argument names differ from PLAN §5"
        );
    }
}

#[test]
fn capabilities_only_reference_known_commands() {
    let known: BTreeSet<String> = build_rs_commands().into_iter().collect();
    let dir = manifest_dir().join("capabilities");
    let mut allowed_somewhere = BTreeSet::new();
    let mut files = 0;
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        files += 1;
        let cap: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{}: invalid JSON: {e}", path.display()));
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            cap["identifier"],
            name.as_str(),
            "{name}: identifier ≠ file name"
        );
        assert_eq!(
            cap["windows"],
            json!([name]),
            "{name}: must target only its own window"
        );
        for perm in cap["permissions"].as_array().expect("permissions array") {
            let perm = perm.as_str().expect("permission must be a string");
            if perm.contains(':') {
                // plugin/core permission: no plugin permissions per D-07
                assert!(
                    perm.starts_with("core:"),
                    "{name}: unexpected plugin permission {perm}"
                );
                continue;
            }
            let command = perm
                .strip_prefix("allow-")
                .unwrap_or_else(|| panic!("{name}: unexpected permission {perm}"))
                .replace('-', "_");
            assert!(
                known.contains(&command),
                "{name}: {perm} names no command in build.rs"
            );
            allowed_somewhere.insert(command);
        }
    }
    assert_eq!(files, 3, "expected buddy/notes/settings capabilities");

    // Commands no window may call: only reachable via tray/menu/Rust (load_note is kept
    // for the PLAN contract but no window needs it, so no capability grants it).
    // If a window starts using one, add it to its capability and remove it here.
    let rust_only: BTreeSet<String> = ["load_note", "show_notes", "quit_app"]
        .into_iter()
        .map(String::from)
        .collect();
    let unexposed: BTreeSet<String> = known.difference(&allowed_somewhere).cloned().collect();
    assert_eq!(unexposed, rust_only);
}

#[test]
fn autogenerated_permissions_exist_for_every_command() {
    // tauri-build writes permissions/autogenerated/<command>.toml for each COMMANDS entry
    // (the build script has run before tests, so the files must be current).
    for cmd in build_rs_commands() {
        let toml = read(format!("permissions/autogenerated/{cmd}.toml"));
        assert!(
            toml.contains(&format!("allow-{}", kebab(&cmd))),
            "{cmd}.toml lacks allow-{}",
            kebab(&cmd)
        );
    }
}

// ------------------------------------------------------------- types.ts mirror

fn types_ts() -> String {
    read("../src/types.ts")
}

/// Key → raw value text of a `export const NAME: T = { ... };` object literal (flat).
fn ts_object(ts: &str, name: &str) -> Vec<(String, String)> {
    let body = between(ts, &format!("export const {name}: "), "};");
    let body = &body[body.find('{').expect("object literal") + 1..];
    body.lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty() && !l.starts_with("//") && !l.starts_with("/*") && !l.starts_with('*')
        })
        .map(|l| {
            let (k, v) = l
                .split_once(':')
                .unwrap_or_else(|| panic!("cannot parse {l:?}"));
            (
                k.trim().to_string(),
                v.trim().trim_end_matches(',').trim().to_string(),
            )
        })
        .collect()
}

/// Field names of `export interface NAME { ... }`.
fn ts_interface_keys(ts: &str, name: &str) -> Vec<String> {
    let body = between(ts, &format!("export interface {name} {{"), "\n}");
    body.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("/*") && !l.starts_with('*') && !l.starts_with("//"))
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, _)| k.trim().trim_end_matches('?').to_string())
        })
        .filter(|k| !k.is_empty())
        .collect()
}

/// Variants of `export type NAME = "a" | "b";`.
fn ts_union(ts: &str, name: &str) -> Vec<String> {
    between(ts, &format!("export type {name} = "), ";")
        .split('|')
        .map(|s| s.trim().trim_matches('"').to_string())
        .collect()
}

/// `export const NAME = <JSON literal>;` (number or string).
fn ts_const(ts: &str, name: &str) -> Value {
    let raw = between(ts, &format!("export const {name} = "), ";").trim();
    serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Resolves a literal / known constant / nested default object to JSON.
fn ts_value(ts: &str, raw: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        return v;
    }
    if raw.ends_with("_SCHEMA_VERSION") {
        return ts_const(ts, raw);
    }
    if raw == "DEFAULT_BUDDY" {
        return ts_object_value(ts, raw);
    }
    panic!("unsupported value in types.ts: {raw}")
}

fn ts_object_value(ts: &str, name: &str) -> Value {
    let mut map = serde_json::Map::new();
    for (k, raw) in ts_object(ts, name) {
        map.insert(k, ts_value(ts, &raw));
    }
    Value::Object(map)
}

fn keys(v: &Value) -> Vec<String> {
    sorted(v.as_object().expect("object").keys().cloned())
}

/// Numbers compared as f64 (TS `1` == Rust `1.0`).
fn assert_json_eq(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            assert_eq!(keys(actual), keys(expected), "{path}: keys differ");
            for (k, av) in a {
                assert_json_eq(av, &e[k], &format!("{path}.{k}"));
            }
        }
        (Value::Number(a), Value::Number(e)) => {
            assert_eq!(a.as_f64(), e.as_f64(), "{path}: number differs")
        }
        _ => assert_eq!(actual, expected, "{path}: value differs"),
    }
}

#[test]
fn default_settings_match_types_ts_default_settings() {
    let ts = types_ts();
    let expected = ts_object_value(&ts, "DEFAULT_SETTINGS");
    let actual = serde_json::to_value(Settings::default()).unwrap();
    assert_json_eq(&actual, &expected, "DEFAULT_SETTINGS");
    // sanity: the parser really saw the nested object and all top-level keys
    assert_eq!(expected["buddy"]["faceColor"], "#FFD54A");
    assert_eq!(keys(&expected).len(), 18);
}

#[test]
fn rust_structs_have_exactly_the_ts_interface_keys() {
    let ts = types_ts();
    let settings = serde_json::to_value(Settings::default()).unwrap();
    assert_eq!(keys(&settings), sorted(ts_interface_keys(&ts, "Settings")));
    assert_eq!(
        keys(&settings["buddy"]),
        sorted(ts_interface_keys(&ts, "BuddyConfig"))
    );

    let with_options = Settings::default()
        .with_patch(&json!({
            "buddyPosition": {"x": 1, "y": 2},
            "notesSize": {"width": 400, "height": 500}
        }))
        .unwrap();
    let v = serde_json::to_value(with_options).unwrap();
    assert_eq!(
        keys(&v["buddyPosition"]),
        sorted(ts_interface_keys(&ts, "WindowPosition"))
    );
    assert_eq!(
        keys(&v["notesSize"]),
        sorted(ts_interface_keys(&ts, "WindowSize"))
    );

    let note = Note {
        id: "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f".into(),
        title: String::new(),
        color: NoteColor::default(),
        content: json!({"type": "doc"}),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        schema_version: 1,
    };
    let v = serde_json::to_value(note).unwrap();
    assert_eq!(keys(&v), sorted(ts_interface_keys(&ts, "Note")));

    let reminder = display_buddy_lib::model::Reminder {
        note_id: "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f".into(),
        at: "2026-01-01T00:00:00.000Z".into(),
        repeat: Default::default(),
        state: Default::default(),
        fired_at: None,
        updated_at: None,
        time_zone: None,
    };
    let v = serde_json::to_value(reminder).unwrap();
    assert_eq!(keys(&v), sorted(ts_interface_keys(&ts, "Reminder")));

    let v = serde_json::to_value(display_buddy_lib::model::SyncStatus::default()).unwrap();
    assert_eq!(keys(&v), sorted(ts_interface_keys(&ts, "SyncStatus")));
    let v = serde_json::to_value(display_buddy_lib::model::AccountRegistered::default()).unwrap();
    assert_eq!(
        keys(&v),
        sorted(ts_interface_keys(&ts, "AccountRegistered"))
    );
    let v = serde_json::to_value(display_buddy_lib::model::PairingInfo::default()).unwrap();
    assert_eq!(keys(&v), sorted(ts_interface_keys(&ts, "PairingInfo")));
    let v = serde_json::to_value(display_buddy_lib::model::NotesChangedPayload::default()).unwrap();
    assert_eq!(
        keys(&v),
        sorted(ts_interface_keys(&ts, "NotesChangedPayload"))
    );
}

#[test]
fn enums_serialise_to_the_ts_union_values() {
    let ts = types_ts();
    let ser = |v: Vec<Value>| -> Vec<String> {
        v.into_iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    };
    let colors = [
        NoteColor::Yellow,
        NoteColor::Pink,
        NoteColor::Blue,
        NoteColor::Green,
        NoteColor::Purple,
        NoteColor::Orange,
    ];
    assert_eq!(
        ser(colors
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect()),
        ts_union(&ts, "NoteColor")
    );
    let eyes = [EyeStyle::Round, EyeStyle::Lines, EyeStyle::Hearts];
    assert_eq!(
        ser(eyes
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect()),
        ts_union(&ts, "EyeStyle")
    );
    let mouths = [MouthStyle::Smile, MouthStyle::Wide, MouthStyle::Neutral];
    assert_eq!(
        ser(mouths
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect()),
        ts_union(&ts, "MouthStyle")
    );
    assert_eq!(
        serde_json::to_value(NoteColor::default()).unwrap(),
        "yellow"
    );
    use display_buddy_lib::model::SyncState;
    let states = [
        SyncState::Off,
        SyncState::Idle,
        SyncState::Syncing,
        SyncState::Offline,
        SyncState::Error,
        SyncState::Unauthorized,
    ];
    assert_eq!(
        ser(states
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect()),
        ts_union(&ts, "SyncState")
    );

    // schema versions agree
    assert_eq!(
        ts_const(&ts, "NOTE_SCHEMA_VERSION"),
        json!(display_buddy_lib::model::NOTE_SCHEMA_VERSION)
    );
    assert_eq!(
        ts_const(&ts, "SETTINGS_SCHEMA_VERSION"),
        json!(display_buddy_lib::model::SETTINGS_SCHEMA_VERSION)
    );
    // v4: the standard server is the same constant on both sides (D-96)
    assert_eq!(
        ts_const(&ts, "DEFAULT_SYNC_SERVER_URL"),
        json!(display_buddy_lib::model::DEFAULT_SYNC_SERVER_URL)
    );
}

#[test]
fn notes_min_size_matches_tauri_conf() {
    let conf: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let windows = conf["app"]["windows"].as_array().unwrap();
    let notes = windows.iter().find(|w| w["label"] == "notes").unwrap();
    assert_eq!(
        notes["minWidth"].as_f64(),
        Some(display_buddy_lib::model::NOTES_MIN_WIDTH)
    );
    assert_eq!(
        notes["minHeight"].as_f64(),
        Some(display_buddy_lib::model::NOTES_MIN_HEIGHT)
    );
    let buddy = windows.iter().find(|w| w["label"] == "buddy").unwrap();
    assert_eq!(
        buddy["width"].as_u64(),
        Some(u64::from(Settings::default().buddy.size)),
        "buddy window default size = default buddy.size"
    );
}

/// Regression (crash on Windows start): Tauri creates the config windows and Windows
/// delivers their first events *before* `setup` calls `app.manage(AppState)`. A direct
/// `app.state::<AppState>()` in such a path panics (and with `panic = "abort"` kills the
/// app silently). Only `state.rs` may touch the managed state, via `try_app_state`.
#[test]
fn no_direct_app_state_access_outside_state_rs() {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|e| e == "rs") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    let offenders: Vec<String> = files
        .iter()
        .filter(|p| !p.ends_with("state.rs"))
        .filter(|p| {
            let text = std::fs::read_to_string(p).unwrap();
            text.contains(".state::<") || text.contains(".state()")
        })
        .map(|p| p.display().to_string())
        .collect();
    assert!(
        offenders.is_empty(),
        "use state::try_app_state instead in: {offenders:?}"
    );
}
