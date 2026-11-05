//! v2: flush on Windows logoff/shutdown (PLAN §12, closes D-20).
//!
//! The buddy window is subclassed (`SetWindowSubclass`):
//! * `WM_QUERYENDSESSION` → `ShutdownBlockReasonCreate("Notizen werden gespeichert …")`,
//!   persist the window geometry, start the flush handshake (`quit::request_flush`)
//!   and pump messages until `flush_done` arrives (max. 3 s), then return TRUE.
//! * `WM_ENDSESSION(TRUE)` → if the flush is still pending, keep pumping for the rest of
//!   the 3 s budget; then `ShutdownBlockReasonDestroy` and the default processing.
//! * `WM_ENDSESSION(FALSE)` (logoff cancelled) → `ShutdownBlockReasonDestroy`.
//!
//! Why the wait already starts in `WM_QUERYENDSESSION`: tao terminates the process
//! (`std::process::exit`) when its hidden event-target window receives
//! `WM_ENDSESSION(TRUE)`, and Windows gives no ordering guarantee between our buddy
//! window and that hidden window. Waiting only in our `WM_ENDSESSION` would therefore
//! race with tao's exit. Every top-level window must have answered
//! `WM_QUERYENDSESSION` before any `WM_ENDSESSION` is sent, so flushing there is safe.
//! Pumping keeps the app responsive, so Windows does not flag it as hung; the block
//! reason is what the user sees in the "apps are preventing shutdown" screen.
//!
//! Non-Windows: no-op.

use tauri::AppHandle;

