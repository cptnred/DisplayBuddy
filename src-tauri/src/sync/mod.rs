//! v3 desktop sync client (PLAN_V3_SYNC §8).
//!
//! - [`client`]: HTTP (Rust-side `tauri_plugin_http::reqwest`, https only, 15 s).
//! - [`outbox`], [`meta`], [`core`]: `sync/outbox.json` and `sync/state.json`.
//! - [`merge`]: pure LWW decisions (`buddy_core::lww`); taken-over data never goes
//!   into the outbox.
//! - [`engine`]: one cycle = push (≤ 200 per package) → pull → merge.
//! - [`secret`]: the token in the Windows Credential Manager.
//!
//! Flow: changes wake the worker after 2 s; it also runs every 60 s, when the notes
//! window is shown, on start and on "Jetzt synchronisieren". At start-up it pulls
//! first (5 s timeout) and only then lets the reminder scheduler fire.
//!
//! **Fire is not an edit (decision):** the local scheduler marking a reminder `due`
//! creates no outbox entry. Every device (and the server's scheduler) derives `due`
//! from `at` itself; pushing it would make every PC write the same occurrence with a
//! different `firedAt`. A `due` copy still travels whenever the reminder is pushed
//! for another reason, and a remote `due` (same `updatedAt`, rank due > scheduled,
//! D-58) is taken over and alarms here only if it fired ≤ 10 min ago (§5.5).
//!
//! **Lock order:** `AppState.settings` → `AppState.storage` → reminders list →
//! sync `outbox`/`meta` (leaf locks, nothing is taken while holding them). The
//! `cycle` lock only serialises sync cycles with connect/disconnect; it guards no
//! data and is the only lock held during network calls. Hooks run under the
//! storage/reminders lock and therefore never read settings (they use the
//! `enabled` atomic) and never compute or emit the status.

pub mod client;
pub mod core;
pub mod engine;
pub mod merge;
pub mod meta;
pub mod outbox;
pub mod secret;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use tauri::{AppHandle, Emitter, Listener, Manager};

use self::client::{Client, ClientError, START_TIMEOUT, SystemClock, TIMEOUT};
use self::core::SyncCore;
use self::engine::{Engine, LocalData, SyncError, enqueue_all};
use self::outbox::Kind;
use self::secret::TokenStore;
use crate::model::{NotesChangedPayload, Reminder, SyncState, SyncStatus};
use crate::state::lock;
use crate::storage::Storage;

pub const SYNC_STATUS: &str = "sync-status";
pub const NOTES_CHANGED: &str = "notes-changed";
/// Debounce after a local change (§8).
pub const CHANGE_DELAY: Duration = Duration::from_secs(2);
/// Periodic sync (§8).
pub const PERIOD: Duration = Duration::from_secs(60);
/// Timeout of `DELETE /devices/current` on disconnect.
pub const LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEVICE_NAME_MAX: usize = 64;

// ---- start gate: the reminder scheduler waits for the start-up pull ----------

static START_GATE: LazyLock<(Mutex<bool>, Condvar)> =
    LazyLock::new(|| (Mutex::new(false), Condvar::new()));

pub fn release_start_gate() {
    let (m, cv) = &*START_GATE;
    *lock(m) = true;
    cv.notify_all();
}

/// Blocks until the start-up pull finished (or was skipped), at most `max`.
pub fn wait_for_start_pull(max: Duration) {
    let (m, cv) = &*START_GATE;
    let guard = lock(m);
    let _ = cv
        .wait_timeout_while(guard, max, |open| !*open)
        .unwrap_or_else(|e| e.into_inner());
}

// ---- managed state -----------------------------------------------------------

#[derive(Default)]
struct Wake {
    now: bool,
    change_at: Option<Instant>,
}

pub struct SyncModule {
    core: SyncCore,
    tokens: Box<dyn TokenStore>,
    /// Mirrors `settings.syncEnabled` (readable under any lock).
    enabled: AtomicBool,
    wake: Mutex<Wake>,
    wake_cv: Condvar,
    /// (state, message) of the last cycle.
    run_state: Mutex<(SyncState, Option<String>)>,
    cycle: Mutex<()>,
}

