//! Data model shared with the frontend (mirror of `src/types.ts`, camelCase on the wire).

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const NOTE_SCHEMA_VERSION: u32 = 1;
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

pub const BUDDY_SIZE_MIN: u32 = 48;
pub const BUDDY_SIZE_MAX: u32 = 192;
pub const OPACITY_MIN: f64 = 0.3;
pub const OPACITY_MAX: f64 = 1.0;
pub const SPEED_MIN: f64 = 0.5;
pub const SPEED_MAX: f64 = 2.0;
/// Must match `minWidth`/`minHeight` of the notes window in tauri.conf.json.
pub const NOTES_MIN_WIDTH: f64 = 320.0;
pub const NOTES_MIN_HEIGHT: f64 = 360.0;
const NOTES_MAX_EDGE: f64 = 10_000.0;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NoteColor {
    #[default]
    Yellow,
    Pink,
    Blue,
    Green,
    Purple,
    Orange,
}

fn one() -> u32 {
    1
}

/// Deserializes a field, falling back to `T::default()` if the value has the
/// wrong type / an unknown variant (keeps old or hand-edited files loadable).
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Canonical lowercase hyphenated UUID; validated before any file-system use.
    pub id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub title: String,
    #[serde(default, deserialize_with = "lenient")]
    pub color: NoteColor,
    /// TipTap JSON, stored verbatim.
    pub content: Value,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "one")]
    pub schema_version: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EyeStyle {
    #[default]
    Round,
    Lines,
    Hearts,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MouthStyle {
    #[default]
    Smile,
    Wide,
    Neutral,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BuddyConfig {
    /// "smiley" | "cat" | "robot" | "ghost" | <uuid of an imported skin>.
    pub skin: String,
    pub face_color: String,
    pub eye_style: EyeStyle,
    pub mouth_style: MouthStyle,
    /// Logical px, 48..=192.
    pub size: u32,
    /// 0.3..=1.0
    pub opacity: f64,
    pub animate: bool,
    /// 0.5..=2.0
    pub animation_speed: f64,
}

pub const DEFAULT_FACE_COLOR: &str = "#FFD54A";
pub const DEFAULT_SKIN: &str = "smiley";
pub const BUILTIN_SKINS: [&str; 4] = ["smiley", "cat", "robot", "ghost"];

/// Built-in skin name or the id of an imported skin (canonical uuid).
pub fn is_valid_skin(skin: &str) -> bool {
    BUILTIN_SKINS.contains(&skin) || is_valid_note_id(skin)
}

impl Default for BuddyConfig {
    fn default() -> Self {
        Self {
            skin: DEFAULT_SKIN.to_string(),
            face_color: DEFAULT_FACE_COLOR.to_string(),
            eye_style: EyeStyle::Round,
            mouth_style: MouthStyle::Smile,
            size: 96,
            opacity: 1.0,
            animate: true,
            animation_speed: 1.0,
        }
    }
}

/// Physical pixels (as reported by `outer_position`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

/// Logical pixels.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub buddy: BuddyConfig,
    pub buddy_position: Option<WindowPosition>,
    pub notes_size: Option<WindowSize>,
    pub autostart: bool,
    pub active_note_id: Option<String>,
    pub notes_pinned: bool,
    pub hide_notes_on_blur: bool,
    pub global_shortcut: bool,
    /// Experimental: clicks on the transparent corners of the buddy pass through.
    pub click_through: bool,
    pub reminder_notification: bool,
    pub reminder_sound: bool,
    pub shortcut_bar_collapsed: bool,
    pub shortcut_bar_tab: ShortcutList,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            buddy: BuddyConfig::default(),
            buddy_position: None,
            notes_size: None,
            autostart: false,
            active_note_id: None,
            notes_pinned: false,
            hide_notes_on_blur: false,
            global_shortcut: true,
            click_through: false,
            reminder_notification: true,
            reminder_sound: true,
            shortcut_bar_collapsed: false,
            shortcut_bar_tab: ShortcutList::Items,
        }
    }
}

/// `#RRGGBB` (case-insensitive hex digits).
pub fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

/// Canonical (lowercase, hyphenated) UUID – the only form accepted as a file name.
pub fn is_valid_note_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

fn clamp_f64(v: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v.clamp(min, max)
    } else {
        fallback
    }
}

