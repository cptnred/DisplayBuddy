//! Injectable server clock (PLAN_V3_SYNC §7.3: "Die Zeit ist als `Clock`-Trait injiziert").
//!
//! Business logic never calls `Utc::now()` directly; it asks `AppState::clock`. Tests (and
//! the phase-D scheduler tests) use [`ManualClock`] to simulate time.

use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

pub trait Clock: Send + Sync + 'static {
    /// Current server time (UTC).
    fn now(&self) -> DateTime<Utc>;
}

/// The real wall clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A clock that only moves when told to (tests, simulations).
#[derive(Debug)]
pub struct ManualClock(Mutex<DateTime<Utc>>);

impl ManualClock {
    pub fn new(start: DateTime<Utc>) -> Self {
        Self(Mutex::new(start))
    }

    /// Parses an RFC 3339 instant; panics on bad input (test helper).
    pub fn at(rfc3339: &str) -> Self {
        Self::new(buddy_core::zoned::parse_instant(rfc3339).expect("valid RFC 3339 instant"))
    }

    pub fn set(&self, t: DateTime<Utc>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = t;
    }

    pub fn advance(&self, d: Duration) {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *g += d;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_moves_only_when_told() {
        let c = ManualClock::at("2026-11-06T10:00:00Z");
        assert_eq!(c.now(), c.now());
        c.advance(Duration::minutes(5));
        assert_eq!(
            buddy_core::zoned::format_utc(&c.now()),
            "2026-11-06T10:05:00.000Z"
        );
    }
}
