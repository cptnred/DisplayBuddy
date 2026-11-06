//! Data types shared by the desktop app, the server and the tests (mirror of
//! `src/types.ts`, camelCase on the wire). `src-tauri/src/model.rs` re-exports them.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const NOTE_SCHEMA_VERSION: u32 = 1;
pub const REMINDERS_SCHEMA_VERSION: u32 = 1;

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
pub fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
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
    /// Edit time on the editing device (corrected device clock, UTC). Drives LWW.
    pub updated_at: String,
    #[serde(default = "one")]
    pub schema_version: u32,
}

/// Canonical (lowercase, hyphenated) UUID – the only form accepted as a file name.
pub fn is_valid_note_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
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
    /// Absolute next/last fire time, RFC 3339. New writes use UTC
    /// (`YYYY-MM-DDTHH:MM:SS.sssZ`); always compared as an instant.
    pub at: String,
    #[serde(default)]
    pub repeat: ReminderRepeat,
    #[serde(default)]
    pub state: ReminderState,
    #[serde(default)]
    pub fired_at: Option<String>,
    /// Time of the last user action (set/ack/snooze) on the acting device, UTC.
    /// Firing does not change it (D-30). `None` for data from before v3.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// IANA zone in which wall time and repetition apply (D-39). `None` for data
    /// from before v3; filled by `schedule::sanitize`.
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// File format of `reminders.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemindersFile {
    pub schema_version: u32,
    pub reminders: Vec<Reminder>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn v2_reminder_loads_without_new_fields() {
        let r: Reminder = serde_json::from_value(json!({
            "noteId": "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
            "at": "2026-11-05T09:00:00+01:00",
            "repeat": "daily",
            "state": "scheduled",
            "firedAt": null
        }))
        .unwrap();
        assert_eq!(r.updated_at, None);
        assert_eq!(r.time_zone, None);
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["updatedAt"].is_null() && v["timeZone"].is_null());
    }
}