impl Settings {
    /// Returns a copy with every value forced into its valid range.
    pub fn sanitized(mut self) -> Self {
        let d = BuddyConfig::default();
        let b = &mut self.buddy;
        b.size = b.size.clamp(BUDDY_SIZE_MIN, BUDDY_SIZE_MAX);
        b.opacity = clamp_f64(b.opacity, OPACITY_MIN, OPACITY_MAX, d.opacity);
        b.animation_speed = clamp_f64(b.animation_speed, SPEED_MIN, SPEED_MAX, d.animation_speed);
        if !is_hex_color(&b.face_color) {
            b.face_color = d.face_color;
        }
        if !is_valid_skin(&b.skin) {
            b.skin = d.skin;
        }
        self.schema_version = SETTINGS_SCHEMA_VERSION;
        self.notes_size = self.notes_size.and_then(|s| {
            (s.width.is_finite() && s.height.is_finite()).then(|| WindowSize {
                width: s.width.clamp(NOTES_MIN_WIDTH, NOTES_MAX_EDGE),
                height: s.height.clamp(NOTES_MIN_HEIGHT, NOTES_MAX_EDGE),
            })
        });
        if self
            .active_note_id
            .as_deref()
            .is_some_and(|id| !is_valid_note_id(id))
        {
            self.active_note_id = None;
        }
        self
    }

    /// Builds settings from arbitrary (possibly old or hand-edited) JSON.
    /// Every top-level key – and every key inside `buddy` – is applied on its own;
    /// a key whose value has the wrong type is ignored (keeps its default) instead
    /// of invalidating the whole file. Unknown keys are ignored.
    pub fn from_value_lenient(value: &Value) -> Self {
        let defaults = Settings::default();
        let mut acc = serde_json::to_value(&defaults).unwrap_or(Value::Null);
        let accepts =
            |candidate: &Value| serde_json::from_value::<Settings>(candidate.clone()).is_ok();
        if let Some(obj) = value.as_object() {
            for (key, val) in obj {
                if key == "buddy" {
                    if let Some(buddy) = val.as_object() {
                        for (bk, bv) in buddy {
                            let mut candidate = acc.clone();
                            candidate["buddy"][bk] = bv.clone();
                            if accepts(&candidate) {
                                acc = candidate;
                            }
                        }
                    }
                    continue;
                }
                let mut candidate = acc.clone();
                candidate[key] = val.clone();
                if accepts(&candidate) {
                    acc = candidate;
                }
            }
        }
        serde_json::from_value::<Settings>(acc)
            .unwrap_or(defaults)
            .sanitized()
    }

    /// Applies a JSON-merge patch (RFC 7396 semantics, objects merged recursively)
    /// and returns the sanitized result. `schemaVersion` and `autostart` keys in
    /// the patch are ignored: the schema version is owned by the backend and the
    /// autostart flag mirrors the OS registration (changed via `set_autostart`).
    /// Errors if the patch is not an object or yields values of the wrong type.
    pub fn with_patch(&self, patch: &Value) -> Result<Settings, String> {
        let Some(obj) = patch.as_object() else {
            return Err("settings patch must be a JSON object".into());
        };
        let mut filtered: Map<String, Value> = obj.clone();
        filtered.remove("schemaVersion");
        filtered.remove("autostart");
        let mut target = serde_json::to_value(self).map_err(|e| e.to_string())?;
        merge_patch(&mut target, &Value::Object(filtered));
        let merged: Settings =
            serde_json::from_value(target).map_err(|e| format!("invalid settings patch: {e}"))?;
        Ok(merged.sanitized())
    }
}

