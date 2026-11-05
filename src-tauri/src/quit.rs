//! Quit with flush handshake (decision D-13): Rust emits `flush-request` to the
//! notes window and exits after `flush_done` or a 1500 ms timeout. The wait runs
//! on a separate thread so the main (event-loop) thread is never blocked.
//!
//! The handshake can also be started without exiting ([`request_flush`] +
//! [`wait_flushed`] / [`is_flushed`]), e.g. on Windows logoff (`shutdown.rs`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::state::lock;
use crate::windows;

pub const FLUSH_REQUEST: &str = "flush-request";
pub const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub struct QuitState {
    quitting: AtomicBool,
    flushed: Mutex<bool>,
    cv: Condvar,
}

impl QuitState {
    /// Marks the start of the quit flow; returns false if it was already running.
    pub fn begin(&self) -> bool {
        let first = !self.quitting.swap(true, Ordering::SeqCst);
        if first {
            *lock(&self.flushed) = false;
        }
        first
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// Starts a new flush round (a later `mark_flushed` completes it).
    /// Ignored while quitting: that flow already owns the pending round.
    pub fn arm(&self) {
        if !self.is_quitting() {
            *lock(&self.flushed) = false;
        }
    }

    /// Whether the current round was confirmed (non-blocking).
    pub fn is_flushed(&self) -> bool {
        *lock(&self.flushed)
    }

    /// Called by `flush_done`.
    pub fn mark_flushed(&self) {
        *lock(&self.flushed) = true;
        self.cv.notify_all();
    }

    /// Blocks until `mark_flushed` or `timeout`; returns whether the flush arrived.
    pub fn wait_flushed(&self, timeout: Duration) -> bool {
        let guard = lock(&self.flushed);
        let (guard, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |flushed| !*flushed)
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }
}

/// Emits `flush-request` to the notes window; returns whether it was sent.
fn emit_flush_request(app: &AppHandle) -> bool {
    app.get_webview_window(windows::NOTES).is_some()
        && app
            .emit_to(windows::NOTES, FLUSH_REQUEST, ())
            .inspect_err(|e| log::warn!("failed to emit {FLUSH_REQUEST}: {e}"))
            .is_ok()
}

/// Starts a flush handshake without exiting: arms the flush flag and emits
/// `flush-request`. Returns whether the request was sent (`false`: no notes window,
/// nothing to wait for). Completion: [`wait_flushed`] (blocking) or [`is_flushed`].
pub fn request_flush(app: &AppHandle) -> bool {
    let Some(state) = crate::state::try_app_state(app) else {
        return false;
    };
    state.quit.arm();
    emit_flush_request(app)
}

/// Blocks until the notes window confirmed the flush or `timeout` elapsed.
/// Must not be called on the main thread (`flush_done` is processed there).
pub fn wait_flushed(app: &AppHandle, timeout: Duration) -> bool {
    crate::state::try_app_state(app).is_some_and(|s| s.quit.wait_flushed(timeout))
}

/// Non-blocking: whether the last requested flush was confirmed.
pub fn is_flushed(app: &AppHandle) -> bool {
    crate::state::try_app_state(app).is_some_and(|s| s.quit.is_flushed())
}

/// Starts the quit flow (tray „Beenden“, buddy menu, `quit_app`). Idempotent.
pub fn request_quit(app: &AppHandle) {
    let Some(state) = crate::state::try_app_state(app) else {
        // Not even set up yet: nothing to flush.
        app.exit(0);
        return;
    };
    if !state.quit.begin() {
        return;
    }
    log::info!("quit requested");
    crate::reminders::stop(app);
    windows::persist_geometry_now(app);

    let sent = emit_flush_request(app);

    let app = app.clone();
    let spawned = thread::Builder::new().name("quit".into()).spawn({
        let app = app.clone();
        move || {
            let flushed = wait_flushed(&app, FLUSH_TIMEOUT);
            if sent && !flushed {
                log::warn!(
                    "notes window did not confirm flush within {FLUSH_TIMEOUT:?}; exiting anyway"
                );
            }
            app.exit(0);
        }
    });
    if let Err(e) = spawned {
        log::error!("failed to spawn quit thread: {e}");
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn wait_times_out_without_flush() {
        let q = QuitState::default();
        assert!(q.begin());
        let start = Instant::now();
        assert!(!q.wait_flushed(Duration::from_millis(50)));
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn flush_from_other_thread_wakes_waiter() {
        let q = Arc::new(QuitState::default());
        assert!(q.begin());
        let q2 = q.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            q2.mark_flushed();
        });
        let start = Instant::now();
        assert!(q.wait_flushed(Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(5));
        t.join().unwrap();
    }

    #[test]
    fn begin_is_idempotent() {
        let q = QuitState::default();
        assert!(!q.is_quitting());
        assert!(q.begin());
        assert!(!q.begin());
        assert!(q.is_quitting());
    }

    #[test]
    fn early_flush_is_not_lost() {
        let q = QuitState::default();
        q.begin();
        q.mark_flushed();
        assert!(q.wait_flushed(Duration::from_millis(1)));
    }

    #[test]
    fn arm_starts_a_new_round() {
        let q = QuitState::default();
        q.mark_flushed();
        assert!(q.is_flushed());
        q.arm();
        assert!(!q.is_flushed());
        assert!(!q.wait_flushed(Duration::from_millis(1)));
        q.mark_flushed();
        assert!(q.is_flushed());
        assert!(q.wait_flushed(Duration::from_millis(1)));
    }

    #[test]
    fn arm_does_not_reset_a_running_quit() {
        let q = QuitState::default();
        assert!(q.begin());
        q.mark_flushed();
        q.arm();
        assert!(q.is_flushed(), "the quit flow keeps its confirmation");
    }
}
