//! Rate limits next to the login brake (PLAN_V4 §8.2, D-103; OWASP Authentication Cheat
//! Sheet, "Login Throttling"). Everything lives in memory like the v3 brake (one server
//! process); housekeeping calls [`Limits::prune`].
//!
//! A [`Limiter`] keeps a sliding log of events per key. Two shapes:
//! - **rate** (`lock = None`): at most `max` events per `window`; the next one is refused
//!   until the oldest leaves the window (`acquire`, or `check` + `hit`);
//! - **lock** (`lock = Some(d)`): after `max` events (failures) inside `window` the key is
//!   locked for `d` and its log starts again.
//!
//! Refusals carry the seconds for `429` + `Retry-After`. The (IP, user) login brake of D-67
//! stays in [`super::throttle`] unchanged; [`Limits::login_failures`] adds the IP-wide limit.
//! `/sync/changes` and `/sync/push` have **no** limiter (D-103, Android background sync).

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::net::IpAddr;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub max: u32,
    pub window: Duration,
    /// `None` = rate limit; `Some` = lock after `max` events.
    pub lock: Option<Duration>,
}

impl Rule {
    pub fn rate(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            lock: None,
        }
    }

    pub fn lock(max: u32, window: Duration, lock: Duration) -> Self {
        Self {
            max,
            window,
            lock: Some(lock),
        }
    }
}

#[derive(Debug, Default)]
struct Entry {
    hits: VecDeque<DateTime<Utc>>,
    locked_until: Option<DateTime<Utc>>,
}

impl Entry {
    fn forget_before(&mut self, cut: DateTime<Utc>) {
        while self.hits.front().is_some_and(|t| *t <= cut) {
            self.hits.pop_front();
        }
    }
}

fn secs_until(t: DateTime<Utc>, now: DateTime<Utc>) -> u64 {
    u64::try_from((t - now).num_seconds().max(1)).unwrap_or(1)
}

#[derive(Debug)]
pub struct Limiter<K> {
    rule: Rule,
    map: Mutex<HashMap<K, Entry>>,
}

