//! Window placement, show/hide logic, buddy context menu and window events.
//!
//! All placement math works in **physical** pixels on plain [`Rect`]s so it can
//! be unit-tested without a display.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

use crate::debounce::Debouncer;
use crate::model::{Settings, WindowPosition, WindowSize};
use crate::state::{self, lock};

pub const BUDDY: &str = "buddy";
pub const NOTES: &str = "notes";
pub const SETTINGS: &str = "settings";

pub const NOTES_SHOWN: &str = "notes-shown";
pub const NOTES_HIDDEN: &str = "notes-hidden";
pub const NOTE_CREATE_REQUEST: &str = "note-create-request";

/// Gap between buddy and notes window (logical px).
const NOTES_GAP: f64 = 12.0;
/// Default distance of the buddy from the work-area edges (logical px).
const BUDDY_MARGIN: f64 = 24.0;
const BUDDY_MOVE_DEBOUNCE: Duration = Duration::from_millis(300);
/// A toggle within this time after a blur-hide is the click that caused the blur
/// (buddy / tray click) and must not re-open the notes window.
const BLUR_TOGGLE_GUARD: Duration = Duration::from_millis(400);
/// Windows reports minimised windows at (-32000, -32000).
const MINIMIZED_COORD: i32 = -32000;

pub const MENU_NEW_NOTE: &str = "buddy.new-note";
pub const MENU_SETTINGS: &str = "buddy.settings";
pub const MENU_QUIT: &str = "buddy.quit";

// ------------------------------------------------------------------ pure math

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
    pub fn right(&self) -> i32 {
        self.x + self.width
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.height
    }
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.width / 2, self.y + self.height / 2)
    }
    /// Half-open: `[x, right) × [y, bottom)`.
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

pub fn point_on_any_monitor(x: i32, y: i32, monitors: &[Rect]) -> bool {
    monitors.iter().any(|m| m.contains(x, y))
}

/// Bottom-right corner of the work area, `margin` px from the edges.
pub fn default_buddy_position(work_area: Rect, buddy_size: (i32, i32), margin: i32) -> (i32, i32) {
    let x = (work_area.right() - margin - buddy_size.0).max(work_area.x);
    let y = (work_area.bottom() - margin - buddy_size.1).max(work_area.y);
    (x, y)
}

/// Clamps `pos` so that `[pos, pos+len)` lies in `[min, max)`; if it cannot fit, `min`.
fn clamp_span(pos: i32, len: i32, min: i32, max: i32) -> i32 {
    if len >= max - min {
        min
    } else {
        pos.clamp(min, max - len)
    }
}

/// Notes window position next to the buddy: left of it if it fits into the work
/// area, else right of it, `gap` px apart; bottom edges aligned; the result is
/// clamped into the work area.
pub fn compute_notes_position(
    buddy: Rect,
    notes_size: (i32, i32),
    work_area: Rect,
    gap: i32,
) -> (i32, i32) {
    let (w, h) = notes_size;
    let left = buddy.x - gap - w;
    let right = buddy.right() + gap;
    let x = if left >= work_area.x {
        left
    } else if right + w <= work_area.right() {
        right
    } else {
        // Neither side fits completely: use the side with more room, then clamp.
        let room_left = buddy.x - work_area.x;
        let room_right = work_area.right() - buddy.right();
        if room_left >= room_right { left } else { right }
    };
    let x = clamp_span(x, w, work_area.x, work_area.right());
    let y = clamp_span(buddy.bottom() - h, h, work_area.y, work_area.bottom());
    (x, y)
}

/// New top-left so that a window of `new_size` has the same centre as `old`.
pub fn resize_keep_center(old: Rect, new_size: (i32, i32)) -> (i32, i32) {
    let cx2 = 2 * old.x + old.width;
    let cy2 = 2 * old.y + old.height;
    ((cx2 - new_size.0) / 2, (cy2 - new_size.1) / 2)
}

// --------------------------------------------------------------- tauri glue

fn monitor_rect(m: &Monitor) -> Rect {
    let p = m.position();
    let s = m.size();
    Rect::new(p.x, p.y, s.width as i32, s.height as i32)
}

fn work_rect(m: &Monitor) -> Rect {
    let wa = m.work_area();
    Rect::new(
        wa.position.x,
        wa.position.y,
        wa.size.width as i32,
        wa.size.height as i32,
    )
}

fn window_rect(w: &WebviewWindow) -> tauri::Result<Rect> {
    let p = w.outer_position()?;
    let s = w.outer_size()?;
    Ok(Rect::new(p.x, p.y, s.width as i32, s.height as i32))
}

