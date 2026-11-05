//! Pure reminder logic: repeat math and state transitions on `Vec<Reminder>`.
//!
//! Everything here is generic over [`chrono::TimeZone`] so it can be tested with
//! `FixedOffset` and a hand-made DST zone instead of the machine's `Local` zone.

use std::fmt::Display;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, LocalResult, NaiveDate, NaiveDateTime,
    SecondsFormat, TimeZone, Timelike, Weekday,
};

use crate::model::{Reminder, ReminderRepeat, ReminderState, is_valid_note_id};

pub const SNOOZE_MIN: u32 = 1;
pub const SNOOZE_MAX: u32 = 1440;

/// Safety bound for the candidate loops (never reached for sane input).
const MAX_STEPS: u32 = 1000;

/// RFC 3339 with offset and whole seconds, e.g. `2026-11-05T14:30:00+01:00`.
pub fn format_time<Tz: TimeZone>(t: &DateTime<Tz>) -> String
where
    Tz::Offset: Display,
{
    t.to_rfc3339_opts(SecondsFormat::Secs, false)
}

pub fn parse_time(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s.trim()).ok()
}

/// Turns a local wall-clock time into an instant:
/// ambiguous (DST fold) → the earlier instant; nonexistent (DST gap) → the first
/// valid local minute after it (e.g. 02:30 in a 02:00→03:00 gap becomes 03:00).
pub fn resolve_local<Tz: TimeZone>(tz: &Tz, local: NaiveDateTime) -> Option<DateTime<Tz>> {
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

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map_or(28, |d| d.day())
}

/// `anchor_day` of the month `months` after (year, month), clamped to the month's end.
fn add_months_clamped(year: i32, month: u32, anchor_day: u32, months: i64) -> Option<NaiveDate> {
    let index = i64::from(year) * 12 + i64::from(month) - 1 + months;
    let y = i32::try_from(index.div_euclid(12)).ok()?;
    let m = u32::try_from(index.rem_euclid(12)).ok()? + 1;
    NaiveDate::from_ymd_opt(y, m, anchor_day.min(days_in_month(y, m)))
}

fn is_weekday(d: NaiveDate) -> bool {
    !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
}

/// The first occurrence of a repeating reminder strictly after `now`.
///
/// `at` itself counts as an occurrence. Later occurrences keep `at`'s local
/// wall-clock time: daily (+1 day), weekdays (next Mon–Fri), weekly (+7 days),
/// monthly (same day of month, clamped to the month's end). `None` for
/// [`ReminderRepeat::None`].
pub fn next_occurrence<Tz: TimeZone>(
    at: &DateTime<Tz>,
    repeat: ReminderRepeat,
    now: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    if repeat == ReminderRepeat::None {
        return None;
    }
    if at > now {
        return Some(at.clone());
    }
    let tz = at.timezone();
    let local = at.naive_local();
    let (date0, time) = (local.date(), local.time());
    let now_date = now.with_timezone(&tz).naive_local().date();
    // Days between `at` and `now`, minus a safety day for offset differences.
    let gap_days = (now_date - date0).num_days().max(0);

    let at_date = |d: NaiveDate| resolve_local(&tz, d.and_time(time));

    match repeat {
        ReminderRepeat::None => None,
        ReminderRepeat::Daily | ReminderRepeat::Weekdays => {
            let mut d = date0 + Duration::days((gap_days - 1).max(1));
            for _ in 0..MAX_STEPS {
                if (repeat == ReminderRepeat::Daily || is_weekday(d))
                    && let Some(t) = at_date(d)
                    && t > *now
                {
                    return Some(t);
                }
                d = d.succ_opt()?;
            }
            None
        }
        ReminderRepeat::Weekly => {
            let first = (gap_days / 7 - 1).max(1);
            (first..first + i64::from(MAX_STEPS))
                .filter_map(|k| at_date(date0 + Duration::days(7 * k)))
                .find(|t| t > now)
        }
        ReminderRepeat::Monthly => {
            let months_between = (i64::from(now_date.year()) - i64::from(date0.year())) * 12
                + i64::from(now_date.month())
                - i64::from(date0.month());
            let first = (months_between - 1).max(1);
            (first..first + i64::from(MAX_STEPS))
                .map_while(|k| add_months_clamped(date0.year(), date0.month(), date0.day(), k))
                .filter_map(at_date)
                .find(|t| t > now)
        }
    }
}

