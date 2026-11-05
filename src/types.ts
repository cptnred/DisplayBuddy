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

export interface BuddyConfig {
  /** CSS hex color, e.g. "#FFD54A". */
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
}

export const DEFAULT_BUDDY: BuddyConfig = {
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
};

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
} as const;
