/**
 * Typed wrappers around Tauri `invoke()` and events.
 * This is the ONLY module allowed to import from "@tauri-apps/api/core" / "event".
 * Contract: see docs/PLAN.md §4/§5.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENTS,
  type Note,
  type NotesChangedPayload,
  type Reminder,
  type ReminderRepeat,
  type Settings,
  type ShortcutList,
  type ShortcutsData,
  type SkinData,
  type SkinInfo,
  type SyncStatus,
} from "../types";

/** Deep-partial patch for save_settings (only `buddy` is nested). */
export type SettingsPatch = Partial<Omit<Settings, "buddy" | "schemaVersion">> & {
  buddy?: Partial<Settings["buddy"]>;
};

export const api = {
  // ---- notes storage -------------------------------------------------------
  /** All notes in stored order (index.json); orphans appended, missing ids dropped. */
  listNotes: () => invoke<Note[]>("list_notes"),
  loadNote: (id: string) => invoke<Note>("load_note", { id }),
  /** Writes notes/<id>.json atomically. Appends id to the index if unknown. Returns stored note. */
  saveNote: (note: Note) => invoke<Note>("save_note", { note }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  saveOrder: (ids: string[]) => invoke<void>("save_order", { ids }),

  // ---- settings ------------------------------------------------------------
  loadSettings: () => invoke<Settings>("load_settings"),
  /** Merges the patch into stored settings, persists, emits `settings-changed`, returns result. */
  saveSettings: (patch: SettingsPatch) => invoke<Settings>("save_settings", { patch }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),

  // ---- windows -------------------------------------------------------------
  toggleNotes: () => invoke<void>("toggle_notes"),
  showNotes: () => invoke<void>("show_notes"),
  hideNotes: () => invoke<void>("hide_notes"),
  openSettings: () => invoke<void>("open_settings"),
  /** Pops up the native buddy context menu at the cursor. */
  showBuddyMenu: () => invoke<void>("show_buddy_menu"),
  /** Notes window: answer to `flush-request` once all saves are written. */
  flushDone: () => invoke<void>("flush_done"),
  quitApp: () => invoke<void>("quit_app"),

  // ---- v2: reminders (Rust owns reminders.json + the scheduler) ------------
  listReminders: () => invoke<Reminder[]>("list_reminders"),
  /** Sets/replaces the reminder of a note; `at` = RFC 3339. `at: null` removes it. */
  setReminder: (
    noteId: string,
    at: string | null,
    repeat: ReminderRepeat,
    /** IANA zone of the reminder (v3); null keeps the current one (new: the PC's zone). */
    timeZone: string | null = null,
  ) => invoke<Reminder | null>("set_reminder", { noteId, at, repeat, timeZone }),
  /** „Erledigt“: non-repeating → done; repeating → next occurrence scheduled. */
  ackReminder: (noteId: string) => invoke<Reminder | null>("ack_reminder", { noteId }),
  /** „Später“: reschedule `minutes` from now (state → scheduled). */
  snoozeReminder: (noteId: string, minutes: number) =>
    invoke<Reminder>("snooze_reminder", { noteId, minutes }),
  /** Shows the notes window and emits `open-note` for this note. */
  openNote: (noteId: string) => invoke<void>("open_note", { noteId }),

  // ---- v2: shortcut bar --------------------------------------------------------
  listShortcuts: () => invoke<ShortcutsData>("list_shortcuts"),
  /** Native file/folder picker (Rust side); adds the picked entries to `items`. */
  pickShortcuts: (folder: boolean) => invoke<ShortcutsData>("pick_shortcuts", { folder }),
  /** Adds a web link to `bookmarks` (http/https only; name defaults to host). */
  addBookmark: (name: string, url: string) => invoke<ShortcutsData>("add_bookmark", { name, url }),
  updateShortcut: (id: string, name: string, target?: string) =>
    invoke<ShortcutsData>("update_shortcut", { id, name, target: target ?? null }),
  removeShortcut: (id: string) => invoke<ShortcutsData>("remove_shortcut", { id }),
  reorderShortcuts: (list: ShortcutList, ids: string[]) =>
    invoke<ShortcutsData>("reorder_shortcuts", { list, ids }),
  /** Opens a stored shortcut by id (path via shell, URL in the default browser). */
  openShortcut: (id: string) => invoke<void>("open_shortcut", { id }),
  /** PNG data URL of the file's shell icon (Windows), null if unavailable. Cached by Rust. */
  shortcutIcon: (id: string) => invoke<string | null>("shortcut_icon", { id }),

  // ---- v2: skins ---------------------------------------------------------------------
  listSkins: () => invoke<SkinInfo[]>("list_skins"),
  /** Native file picker (png/svg/gif/webp/json ≤ 5 MB); null if cancelled. */
  importSkin: () => invoke<SkinInfo | null>("import_skin"),
  deleteSkin: (id: string) => invoke<void>("delete_skin", { id }),
  loadSkin: (id: string) => invoke<SkinData>("load_skin", { id }),

  // ---- v3: sync with the own server (Rust owns the HTTP client and the token) --------
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  /**
   * Registers this PC at the server and unites local data with it. Rejects with a
   * string starting with a code: invalid_url, invalid_input, unauthorized, offline,
   * server, protocol, keyring, not_ready.
   */
  syncConnect: (serverUrl: string, username: string, password: string, deviceName: string) =>
    invoke<SyncStatus>("sync_connect", { serverUrl, username, password, deviceName }),
  /** Signs out at the server (best effort), deletes the token and the outbox. */
  syncDisconnect: () => invoke<SyncStatus>("sync_disconnect"),
  /** Starts a sync right away; returns the current status. */
  syncNow: () => invoke<SyncStatus>("sync_now"),

  // ---- events --------------------------------------------------------------
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>(EVENTS.settingsChanged, (e) => cb(e.payload)),
  onNotesShown: (cb: () => void) => listen(EVENTS.notesShown, () => cb()),
  onNotesHidden: (cb: () => void) => listen(EVENTS.notesHidden, () => cb()),
  onNoteCreateRequest: (cb: () => void) => listen(EVENTS.noteCreateRequest, () => cb()),
  onFlushRequest: (cb: () => void) => listen(EVENTS.flushRequest, () => cb()),
  onRemindersChanged: (cb: (r: Reminder[]) => void) =>
    listen<Reminder[]>(EVENTS.remindersChanged, (e) => cb(e.payload)),
  onOpenNote: (cb: (noteId: string) => void) =>
    listen<{ noteId: string }>(EVENTS.openNote, (e) => cb(e.payload.noteId)),
  onShortcutsChanged: (cb: (d: ShortcutsData) => void) =>
    listen<ShortcutsData>(EVENTS.shortcutsChanged, (e) => cb(e.payload)),
  onShortcutDrag: (cb: (state: "enter" | "leave" | "drop") => void) =>
    listen<{ state: "enter" | "leave" | "drop" }>(EVENTS.shortcutDrag, (e) => cb(e.payload.state)),
  onSkinsChanged: (cb: (s: SkinInfo[]) => void) =>
    listen<SkinInfo[]>(EVENTS.skinsChanged, (e) => cb(e.payload)),
  onSyncStatus: (cb: (s: SyncStatus) => void) => listen<SyncStatus>(EVENTS.syncStatus, (e) => cb(e.payload)),
  onNotesChanged: (cb: (p: NotesChangedPayload) => void) =>
    listen<NotesChangedPayload>(EVENTS.notesChanged, (e) => cb(e.payload)),
};

export type Api = typeof api;
