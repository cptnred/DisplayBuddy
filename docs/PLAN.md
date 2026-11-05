# Display Buddy – Plan & Interface Contract (v1)

This document is the **binding contract** for all contributors (incl. sub-agents).
Shared files (`src/types.ts`, `src/lib/api.ts`, `src-tauri/tauri.conf.json`,
`src-tauri/capabilities/*`, `src-tauri/build.rs`) are owned by the orchestrator.
Sub-agents only **read** them. If a change is needed, report it as a "contract deviation".

## 1. Versions (verified against npm / crates.io on 2026-11-05)

| Package | Version |
|---|---|
| tauri / tauri-build | 2.12.5 / 2.7.4 |
| @tauri-apps/cli, @tauri-apps/api | 2.12.4 |
| tauri-plugin-single-instance | 2.5.5 |
| tauri-plugin-autostart | 2.7.0 (Rust-side only) |
| tauri-plugin-global-shortcut | 2.4.1 (Rust-side only) |
| React / react-dom | 18.3.1 (pinned, per brief) |
| TipTap (`@tiptap/*`) | 3.32.3 |
| Vite / Vitest | 8.3.6 / 5.1.0 |

TipTap 3 notes: `StarterKit` already contains Bold, Italic, **Underline**, Strike, BulletList,
OrderedList, ListItem, ListKeymap, Undo/Redo. `TaskList`/`TaskItem` come from
`@tiptap/extension-list`. `TextStyle`, `Color`, **`FontSize`** come from
`@tiptap/extension-text-style` (official FontSize – no custom extension needed).

## 2. Folder structure

```
buddy.html notes.html settings.html      # one Vite entry per window (buddy never loads TipTap)
src/
  types.ts                 # shared types + defaults + event names (contract)
  lib/api.ts               # typed invoke()/listen() wrappers (contract) – ONLY place using @tauri-apps/api core/event
  lib/carousel.ts          # pure carousel logic (tested)
  lib/debounce.ts          # (integration) keyed debouncer for autosave
  styles/base.css          # global base styles
  test/setup.ts            # vitest setup (jest-dom, cleanup)
  windows/buddy/           # main.tsx, BuddyApp.tsx, Smiley.tsx (exported for settings preview), dragClick.ts
  windows/notes/           # main.tsx, NotesApp.tsx, Carousel.tsx, NoteCard.tsx, TitleBar.tsx, useNotesStore.ts
  windows/settings/        # main.tsx, SettingsApp.tsx (integration phase)
  components/editor/       # NoteEditor.tsx, Toolbar.tsx, extensions.ts, editor.module.css
src-tauri/src/
  main.rs                  # calls display_buddy_lib::run()
  lib.rs                   # builder, plugins, setup, invoke_handler
  model.rs                 # Note, Settings, BuddyConfig … (serde, camelCase)
  storage/mod.rs           # Storage (pure Rust, no Tauri types) – atomic writes, corrupt handling
  commands/mod.rs          # notes.rs, settings.rs, windows.rs (#[tauri::command] fns)
  windows.rs               # window creation/positioning helpers, monitor checks
  tray.rs                  # tray icon + menu
  quit.rs                  # flush-on-quit handshake
```

Styling: **CSS Modules** (`*.module.css`) + one global `base.css`. No Tailwind.

## 3. Data model

TypeScript: see `src/types.ts` (authoritative). Rust mirror (`src-tauri/src/model.rs`):

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NoteColor { Yellow, Pink, Blue, Green, Purple, Orange }   // default Yellow

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,                 // uuid v4; validated with uuid::Uuid::parse_str before any FS use
    #[serde(default)] pub title: String,
    #[serde(default)] pub color: NoteColor,
    pub content: serde_json::Value, // TipTap JSON, stored verbatim
    pub created_at: String,         // ISO-8601, set by frontend
    pub updated_at: String,
    #[serde(default = "one")] pub schema_version: u32,
}

