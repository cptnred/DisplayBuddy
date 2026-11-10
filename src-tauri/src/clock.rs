//! Corrected device time for the desktop (PLAN_V3_SYNC §5.3, D-41).
//!
//! Every edit is stamped with the device time corrected by the measured offset to the
//! sync server's clock. Without sync the offset stays 0 and the behaviour is exactly
//! that of 0.2.0. The sync module (`crate::sync`) updates the offset after each
//! measurement via [`set_offset_ms`]; the math lives in `buddy_core::clock`.

use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Utc};

static OFFSET_MS: AtomicI64 = AtomicI64::new(0);

/// Sets the clock offset (median of the last samples) in milliseconds.
pub fn set_offset_ms(offset_ms: i64) {
    OFFSET_MS.store(offset_ms, Ordering::Relaxed);
}

pub fn offset_ms() -> i64 {
    OFFSET_MS.load(Ordering::Relaxed)
}

/// Device time + offset, UTC. The only "now" used for stamps and reminder math.
pub fn corrected_now() -> DateTime<Utc> {
    buddy_core::clock::corrected_now(Utc::now(), offset_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_shifts_now() {
        set_offset_ms(0);
        let a = corrected_now();
        set_offset_ms(3_600_000);
        let b = corrected_now();
        set_offset_ms(0);
        let diff = (b - a).num_milliseconds();
        assert!((3_599_000..3_601_000).contains(&diff), "{diff}");
    }
}
