//! Login brake (PLAN_V3_SYNC §7.5; OWASP Authentication Cheat Sheet, "Login Throttling"):
//! per client IP **and** username; from the 5th failure on, further attempts are blocked
//! for 30 s, doubling per failure up to 15 min. While blocked the password is not even
//! checked (429 + `Retry-After`). A success resets the counter; counters are forgotten
//! one day after the last failure.
//!
//! The client IP is the TCP peer, or the last `X-Forwarded-For` entry when the peer is a
//! trusted proxy (Caddy in the Docker network, `BUDDY_TRUSTED_PROXIES`). Caddy replaces
//! incoming forwarding headers unless configured otherwise, so the last entry is the one
//! it added.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;

use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use ipnet::IpNet;

pub const FREE_ATTEMPTS: u32 = 5;
pub const FIRST_LOCK_SECS: i64 = 30;
pub const MAX_LOCK_SECS: i64 = 15 * 60;
const FORGET_AFTER_HOURS: i64 = 24;

#[derive(Debug, Clone, Copy)]
struct Entry {
    failures: u32,
    last_failure: DateTime<Utc>,
}

/// Lock duration after `failures` failed attempts.
pub fn lock_secs(failures: u32) -> i64 {
    if failures < FREE_ATTEMPTS {
        return 0;
    }
    let exp = (failures - FREE_ATTEMPTS).min(20);
    (FIRST_LOCK_SECS << exp).min(MAX_LOCK_SECS)
}

#[derive(Debug, Default)]
pub struct LoginThrottle {
    map: Mutex<HashMap<(IpAddr, String), Entry>>,
}

fn key(ip: IpAddr, username: &str) -> (IpAddr, String) {
    (ip, username.trim().to_lowercase())
}

impl LoginThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Err(seconds)` while this IP/user pair is locked.
    pub fn check(&self, ip: IpAddr, username: &str, now: DateTime<Utc>) -> Result<(), u64> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let Some(e) = map.get(&key(ip, username)) else {
            return Ok(());
        };
        let until = e.last_failure + Duration::seconds(lock_secs(e.failures));
        if now < until {
            Err(u64::try_from((until - now).num_seconds().max(1)).unwrap_or(1))
        } else {
            Ok(())
        }
    }

    pub fn fail(&self, ip: IpAddr, username: &str, now: DateTime<Utc>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let e = map.entry(key(ip, username)).or_insert(Entry {
            failures: 0,
            last_failure: now,
        });
        if now - e.last_failure > Duration::hours(FORGET_AFTER_HOURS) {
            e.failures = 0;
        }
        e.failures = e.failures.saturating_add(1);
        e.last_failure = now;
    }

    pub fn success(&self, ip: IpAddr, username: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&key(ip, username));
    }

    /// Drops counters whose last failure is older than a day (housekeeping).
    pub fn prune(&self, now: DateTime<Utc>) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, e| now - e.last_failure <= Duration::hours(FORGET_AFTER_HOURS));
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The client IP for throttling (see module docs).
pub fn client_ip(peer: Option<SocketAddr>, headers: &HeaderMap, trusted: &[IpNet]) -> IpAddr {
    let peer_ip = peer.map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |p| p.ip());
    let peer_ip = match peer_ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(peer_ip, IpAddr::V4),
        v4 => v4,
    };
    if !trusted.iter().any(|n| n.contains(&peer_ip)) {
        return peer_ip;
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|s| s.trim().parse::<IpAddr>().ok())
        .next_back()
        .unwrap_or(peer_ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn t(s: &str) -> DateTime<Utc> {
        buddy_core::zoned::parse_instant(s).unwrap()
    }

    #[test]
    fn lock_schedule() {
        assert_eq!(lock_secs(4), 0);
        assert_eq!(lock_secs(5), 30);
        assert_eq!(lock_secs(6), 60);
        assert_eq!(lock_secs(9), 480);
        assert_eq!(lock_secs(10), 900);
        assert_eq!(lock_secs(1000), 900);
    }

    #[test]
    fn locks_per_ip_and_user() {
        let th = LoginThrottle::new();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let other: IpAddr = "203.0.113.8".parse().unwrap();
        let now = t("2026-11-06T10:00:00Z");
        for _ in 0..4 {
            th.fail(ip, "Martin", now);
        }
        assert!(th.check(ip, "martin", now).is_ok());
        th.fail(ip, "martin", now);
        assert_eq!(th.check(ip, "MARTIN", now), Err(30));
        assert!(th.check(other, "martin", now).is_ok());
        assert!(th.check(ip, "someone", now).is_ok());
        assert!(th.check(ip, "martin", now + Duration::seconds(30)).is_ok());
        th.success(ip, "martin");
        assert!(th.is_empty());
    }

    #[test]
    fn forgets_after_a_day() {
        let th = LoginThrottle::new();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let now = t("2026-11-06T10:00:00Z");
        for _ in 0..5 {
            th.fail(ip, "m", now);
        }
        th.prune(now + Duration::hours(25));
        assert!(th.is_empty());
    }

    #[test]
    fn forwarded_for_only_from_trusted_proxy() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("10.9.9.9, 198.51.100.4"),
        );
        let proxy: SocketAddr = "172.30.0.2:5555".parse().unwrap();
        let trusted = vec!["172.30.0.0/16".parse::<IpNet>().unwrap()];
        assert_eq!(
            client_ip(Some(proxy), &h, &trusted),
            "198.51.100.4".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            client_ip(Some(proxy), &h, &[]),
            "172.30.0.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            client_ip(Some(proxy), &HeaderMap::new(), &trusted),
            "172.30.0.2".parse::<IpAddr>().unwrap()
        );
        let mapped: SocketAddr = "[::ffff:172.30.0.2]:1".parse().unwrap();
        assert_eq!(
            client_ip(Some(mapped), &h, &trusted),
            "198.51.100.4".parse::<IpAddr>().unwrap()
        );
    }
}
