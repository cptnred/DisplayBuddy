/**
 * Typed wrappers around Tauri `invoke()` and events.
 * This is the ONLY module allowed to import from "@tauri-apps/api/core" / "event".
 * Contract: see docs/PLAN.md §4/§5.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EVENTS, type Note, type Settings } from "../types";

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

  // ---- events --------------------------------------------------------------
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>(EVENTS.settingsChanged, (e) => cb(e.payload)),
  onNotesShown: (cb: () => void) => listen(EVENTS.notesShown, () => cb()),
  onNotesHidden: (cb: () => void) => listen(EVENTS.notesHidden, () => cb()),
  onNoteCreateRequest: (cb: () => void) => listen(EVENTS.noteCreateRequest, () => cb()),
  onFlushRequest: (cb: () => void) => listen(EVENTS.flushRequest, () => cb()),
};

export type Api = typeof api;
