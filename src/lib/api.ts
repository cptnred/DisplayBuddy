/**
 * Typed wrappers around Tauri `invoke()` and events.
 * This is the ONLY module allowed to import from "@tauri-apps/api/core" / "event".
 * Contract: see docs/PLAN.md §4/§5.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENTS,
  type AccountInfo,
  type AccountRegistered,
  type DeviceInfo,
  type Note,
  type NotesChangedPayload,
  type PairingInfo,
  type PairingStatus,
  type Reminder,
  type ReminderRepeat,
  type Settings,
  type ShortcutList,
  type ShortcutsData,
  type SkinData,
  type ServerInfo,
  type SkinInfo,
  type SyncStatus,
} from "../types";

/** Links of ServerInfo.legal that account_open_link can open. */
export type LegalLinkKind = "imprint" | "privacy" | "terms";

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
  /** `section` "account" scrolls to „Konto & Handy“ (v4). */
  openSettings: (section: "account" | null = null) => invoke<void>("open_settings", { section }),
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
   * Registers this PC at the server and unites local data with it. `serverUrl` "" = standard
   * server (v4). Rejects with a string starting with a code: invalid_url, invalid_input,
   * unauthorized, offline, protocol, keyring, not_ready, a server code (too_many_requests,
   * device_limit, account_disabled, …) or server.
   */
  syncConnect: (serverUrl: string, username: string, password: string, deviceName: string) =>
    invoke<SyncStatus>("sync_connect", { serverUrl, username, password, deviceName }),
  /** Signs out at the server (best effort), deletes the token and the outbox. */
  syncDisconnect: () => invoke<SyncStatus>("sync_disconnect"),
  /** Starts a sync right away; returns the current status. */
  syncNow: () => invoke<SyncStatus>("sync_now"),

  // ---- v4: account & QR pairing (PLAN_V4 §7.1; errors "code: detail") ----------------
  /** GET /info of the server ("" = standard); 404 → "server_too_old". */
  accountServerInfo: (serverUrl: string) => invoke<ServerInfo>("account_server_info", { serverUrl }),
  /** Proof-of-work + POST /accounts, then connected like syncConnect. */
  accountRegister: (serverUrl: string, username: string, password: string, deviceName: string, inviteCode: string | null = null) =>
    invoke<AccountRegistered>("account_register", { serverUrl, username, password, deviceName, inviteCode }),
  accountRecover: (serverUrl: string, username: string, recoveryCode: string, newPassword: string, deviceName: string) =>
    invoke<AccountRegistered>("account_recover", { serverUrl, username, recoveryCode, newPassword, deviceName }),
  accountInfo: () => invoke<AccountInfo>("account_info"),
  accountDevices: () => invoke<DeviceInfo[]>("account_devices"),
  /** Returns the device list afterwards; older devices need the password (password_required). */
  accountRevokeDevice: (deviceId: string, password: string | null = null) =>
    invoke<DeviceInfo[]>("account_revoke_device", { deviceId, password }),
  /** `currentPassword` null = „Ich kenne mein aktuelles Passwort nicht“; other devices are signed out. */
  accountChangePassword: (currentPassword: string | null, newPassword: string) =>
    invoke<void>("account_change_password", { currentPassword, newPassword }),
  accountNewRecoveryCode: (password: string) => invoke<string>("account_new_recovery_code", { password }),
  /** Save dialog in Rust; path of the file or null if cancelled. */
  accountExport: () => invoke<string | null>("account_export"),
  accountDelete: (password: string, confirmUsername: string) =>
    invoke<SyncStatus>("account_delete", { password, confirmUsername }),
  accountOpenLink: (kind: LegalLinkKind) => invoke<void>("account_open_link", { kind }),
  pairingStart: () => invoke<PairingInfo>("pairing_start"),
  pairingStatus: (pairingId: string) => invoke<PairingStatus>("pairing_status", { pairingId }),
  pairingCancel: (pairingId: string) => invoke<void>("pairing_cancel", { pairingId }),

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
  onSettingsSection: (cb: (section: string) => void) =>
    listen<string>(EVENTS.settingsSection, (e) => cb(e.payload)),
};

export type Api = typeof api;
