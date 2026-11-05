//! Optional click-through for the transparent corners of the buddy window.
//!
//! A polling thread (~30 ms) compares the global cursor position with the
//! circle inscribed in the buddy window. Only when the cursor is inside the
//! window **and** outside that circle are cursor events ignored, so clicks in
//! the corners reach the window below. Fail-safe: whenever anything cannot be
//! determined (window hidden, API error, cursor outside), the window is made
//! clickable again, and the thread resets it on exit.
//!
//! Opt-in via `Settings::click_through` (default off, experimental): while disabled the
//! thread makes no window calls at all and only checks the cached setting every 250 ms.
//!
//! Windows only – on other platforms `set_ignore_cursor_events` and global cursor
//! positions behave differently, and the app only targets Windows.

use crate::windows::Rect;

/// True if `(x, y)` lies inside the window rect but outside its inscribed circle.
pub fn in_transparent_corner(x: f64, y: f64, rect: Rect) -> bool {
    let (w, h) = (rect.width as f64, rect.height as f64);
    if w <= 0.0 || h <= 0.0 {
        return false;
    }
    let inside =
        x >= rect.x as f64 && x < rect.x as f64 + w && y >= rect.y as f64 && y < rect.y as f64 + h;
    if !inside {
        return false;
    }
    let (cx, cy) = (rect.x as f64 + w / 2.0, rect.y as f64 + h / 2.0);
    let r = w.min(h) / 2.0;
    let (dx, dy) = (x - cx, y - cy);
    dx * dx + dy * dy > r * r
}

#[cfg(windows)]
pub fn start(app: &tauri::AppHandle) {
    use std::time::Duration;
    use tauri::Manager;

    use crate::windows::BUDDY;

    const INTERVAL: Duration = Duration::from_millis(30);
    const IDLE_INTERVAL: Duration = Duration::from_millis(250);

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("clickthrough".into())
        .spawn(move || {
            struct Reset(Option<tauri::WebviewWindow>);
            impl Drop for Reset {
                fn drop(&mut self) {
                    if let Some(w) = &self.0 {
                        let _ = w.set_ignore_cursor_events(false);
                    }
                }
            }

            let Some(buddy) = app.get_webview_window(BUDDY) else {
                return;
            };
            let _reset = Reset(Some(buddy.clone()));
            let mut ignoring = false;
            loop {
                let Some(state) = crate::state::try_app_state(&app) else {
                    std::thread::sleep(IDLE_INTERVAL);
                    continue;
                };
                if state.quit.is_quitting() {
                    break;
                }
                if !crate::state::current_settings(&app).click_through {
                    if ignoring {
                        let _ = buddy.set_ignore_cursor_events(false);
                        ignoring = false;
                    }
                    std::thread::sleep(IDLE_INTERVAL);
                    continue;
                }
                std::thread::sleep(INTERVAL);
                let want = (|| -> Option<bool> {
                    if !buddy.is_visible().ok()? {
                        return Some(false);
                    }
                    let p = buddy.outer_position().ok()?;
                    let s = buddy.outer_size().ok()?;
                    let c = app.cursor_position().ok()?;
                    let rect = Rect::new(p.x, p.y, s.width as i32, s.height as i32);
                    Some(in_transparent_corner(c.x, c.y, rect))
                })()
                .unwrap_or(false);
                if want != ignoring {
                    match buddy.set_ignore_cursor_events(want) {
                        Ok(()) => ignoring = want,
                        Err(e) => {
                            log::warn!("click-through disabled: {e}");
                            break;
                        }
                    }
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("could not start click-through thread: {e}");
    }
}

#[cfg(not(windows))]
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    const R: Rect = Rect::new(100, 200, 96, 96);

    #[test]
    fn centre_and_face_are_clickable() {
        assert!(!in_transparent_corner(148.0, 248.0, R));
        assert!(!in_transparent_corner(100.5, 248.0, R)); // left edge midpoint
        assert!(!in_transparent_corner(148.0, 295.0, R)); // bottom edge midpoint
    }

    #[test]
    fn corners_are_transparent() {
        assert!(in_transparent_corner(101.0, 201.0, R));
        assert!(in_transparent_corner(195.0, 201.0, R));
        assert!(in_transparent_corner(101.0, 295.0, R));
        assert!(in_transparent_corner(195.0, 295.0, R));
    }

    #[test]
    fn outside_window_is_never_ignored() {
        assert!(!in_transparent_corner(99.0, 199.0, R));
        assert!(!in_transparent_corner(196.0, 250.0, R));
        assert!(!in_transparent_corner(0.0, 0.0, Rect::new(0, 0, 0, 0)));
    }
}