/// JSON merge patch (RFC 7396): objects are merged recursively, `null` removes a
/// key (→ the field falls back to its default, i.e. `None` for optional fields),
/// any other value replaces the target.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch_obj) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Value::Object(target_obj) = target else {
        unreachable!()
    };
    for (key, value) in patch_obj {
        if value.is_null() {
            target_obj.remove(key);
        } else {
            merge_patch(target_obj.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

// ---- v2 data types (mirror of src/types.ts) -------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutList {
    #[default]
    Items,
    Bookmarks,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReminderRepeat {
    #[default]
    None,
    Daily,
    Weekdays,
    Weekly,
    Monthly,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReminderState {
    #[default]
    Scheduled,
    Due,
    Done,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub note_id: String,
    /// RFC 3339 with offset.
    pub at: String,
    #[serde(default)]
    pub repeat: ReminderRepeat,
    #[serde(default)]
    pub state: ReminderState,
    #[serde(default)]
    pub fired_at: Option<String>,
}

pub const REMINDERS_SCHEMA_VERSION: u32 = 1;

/// File format of `reminders.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemindersFile {
    pub schema_version: u32,
    pub reminders: Vec<Reminder>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutKind {
    File,
    Folder,
    Program,
    Url,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub kind: ShortcutKind,
    pub name: String,
    pub target: String,
}

pub const SHORTCUTS_SCHEMA_VERSION: u32 = 1;

/// File format of `shortcuts.json` and payload of `shortcuts-changed`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutsData {
    pub schema_version: u32,
    pub items: Vec<Shortcut>,
    pub bookmarks: Vec<Shortcut>,
}

impl Default for ShortcutsData {
    fn default() -> Self {
        Self {
            schema_version: SHORTCUTS_SCHEMA_VERSION,
            items: Vec::new(),
            bookmarks: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkinKind {
    Image,
    Lottie,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub id: String,
    pub name: String,
    pub kind: SkinKind,
    pub mime: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkinData {
    pub info: SkinInfo,
    /// image: data URL; lottie: JSON text.
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_settings_match_frontend_defaults() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            v,
            json!({
                "schemaVersion": 1,
                "buddy": {
                    "skin": "smiley",
                "faceColor": "#FFD54A",
                    "eyeStyle": "round",
                    "mouthStyle": "smile",
                    "size": 96,
                    "opacity": 1.0,
                    "animate": true,
                    "animationSpeed": 1.0
                },
                "buddyPosition": null,
                "notesSize": null,
                "autostart": false,
                "activeNoteId": null,
                "notesPinned": false,
                "hideNotesOnBlur": false,
                "globalShortcut": true,
                "clickThrough": false,
                "reminderNotification": true,
                "reminderSound": true,
                "shortcutBarCollapsed": false,
                "shortcutBarTab": "items"
            })
        );
    }

    #[test]
    fn sanitized_clamps_values() {
        let mut s = Settings::default();
        s.buddy.size = 500;
        s.buddy.opacity = 0.0;
        s.buddy.animation_speed = f64::NAN;
        s.buddy.face_color = "red".into();
        s.schema_version = 99;
        s.notes_size = Some(WindowSize {
            width: 10.0,
            height: 99_999.0,
        });
        s.active_note_id = Some("../evil".into());
        let s = s.sanitized();
        assert_eq!(s.buddy.size, BUDDY_SIZE_MAX);
        assert_eq!(s.buddy.opacity, OPACITY_MIN);
        assert_eq!(s.buddy.animation_speed, 1.0);
        assert_eq!(s.buddy.face_color, DEFAULT_FACE_COLOR);
        assert_eq!(s.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            s.notes_size,
            Some(WindowSize {
                width: NOTES_MIN_WIDTH,
                height: NOTES_MAX_EDGE
            })
        );
        assert_eq!(s.active_note_id, None);

        let mut s = Settings::default();
        s.buddy.size = 1;
        s.buddy.animation_speed = 7.0;
        s.buddy.face_color = "#a1B2c3".into();
        s.notes_size = Some(WindowSize {
            width: f64::INFINITY,
            height: 400.0,
        });
        let s = s.sanitized();
        assert_eq!(s.buddy.size, BUDDY_SIZE_MIN);
        assert_eq!(s.buddy.animation_speed, SPEED_MAX);
        assert_eq!(s.buddy.face_color, "#a1B2c3");
        assert_eq!(s.notes_size, None);
    }

    #[test]
    fn hex_color_validation() {
        assert!(is_hex_color("#FFD54A"));
        assert!(is_hex_color("#abcdef"));
        assert!(!is_hex_color("#FFF"));
        assert!(!is_hex_color("FFD54A0"));
        assert!(!is_hex_color("#GGGGGG"));
        assert!(!is_hex_color("#FFD54A "));
    }

    #[test]
    fn note_id_validation() {
        assert!(is_valid_note_id("0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f"));
        assert!(!is_valid_note_id("0B9A7A3E-4F5D-4C1E-9D8A-2A6B1C3D4E5F"));
        assert!(!is_valid_note_id("0b9a7a3e4f5d4c1e9d8a2a6b1c3d4e5f"));
        assert!(!is_valid_note_id("{0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f}"));
        assert!(!is_valid_note_id(
            "urn:uuid:0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f"
        ));
        assert!(!is_valid_note_id("../settings"));
        assert!(!is_valid_note_id(""));
    }

    #[test]
    fn merge_patch_rfc7396() {
        let mut t = json!({"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]});
        merge_patch(
            &mut t,
            &json!({"a": null, "b": {"c": 20, "x": {"y": 1}}, "e": [3], "f": "new"}),
        );
        assert_eq!(
            t,
            json!({"b": {"c": 20, "d": 3, "x": {"y": 1}}, "e": [3], "f": "new"})
        );

        let mut t = json!({"a": 1});
        merge_patch(&mut t, &json!({"a": {"b": 1}}));
        assert_eq!(t, json!({"a": {"b": 1}}));

        let mut t = json!({"a": 1});
        merge_patch(&mut t, &json!("scalar"));
        assert_eq!(t, json!("scalar"));
    }

    #[test]
    fn with_patch_merges_nested_buddy_and_ignores_protected_keys() {
        let base = Settings::default();
        let s = base
            .with_patch(&json!({
                "buddy": {"size": 128, "eyeStyle": "hearts"},
                "notesPinned": true,
                "schemaVersion": 42,
                "autostart": true,
                "buddyPosition": {"x": -100, "y": 50}
            }))
            .unwrap();
        assert_eq!(s.buddy.size, 128);
        assert_eq!(s.buddy.eye_style, EyeStyle::Hearts);
        assert_eq!(
            s.buddy.face_color, DEFAULT_FACE_COLOR,
            "untouched nested keys survive"
        );
        assert!(s.notes_pinned);
        assert_eq!(s.schema_version, SETTINGS_SCHEMA_VERSION);
        assert!(!s.autostart);
        assert_eq!(s.buddy_position, Some(WindowPosition { x: -100, y: 50 }));

        // null clears optional fields
        let s = s.with_patch(&json!({"buddyPosition": null})).unwrap();
        assert_eq!(s.buddy_position, None);

        // sanitize after merge
        let s = s
            .with_patch(&json!({"buddy": {"size": 9999, "faceColor": "nope"}}))
            .unwrap();
        assert_eq!(s.buddy.size, BUDDY_SIZE_MAX);
        assert_eq!(s.buddy.face_color, DEFAULT_FACE_COLOR);
    }

    #[test]
    fn with_patch_rejects_bad_input() {
        let base = Settings::default();
        assert!(base.with_patch(&json!([1, 2])).is_err());
        assert!(base.with_patch(&json!({"buddy": {"size": "big"}})).is_err());
        assert!(
            base.with_patch(&json!({"buddy": {"eyeStyle": "laser"}}))
                .is_err()
        );
        assert!(base.with_patch(&json!({"notesPinned": "yes"})).is_err());
    }

    #[test]
    fn lenient_settings_keep_valid_keys() {
        let s = Settings::from_value_lenient(&json!({
            "buddy": {"size": "huge", "eyeStyle": "lines", "mouthStyle": "laser", "opacity": 0.5},
            "globalShortcut": false,
            "notesPinned": "maybe",
            "unknownKey": {"x": 1},
            "buddyPosition": {"x": 10, "y": 20}
        }));
        assert_eq!(s.buddy.size, 96);
        assert_eq!(s.buddy.eye_style, EyeStyle::Lines);
        assert_eq!(s.buddy.mouth_style, MouthStyle::Smile);
        assert_eq!(s.buddy.opacity, 0.5);
        assert!(!s.global_shortcut);
        assert!(!s.notes_pinned);
        assert_eq!(s.buddy_position, Some(WindowPosition { x: 10, y: 20 }));

        assert_eq!(
            Settings::from_value_lenient(&json!("garbage")),
            Settings::default()
        );
        assert_eq!(
            Settings::from_value_lenient(&json!({"buddy": null})),
            Settings::default()
        );
    }

    #[test]
    fn note_defaults_and_lenient_fields() {
        let n: Note = serde_json::from_value(json!({
            "id": "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
            "content": {"type": "doc"},
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "color": "chartreuse",
            "extra": true
        }))
        .unwrap();
        assert_eq!(n.title, "");
        assert_eq!(n.color, NoteColor::Yellow);
        assert_eq!(n.schema_version, NOTE_SCHEMA_VERSION);

        let v = serde_json::to_value(&n).unwrap();
        assert!(v.get("createdAt").is_some());
        assert!(v.get("schemaVersion").is_some());
        assert_eq!(v["color"], "yellow");
    }
}