fn module(app: &AppHandle) -> Option<tauri::State<'_, SyncModule>> {
    app.try_state::<SyncModule>()
}

impl SyncModule {
    fn wake_now(&self) {
        lock(&self.wake).now = true;
        self.wake_cv.notify_all();
    }

    fn wake_change(&self) {
        let mut w = lock(&self.wake);
        if w.change_at.is_none() {
            w.change_at = Some(Instant::now());
        }
        drop(w);
        self.wake_cv.notify_all();
    }

    /// Sleeps until "now", 2 s after the first unsynced change, or `period`.
    fn wait_next(&self, period: Duration) {
        let periodic = Instant::now() + period;
        let mut w = lock(&self.wake);
        loop {
            if w.now {
                break;
            }
            let target = w
                .change_at
                .map_or(periodic, |t| (t + CHANGE_DELAY).min(periodic));
            let now = Instant::now();
            if now >= target {
                break;
            }
            w = self
                .wake_cv
                .wait_timeout(w, target - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        *w = Wake::default();
    }
}

// ---- local data of the real app ------------------------------------------------

struct AppLocal<'a> {
    app: &'a AppHandle,
}

impl LocalData for AppLocal<'_> {
    fn with_storage<T>(&self, f: impl FnOnce(&Storage) -> T) -> Result<T, String> {
        let state = crate::state::try_app_state(self.app)
            .ok_or_else(|| "app state not ready".to_string())?;
        let storage = lock(&state.storage);
        Ok(f(&storage))
    }
    fn with_reminders<T>(&self, f: impl FnOnce(&mut Vec<Reminder>) -> T) -> Result<T, String> {
        crate::reminders::apply_from_sync(self.app, f)
    }
    fn notes_changed(&self, payload: &NotesChangedPayload) {
        if let Err(e) = self
            .app
            .emit_to(crate::windows::NOTES, NOTES_CHANGED, payload)
        {
            log::warn!("failed to emit {NOTES_CHANGED}: {e}");
        }
    }
    fn alert(&self, note_id: &str) {
        log::info!("reminder for note {note_id} became due on another device");
        crate::reminders::alert(self.app, note_id);
    }
    fn now(&self) -> DateTime<Utc> {
        crate::clock::corrected_now()
    }
    fn set_clock_offset(&self, offset_ms: i64) {
        crate::clock::set_offset_ms(offset_ms);
    }
    fn default_zone(&self) -> Tz {
        crate::reminders::device_zone()
    }
}

// ---- status --------------------------------------------------------------------

pub fn status(app: &AppHandle) -> SyncStatus {
    let settings = crate::state::current_settings(app);
    let mut s = SyncStatus {
        enabled: settings.sync_enabled,
        server_url: settings.sync_server_url,
        device_name: settings.sync_device_name,
        ..Default::default()
    };
    if let Some(m) = module(app) {
        let meta = m.core.meta();
        let (state, message) = lock(&m.run_state).clone();
        s.state = if s.enabled { state } else { SyncState::Off };
        s.message = message;
        s.last_sync_at = meta.last_sync_at;
        s.pending = u32::try_from(m.core.pending_count()).unwrap_or(u32::MAX);
        s.clock_offset_ms = meta.clock_offsets.offset_ms();
    }
    s
}

fn emit_status(app: &AppHandle) {
    let s = status(app);
    if let Err(e) = app.emit(SYNC_STATUS, &s) {
        log::warn!("failed to emit {SYNC_STATUS}: {e}");
    }
}

fn set_run_state(app: &AppHandle, state: SyncState, message: Option<String>) {
    if let Some(m) = module(app) {
        *lock(&m.run_state) = (state, message);
    }
    emit_status(app);
}

fn classify(e: &SyncError) -> SyncState {
    match e {
        SyncError::Net(ClientError::Offline(_)) => SyncState::Offline,
        SyncError::Net(ClientError::Unauthorized) | SyncError::NotConnected => {
            SyncState::Unauthorized
        }
        _ => SyncState::Error,
    }
}

