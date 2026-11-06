//! Push payload (PLAN_V3_SYNC §7.4, `buddy_core::sync::ReminderPushPayload`) and the Topic
//! header.
//!
//! - title „Erinnerung: <Titel>“ (empty title → „Notiz“, like the desktop toast), body =
//!   the first 100 characters of the note's plain text (`buddy_core::text`);
//! - the JSON must fit the Web Push limit: `web-push` 0.11 refuses plain texts over
//!   [`MAX_PLAINTEXT`] bytes (`http_ece.rs`), which keeps the encrypted record well below
//!   the 4 KB Apple and RFC 8291 allow. If it does not fit, or the push service answers 413,
//!   the text is shortened step by step ([`Shrink`]).
//! - Topic (RFC 8030 §5.4, max. 32 characters of the base64url alphabet):
//!   `r` + the first 31 characters of base64url(SHA-256(noteId)). All messages for one
//!   reminder share it, so an undelivered older one is replaced (e.g. after snoozing).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_core::model::{Note, Reminder};
use buddy_core::sync::ReminderPushPayload;
use buddy_core::text::{plain_text, truncate_chars};
use sha2::{Digest, Sha256};

/// Largest plain text `web-push` 0.11 encrypts (`HttpEce::encrypt`).
pub const MAX_PLAINTEXT: usize = 3052;
/// Characters of note text in the body (§7.4).
pub const BODY_CHARS: usize = 100;
/// Characters of the note title (the plan only limits the body; titles are capped so a
/// huge title cannot push the payload over the limit).
pub const TITLE_CHARS: usize = 100;

/// Shortening levels: 0 = normal, 1 = after 413 / over the limit, 2 = minimal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Shrink(pub u8);

impl Shrink {
    pub const NORMAL: Self = Self(0);
    pub const MAX: Self = Self(2);

    fn limits(self) -> (usize, usize) {
        match self.0 {
            0 => (TITLE_CHARS, BODY_CHARS),
            1 => (40, 40),
            _ => (0, 0),
        }
    }

    pub fn next(self) -> Option<Self> {
        (self < Self::MAX).then_some(Self(self.0 + 1))
    }
}

/// `Topic` header for a reminder.
pub fn topic(note_id: &str) -> String {
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(note_id.as_bytes()));
    format!("r{}", &hash[..31])
}

/// Notification title for a note title (same text as the desktop toast).
pub fn notification_title(note_title: &str, max_chars: usize) -> String {
    let t = note_title.trim();
    if max_chars == 0 {
        return "Erinnerung".into();
    }
    let t = if t.is_empty() {
        "Notiz".to_string()
    } else {
        truncate_chars(t, max_chars)
    };
    format!("Erinnerung: {t}")
}

/// What a reminder push says. `at` is the occurrence key (normalised UTC), `zone` the
/// reminder's effective zone; `note` is `None` if the note is unknown or deleted.
pub fn reminder_payload(
    reminder: &Reminder,
    at: &str,
    zone: &str,
    note: Option<&Note>,
    shrink: Shrink,
) -> ReminderPushPayload {
    let (title_chars, body_chars) = shrink.limits();
    let title = notification_title(note.map_or("", |n| n.title.as_str()), title_chars);
    let body = match note {
        Some(n) if body_chars > 0 => truncate_chars(&plain_text(&n.content), body_chars),
        _ => String::new(),
    };
    ReminderPushPayload {
        v: 1,
        kind: "reminder".into(),
        note_id: Some(reminder.note_id.clone()),
        at: Some(at.to_string()),
        time_zone: Some(zone.to_string()),
        title,
        body,
        url: format!("/notes/{}", reminder.note_id),
    }
}

/// Payload of `POST /push/test`.
pub fn test_payload() -> ReminderPushPayload {
    ReminderPushPayload {
        v: 1,
        kind: "test".into(),
        note_id: None,
        at: None,
        time_zone: None,
        title: "Display Buddy".into(),
        body: "Testbenachrichtigung: Push-Benachrichtigungen funktionieren.".into(),
        url: "/".into(),
    }
}