/// Called from `setup` (main thread). Windows: subclass the buddy window.
pub fn install(app: &AppHandle) {
    #[cfg(windows)]
    imp::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
mod imp {
    use std::cell::Cell;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Shutdown::{
        ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, PostQuitMessage,
        QS_ALLINPUT, TranslateMessage, WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION, WM_QUIT,
    };
    use windows_sys::w;

    use crate::{quit, windows};

    /// Arbitrary id of our subclass on the buddy window.
    const SUBCLASS_ID: usize = 0xDB_5D;
    /// Total time we hold up logoff/shutdown for the flush.
    const FLUSH_BUDGET: Duration = Duration::from_secs(3);
    /// Max. single wait inside the pump.
    const PUMP_SLICE: Duration = Duration::from_millis(50);

    /// Context passed through `dwRefData`. Only ever touched on the UI thread that
    /// owns the buddy window (the subclass proc runs nowhere else), hence `Cell`.
    struct Ctx {
        app: AppHandle,
        /// Deadline of the running flush round (`None`: no round / already done).
        deadline: Cell<Option<Instant>>,
        /// A flush request was actually sent (there is something to wait for).
        sent: Cell<bool>,
        block_reason: Cell<bool>,
        /// Guards against re-entering the pump from a nested message.
        pumping: Cell<bool>,
    }

    pub fn install(app: &AppHandle) {
        let Some(window) = app.get_webview_window(windows::BUDDY) else {
            log::warn!("shutdown flush: buddy window missing, not installed");
            return;
        };
        let hwnd: HWND = match window.hwnd() {
            Ok(h) => h.0 as HWND,
            Err(e) => {
                log::warn!("shutdown flush: no HWND: {e}");
                return;
            }
        };
        let ctx = Box::into_raw(Box::new(Ctx {
            app: app.clone(),
            deadline: Cell::new(None),
            sent: Cell::new(false),
            block_reason: Cell::new(false),
            pumping: Cell::new(false),
        }));
        // SAFETY: `hwnd` is a live window created on this (main) thread – `setup` runs
        // on the main thread and SetWindowSubclass must be called from the window's
        // thread. `ctx` is a leaked Box that stays valid for the whole process
        // lifetime (the buddy window is never destroyed before exit); it is freed only
        // on WM_NCDESTROY, after which the proc is never called again.
        let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, ctx as usize) };
        if ok == 0 {
            // SAFETY: not registered, so we still own the only pointer.
            drop(unsafe { Box::from_raw(ctx) });
            log::warn!("shutdown flush: SetWindowSubclass failed");
        } else {
            log::debug!("shutdown flush installed");
        }
    }

    /// The subclass procedure. Never panics into Windows: all work runs inside
    /// `catch_unwind` (release builds use `panic = "abort"` anyway, and the code
    /// below avoids panicking operations).
    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        // SAFETY: `data` is the `Ctx` pointer registered in `install`, valid until
        // WM_NCDESTROY (handled below, last message a window receives).
        let ctx = unsafe { &*(data as *const Ctx) };
        match msg {
            WM_QUERYENDSESSION => {
                if catch_unwind(AssertUnwindSafe(|| on_query_end_session(hwnd, ctx))).is_err() {
                    log::error!("panic in WM_QUERYENDSESSION handler");
                }
                // TRUE: we agree to end the session (we only delay it a little).
                return 1;
            }
            WM_ENDSESSION => {
                if catch_unwind(AssertUnwindSafe(|| on_end_session(hwnd, ctx, wparam != 0)))
                    .is_err()
                {
                    log::error!("panic in WM_ENDSESSION handler");
                }
            }
            WM_NCDESTROY => {
                // SAFETY: same proc/id as registered; afterwards nobody uses `data`.
                unsafe {
                    RemoveWindowSubclass(hwnd, Some(subclass_proc), id);
                    drop(Box::from_raw(data as *mut Ctx));
                }
            }
            _ => {}
        }
        // SAFETY: forwards to the next proc in the chain (tao's window proc).
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    fn on_query_end_session(hwnd: HWND, ctx: &Ctx) {
        if ctx.pumping.get() {
            return;
        }
        log::info!("session is ending: flushing notes");
        if !ctx.block_reason.get() {
            // SAFETY: valid hwnd of this thread; `w!` yields a static NUL-terminated UTF-16 string.
            let ok =
                unsafe { ShutdownBlockReasonCreate(hwnd, w!("Notizen werden gespeichert …")) };
            ctx.block_reason.set(ok != 0);
        }
        windows::persist_geometry_now(&ctx.app);
        let sent = quit::request_flush(&ctx.app);
        ctx.sent.set(sent);
        ctx.deadline.set(Some(Instant::now() + FLUSH_BUDGET));
        if sent {
            pump_until_flushed(ctx);
        }
    }

    fn on_end_session(hwnd: HWND, ctx: &Ctx, ending: bool) {
        if ending && ctx.sent.get() && !ctx.pumping.get() {
            pump_until_flushed(ctx);
        }
        if ending {
            log::info!(
                "session ends (notes flushed: {})",
                !ctx.sent.get() || quit::is_flushed(&ctx.app)
            );
        }
        ctx.deadline.set(None);
        if ctx.block_reason.replace(false) {
            // SAFETY: valid hwnd of this thread.
            unsafe { ShutdownBlockReasonDestroy(hwnd) };
        }
    }

    /// Nested message loop until `flush_done` was processed or the deadline passed.
    ///
    /// Why `flush_done` can arrive while we sit in here: it is a sync command, i.e.
    /// it runs on the main thread. WebView2 delivers the IPC request (and the replies
    /// of the async `save_note` commands, which do their file I/O on the async
    /// runtime) as window messages to this UI thread, and `emit` of `flush-request`
    /// from the main thread is either evaluated directly or posted as a tao user
    /// event – all of which are retrieved and dispatched by the `PeekMessageW` /
    /// `DispatchMessageW` loop below. So `QuitState::mark_flushed` runs from inside
    /// this pump and `quit::is_flushed` becomes true. (If tao were busy in an event
    /// callback it would buffer user events; then the 3 s budget bounds the wait.)
    fn pump_until_flushed(ctx: &Ctx) {
        let Some(deadline) = ctx.deadline.get() else {
            return;
        };
        ctx.pumping.set(true);
        // SAFETY: MSG is plain data; all-zero is a valid value.
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        'outer: while !quit::is_flushed(&ctx.app) {
            let now = Instant::now();
            if now >= deadline {
                log::warn!("notes window did not confirm flush before session end");
                break;
            }
            // SAFETY: standard message loop on this thread with a valid MSG buffer.
            unsafe {
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    if msg.message == WM_QUIT {
                        // Leave WM_QUIT for the real loop.
                        PostQuitMessage(msg.wParam as i32);
                        break 'outer;
                    }
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                    if quit::is_flushed(&ctx.app) {
                        break 'outer;
                    }
                }
                let slice = (deadline - now).min(PUMP_SLICE);
                MsgWaitForMultipleObjects(
                    0,
                    std::ptr::null(),
                    0,
                    u32::try_from(slice.as_millis()).unwrap_or(50),
                    QS_ALLINPUT,
                );
            }
        }
        ctx.pumping.set(false);
    }
}
