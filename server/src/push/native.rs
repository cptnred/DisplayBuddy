//! Native push channel of the mobile shell (PLAN_V3_SYNC §7.4, §10.5; D-55: Android/FCM
//! only, implemented in phase N2 under `server/src/push/native*`).
//!
//! Until then [`NoopNativeChannel`] is used: it supports no platform, so nothing is sent
//! and nothing is written to `push_log` (a token registered later still gets the push
//! while the occurrence is < 24 h old).
//!
//! Dedupe rule for `mobile` devices ([`mobile_needs_push`]): the shell plans every reminder
//! locally after each sync. A push is only sent when the device has **not** planned the
//! current occurrence yet (`scheduled_seq` < the reminder's `at_seq`) or cannot show local
//! notifications (`local_notifications = "denied"`). Otherwise the local notification rings
//! and a push would duplicate it.

use std::future::Future;
use std::pin::Pin;

use buddy_core::sync::{NativePushPlatform, ReminderPushPayload};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Result of a native send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeOutcome {
    Delivered,
    /// The token is invalid/unregistered (FCM `UNREGISTERED`): it is cleared.
    TokenGone,
    /// Transient (FCM 429/5xx, network): retried like Web Push.
    Retry,
    Failed(String),
}

/// A native push transport (FCM HTTP v1 in phase N2).
pub trait NativePushChannel: Send + Sync + 'static {
    /// Whether this channel can deliver to `platform` (configured credentials).
    fn supports(&self, platform: NativePushPlatform) -> bool;

    /// Sends a visible notification with `noteId`/`at` as data fields.
    fn send<'a>(
        &'a self,
        platform: NativePushPlatform,
        token: &'a str,
        payload: &'a ReminderPushPayload,
    ) -> BoxFuture<'a, NativeOutcome>;
}

/// Placeholder until phase N2: supports nothing.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopNativeChannel;

impl NativePushChannel for NoopNativeChannel {
    fn supports(&self, _platform: NativePushPlatform) -> bool {
        false
    }

    fn send<'a>(
        &'a self,
        _platform: NativePushPlatform,
        _token: &'a str,
        _payload: &'a ReminderPushPayload,
    ) -> BoxFuture<'a, NativeOutcome> {
        Box::pin(async { NativeOutcome::Failed("native push is not configured".into()) })
    }
}

/// `"granted"`/`"denied"` from `deviceState`.
pub fn notifications_denied(local_notifications: Option<&str>) -> bool {
    local_notifications == Some("denied")
}

/// §7.4: does a mobile device need a native push for an occurrence whose current `at`
/// was stored with `at_seq`? A device that never reported `deviceState`
/// (`scheduled_seq = NULL`) has planned nothing.
pub fn mobile_needs_push(
    scheduled_seq: Option<i64>,
    local_notifications: Option<&str>,
    at_seq: i64,
) -> bool {
    notifications_denied(local_notifications) || scheduled_seq.is_none_or(|s| s < at_seq)
}

pub fn platform_str(p: NativePushPlatform) -> &'static str {
    match p {
        NativePushPlatform::Fcm => "fcm",
        NativePushPlatform::Apns => "apns",
    }
}

pub fn parse_platform(s: &str) -> Option<NativePushPlatform> {
    match s {
        "fcm" => Some(NativePushPlatform::Fcm),
        "apns" => Some(NativePushPlatform::Apns),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_rule_table() {
        // (scheduled_seq, local_notifications, at_seq) → push?
        let cases: &[(Option<i64>, Option<&str>, i64, bool)] = &[
            (None, None, 5, true),                // never reported: nothing planned
            (Some(4), Some("granted"), 5, true),  // planned an older version
            (Some(5), Some("granted"), 5, false), // planned exactly this version
            (Some(9), Some("granted"), 5, false), // planned a later state
            (Some(9), None, 5, false),            // state without permission info
            (Some(9), Some("denied"), 5, true),   // cannot ring locally
            (None, Some("denied"), 5, true),
            (Some(0), Some("granted"), 0, false),
        ];
        for &(s, ln, at, want) in cases {
            assert_eq!(mobile_needs_push(s, ln, at), want, "{s:?} {ln:?} {at}");
        }
    }

    #[test]
    fn noop_supports_nothing() {
        let c = NoopNativeChannel;
        assert!(!c.supports(NativePushPlatform::Fcm));
        assert!(!c.supports(NativePushPlatform::Apns));
        let p = crate::push::payload::test_payload();
        let out = futures_block_on(c.send(NativePushPlatform::Fcm, "t", &p));
        assert!(matches!(out, NativeOutcome::Failed(_)));
    }

    fn futures_block_on<T>(f: BoxFuture<'_, T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn platforms_round_trip() {
        for p in [NativePushPlatform::Fcm, NativePushPlatform::Apns] {
            assert_eq!(parse_platform(platform_str(p)), Some(p));
        }
        assert_eq!(parse_platform("x"), None);
    }
}