fn scaled(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

fn window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    app.get_webview_window(label)
        .ok_or(tauri::Error::WindowNotFound)
}

/// Monitor containing `point`, else the window's current monitor, else primary.
fn monitor_for(app: &AppHandle, w: &WebviewWindow, point: (i32, i32)) -> Option<Monitor> {
    app.monitor_from_point(point.0 as f64, point.1 as f64)
        .ok()
        .flatten()
        .or_else(|| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// Startup: size the buddy, restore its position if the saved position's centre
/// lies on a connected monitor (else bottom-right of the primary work area), show it.
pub fn setup_buddy(app: &AppHandle, settings: &Settings) -> tauri::Result<()> {
    let buddy = window(app, BUDDY)?;
    let logical = settings.buddy.size as f64;
    buddy.set_size(LogicalSize::new(logical, logical))?;

    let monitors: Vec<Monitor> = app.available_monitors().unwrap_or_default();
    let rects: Vec<Rect> = monitors.iter().map(monitor_rect).collect();
    let saved = settings.buddy_position.filter(|p| {
        let target = monitors.iter().find(|m| monitor_rect(m).contains(p.x, p.y));
        let scale = target.map(|m| m.scale_factor()).unwrap_or(1.0);
        let side = scaled(logical, scale);
        let centre = Rect::new(p.x, p.y, side, side).center();
        point_on_any_monitor(centre.0, centre.1, &rects)
    });

    let position = match saved {
        Some(p) => Some((p.x, p.y)),
        None => {
            let primary = app
                .primary_monitor()
                .ok()
                .flatten()
                .or_else(|| monitors.first().cloned());
            primary.map(|m| {
                let scale = m.scale_factor();
                let side = scaled(logical, scale);
                default_buddy_position(work_rect(&m), (side, side), scaled(BUDDY_MARGIN, scale))
            })
        }
    };
    if let Some((x, y)) = position {
        if saved.is_none() {
            *lock(&AUTO_POSITION) = Some(WindowPosition { x, y });
        }
        buddy.set_position(PhysicalPosition::new(x, y))?;
        // Re-apply the logical size: the target monitor may have another DPI.
        buddy.set_size(LogicalSize::new(logical, logical))?;
    } else {
        log::warn!("no monitor information available; leaving buddy at its default position");
    }
    buddy.show()?;
    Ok(())
}

/// Resizes the buddy window to `size` logical px. The **centre** is kept stable
/// (rather than the top-left corner), so the smiley grows/shrinks in place under
/// the cursor instead of drifting towards the bottom-right.
pub fn resize_buddy(app: &AppHandle, size: u32) -> tauri::Result<()> {
    let buddy = window(app, BUDDY)?;
    let old = window_rect(&buddy)?;
    let scale = buddy.scale_factor()?;
    let side = scaled(size as f64, scale);
    let (x, y) = resize_keep_center(old, (side, side));
    buddy.set_size(LogicalSize::new(size as f64, size as f64))?;
    buddy.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Applies the stored notes window size (logical px) at startup.
pub fn apply_notes_size(app: &AppHandle, settings: &Settings) -> tauri::Result<()> {
    if let Some(size) = settings.notes_size {
        window(app, NOTES)?.set_size(LogicalSize::new(size.width, size.height))?;
    }
    Ok(())
}

/// Default / minimum logical size of the notes window (mirrors tauri.conf.json).
pub const NOTES_DEFAULT_SIZE: (f64, f64) = (420.0, 520.0);
pub const NOTES_MIN_SIZE: (f64, f64) = (320.0, 360.0);

/// Logical notes size → physical px on the target monitor. Falls back to the default
/// when the size is unknown or degenerate (e.g. a never-realized window reports 0×0).
pub fn notes_physical_size(logical: Option<(f64, f64)>, scale: f64) -> (i32, i32) {
    let (w, h) = logical
        .filter(|(w, h)| w.is_finite() && h.is_finite() && *w >= 1.0 && *h >= 1.0)
        .map(|(w, h)| (w.max(NOTES_MIN_SIZE.0), h.max(NOTES_MIN_SIZE.1)))
        .unwrap_or(NOTES_DEFAULT_SIZE);
    (scaled(w, scale), scaled(h, scale))
}

fn position_notes(app: &AppHandle, notes: &WebviewWindow) -> tauri::Result<()> {
    let buddy = window(app, BUDDY)?;
    let buddy_rect = window_rect(&buddy)?;
    let Some(monitor) = monitor_for(app, &buddy, buddy_rect.center()) else {
        return Ok(());
    };
    // Work in logical size and convert with the *target* monitor's scale: the window's
    // current physical size may stem from another DPI, or be 0×0 before first realize.
    let current = notes
        .inner_size()
        .ok()
        .filter(|s| s.width > 0 && s.height > 0)
        .and_then(|s| notes.scale_factor().ok().map(|f| s.to_logical::<f64>(f)))
        .map(|l| (l.width, l.height));
    let stored = state::current_settings(app)
        .notes_size
        .map(|s| (s.width, s.height));
    let logical = notes_physical_size(current.or(stored), 1.0);
    let scale = monitor.scale_factor();
    let size = notes_physical_size(Some((logical.0 as f64, logical.1 as f64)), scale);
    let gap = scaled(NOTES_GAP, scale);
    let (x, y) = compute_notes_position(buddy_rect, size, work_rect(&monitor), gap);
    notes.set_position(PhysicalPosition::new(x, y))?;
    notes.set_size(LogicalSize::new(logical.0 as f64, logical.1 as f64))?;
    Ok(())
}

pub fn show_notes(app: &AppHandle) -> tauri::Result<()> {
    let notes = window(app, NOTES)?;
    if notes.is_visible()? {
        if notes.is_minimized().unwrap_or(false) {
            notes.unminimize()?;
        }
        notes.set_focus()?;
        return Ok(());
    }
    if let Err(e) = position_notes(app, &notes) {
        log::warn!("could not position notes window: {e}");
    }
    notes.show()?;
    notes.set_focus()?;
    app.emit_to(NOTES, NOTES_SHOWN, ())?;
    log::debug!("notes shown");
    Ok(())
}

/// Emits `notes-hidden` (so the notes window flushes its autosave) **before**
/// hiding, and persists the current window size (logical px).
pub fn hide_notes(app: &AppHandle) -> tauri::Result<()> {
    let notes = window(app, NOTES)?;
    if !notes.is_visible()? {
        return Ok(());
    }
    app.emit_to(NOTES, NOTES_HIDDEN, ())?;
    persist_notes_size(app, &notes);
    notes.hide()?;
    Ok(())
}

pub fn toggle_notes(app: &AppHandle) -> tauri::Result<()> {
    let notes = window(app, NOTES)?;
    let visible = notes.is_visible()?;
    log::debug!("toggle_notes (visible: {visible})");
    if visible {
        hide_notes(app)
    } else if state::take_recent_blur_hide(app, BLUR_TOGGLE_GUARD) {
        // The click on buddy/tray already hid the window via focus loss.
        Ok(())
    } else {
        show_notes(app)
    }
}

/// Tray/menu „Neue Notiz“: show notes, then ask the notes window to create one.
pub fn request_new_note(app: &AppHandle) -> tauri::Result<()> {
    show_notes(app)?;
    app.emit_to(NOTES, NOTE_CREATE_REQUEST, ())?;
    Ok(())
}

pub fn toggle_buddy(app: &AppHandle) -> tauri::Result<()> {
    let buddy = window(app, BUDDY)?;
    if buddy.is_visible()? {
        buddy.hide()
    } else {
        buddy.show()
    }
}

fn persist_notes_size(app: &AppHandle, notes: &WebviewWindow) {
    if notes.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(size), Ok(scale)) = (notes.inner_size(), notes.scale_factor()) else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let logical = size.to_logical::<f64>(scale);
    let new = WindowSize {
        width: logical.width.round(),
        height: logical.height.round(),
    };
    let result = state::update_settings(app, |s| {
        let mut s = s.clone();
        s.notes_size = Some(new);
        Ok(s)
    });
    if let Err(e) = result {
        log::warn!("failed to persist notes size: {e}");
    }
}

/// Position computed by the "bottom-right" default at startup. It is not
/// persisted (the Moved event caused by placing the window is ignored), so the
/// default rule keeps applying until the user actually moves the buddy.
static AUTO_POSITION: Mutex<Option<WindowPosition>> = Mutex::new(None);

fn persist_buddy_position(app: &AppHandle, pos: WindowPosition) {
    if *lock(&AUTO_POSITION) == Some(pos) {
        return;
    }
    let result = state::update_settings(app, |s| {
        let mut s = s.clone();
        s.buddy_position = Some(pos);
        Ok(s)
    });
    if let Err(e) = result {
        log::warn!("failed to persist buddy position: {e}");
    }
}

/// Persists geometry synchronously (used right before quitting, so a move within
/// the last 300 ms or an unsaved notes resize is not lost).
pub fn persist_geometry_now(app: &AppHandle) {
    if let Some(buddy) = app.get_webview_window(BUDDY)
        && let Ok(p) = buddy.outer_position()
        && p.x > MINIMIZED_COORD
    {
        persist_buddy_position(app, WindowPosition { x: p.x, y: p.y });
    }
    if let Some(notes) = app.get_webview_window(NOTES)
        && notes.is_visible().unwrap_or(false)
    {
        persist_notes_size(app, &notes);
    }
}

/// Installs the 300 ms debounced persistence for `WindowEvent::Moved` of the buddy.
pub fn init_buddy_move_persistence(app: &AppHandle) {
    let handle = app.clone();
    let debouncer = Debouncer::new(BUDDY_MOVE_DEBOUNCE, move |pos: WindowPosition| {
        persist_buddy_position(&handle, pos);
    });
    if let Some(state) = state::try_app_state(app) {
        *lock(&state.buddy_moves) = Some(debouncer);
    }
}

static CREATING_SETTINGS: AtomicBool = AtomicBool::new(false);

/// Focuses the settings window or creates it on demand.
pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        if w.is_minimized().unwrap_or(false) {
            w.unminimize()?;
        }
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    if CREATING_SETTINGS.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Window creation must not happen on the main thread from a sync command or
    // event handler (WebView2 deadlock on Windows), so build on a helper thread.
    let app = app.clone();
    std::thread::spawn(move || {
        let result =
            WebviewWindowBuilder::new(&app, SETTINGS, WebviewUrl::App("settings.html".into()))
                .title("Einstellungen – Display Buddy")
                .inner_size(520.0, 640.0)
                .min_inner_size(420.0, 480.0)
                // The notes window is always on top; keep settings above it while open.
                .always_on_top(true)
                .resizable(true)
                .center()
                .focused(true)
                .build();
        CREATING_SETTINGS.store(false, Ordering::SeqCst);
        match result {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => log::error!("failed to create settings window: {e}"),
        }
    });
    Ok(())
}

/// Native context menu on the buddy window (decision D-10).
pub fn show_buddy_menu(app: &AppHandle) -> tauri::Result<()> {
    let buddy = window(app, BUDDY)?;
    let new_note = MenuItem::with_id(app, MENU_NEW_NOTE, "Neue Notiz", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Einstellungen", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_note, &settings, &separator, &quit])?;
    buddy.popup_menu(&menu)
}

/// Handles buddy-menu ids; returns false for ids it does not own.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let result = match id {
        MENU_NEW_NOTE => request_new_note(app),
        MENU_SETTINGS => open_settings(app),
        MENU_QUIT => {
            crate::quit::request_quit(app);
            Ok(())
        }
        _ => return false,
    };
    if let Err(e) = result {
        log::warn!("menu action {id} failed: {e}");
    }
    true
}

