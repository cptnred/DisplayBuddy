//! Instants and wall-clock times in IANA zones (PLAN_V3_SYNC §5.5, D-39).
//!
//! Instants (`at`, `updatedAt`, "now") are UTC and never depend on a zone. Zones
//! only matter for turning a wall time into an instant and for repetition. The
//! TypeScript mirror is `src/lib/zoned.ts`; both pass `schedule_vectors.json`.

use std::str::FromStr;

use chrono::{
    DateTime, Duration, LocalResult, NaiveDateTime, SecondsFormat, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;

/// Parses an IANA zone name (`"Europe/Berlin"`). `None` for unknown names.
pub fn parse_zone(name: &str) -> Option<Tz> {
    Tz::from_str(name.trim()).ok()
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` (the v3 wire format for instants).
pub fn format_utc(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Any RFC 3339 instant (with `Z` or an offset) as UTC.
pub fn parse_instant(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Turns a wall-clock time in `tz` into an instant:
/// ambiguous (DST fold) → the earlier instant; nonexistent (DST gap) → the first
/// valid wall-clock minute after it (e.g. 02:30 in a 02:00→03:00 gap becomes 03:00).
pub fn resolve_local<Z: TimeZone>(tz: &Z, local: NaiveDateTime) -> Option<DateTime<Z>> {
    let mut candidate = local;
    for _ in 0..=24 * 60 {
        match tz.from_local_datetime(&candidate) {
            LocalResult::Single(t) => return Some(t),
            LocalResult::Ambiguous(a, b) => return Some(if a <= b { a } else { b }),
            LocalResult::None => {
                // Step to the next whole minute.
                let next = candidate + Duration::minutes(1);
                candidate = next
                    .with_second(0)
                    .and_then(|t| t.with_nanosecond(0))
                    .unwrap_or(next);
            }
        }
    }
    None
}

/// Wall time in `tz` → UTC instant (gap → next valid minute, fold → earlier).
pub fn wall_to_instant(tz: &Tz, wall: NaiveDateTime) -> Option<DateTime<Utc>> {
    resolve_local(tz, wall).map(|t| t.with_timezone(&Utc))
}

/// UTC instant → wall time in `tz`.
pub fn instant_to_wall(tz: &Tz, instant: &DateTime<Utc>) -> NaiveDateTime {
    instant.with_timezone(tz).naive_local()
}

/// Parses `YYYY-MM-DDTHH:MM` (optionally with `:SS`) as a naive wall time.
pub fn parse_wall(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall(s: &str) -> NaiveDateTime {
        parse_wall(s).unwrap()
    }

    #[test]
    fn zone_names() {
        assert!(parse_zone("Europe/Berlin").is_some());
        assert!(parse_zone(" Asia/Kolkata ").is_some());
        assert!(parse_zone("Mars/Olympus").is_none());
        assert!(parse_zone("").is_none());
    }

    #[test]
    fn utc_format_and_parse() {
        let t = parse_instant("2026-11-06T11:00:00.5+01:00").unwrap();
        assert_eq!(format_utc(&t), "2026-11-06T10:00:00.500Z");
        assert!(parse_instant("tomorrow").is_none());
    }

    #[test]
    fn gap_and_fold() {
        let berlin = parse_zone("Europe/Berlin").unwrap();
        let gap = wall_to_instant(&berlin, wall("2026-03-29T02:30")).unwrap();
        assert_eq!(format_utc(&gap), "2026-03-29T01:00:00.000Z"); // 03:00 CEST
        let fold = wall_to_instant(&berlin, wall("2026-10-25T02:30")).unwrap();
        assert_eq!(format_utc(&fold), "2026-10-25T00:30:00.000Z"); // first 02:30 (CEST)
        let lh = parse_zone("Australia/Lord_Howe").unwrap();
        // 30-minute DST: 2026-10-04 02:00 → 02:30
        let gap = wall_to_instant(&lh, wall("2026-10-04T02:10")).unwrap();
        assert_eq!(instant_to_wall(&lh, &gap), wall("2026-10-04T02:30"));
    }
}