/// Drops reminders with an invalid note id or an unparseable time and duplicates
/// (first one per note wins).
pub fn sanitize(list: Vec<Reminder>) -> Vec<Reminder> {
    let mut out: Vec<Reminder> = Vec::with_capacity(list.len());
    for r in list {
        if !is_valid_note_id(&r.note_id) || parse_time(&r.at).is_none() {
            log::warn!("dropping invalid reminder for note {:?}", r.note_id);
            continue;
        }
        if out.iter().any(|o| o.note_id == r.note_id) {
            continue;
        }
        out.push(r);
    }
    out
}

/// Indices of scheduled reminders whose time is ≤ `now`.
pub fn due_now<Tz: TimeZone>(list: &[Reminder], now: &DateTime<Tz>) -> Vec<usize> {
    list.iter()
        .enumerate()
        .filter(|(_, r)| {
            r.state == ReminderState::Scheduled && parse_time(&r.at).is_some_and(|at| at <= *now)
        })
        .map(|(i, _)| i)
        .collect()
}

/// Earliest `at` of all scheduled reminders.
pub fn earliest_scheduled(list: &[Reminder]) -> Option<DateTime<FixedOffset>> {
    list.iter()
        .filter(|r| r.state == ReminderState::Scheduled)
        .filter_map(|r| parse_time(&r.at))
        .min()
}

/// Marks the given reminders as due (fired at `now`).
pub fn fire<Tz: TimeZone>(list: &mut [Reminder], indices: &[usize], now: &DateTime<Tz>)
where
    Tz::Offset: Display,
{
    let fired_at = format_time(now);
    for &i in indices {
        if let Some(r) = list.get_mut(i) {
            r.state = ReminderState::Due;
            r.fired_at = Some(fired_at.clone());
        }
    }
}

/// Creates/replaces (`Some(at)`) or removes (`None`) the reminder of a note.
/// A new time always means state `scheduled`; `firedAt` is kept.
pub fn set<Tz: TimeZone>(
    list: &mut Vec<Reminder>,
    note_id: &str,
    at: Option<&DateTime<Tz>>,
    repeat: ReminderRepeat,
) -> Option<Reminder>
where
    Tz::Offset: Display,
{
    let pos = list.iter().position(|r| r.note_id == note_id);
    let Some(at) = at else {
        if let Some(pos) = pos {
            list.remove(pos);
        }
        return None;
    };
    let at = format_time(at);
    let reminder = match pos {
        Some(pos) => {
            let r = &mut list[pos];
            r.at = at;
            r.repeat = repeat;
            r.state = ReminderState::Scheduled;
            r.clone()
        }
        None => {
            let r = Reminder {
                note_id: note_id.to_string(),
                at,
                repeat,
                state: ReminderState::Scheduled,
                fired_at: None,
            };
            list.push(r.clone());
            r
        }
    };
    Some(reminder)
}

/// Acknowledges a reminder: one-off → `done`; repeating → next occurrence
/// strictly after `max(now, at)` in `now`'s zone, `scheduled`.
/// `Ok(None)` if the note has no reminder.
pub fn ack<Tz: TimeZone>(
    list: &mut [Reminder],
    note_id: &str,
    now: &DateTime<Tz>,
) -> Result<Option<Reminder>, String>
where
    Tz::Offset: Display,
{
    let Some(r) = list.iter_mut().find(|r| r.note_id == note_id) else {
        return Ok(None);
    };
    if r.repeat == ReminderRepeat::None {
        r.state = ReminderState::Done;
        return Ok(Some(r.clone()));
    }
    let tz = now.timezone();
    let at = parse_time(&r.at)
        .ok_or_else(|| format!("invalid reminder time: {}", r.at))?
        .with_timezone(&tz);
    // Acknowledging ahead of time skips the upcoming occurrence.
    let after = if at > *now { at.clone() } else { now.clone() };
    let next = next_occurrence(&at, r.repeat, &after)
        .ok_or_else(|| "could not compute the next occurrence".to_string())?;
    r.at = format_time(&next);
    r.state = ReminderState::Scheduled;
    Ok(Some(r.clone()))
}