/// Global window-event hook (registered in `lib.rs`).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (BUDDY, WindowEvent::Moved(pos)) => {
            if pos.x <= MINIMIZED_COORD && pos.y <= MINIMIZED_COORD {
                return;
            }
            // Fired during window creation, before setup registered the state.
            let Some(state) = state::try_app_state(app) else {
                return;
            };
            if let Some(d) = lock(&state.buddy_moves).as_ref() {
                d.push(WindowPosition { x: pos.x, y: pos.y });
            }
        }
        // The buddy must never be destroyed (e.g. Alt+F4 while it has focus).
        (BUDDY, WindowEvent::CloseRequested { api, .. }) => api.prevent_close(),
        (NOTES, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            if let Err(e) = hide_notes(app) {
                log::warn!("hide notes on close failed: {e}");
            }
        }
        (NOTES, WindowEvent::Focused(false)) => {
            let Some(app_state) = state::try_app_state(app) else {
                return;
            };
            let s = state::current_settings(app);
            let quitting = app_state.quit.is_quitting();
            if s.hide_notes_on_blur
                && !s.notes_pinned
                && !quitting
                && window.is_visible().unwrap_or(false)
            {
                state::mark_blur_hide(app);
                if let Err(e) = hide_notes(app) {
                    log::warn!("hide notes on blur failed: {e}");
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: Rect = Rect::new(0, 0, 1920, 1080);
    const WORK: Rect = Rect::new(0, 0, 1920, 1040); // taskbar at the bottom

    #[test]
    fn rect_contains_is_half_open() {
        assert!(FHD.contains(0, 0));
        assert!(FHD.contains(1919, 1079));
        assert!(!FHD.contains(1920, 500));
        assert!(!FHD.contains(-1, 500));
    }

    #[test]
    fn point_on_monitors() {
        let left = Rect::new(-1920, 0, 1920, 1080);
        let monitors = [FHD, left];
        assert!(point_on_any_monitor(100, 100, &monitors));
        assert!(point_on_any_monitor(-100, 100, &monitors));
        assert!(!point_on_any_monitor(-100, 100, &[FHD])); // second monitor unplugged
        assert!(!point_on_any_monitor(100, 2000, &monitors));
        assert!(!point_on_any_monitor(0, 0, &[]));
    }

    #[test]
    fn default_position_bottom_right_with_margin() {
        assert_eq!(
            default_buddy_position(WORK, (96, 96), 24),
            (1920 - 24 - 96, 1040 - 24 - 96)
        );
        let offset = Rect::new(1920, -200, 2560, 1400);
        assert_eq!(
            default_buddy_position(offset, (144, 144), 36),
            (1920 + 2560 - 36 - 144, -200 + 1400 - 36 - 144)
        );
        // tiny work area: never left/above of it
        assert_eq!(
            default_buddy_position(Rect::new(10, 10, 50, 50), (96, 96), 24),
            (10, 10)
        );
    }

    #[test]
    fn notes_left_of_buddy_when_it_fits() {
        let buddy = Rect::new(1800, 920, 96, 96);
        let (x, y) = compute_notes_position(buddy, (420, 520), WORK, 12);
        assert_eq!(x, 1800 - 12 - 420);
        assert_eq!(y, 920 + 96 - 520, "bottom aligned");
    }

    #[test]
    fn notes_right_of_buddy_when_left_does_not_fit() {
        let buddy = Rect::new(100, 600, 96, 96);
        let (x, y) = compute_notes_position(buddy, (420, 520), WORK, 12);
        assert_eq!(x, 100 + 96 + 12);
        assert_eq!(y, 600 + 96 - 520);
    }

    #[test]
    fn notes_exactly_fitting_left_edge() {
        let buddy = Rect::new(432, 600, 96, 96);
        assert_eq!(compute_notes_position(buddy, (420, 520), WORK, 12).0, 0);
    }

    #[test]
    fn notes_clamped_vertically() {
        // buddy near top → bottom alignment would go above the work area
        let buddy = Rect::new(1800, 10, 96, 96);
        assert_eq!(compute_notes_position(buddy, (420, 520), WORK, 12).1, 0);
        // buddy partially below the work area → clamp to work-area bottom
        let buddy = Rect::new(1800, 1030, 96, 96);
        assert_eq!(
            compute_notes_position(buddy, (420, 520), WORK, 12).1,
            1040 - 520
        );
    }

    #[test]
    fn notes_neither_side_fits_is_clamped() {
        let small = Rect::new(0, 0, 800, 600);
        let buddy = Rect::new(352, 400, 96, 96);
        let (x, y) = compute_notes_position(buddy, (420, 520), small, 12);
        assert!(x >= 0 && x + 420 <= 800, "{x}");
        assert!(y >= 0 && y + 520 <= 600, "{y}");
        // larger than the work area → pinned to its top-left
        assert_eq!(compute_notes_position(buddy, (900, 700), small, 12), (0, 0));
    }

    #[test]
    fn notes_on_secondary_monitor_with_negative_coords() {
        let work = Rect::new(-1920, 0, 1920, 1040);
        let buddy = Rect::new(-1900, 900, 96, 96);
        let (x, y) = compute_notes_position(buddy, (420, 520), work, 12);
        assert_eq!(x, -1900 + 96 + 12);
        assert_eq!(y, 900 + 96 - 520);
    }

    #[test]
    fn resize_keeps_center() {
        let old = Rect::new(1000, 500, 96, 96);
        let (x, y) = resize_keep_center(old, (192, 192));
        assert_eq!((x, y), (952, 452));
        assert_eq!(Rect::new(x, y, 192, 192).center(), old.center());
        assert_eq!(resize_keep_center(old, (96, 96)), (1000, 500));
        assert_eq!(
            resize_keep_center(Rect::new(-500, -20, 48, 48), (96, 96)),
            (-524, -44)
        );
    }

    #[test]
    fn notes_size_falls_back_for_unrealized_window() {
        assert_eq!(notes_physical_size(Some((0.0, 0.0)), 1.0), (420, 520));
        assert_eq!(notes_physical_size(None, 1.5), (630, 780));
    }

    #[test]
    fn notes_size_scales_to_target_monitor_and_respects_minimum() {
        assert_eq!(notes_physical_size(Some((500.0, 600.0)), 1.5), (750, 900));
        assert_eq!(notes_physical_size(Some((100.0, 100.0)), 1.0), (320, 360));
    }
}
