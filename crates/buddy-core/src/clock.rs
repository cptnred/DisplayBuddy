//! Corrected device clock (PLAN_V3_SYNC §5.3.3, D-41). TypeScript mirror:
//! `src/lib/clock.ts`; both pass `tests/fixtures/clock_vectors.json`.
//!
//! `offset = serverTime − (sentAt + RTT/2)`, measured only when RTT < 5 s. The
//! offset used is the median of the last 5 samples (even count: mean of the two
//! middle values, truncated toward zero). Offline the last value stays in force.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Samples with a round trip of this many ms or more are discarded.
pub const MAX_RTT_MS: i64 = 5_000;
/// Number of samples kept for the median.
pub const SAMPLES: usize = 5;
/// Above this absolute offset the UI shows a clock warning.
pub const WARN_OFFSET_MS: i64 = 2 * 60 * 1000;

/// One offset sample in ms (server ahead of the device = positive), or `None` if the
/// round trip was too slow or negative. All arguments are Unix milliseconds.
pub fn offset_sample(server_time_ms: i64, sent_ms: i64, received_ms: i64) -> Option<i64> {
    let rtt = received_ms - sent_ms;
    if !(0..MAX_RTT_MS).contains(&rtt) {
        return None;
    }
    Some(server_time_ms - (sent_ms + rtt / 2))
}

/// The last [`SAMPLES`] offsets, oldest first (persisted as `clockOffsets`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(transparent)]
pub struct ClockOffsets(pub Vec<i64>);

impl ClockOffsets {
    pub fn push(&mut self, offset_ms: i64) {
        self.0.push(offset_ms);
        if self.0.len() > SAMPLES {
            let extra = self.0.len() - SAMPLES;
            self.0.drain(..extra);
        }
    }

    /// Median of the kept samples; 0 without samples.
    pub fn offset_ms(&self) -> i64 {
        let mut v: Vec<i64> = self.0.iter().rev().take(SAMPLES).copied().collect();
        if v.is_empty() {
            return 0;
        }
        v.sort_unstable();
        let n = v.len();
        if n % 2 == 1 {
            v[n / 2]
        } else {
            (v[n / 2 - 1] + v[n / 2]) / 2
        }
    }

    pub fn needs_warning(&self) -> bool {
        self.offset_ms().abs() > WARN_OFFSET_MS
    }
}

/// Device time corrected by `offset_ms`.
pub fn corrected_now(device_now: DateTime<Utc>, offset_ms: i64) -> DateTime<Utc> {
    device_now + Duration::milliseconds(offset_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SampleCase {
        name: String,
        server_time_ms: i64,
        sent_ms: i64,
        received_ms: i64,
        expected: Option<i64>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MedianCase {
        name: String,
        pushes: Vec<i64>,
        expected_offset_ms: i64,
        expected_kept: Vec<i64>,
        warning: bool,
    }

    #[derive(Deserialize)]
    struct Vectors {
        samples: Vec<SampleCase>,
        median: Vec<MedianCase>,
    }

    #[test]
    fn shared_clock_vectors() {
        let v: Vectors =
            serde_json::from_str(include_str!("../tests/fixtures/clock_vectors.json")).unwrap();
        for c in &v.samples {
            assert_eq!(
                offset_sample(c.server_time_ms, c.sent_ms, c.received_ms),
                c.expected,
                "{}",
                c.name
            );
        }
        for c in &v.median {
            let mut o = ClockOffsets::default();
            for p in &c.pushes {
                o.push(*p);
            }
            assert_eq!(o.offset_ms(), c.expected_offset_ms, "{}", c.name);
            assert_eq!(o.0, c.expected_kept, "{}", c.name);
            assert_eq!(o.needs_warning(), c.warning, "{}", c.name);
        }
    }

    #[test]
    fn corrected_now_adds_offset() {
        let t = crate::zoned::parse_instant("2026-11-06T10:00:00Z").unwrap();
        assert_eq!(
            crate::zoned::format_utc(&corrected_now(t, -600_000)),
            "2026-11-06T09:50:00.000Z"
        );
    }
}