impl<K: Eq + Hash + Clone> Limiter<K> {
    pub fn new(rule: Rule) -> Self {
        Self {
            rule,
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn rule(&self) -> Rule {
        self.rule
    }

    /// `Err(seconds)` while `key` is locked or its window is full.
    pub fn check(&self, key: &K, now: DateTime<Utc>) -> Result<(), u64> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let Some(e) = map.get_mut(key) else {
            return Ok(());
        };
        if let Some(until) = e.locked_until
            && now < until
        {
            return Err(secs_until(until, now));
        }
        e.forget_before(now - self.rule.window);
        if e.hits.len() >= self.rule.max as usize
            && let Some(oldest) = e.hits.front()
        {
            return Err(secs_until(*oldest + self.rule.window, now));
        }
        Ok(())
    }

    /// Counts one event (a request or a failure).
    pub fn hit(&self, key: &K, now: DateTime<Utc>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let e = map.entry(key.clone()).or_default();
        e.forget_before(now - self.rule.window);
        e.hits.push_back(now);
        if let Some(lock) = self.rule.lock
            && e.hits.len() >= self.rule.max as usize
        {
            e.locked_until = Some(now + lock);
            e.hits.clear();
        }
    }

    /// `check` + `hit` in one step (rate limits on requests).
    pub fn acquire(&self, key: &K, now: DateTime<Utc>) -> Result<(), u64> {
        self.check(key, now)?;
        self.hit(key, now);
        Ok(())
    }

    /// Drops keys without events in the window and without an active lock.
    pub fn prune(&self, now: DateTime<Utc>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, e| {
            e.forget_before(now - self.rule.window);
            !e.hits.is_empty() || e.locked_until.is_some_and(|t| t > now)
        });
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// All limits of PLAN_V4 §8.2 except the (IP, user) brake (`throttle`).
#[derive(Debug)]
pub struct Limits {
    /// Failed password checks over all usernames: 30/h per IP → 15 min lock.
    pub login_failures: Limiter<IpAddr>,
    /// `POST /accounts/challenge`: 10/h per IP.
    pub challenges: Limiter<IpAddr>,
    /// Successful registrations: 3/h and 10/day per IP.
    pub registrations_hour: Limiter<IpAddr>,
    pub registrations_day: Limiter<IpAddr>,
    /// Successful registrations of all IPs: `BUDDY_REGISTRATION_DAILY_LIMIT`/day.
    pub registrations_global: Limiter<()>,
    /// Failed pairing redemptions (phase P): 10 per 10 min per IP → 15 min lock.
    pub pairing_failures: Limiter<IpAddr>,
    /// New pairing codes (phase P): 20/h per account.
    pub pairing_starts: Limiter<i64>,
    /// `GET /me/export`: 1/min per account.
    pub exports: Limiter<i64>,
}

impl Limits {
    pub fn new(registration_daily_limit: u32) -> Self {
        let h = Duration::hours(1);
        let d = Duration::days(1);
        let lock = Duration::minutes(15);
        Self {
            login_failures: Limiter::new(Rule::lock(30, h, lock)),
            challenges: Limiter::new(Rule::rate(10, h)),
            registrations_hour: Limiter::new(Rule::rate(3, h)),
            registrations_day: Limiter::new(Rule::rate(10, d)),
            registrations_global: Limiter::new(Rule::rate(registration_daily_limit, d)),
            pairing_failures: Limiter::new(Rule::lock(10, Duration::minutes(10), lock)),
            pairing_starts: Limiter::new(Rule::rate(20, h)),
            exports: Limiter::new(Rule::rate(1, Duration::minutes(1))),
        }
    }

    pub fn prune(&self, now: DateTime<Utc>) {
        self.login_failures.prune(now);
        self.challenges.prune(now);
        self.registrations_hour.prune(now);
        self.registrations_day.prune(now);
        self.registrations_global.prune(now);
        self.pairing_failures.prune(now);
        self.pairing_starts.prune(now);
        self.exports.prune(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        buddy_core::zoned::parse_instant(s).unwrap()
    }

    #[test]
    fn rate_limit_slides() {
        let l: Limiter<u8> = Limiter::new(Rule::rate(3, Duration::hours(1)));
        let t0 = t("2026-11-10T10:00:00Z");
        for m in 0..3 {
            assert!(l.acquire(&1, t0 + Duration::minutes(m)).is_ok());
        }
        // 4th within the hour: wait until the first leaves the window
        assert_eq!(l.acquire(&1, t0 + Duration::minutes(10)), Err(50 * 60));
        assert!(l.acquire(&2, t0 + Duration::minutes(10)).is_ok(), "per key");
        assert!(l.acquire(&1, t0 + Duration::minutes(60)).is_ok());
        assert_eq!(l.check(&1, t0 + Duration::minutes(60)), Err(60));
    }

    #[test]
    fn lock_after_failures() {
        let l: Limiter<u8> =
            Limiter::new(Rule::lock(3, Duration::minutes(10), Duration::minutes(15)));
        let t0 = t("2026-11-10T10:00:00Z");
        l.hit(&1, t0);
        l.hit(&1, t0);
        assert!(l.check(&1, t0).is_ok());
        l.hit(&1, t0 + Duration::minutes(1));
        assert_eq!(l.check(&1, t0 + Duration::minutes(1)), Err(15 * 60));
        assert!(l.check(&1, t0 + Duration::minutes(16)).is_ok());
        // failures older than the window do not count
        let l2: Limiter<u8> =
            Limiter::new(Rule::lock(3, Duration::minutes(10), Duration::minutes(15)));
        l2.hit(&1, t0);
        l2.hit(&1, t0);
        l2.hit(&1, t0 + Duration::minutes(11));
        assert!(l2.check(&1, t0 + Duration::minutes(11)).is_ok());
    }

    #[test]
    fn prune_keeps_only_active_keys() {
        let l: Limiter<u8> = Limiter::new(Rule::lock(1, Duration::minutes(10), Duration::hours(1)));
        let t0 = t("2026-11-10T10:00:00Z");
        l.hit(&1, t0); // locked for an hour
        let r: Limiter<u8> = Limiter::new(Rule::rate(5, Duration::minutes(10)));
        r.hit(&1, t0);
        l.prune(t0 + Duration::minutes(30));
        r.prune(t0 + Duration::minutes(30));
        assert_eq!((l.len(), r.len()), (1, 0));
        l.prune(t0 + Duration::minutes(61));
        assert!(l.is_empty());
    }

    #[test]
    fn plan_values() {
        let l = Limits::new(200);
        assert_eq!(
            l.login_failures.rule(),
            Rule::lock(30, Duration::hours(1), Duration::minutes(15))
        );
        assert_eq!(l.challenges.rule(), Rule::rate(10, Duration::hours(1)));
        assert_eq!(
            l.registrations_hour.rule(),
            Rule::rate(3, Duration::hours(1))
        );
        assert_eq!(
            l.registrations_day.rule(),
            Rule::rate(10, Duration::days(1))
        );
        assert_eq!(
            l.registrations_global.rule(),
            Rule::rate(200, Duration::days(1))
        );
        assert_eq!(
            l.pairing_failures.rule(),
            Rule::lock(10, Duration::minutes(10), Duration::minutes(15))
        );
        assert_eq!(l.pairing_starts.rule(), Rule::rate(20, Duration::hours(1)));
        assert_eq!(l.exports.rule(), Rule::rate(1, Duration::minutes(1)));
    }
}