/// Postpones a reminder to `now + minutes` (1..=1440), state `scheduled`.
pub fn snooze<Tz: TimeZone>(
    list: &mut [Reminder],
    note_id: &str,
    minutes: u32,
    now: &DateTime<Tz>,
) -> Result<Reminder, String>
where
    Tz::Offset: Display,
{
    if !(SNOOZE_MIN..=SNOOZE_MAX).contains(&minutes) {
        return Err(format!(
            "minutes must be between {SNOOZE_MIN} and {SNOOZE_MAX}, got {minutes}"
        ));
    }
    let r = list
        .iter_mut()
        .find(|r| r.note_id == note_id)
        .ok_or_else(|| format!("no reminder for note {note_id}"))?;
    r.at = format_time(&(now.clone() + Duration::minutes(i64::from(minutes))));
    r.state = ReminderState::Scheduled;
    Ok(r.clone())
}

/// Removes a note's reminder; returns whether one existed.
pub fn remove(list: &mut Vec<Reminder>, note_id: &str) -> bool {
    let before = list.len();
    list.retain(|r| r.note_id != note_id);
    list.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{MappedLocalTime, NaiveTime, Offset};

    const ID: &str = "123e4567-e89b-42d3-a456-426614174000";
    const ID2: &str = "123e4567-e89b-42d3-a456-426614174001";

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }

    fn t(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    fn next(at: &str, repeat: ReminderRepeat, now: &str) -> String {
        format_time(&next_occurrence(&t(at), repeat, &t(now)).unwrap())
    }

    /// EU-like zone for 2026: +01:00, +02:00 from 2026-03-29 01:00 UTC until
    /// 2026-10-25 01:00 UTC (local gap 02:00–03:00 in March, fold 02:00–03:00 in October).
    #[derive(Clone, Copy, Debug)]
    struct TestDst;

    fn summer_start() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 3, 29)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap()
    }
    fn summer_end() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 25)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap()
    }

    impl TimeZone for TestDst {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            TestDst
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            self.offset_from_local_datetime(&local.and_time(NaiveTime::MIN))
        }
        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            let valid: Vec<FixedOffset> = [7200, 3600]
                .into_iter()
                .map(|s| FixedOffset::east_opt(s).unwrap())
                .filter(|off| {
                    let utc = *local - Duration::seconds(i64::from(off.local_minus_utc()));
                    self.offset_from_utc_datetime(&utc) == *off
                })
                .collect();
            match valid.as_slice() {
                [] => MappedLocalTime::None,
                [one] => MappedLocalTime::Single(*one),
                // +02:00 first: the earlier instant
                [a, b, ..] => MappedLocalTime::Ambiguous(*a, *b),
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_time(NaiveTime::MIN))
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            let secs = if *utc >= summer_start() && *utc < summer_end() {
                7200
            } else {
                3600
            };
            FixedOffset::east_opt(secs).unwrap().fix()
        }
    }

    fn dst(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<TestDst> {
        resolve_local(
            &TestDst,
            NaiveDate::from_ymd_opt(y, m, d)
                .unwrap()
                .and_hms_opt(h, min, 0)
                .unwrap(),
        )
        .unwrap()
    }

    fn reminder(id: &str, at: &str, repeat: ReminderRepeat, state: ReminderState) -> Reminder {
        Reminder {
            note_id: id.into(),
            at: at.into(),
            repeat,
            state,
            fired_at: None,
        }
    }

    // ------------------------------------------------------------ next_occurrence

    #[test]
    fn none_has_no_next() {
        let at = t("2026-11-05T09:00:00+01:00");
        assert_eq!(next_occurrence(&at, ReminderRepeat::None, &at), None);
    }

    #[test]
    fn future_at_is_its_own_next_occurrence() {
        assert_eq!(
            next(
                "2026-11-06T09:00:00+01:00",
                ReminderRepeat::Daily,
                "2026-11-05T10:00:00+01:00"
            ),
            "2026-11-06T09:00:00+01:00"
        );
    }

    #[test]
    fn daily_is_strictly_after_now() {
        use ReminderRepeat::Daily;
        // fired at 09:00, acknowledged at 09:00 exactly → tomorrow
        assert_eq!(
            next(
                "2026-11-05T09:00:00+01:00",
                Daily,
                "2026-11-05T09:00:00+01:00"
            ),
            "2026-11-06T09:00:00+01:00"
        );
        // acknowledged later the same day → tomorrow
        assert_eq!(
            next(
                "2026-11-05T09:00:00+01:00",
                Daily,
                "2026-11-05T18:00:00+01:00"
            ),
            "2026-11-06T09:00:00+01:00"
        );
        // missed for a long time → the next one after now, not after `at`
        assert_eq!(
            next(
                "2025-01-01T09:00:00+01:00",
                Daily,
                "2026-11-05T08:59:00+01:00"
            ),
            "2026-11-05T09:00:00+01:00"
        );
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        use ReminderRepeat::Weekdays;
        // 2026-11-06 is a Friday
        assert_eq!(
            next(
                "2026-11-06T09:00:00+01:00",
                Weekdays,
                "2026-11-06T10:00:00+01:00"
            ),
            "2026-11-09T09:00:00+01:00"
        );
        // Thursday → Friday
        assert_eq!(
            next(
                "2026-11-05T09:00:00+01:00",
                Weekdays,
                "2026-11-05T10:00:00+01:00"
            ),
            "2026-11-06T09:00:00+01:00"
        );
        // set on a Saturday → Monday
        assert_eq!(
            next(
                "2026-11-07T09:00:00+01:00",
                Weekdays,
                "2026-11-07T09:30:00+01:00"
            ),
            "2026-11-09T09:00:00+01:00"
        );
    }

    #[test]
    fn weekly_keeps_the_weekday() {
        use ReminderRepeat::Weekly;
        assert_eq!(
            next(
                "2026-11-05T09:00:00+01:00",
                Weekly,
                "2026-11-05T09:00:01+01:00"
            ),
            "2026-11-12T09:00:00+01:00"
        );
        // long missed: Thursday 2026-01-01 → next Thursday after now
        assert_eq!(
            next(
                "2026-01-01T09:00:00+01:00",
                Weekly,
                "2026-11-05T10:00:00+01:00"
            ),
            "2026-11-12T09:00:00+01:00"
        );
        assert_eq!(
            next(
                "2026-01-01T09:00:00+01:00",
                Weekly,
                "2026-11-05T08:00:00+01:00"
            ),
            "2026-11-05T09:00:00+01:00"
        );
    }

    #[test]
    fn monthly_clamps_to_month_end() {
        use ReminderRepeat::Monthly;
        assert_eq!(
            next(
                "2026-01-31T09:00:00+01:00",
                Monthly,
                "2026-01-31T10:00:00+01:00"
            ),
            "2026-02-28T09:00:00+01:00"
        );
        // leap year
        assert_eq!(
            next(
                "2028-01-31T09:00:00+01:00",
                Monthly,
                "2028-01-31T10:00:00+01:00"
            ),
            "2028-02-29T09:00:00+01:00"
        );
        // the anchor day comes back in longer months
        assert_eq!(
            next(
                "2026-01-31T09:00:00+01:00",
                Monthly,
                "2026-03-01T00:00:00+01:00"
            ),
            "2026-03-31T09:00:00+01:00"
        );
        // year wrap
        assert_eq!(
            next(
                "2026-12-15T09:00:00+01:00",
                Monthly,
                "2026-12-15T09:00:00+01:00"
            ),
            "2027-01-15T09:00:00+01:00"
        );
        // long missed
        assert_eq!(
            next(
                "2024-05-10T09:00:00+01:00",
                Monthly,
                "2026-11-10T09:00:00+01:00"
            ),
            "2026-12-10T09:00:00+01:00"
        );
    }

    #[test]
    fn keeps_local_wall_time_across_dst() {
        // daily 08:00 before the March switch → 08:00 summer time after it
        let at = dst(2026, 3, 28, 8, 0);
        let now = dst(2026, 3, 28, 9, 0);
        let n = next_occurrence(&at, ReminderRepeat::Daily, &now).unwrap();
        assert_eq!(format_time(&n), "2026-03-29T08:00:00+02:00");
        // weekly across the October switch
        let at = dst(2026, 10, 20, 8, 0);
        let now = dst(2026, 10, 20, 9, 0);
        let n = next_occurrence(&at, ReminderRepeat::Weekly, &now).unwrap();
        assert_eq!(format_time(&n), "2026-10-27T08:00:00+01:00");
    }

    #[test]
    fn dst_gap_shifts_forward() {
        // 02:30 does not exist on 2026-03-29
        let at = dst(2026, 3, 28, 2, 30);
        assert_eq!(format_time(&at), "2026-03-28T02:30:00+01:00");
        let now = dst(2026, 3, 28, 3, 0);
        let n = next_occurrence(&at, ReminderRepeat::Daily, &now).unwrap();
        assert_eq!(format_time(&n), "2026-03-29T03:00:00+02:00");
        // and the day after it is 02:30 again
        let n2 = next_occurrence(&at, ReminderRepeat::Daily, &n).unwrap();
        assert_eq!(format_time(&n2), "2026-03-30T02:30:00+02:00");
    }

    #[test]
    fn dst_fold_picks_the_earlier_instant() {
        let at = dst(2026, 10, 24, 2, 30);
        let now = dst(2026, 10, 24, 3, 0);
        let n = next_occurrence(&at, ReminderRepeat::Daily, &now).unwrap();
        assert_eq!(format_time(&n), "2026-10-25T02:30:00+02:00");
        // after the first 02:30 has passed, the next one is the following day
        // (the repeated wall-clock hour does not fire twice)
        let n2 = next_occurrence(&at, ReminderRepeat::Daily, &n).unwrap();
        assert_eq!(format_time(&n2), "2026-10-26T02:30:00+01:00");
    }

    #[test]
    fn resolve_local_single() {
        let naive = NaiveDate::from_ymd_opt(2026, 11, 5)
            .unwrap()
            .and_hms_opt(14, 30, 0)
            .unwrap();
        assert_eq!(
            format_time(&resolve_local(&cet(), naive).unwrap()),
            "2026-11-05T14:30:00+01:00"
        );
    }

    // ------------------------------------------------------------ transitions

    #[test]
    fn sanitize_drops_invalid_and_duplicates() {
        let list = vec![
            reminder(
                ID,
                "2026-11-05T09:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
            reminder(
                "../evil",
                "2026-11-05T09:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
            reminder(
                ID2,
                "tomorrow",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
            reminder(
                ID,
                "2026-12-05T09:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
        ];
        let out = sanitize(list);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].at, "2026-11-05T09:00:00+01:00");
    }

    #[test]
    fn due_now_only_returns_scheduled_past_reminders() {
        let list = vec![
            reminder(
                ID,
                "2026-11-05T09:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
            reminder(
                ID2,
                "2026-11-05T11:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Scheduled,
            ),
            reminder(
                "123e4567-e89b-42d3-a456-426614174002",
                "2026-11-05T08:00:00+01:00",
                ReminderRepeat::None,
                ReminderState::Due,
            ),
        ];
        // other offset, same instant as 10:00+01:00
        let now = t("2026-11-05T09:00:00+00:00");
        assert_eq!(due_now(&list, &now), vec![0]);
        assert_eq!(due_now(&list, &t("2026-11-05T09:00:00+01:00")), vec![0]);
        assert!(due_now(&list, &t("2026-11-05T08:59:59+01:00")).is_empty());
        assert_eq!(
            earliest_scheduled(&list),
            Some(t("2026-11-05T09:00:00+01:00"))
        );
    }

    #[test]
    fn fire_marks_due_with_fired_at() {
        let mut list = vec![reminder(
            ID,
            "2026-11-05T09:00:00+01:00",
            ReminderRepeat::Daily,
            ReminderState::Scheduled,
        )];
        let now = t("2026-11-05T09:00:05+01:00");
        let due = due_now(&list, &now);
        fire(&mut list, &due, &now);
        assert_eq!(list[0].state, ReminderState::Due);
        assert_eq!(
            list[0].fired_at.as_deref(),
            Some("2026-11-05T09:00:05+01:00")
        );
        assert_eq!(list[0].at, "2026-11-05T09:00:00+01:00");
        assert!(due_now(&list, &now).is_empty(), "fires only once");
        assert_eq!(earliest_scheduled(&list), None);
    }

    #[test]
    fn set_creates_replaces_and_removes() {
        let mut list = Vec::new();
        let at = t("2026-11-05T09:00:00+01:00");
        let r = set(&mut list, ID, Some(&at), ReminderRepeat::Weekly).unwrap();
        assert_eq!(r.state, ReminderState::Scheduled);
        assert_eq!(r.at, "2026-11-05T09:00:00+01:00");
        assert_eq!(list.len(), 1);

        list[0].state = ReminderState::Due;
        list[0].fired_at = Some("x".into());
        let at2 = t("2026-11-06T10:15:30.250+01:00");
        let r = set(&mut list, ID, Some(&at2), ReminderRepeat::None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(r.state, ReminderState::Scheduled);
        assert_eq!(r.repeat, ReminderRepeat::None);
        assert_eq!(r.at, "2026-11-06T10:15:30+01:00");

        assert_eq!(
            set::<FixedOffset>(&mut list, ID, None, ReminderRepeat::None),
            None
        );
        assert!(list.is_empty());
        // removing a missing one is fine
        assert_eq!(
            set::<FixedOffset>(&mut list, ID, None, ReminderRepeat::None),
            None
        );
    }

    #[test]
    fn ack_one_off_is_done() {
        let mut list = vec![reminder(
            ID,
            "2026-11-05T09:00:00+01:00",
            ReminderRepeat::None,
            ReminderState::Due,
        )];
        let now = t("2026-11-05T09:05:00+01:00");
        let r = ack(&mut list, ID, &now).unwrap().unwrap();
        assert_eq!(r.state, ReminderState::Done);
        assert_eq!(list[0].state, ReminderState::Done);
        assert_eq!(ack(&mut list, ID2, &now), Ok(None));
    }

    #[test]
    fn ack_repeating_schedules_next() {
        let mut list = vec![reminder(
            ID,
            "2026-11-06T09:00:00+01:00",
            ReminderRepeat::Weekdays,
            ReminderState::Due,
        )];
        let now = t("2026-11-06T09:05:00+01:00");
        let r = ack(&mut list, ID, &now).unwrap().unwrap();
        assert_eq!(r.state, ReminderState::Scheduled);
        assert_eq!(r.at, "2026-11-09T09:00:00+01:00");
        // acknowledging early skips the upcoming occurrence
        let r = ack(&mut list, ID, &now).unwrap().unwrap();
        assert_eq!(r.at, "2026-11-10T09:00:00+01:00");
    }

    #[test]
    fn snooze_validates_minutes() {
        let mut list = vec![reminder(
            ID,
            "2026-11-05T09:00:00+01:00",
            ReminderRepeat::Daily,
            ReminderState::Due,
        )];
        let now = t("2026-11-05T09:05:00+01:00");
        assert!(snooze(&mut list, ID, 0, &now).is_err());
        assert!(snooze(&mut list, ID, 1441, &now).is_err());
        assert!(snooze(&mut list, ID2, 10, &now).is_err());
        let r = snooze(&mut list, ID, 10, &now).unwrap();
        assert_eq!(r.at, "2026-11-05T09:15:00+01:00");
        assert_eq!(r.state, ReminderState::Scheduled);
        assert_eq!(r.repeat, ReminderRepeat::Daily);
        let r = snooze(&mut list, ID, 1440, &now).unwrap();
        assert_eq!(r.at, "2026-11-06T09:05:00+01:00");
    }

    #[test]
    fn remove_reports_presence() {
        let mut list = vec![reminder(
            ID,
            "2026-11-05T09:00:00+01:00",
            ReminderRepeat::None,
            ReminderState::Due,
        )];
        assert!(!remove(&mut list, ID2));
        assert!(remove(&mut list, ID));
        assert!(list.is_empty());
    }
}