// ---- hooks (called by commands/notes.rs and reminders.rs) ---------------------

/// A note was saved locally (called under the storage lock).
pub fn note_saved(app: &AppHandle, id: &str) {
    record(app, |o, _| o.changed(Kind::Note, id));
}

/// A note was deleted locally (called under the storage lock).
pub fn note_deleted(app: &AppHandle, id: &str) {
    record(app, |o, now| o.deleted(Kind::Note, id, now));
}

/// The note order was saved locally.
pub fn order_saved(app: &AppHandle) {
    record(app, |o, now| o.order_changed(now));
}

/// A user action changed the reminders (called under the reminders lock).
pub fn reminders_edited(app: &AppHandle, before: &[Reminder], after: &[Reminder]) {
    let ids: HashSet<&str> = before
        .iter()
        .chain(after)
        .map(|r| r.note_id.as_str())
        .collect();
    let changes: Vec<(String, bool)> = ids
        .into_iter()
        .filter_map(|id| {
            let a = before.iter().find(|r| r.note_id == id);
            let b = after.iter().find(|r| r.note_id == id);
            (a != b).then(|| (id.to_string(), b.is_none()))
        })
        .collect();
    if changes.is_empty() {
        return;
    }
    record(app, |o, now| {
        for (id, removed) in &changes {
            if *removed {
                o.deleted(Kind::Reminder, id, now);
            } else {
                o.changed(Kind::Reminder, id);
            }
        }
    });
}

fn record(app: &AppHandle, f: impl FnOnce(&mut outbox::Outbox, &str)) {
    let Some(m) = module(app) else { return };
    if !m.enabled.load(Ordering::SeqCst) {
        return; // sync off: behaviour of 0.2.0 (the first connect unites everything)
    }
    let now = buddy_core::zoned::format_utc(&crate::clock::corrected_now());
    m.core.outbox_update(|o| f(o, &now));
    m.wake_change();
}

// ---- worker ----------------------------------------------------------------------

/// Registers the module and starts the worker. Called from `setup` after
/// `reminders::init` (the scheduler waits for [`release_start_gate`]).
pub fn init(app: &AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let core = SyncCore::load(&root);
    let enabled = crate::state::current_settings(app).sync_enabled;
    if enabled {
        // offline the last measured offset stays in force (§5.3)
        crate::clock::set_offset_ms(core.meta().clock_offsets.offset_ms());
    } else {
        release_start_gate();
    }
    app.manage(SyncModule {
        core,
        tokens: secret::platform_store(),
        enabled: AtomicBool::new(enabled),
        wake: Mutex::new(Wake::default()),
        wake_cv: Condvar::new(),
        run_state: Mutex::new((SyncState::Idle, None)),
        cycle: Mutex::new(()),
    });

    let handle = app.clone();
    app.listen_any(crate::windows::NOTES_SHOWN, move |_| {
        if let Some(m) = module(&handle) {
            m.wake_now();
        }
    });

    let app = app.clone();
    thread::Builder::new()
        .name("sync".into())
        .spawn(move || worker(&app))
        .map_err(|e| {
            release_start_gate();
            format!("could not start sync worker: {e}")
        })?;
    Ok(())
}

fn quitting(app: &AppHandle) -> bool {
    crate::state::try_app_state(app).is_some_and(|s| s.quit.is_quitting())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    StartPull,
    Full,
}

fn worker(app: &AppHandle) {
    run_cycle(app, Mode::StartPull);
    release_start_gate();
    run_cycle(app, Mode::Full);
    while let Some(m) = module(app) {
        m.wait_next(PERIOD);
        if quitting(app) {
            break;
        }
        run_cycle(app, Mode::Full);
    }
}