#[serde(rename_all = "lowercase")] pub enum EyeStyle { Round, Lines, Hearts }
#[serde(rename_all = "lowercase")] pub enum MouthStyle { Smile, Wide, Neutral }

#[serde(rename_all = "camelCase", default)]
pub struct BuddyConfig { face_color: String, eye_style, mouth_style, size: u32 /*48..=192*/,
                         opacity: f64 /*0.3..=1*/, animate: bool, animation_speed: f64 /*0.5..=2*/ }

#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    schema_version: u32, buddy: BuddyConfig,
    buddy_position: Option<WindowPosition>,   // { x: i32, y: i32 } physical px
    notes_size: Option<WindowSize>,           // { width: f64, height: f64 } logical px
    autostart: bool, active_note_id: Option<String>,
    notes_pinned: bool, hide_notes_on_blur: bool, global_shortcut: bool,
}
```
Defaults identical to `DEFAULT_SETTINGS` in `types.ts`. `Settings::sanitized()` clamps
size/opacity/speed into range and validates `face_color` (`#RRGGBB`, else default).
Unknown/missing fields → defaults (`#[serde(default)]`), so old files keep loading.

## 4. Storage layout & rules

Root = `app.path().app_data_dir()` → on Windows `%APPDATA%\de.displaybuddy.desktop\` (never hard-coded).

```
settings.json
notes/index.json        # ["uuid", …]  (order)
notes/<uuid>.json       # Note
```

* **Atomic write:** write `<file>.tmp`, `sync_all`, then `rename` over target (rename replaces on Windows via `std::fs::rename`, which uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`).
* **Corrupt JSON:** rename to `<file>.corrupt` (if exists: `<file>.<unix_ts>.corrupt`), `log::warn!`, continue with default / skip note.
* `list_notes`: read index; drop ids whose file is missing or corrupt; append orphan `*.json` files (valid uuid names) not in index (sorted by `createdAt`); if result differs from index, rewrite index.
* `save_note`: validate uuid; write file; if id not in index → append and save index.
* `delete_note`: remove file (missing = ok) and id from index.
* `save_order(ids)`: keep only valid uuids with existing files, de-duplicate, then append any existing notes missing from `ids` (never lose a note through a bad order).
* All storage functions live in `storage::Storage { root: PathBuf }` with **no Tauri dependency** → unit-testable with `tempfile`. Wrapped in `Mutex<Storage>` in Tauri state (serialises all writes → no interleaving).

## 5. Rust commands (exact names; args camelCase on JS side)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `list_notes` | – | `Vec<Note>` | ordered |
| `load_note` | `id: String` | `Note` | Err if missing/invalid |
| `save_note` | `note: Note` | `Note` | |
| `delete_note` | `id: String` | `()` | |
| `save_order` | `ids: Vec<String>` | `()` | |
| `load_settings` | – | `Settings` | |
| `save_settings` | `patch: serde_json::Value` | `Settings` | JSON-merge patch (objects merged recursively, `buddy` nested), sanitize, persist, **emit `settings-changed` to all windows**, apply side effects: buddy window size = `buddy.size` (logical), global shortcut on/off |
| `get_autostart` | – | `bool` | from autostart plugin |
| `set_autostart` | `enabled: bool` | `bool` | enable/disable plugin, update settings.autostart + tray check item, emit settings-changed |
| `toggle_notes` | – | `()` | visible → hide (see hide); hidden → position next to buddy, show, focus, emit `notes-shown` |
| `show_notes` | – | `()` | |
| `hide_notes` | – | `()` | emit `notes-hidden` to notes **before** hiding; store notes size |
| `open_settings` | – | `()` | create `settings` window on demand (normal decorated window, 520×640, centered) or focus existing |
| `show_buddy_menu` | – | `()` | native popup menu on buddy window: „Neue Notiz“, „Einstellungen“, „Beenden“ |
| `flush_done` | – | `()` | notes window confirms flush on quit |
| `quit_app` | – | `()` | flush handshake then exit |