/// JSON bytes of the payload, shortened until they fit [`MAX_PLAINTEXT`].
/// Returns the bytes and the level actually used.
pub fn encode_fitting(
    build: impl Fn(Shrink) -> ReminderPushPayload,
    mut level: Shrink,
) -> (Vec<u8>, Shrink) {
    loop {
        let bytes = serde_json::to_vec(&build(level)).unwrap_or_default();
        match level.next() {
            Some(next) if bytes.len() > MAX_PLAINTEXT => level = next,
            _ => return (bytes, level),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";

    fn note(title: &str, text: &str) -> Note {
        serde_json::from_value(json!({
            "id": ID, "title": title, "color": "yellow",
            "content": {"type": "doc", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": text}]}
            ]},
            "createdAt": "2026-11-01T08:00:00.000Z", "updatedAt": "2026-11-01T08:00:00.000Z"
        }))
        .unwrap()
    }

    fn reminder() -> Reminder {
        serde_json::from_value(json!({"noteId": ID, "at": "2026-11-07T09:00:00+01:00",
            "timeZone": "Europe/Berlin"}))
        .unwrap()
    }

    #[test]
    fn topic_is_32_base64url_chars_and_stable() {
        let t = topic(ID);
        assert_eq!(t.len(), 32);
        assert!(t.starts_with('r'));
        assert!(
            t.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_eq!(t, topic(ID));
        assert_ne!(t, topic("00000000-0000-4000-8000-000000000001"));
        // independent check: SHA-256 of the id, base64url, first 31 characters
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(ID));
        assert_eq!(&t[1..], &expected[..31]);
    }

    #[test]
    fn payload_matches_the_api_example() {
        let n = note("Einkauf", "Milch, Brot");
        let p = reminder_payload(
            &reminder(),
            "2026-11-07T08:00:00.000Z",
            "Europe/Berlin",
            Some(&n),
            Shrink::NORMAL,
        );
        let ex: serde_json::Value = serde_json::from_str(include_str!(
            "../../../crates/buddy-core/tests/fixtures/api_examples.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(&p).unwrap(), ex["reminderPushPayload"]);
    }

    #[test]
    fn body_is_cut_to_100_chars_and_titles_fall_back() {
        let long = "ä".repeat(500);
        let p = reminder_payload(
            &reminder(),
            "x",
            "UTC",
            Some(&note("  ", &long)),
            Shrink::NORMAL,
        );
        assert_eq!(p.title, "Erinnerung: Notiz");
        assert_eq!(p.body.chars().count(), 101, "100 + ellipsis");
        let p = reminder_payload(&reminder(), "x", "UTC", None, Shrink::NORMAL);
        assert_eq!(
            (p.title.as_str(), p.body.as_str()),
            ("Erinnerung: Notiz", "")
        );
        let p = reminder_payload(&reminder(), "x", "UTC", Some(&note("T", "b")), Shrink::MAX);
        assert_eq!((p.title.as_str(), p.body.as_str()), ("Erinnerung", ""));
    }

    #[test]
    fn oversized_payloads_are_shortened() {
        // 100 four-byte characters in title and body still fit …
        let emoji = "😀".repeat(1000);
        let n = note(&emoji, &emoji);
        let r = reminder();
        let build = |s| reminder_payload(&r, "2026-11-07T08:00:00.000Z", "UTC", Some(&n), s);
        let (bytes, level) = encode_fitting(build, Shrink::NORMAL);
        assert!(bytes.len() <= MAX_PLAINTEXT);
        assert_eq!(level, Shrink::NORMAL);
        // … and every level is smaller than the one before
        let sizes: Vec<usize> = (0..=2)
            .map(|l| serde_json::to_vec(&build(Shrink(l))).unwrap().len())
            .collect();
        assert!(sizes[0] > sizes[1] && sizes[1] > sizes[2], "{sizes:?}");
        assert_eq!(Shrink::MAX.next(), None);
    }

    #[test]
    fn test_payload_is_a_test() {
        let p = test_payload();
        assert_eq!(p.kind, "test");
        assert!(p.note_id.is_none());
    }
}