fn run_cycle(app: &AppHandle, mode: Mode) {
    let Some(m) = module(app) else { return };
    if !m.enabled.load(Ordering::SeqCst) {
        return;
    }
    let _cycle = lock(&m.cycle);
    if !m.enabled.load(Ordering::SeqCst) {
        return; // disconnected while we waited
    }
    let settings = crate::state::current_settings(app);
    let token = match m.tokens.get() {
        Ok(Some(t)) => t,
        Ok(None) => {
            set_run_state(app, SyncState::Unauthorized, Some("no token".into()));
            return;
        }
        Err(e) => {
            log::warn!("could not read the sync token: {e}");
            set_run_state(app, SyncState::Error, Some(format!("keyring: {e}")));
            return;
        }
    };
    let client = match Client::new(
        &settings.sync_server_url,
        Some(token),
        Arc::new(SystemClock),
    ) {
        Ok(c) => c,
        Err(e) => {
            set_run_state(app, SyncState::Error, Some(e.to_string()));
            return;
        }
    };
    set_run_state(app, SyncState::Syncing, None);
    let local = AppLocal { app };
    let engine = Engine {
        local: &local,
        core: &m.core,
        client: &client,
    };
    let result = tauri::async_runtime::block_on(async {
        match mode {
            Mode::StartPull => engine.pull_only(START_TIMEOUT).await,
            Mode::Full => engine.run(TIMEOUT).await,
        }
    });
    match result {
        Ok(report) => {
            if report.pushed + report.pulled > 0 {
                log::info!(
                    "sync: {} pushed, {} pulled, {} stale, {} invalid",
                    report.pushed,
                    report.pulled,
                    report.stale,
                    report.invalid
                );
            }
            let message = (report.stale > 0).then(|| format!("stale:{}", report.stale));
            set_run_state(app, SyncState::Idle, message);
        }
        Err(e) => {
            let state = classify(&e);
            log::info!("sync failed ({state:?}): {e}");
            let msg = e.to_string();
            m.core
                .meta_update(|meta| meta.last_error = Some(msg.clone()));
            set_run_state(app, state, Some(msg));
        }
    }
}

// ---- commands ----------------------------------------------------------------------

/// Error strings of `sync_connect` start with a code the UI maps to German texts:
/// `invalid_url`, `invalid_input`, `unauthorized`, `offline`, `server`, `protocol`,
/// `keyring`, `not_ready` (`ClientError`'s `Display` already starts with its code).
pub async fn connect(
    app: AppHandle,
    server_url: String,
    username: String,
    password: String,
    device_name: String,
) -> Result<SyncStatus, String> {
    let server = client::normalize_server_url(&server_url).map_err(|e| e.to_string())?;
    let username = username.trim().to_string();
    let device_name = device_name.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("invalid_input: username and password required".into());
    }
    if device_name.is_empty() || device_name.chars().count() > DEVICE_NAME_MAX {
        return Err("invalid_input: device name".into());
    }
    let client = Client::new(&server, None, Arc::new(SystemClock)).map_err(|e| e.to_string())?;
    let resp = client
        .register(&username, &password, &device_name)
        .await
        .map_err(|e| e.to_string())?;
    log::info!(
        "sync: registered this PC as device {}",
        resp.value.device_id
    );

    {
        let m = module(&app).ok_or("not_ready: sync module")?;
        let _cycle = lock(&m.cycle);
        m.tokens
            .set(&resp.value.token)
            .map_err(|e| format!("keyring: {e}"))?;
        let device_id = resp.value.device_id.clone();
        let sample = resp.offset_sample;
        let offset = m.core.meta_update(|meta| {
            *meta = meta::SyncMeta {
                device_id: Some(device_id),
                ..Default::default()
            };
            if let Some(s) = sample {
                meta.clock_offsets.push(s);
            }
            meta.clock_offsets.offset_ms()
        });
        crate::clock::set_offset_ms(offset);
        // Record local saves from now on, so none falls between the snapshot below and
        // the switch (a double outbox entry is harmless).
        m.enabled.store(true, Ordering::SeqCst);
        // first connect: unite local data with the server (by id, LWW per id)
        let united = enqueue_all(&AppLocal { app: &app }, &m.core).and_then(|()| {
            crate::state::update_settings(&app, |s| {
                let mut s = s.clone();
                s.sync_enabled = true;
                s.sync_server_url = server.clone();
                s.sync_device_name = device_name.clone();
                Ok(s)
            })
        });
        let new = match united {
            Ok((_, new)) => new,
            Err(e) => {
                m.enabled.store(false, Ordering::SeqCst);
                return Err(e);
            }
        };
        *lock(&m.run_state) = (SyncState::Idle, None);
        crate::state::emit_settings_changed(&app, &new);
        m.wake_now();
    }
    emit_status(&app);
    Ok(status(&app))
}