All commands return `Result<T, String>` (error string is German-free technical text; UI shows generic German message).

## 6. Events

| Name | Direction | Payload |
|---|---|---|
| `settings-changed` | Rust → all | `Settings` |
| `notes-shown` | Rust → notes | – |
| `notes-hidden` | Rust → notes | – (flush autosave) |
| `note-create-request` | Rust → notes | – (tray/menu „Neue Notiz“; Rust shows notes first) |
| `flush-request` | Rust → notes | – (on quit; notes saves everything then calls `flush_done`; Rust exits after `flush_done` or 1500 ms timeout) |

## 7. Windows

| Label | Created | Config |
|---|---|---|
| `buddy` | tauri.conf (hidden) | 96×96 (resized to `buddy.size`), no decorations, transparent, alwaysOnTop, skipTaskbar, not resizable, no shadow, `focus:false`. Rust positions it in setup (saved position if it lies on any monitor, else bottom-right of primary monitor work area with 24 px margin) and then shows it. |
| `notes` | tauri.conf (hidden) | 420×520, min 320×360, no decorations (own title bar with `data-tauri-drag-region` / `startDragging`), alwaysOnTop, skipTaskbar, resizable. Shown/hidden only, never re-created. |
| `settings` | on demand (Rust `WebviewWindowBuilder`) | `settings.html`, decorated, 520×640, resizable, normal z-order, in taskbar. |

Notes placement (Rust, `windows.rs`, pure helper `compute_notes_position(buddy_rect, notes_size, work_area) -> (x, y)` unit-tested): prefer left of the buddy if it fits, else right, gap 12 px; vertically align bottom of notes with bottom of buddy, clamped into the work area of the monitor the buddy is on.

Buddy position persistence: Rust listens to `WindowEvent::Moved` of `buddy`, debounces 300 ms (spawned thread / timestamp check), saves `buddyPosition` (physical px). Off-screen check at startup: position valid if the buddy's centre lies inside any monitor's rect.

Focus loss on notes: if `hideNotesOnBlur && !notesPinned` → hide_notes. Default: stays open.

Tray (`tray.rs`): icon = app icon; tooltip „Display Buddy“; menu: „Notizen öffnen“, „Neue Notiz“, „Buddy ein-/ausblenden“, „Einstellungen“, separator, „Mit Windows starten“ (CheckMenuItem), separator, „Beenden“. Left-click on tray icon toggles notes.

Single instance: second launch → `show_notes` on the running instance.
Global shortcut (Rust-side plugin): `Ctrl+Alt+N` toggles notes, registered if `globalShortcut`.
Autostart: plugin initialised Rust-side (`MacosLauncher::LaunchAgent`, args `["--autostart"]`); state read via `app.autolaunch()`.

Optional (only after core): click-through for transparent corners (polling thread ~30 ms + `set_ignore_cursor_events`).

## 8. Frontend component contracts

### Buddy (`src/windows/buddy/`)
* `Smiley.tsx`: `export function Smiley(props: { config: BuddyConfig; hovered?: boolean; hopping?: boolean; preview?: boolean })` – pure SVG, CSS-Module animations (transform/opacity only). Respects `config.animate`, `animationSpeed` (CSS var `--speed`), `prefers-reduced-motion`. Opacity applied via CSS. Blink scheduler random 3–7 s (disabled when not animating).
* `dragClick.ts`: pure `createDragClickTracker({ threshold = 4 })` with `down(x,y)`, `move(x,y) → "drag" | null` (returns "drag" exactly once when distance > threshold), `up() → "click" | "none"`. Tested.
* `BuddyApp.tsx`: loads settings (`api.loadSettings`), listens to `api.onSettingsChanged`; pointerdown/move/up → `getCurrentWindow().startDragging()` on drag, `api.toggleNotes()` on click; `contextmenu` → `api.showBuddyMenu()` (preventDefault). Keyboard: buddy has `role="button"`, `aria-label="Display Buddy – Notizen öffnen"`, Enter/Space → toggle. (Exception to the api.ts rule: `getCurrentWindow` from `@tauri-apps/api/window` is allowed here.)

