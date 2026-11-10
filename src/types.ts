/**
 * Shared data contract between the frontend and the Rust backend.
 * Mirrors the serde structs in `src-tauri/src/model.rs` (camelCase on the wire).
 * DO NOT change without updating docs/PLAN.md and the Rust side.
 */
import type { JSONContent } from "@tiptap/core";

export const NOTE_SCHEMA_VERSION = 1;
export const SETTINGS_SCHEMA_VERSION = 1;

export type NoteColor = "yellow" | "pink" | "blue" | "green" | "purple" | "orange";

export const NOTE_COLORS: Record<NoteColor, { label: string; value: string }> = {
  yellow: { label: "Gelb", value: "#FFF6C7" },
  pink: { label: "Rosa", value: "#FDE2E7" },
  blue: { label: "Blau", value: "#DCEEFF" },
  green: { label: "Grün", value: "#DDF5E3" },
  purple: { label: "Lila", value: "#ECE3FB" },
  orange: { label: "Orange", value: "#FFE7D1" },
};

export interface Note {
  /** UUID v4, lowercase. Also the file name `notes/<id>.json`. */
  id: string;
  /** Optional title from a separate title input. Empty string = no title. */
  title: string;
  color: NoteColor;
  /** TipTap document JSON (`editor.getJSON()`), type "doc". */
  content: JSONContent;
  /** ISO-8601 UTC timestamps. */
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export type EyeStyle = "round" | "lines" | "hearts";
export type MouthStyle = "smile" | "wide" | "neutral";

/** Built-in skins; any other value is the id (uuid) of an imported custom skin. */
export const BUILTIN_SKINS = ["smiley", "cat", "robot", "ghost"] as const;
export type BuiltinSkin = (typeof BUILTIN_SKINS)[number];

export interface BuddyConfig {
  /** "smiley" | "cat" | "robot" | "ghost" | <uuid of an imported skin>. */
  skin: string;
  /** CSS hex color, e.g. "#FFD54A". Primary colour of built-in skins. */
  faceColor: string;
  eyeStyle: EyeStyle;
  mouthStyle: MouthStyle;
  /** Window/smiley size in logical px, 48..=192. */
  size: number;
  /** 0.3..=1.0 */
  opacity: number;
  /** Animations on/off ("Ruhiger Modus" = false). */
  animate: boolean;
  /** Speed multiplier 0.5..=2.0 (higher = faster). */
  animationSpeed: number;
}

/** Physical pixel position (as reported by Tauri's outer_position). */
export interface WindowPosition {
  x: number;
  y: number;
}

/** Logical size. */
export interface WindowSize {
  width: number;
  height: number;
}

export interface Settings {
  schemaVersion: number;
  buddy: BuddyConfig;
  /** Last buddy position; null = default (bottom-right of primary monitor). */
  buddyPosition: WindowPosition | null;
  /** Last notes window size; null = default 420x520. */
  notesSize: WindowSize | null;
  /** Mirrors the OS autostart registration (source of truth: plugin). */
  autostart: boolean;
  activeNoteId: string | null;
  /** Notes window "Anheften": never hide on focus loss. */
  notesPinned: boolean;
  /** Hide notes window on focus loss unless pinned. Default false. */
  hideNotesOnBlur: boolean;
  /** Global shortcut Ctrl+Alt+N enabled. */
  globalShortcut: boolean;
  /** Experimental: clicks on the transparent corners of the buddy pass through. Default false. */
  clickThrough: boolean;
  /** Reminder: show a Windows toast notification. */
  reminderNotification: boolean;
  /** Reminder: play a sound. */
  reminderSound: boolean;
  /** Shortcut bar under the notes collapsed. */
  shortcutBarCollapsed: boolean;
  /** Active tab of the shortcut bar. */
  shortcutBarTab: ShortcutList;
  /** v3: sync with the own server on. Changed only via sync_connect/sync_disconnect. */
  syncEnabled: boolean;
  /** v3: server address, e.g. "https://buddy.example.org". Empty = not configured. */
  syncServerUrl: string;
  /** v3: name of this PC on the server. The token never lives in settings. */
  syncDeviceName: string;
  /** v4: the account hint card in the notes window was dismissed for good („Nicht mehr zeigen“). */
  accountHintDismissed: boolean;
}

export const DEFAULT_BUDDY: BuddyConfig = {
  skin: "smiley",
  faceColor: "#FFD54A",
  eyeStyle: "round",
  mouthStyle: "smile",
  size: 96,
  opacity: 1,
  animate: true,
  animationSpeed: 1,
};

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  buddy: DEFAULT_BUDDY,
  buddyPosition: null,
  notesSize: null,
  autostart: false,
  activeNoteId: null,
  notesPinned: false,
  hideNotesOnBlur: false,
  globalShortcut: true,
  clickThrough: false,
  reminderNotification: true,
  reminderSound: true,
  shortcutBarCollapsed: false,
  shortcutBarTab: "items",
  syncEnabled: false,
  syncServerUrl: "",
  syncDeviceName: "",
  accountHintDismissed: false,
};

// ---- v2: reminders -----------------------------------------------------------

export type ReminderRepeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";
/** scheduled = waiting; due = fired, not yet acknowledged; done = acknowledged (non-repeating). */
export type ReminderState = "scheduled" | "due" | "done";

