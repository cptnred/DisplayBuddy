//! Quit with flush handshake (decision D-13): Rust emits `flush-request` to the
//! notes window and exits after `flush_done` or a 1500 ms timeout. The wait runs
//! on a separate thread so the main (event-loop) thread is never blocked.

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
    windows::persist_geometry_now(app);

    let notes_alive = app.get_webview_window(windows::NOTES).is_some();
    let sent = notes_alive
        && app
            .emit_to(windows::NOTES, FLUSH_REQUEST, ())
            .inspect_err(|e| log::warn!("failed to emit {FLUSH_REQUEST}: {e}"))
            .is_ok();

    let app = app.clone();
    let spawned = thread::Builder::new().name("quit".into()).spawn({
        let app = app.clone();
        move || {
            let flushed = crate::state::try_app_state(&app)
                .is_some_and(|s| s.quit.wait_flushed(FLUSH_TIMEOUT));
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
}