### Editor (`src/components/editor/`)
* `extensions.ts`: `export function createExtensions(): Extensions` – StarterKit (link/code/codeBlock/blockquote/heading/horizontalRule disabled), TextStyle, Color, FontSize, TaskList, TaskItem `{ nested: true }`. Used by NoteEditor **and** by notes previews (`generateHTML`).
* `NoteEditor.tsx`: `export function NoteEditor(props: { content: JSONContent | null; onChange: (doc: JSONContent) => void; autoFocus?: boolean; placeholder?: string })`. Uncontrolled after mount (content only read on mount; parent remounts with `key={note.id}`). No storage knowledge. Must **not** swallow `Ctrl+ArrowLeft/Right` (`Ctrl+Shift+Arrow` too) – these bubble to the notes window for carousel navigation.
* `Toolbar.tsx`: buttons with German `aria-label` + `title`; font size select 12/14/16/18/24/32 px; colour palette 8 colours + „Farbe entfernen“; lists; undo/redo. Keyboard reachable (roving or plain tab order).
* Shortcuts: Ctrl+B/I/U (TipTap default), Ctrl+Shift+7/8/9 (ordered/bullet/task), Tab/Shift+Tab nest/lift in lists.
* Checked task items: line-through + reduced opacity.

### Carousel / Notes (`src/lib/carousel.ts`, `src/windows/notes/`)
`carousel.ts` (pure, no React):
```ts
export function normalizeIndex(i: number, n: number): number;           // ((i % n) + n) % n; n=0 → 0
export function circularOffset(index: number, active: number, n: number): number; // shortest signed distance
export interface Slot { index: number; offset: number }                // offset -2..2
export function visibleSlots(n: number, active: number, radius?: number): Slot[]; // no duplicates; n=1 → [0]; n=2 → active + other at +1
export function step(active: number, delta: number, n: number): number;
export function insertAfter<T>(items: T[], active: number, item: T): { items: T[]; active: number };
export function removeAt<T>(items: T[], index: number): { items: T[]; active: number }; // active → the next note (wraps), -1/0 when empty
export function move<T>(items: T[], index: number, delta: -1 | 1): { items: T[]; active: number }; // reorder with wraparound
export function indicatorLabel(active: number, n: number): string;      // "3 / 7", "0 / 0"
```
`Carousel.tsx`: generic presentation `({ items, activeIndex, onSelect, renderActive, renderPreview })`; cards keyed by id; CSS transforms by offset (coverflow); hidden `±2` cards for seamless wrap; wheel over side cards → step; click side card → select; arrow buttons with aria-labels; indicator „3 / 7“.
`useNotesStore.ts` + `NotesApp.tsx` + `TitleBar.tsx`: state management against `api` (mocked in tests). Title = **separate input field** above the editor (decision D-05). Note colour picker (6 pastels). Buttons „+ Neue Notiz“, „Löschen“ (confirm dialog), „Anheften“, „Schließen“ (→ `api.hideNotes()`), Esc hides. Ctrl+←/→ navigate, Ctrl+Shift+←/→ reorder active note. Empty state „Erste Notiz anlegen“.

Autosave (store): per-note debounce 500 ms keyed by note id; pending saves are flushed when switching active note, on `notes-hidden`, on `flush-request`, on `beforeunload`. Saves are serialized per note (latest wins; never write an older snapshot after a newer one).

## 9. Testing
* Frontend: `npm test` (Vitest + Testing Library, jsdom). Mock `../lib/api` with `vi.mock`.
* Rust: `cargo test` (storage with `tempfile`, merge/sanitize, placement math, monitor checks).
* Lint: `cargo clippy --all-targets -- -D warnings`; `npm run build` (tsc strict).
* Windows cross-check: `cargo xwin clippy --target x86_64-pc-windows-msvc`.