export interface Reminder {
  noteId: string;
  /**
   * Absolute next/last fire time, RFC 3339. v3 writes UTC ("2026-11-05T13:30:00.000Z"),
   * older data may carry an offset. Always compare as an instant.
   */
  at: string;
  repeat: ReminderRepeat;
  state: ReminderState;
  /** When it last fired (RFC 3339) or null. */
  firedAt: string | null;
  /** v3: time of the last user action (set/ack/snooze) on the acting device, UTC. Firing does not change it. */
  updatedAt: string | null;
  /** v3: IANA zone in which wall time and repetition apply, e.g. "Europe/Berlin". */
  timeZone: string | null;
}

export const REMINDER_REPEAT_LABELS: Record<ReminderRepeat, string> = {
  none: "Einmalig",
  daily: "Täglich",
  weekdays: "Werktags (Mo–Fr)",
  weekly: "Wöchentlich",
  monthly: "Monatlich",
};

// ---- v2: shortcut bar ----------------------------------------------------------

export type ShortcutList = "items" | "bookmarks";
export type ShortcutKind = "file" | "folder" | "program" | "url";

export interface Shortcut {
  /** uuid v4 */
  id: string;
  kind: ShortcutKind;
  /** Display name (editable). */
  name: string;
  /** Absolute path (file/folder/program) or http(s) URL (url). */
  target: string;
}

export interface ShortcutsData {
  schemaVersion: number;
  /** Files, programs (.exe/.lnk/.bat …), folders – tab „Programme & Ordner“. */
  items: Shortcut[];
  /** Web links – tab „Lesezeichen“. */
  bookmarks: Shortcut[];
}

// ---- v2: skins ---------------------------------------------------------------------

export type SkinKind = "image" | "lottie";

export interface SkinInfo {
  /** uuid v4 (file name in skins/) */
  id: string;
  /** Display name (from the imported file name). */
  name: string;
  kind: SkinKind;
  /** image/png, image/svg+xml, image/gif, image/webp, application/json (lottie) */
  mime: string;
}

export interface SkinData {
  info: SkinInfo;
  /** image: data URL; lottie: the animation JSON as text. */
  data: string;
}

// ---- v3: sync (PLAN_V3_SYNC §8) -------------------------------------------------

export type SyncState = "off" | "idle" | "syncing" | "offline" | "error" | "unauthorized";

/** Payload of sync_status and the `sync-status` event. */
export interface SyncStatus {
  enabled: boolean;
  serverUrl: string;
  deviceName: string;
  state: SyncState;
  /** Last completed sync (UTC) or null. */
  lastSyncAt: string | null;
  /** Changes waiting in the outbox. */
  pending: number;
  /** Technical detail of the last error (UI shows German texts per state). */
  message: string | null;
  /** Median offset to the server clock in ms (positive = PC is behind). Warn above 2 min. */
  clockOffsetMs: number;
}

// ---- v4: accounts and pairing (PLAN_V4 §7.1) ------------------------------------

/** Standard server (D-96); `syncServerUrl = ""` means this one. Same value in model.rs. */
export const DEFAULT_SYNC_SERVER_URL = "https://buddy.pev-point.de";

/** Server messages passed through unchanged by the account/pairing commands. */
export type { AccountInfo, DeviceInfo, PairingStatus, ServerInfo } from "./lib/sync/types";

/** Result of account_register and account_recover. */
export interface AccountRegistered {
  /** Sync status after connecting (like sync_connect). */
  status: SyncStatus;
  /** Normalised 24 chars; shown once in the mandatory dialog (formatRecoveryCode). */
  recoveryCode: string;
}

/** Result of pairing_start. */
export interface PairingInfo {
  pairingId: string;
  /** Normalised 12 chars; displayed with formatCode. */
  code: string;
  /** QR code as SVG markup (EC level M); shown as data:image/svg+xml. */
  qrSvg: string;
  expiresAt: string;
}

/** Payload of `notes-changed` (remote changes merged by the sync). */
export interface NotesChangedPayload {
  notes: Note[];
  deletedIds: string[];
  /** New order if it changed remotely, else null. */
  order: string[] | null;
}

/** Event names (Rust <-> windows). */
export const EVENTS = {
  /** payload: Settings. Emitted by Rust to all windows after save_settings. */
  settingsChanged: "settings-changed",
  /** payload: none. Rust -> notes: window was just shown. */
  notesShown: "notes-shown",
  /** payload: none. Rust -> notes: window is about to be / was hidden; flush saves. */
  notesHidden: "notes-hidden",
  /** payload: none. Rust -> notes: create a new note (tray / buddy menu). */
  noteCreateRequest: "note-create-request",
  /** payload: none. Rust -> notes: app quits; flush all pending saves then call flush_done. */
  flushRequest: "flush-request",
  /** payload: Reminder[] (all). Rust -> all, whenever any reminder changes (set/fire/ack/snooze). */
  remindersChanged: "reminders-changed",
  /** payload: { noteId }. Rust -> notes: show this note (notes window is shown first). */
  openNote: "open-note",
  /** payload: ShortcutsData. Rust -> all after any shortcut change. */
  shortcutsChanged: "shortcuts-changed",
  /** payload: { state: "enter" | "leave" | "drop" }. Rust -> notes: OS file drag over notes window. */
  shortcutDrag: "shortcut-drag",
  /** payload: SkinInfo[]. Rust -> all after import/delete. */
  skinsChanged: "skins-changed",
  /** v3 payload: SyncStatus. Rust -> settings + notes whenever the sync status changes. */
  syncStatus: "sync-status",
  /** v3 payload: NotesChangedPayload. Rust -> notes after merging remote changes. */
  notesChanged: "notes-changed",
  /** v4 payload: section name ("account"). Rust -> settings: open_settings(section) on an open window. */
  settingsSection: "settings-section",
} as const;
