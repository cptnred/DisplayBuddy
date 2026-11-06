//! buddy-core passes the shared reminder-math vectors (also read by Vitest).

use buddy_core::model::{Reminder, ReminderRepeat, ReminderState};
use buddy_core::schedule;
use buddy_core::zoned::{
    format_utc, instant_to_wall, parse_instant, parse_wall, parse_zone, wall_to_instant,
};
use serde_json::Value;

const ID: &str = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/schedule_vectors.json")).unwrap()
}

fn s<'a>(c: &'a Value, k: &str) -> &'a str {
    c[k].as_str()
        .unwrap_or_else(|| panic!("{k} missing in {c}"))
}

fn repeat(c: &Value) -> ReminderRepeat {
    serde_json::from_value(c["repeat"].clone()).unwrap()
}

#[test]
fn wall_to_instant_vectors() {
    let v = vectors();
    let cases = v["wallToInstant"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let tz = parse_zone(s(c, "zone")).unwrap();
        let got = wall_to_instant(&tz, parse_wall(s(c, "wall")).unwrap()).unwrap();
        assert_eq!(format_utc(&got), s(c, "expected"), "{}", s(c, "name"));
    }
}

#[test]
fn instant_to_wall_vectors() {
    let v = vectors();
    for c in v["instantToWall"].as_array().unwrap() {
        let tz = parse_zone(s(c, "zone")).unwrap();
        let wall = instant_to_wall(&tz, &parse_instant(s(c, "instant")).unwrap());
        assert_eq!(
            wall.format("%Y-%m-%dT%H:%M").to_string(),
            s(c, "wall"),
            "{}",
            s(c, "name")
        );
    }
}

#[test]
fn next_occurrence_vectors() {
    let v = vectors();
    let cases = v["next"].as_array().unwrap();
    assert!(cases.len() >= 100);
    for c in cases {
        let tz = parse_zone(s(c, "zone")).unwrap();
        let got = schedule::next_occurrence_in(
            tz,
            &parse_instant(s(c, "at")).unwrap(),
            repeat(c),
            &parse_instant(s(c, "now")).unwrap(),
        );
        assert_eq!(
            got.map(|t| format_utc(&t)),
            c["expected"].as_str().map(String::from),
            "{}",
            s(c, "name")
        );
    }
}

#[test]
fn ack_vectors() {
    let v = vectors();
    for c in v["ack"].as_array().unwrap() {
        let mut list = vec![Reminder {
            note_id: ID.into(),
            at: s(c, "at").into(),
            repeat: repeat(c),
            state: ReminderState::Due,
            fired_at: None,
            updated_at: None,
            time_zone: Some(s(c, "zone").into()),
        }];
        let now = parse_instant(s(c, "now")).unwrap();
        // the default zone must not matter when the reminder has its own
        let r = schedule::ack(&mut list, ID, &now, chrono_tz::Pacific::Kiritimati)
            .unwrap()
            .unwrap();
        assert_eq!(r.at, s(c, "expectedAt"), "{}", s(c, "name"));
        let state: ReminderState = serde_json::from_value(c["expectedState"].clone()).unwrap();
        assert_eq!(r.state, state, "{}", s(c, "name"));
        assert_eq!(r.updated_at.as_deref(), Some(format_utc(&now).as_str()));
    }
}

#[test]
fn snooze_vectors() {
    let v = vectors();
    for c in v["snooze"].as_array().unwrap() {
        let mut list = vec![Reminder {
            note_id: ID.into(),
            at: s(c, "at").into(),
            repeat: ReminderRepeat::Daily,
            state: ReminderState::Due,
            fired_at: None,
            updated_at: None,
            time_zone: Some("Asia/Kolkata".into()),
        }];
        let minutes = u32::try_from(c["minutes"].as_u64().unwrap()).unwrap();
        let r =
            schedule::snooze(&mut list, ID, minutes, &parse_instant(s(c, "now")).unwrap()).unwrap();
        assert_eq!(r.at, s(c, "expectedAt"), "{}", s(c, "name"));
    }
}