pub async fn disconnect(app: AppHandle) -> Result<SyncStatus, String> {
    let settings = crate::state::current_settings(&app);
    let token = module(&app)
        .ok_or("not_ready: sync module")?
        .tokens
        .get()
        .ok()
        .flatten();
    if let Some(token) = token
        && let Ok(client) = Client::new(
            &settings.sync_server_url,
            Some(token),
            Arc::new(SystemClock),
        )
        && let Err(e) = client.unregister(LOGOUT_TIMEOUT).await
    {
        // best effort: the device can also be revoked on the server
        log::info!("sync: could not sign out on the server: {e}");
    }
    {
        let m = module(&app).ok_or("not_ready: sync module")?;
        let _cycle = lock(&m.cycle);
        m.enabled.store(false, Ordering::SeqCst);
        if let Err(e) = m.tokens.delete() {
            log::warn!("could not delete the sync token: {e}");
        }
        m.core.reset();
        crate::clock::set_offset_ms(0);
        *lock(&m.run_state) = (SyncState::Off, None);
        let (_, new) = crate::state::update_settings(&app, |s| {
            let mut s = s.clone();
            s.sync_enabled = false;
            Ok(s)
        })?;
        crate::state::emit_settings_changed(&app, &new);
    }
    emit_status(&app);
    Ok(status(&app))
}

pub fn sync_now(app: &AppHandle) -> Result<SyncStatus, String> {
    let m = module(app).ok_or("not_ready: sync module")?;
    m.wake_now();
    Ok(status(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module_for_test() -> SyncModule {
        let dir = tempfile::tempdir().unwrap();
        SyncModule {
            core: SyncCore::load(dir.path()),
            tokens: Box::new(secret::MemoryTokenStore::default()),
            enabled: AtomicBool::new(true),
            wake: Mutex::new(Wake::default()),
            wake_cv: Condvar::new(),
            run_state: Mutex::new((SyncState::Idle, None)),
            cycle: Mutex::new(()),
        }
    }

    #[test]
    fn wake_now_is_immediate_and_change_is_debounced() {
        let m = Arc::new(module_for_test());
        let m2 = m.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            m2.wake_now();
        });
        let start = Instant::now();
        m.wait_next(Duration::from_secs(30));
        assert!(start.elapsed() < Duration::from_secs(5));
        t.join().unwrap();

        m.wake_change();
        let start = Instant::now();
        m.wait_next(Duration::from_secs(30));
        let took = start.elapsed();
        assert!(took >= CHANGE_DELAY - Duration::from_millis(50), "{took:?}");
        assert!(took < CHANGE_DELAY + Duration::from_secs(2), "{took:?}");

        // without wake: the period
        let start = Instant::now();
        m.wait_next(Duration::from_millis(30));
        assert!(start.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn errors_map_to_states() {
        assert_eq!(
            classify(&SyncError::Net(ClientError::Offline("x".into()))),
            SyncState::Offline
        );
        assert_eq!(
            classify(&SyncError::Net(ClientError::Unauthorized)),
            SyncState::Unauthorized
        );
        assert_eq!(classify(&SyncError::NotConnected), SyncState::Unauthorized);
        assert_eq!(
            classify(&SyncError::Net(ClientError::Server {
                status: 500,
                code: String::new()
            })),
            SyncState::Error
        );
        assert_eq!(classify(&SyncError::Local("x".into())), SyncState::Error);
    }

    #[test]
    fn start_gate_releases_waiters() {
        // the gate is process-wide; releasing is idempotent
        let t = thread::spawn(|| {
            let start = Instant::now();
            wait_for_start_pull(Duration::from_secs(10));
            start.elapsed()
        });
        thread::sleep(Duration::from_millis(20));
        release_start_gate();
        assert!(t.join().unwrap() < Duration::from_secs(5));
    }
}
