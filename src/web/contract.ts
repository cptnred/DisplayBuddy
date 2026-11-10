/**
 * Contract between the web data layer + sync engine (phase C1: src/web/data,
 * src/web/sync) and the web UI / PWA / native shell (C2: src/web/ui, src/web/notify,
 * src/web/sw.ts, src/web/main.tsx; N1: mobile/, src/web/notify/native*).
 * Owned by the orchestrator (PLAN_V3_SYNC §9.2, §9.3). Changes = contract deviation.
 *
 * Rules: the UI reads ONLY through DataStore (local-first, IndexedDB). Every write is
 * stamped by the store with the corrected device time (src/lib/clock.ts) and lands in
 * the record and the outbox in ONE transaction. Reminder math only via
 * src/lib/schedule.ts / src/lib/zoned.ts. No DOM in data/ and sync/ (usable in the
 * service worker and in the native shell).
 */
import type { Clock } from "../lib/clock";
import type { DeviceKind, DeviceState, RecordKind, ServerInfo } from "../lib/sync/types";
import type { Note, Reminder, ReminderRepeat } from "../types";

export interface Account {
  username: string;
  deviceId: string;
  /** Origin of the server, e.g. "https://buddy.example.org" (PWA: same origin). */
  serverUrl: string;
  /** Account default zone from GET /me (for data without timeZone). */
  timeZone: string | null;
}

/** What changed (delivered to subscribers in this tab and – via BroadcastChannel – other tabs). */
export interface DataChange {
  kind: "notes" | "reminders" | "order" | "account" | "all";
  /** Affected ids (note ids) if known. */
  ids?: string[];
  /** local = this tab, remote = merged from the server, other-tab = BroadcastChannel. */
  source: "local" | "remote" | "other-tab";
}

export interface DataStore {
  /** All live notes in the saved order (notes missing from the order are appended by createdAt). */
  listNotes(): Promise<Note[]>;
  getNote(id: string): Promise<Note | null>;
  /** Stores the note; the store sets updatedAt = corrected now and returns the stored copy. */
  saveNote(note: Note): Promise<Note>;
  /** Tombstone + outbox; also removes the note's reminder (tombstone). */
  deleteNote(id: string): Promise<void>;
  getOrder(): Promise<string[]>;
  saveOrder(ids: string[]): Promise<void>;

  listReminders(): Promise<Reminder[]>;
  getReminder(noteId: string): Promise<Reminder | null>;
  /**
   * Sets/replaces the reminder from a wall time in `timeZone` ("YYYY-MM-DD", "HH:MM";
   * DST gap → next valid minute, fold → earlier). Note must exist.
   */
  setReminder(
    noteId: string,
    wallDate: string,
    wallTime: string,
    timeZone: string,
    repeat: ReminderRepeat,
  ): Promise<Reminder>;
  removeReminder(noteId: string): Promise<void>;
  /** „Erledigt“ (next occurrence in the reminder zone for repeating ones). Null if none. */
  ackReminder(noteId: string): Promise<Reminder | null>;
  /** „10 Min. später“ etc. (1..=1440). */
  snoozeReminder(noteId: string, minutes: number): Promise<Reminder>;
  /**
   * Local "due" transition (service worker on push, UI timer): only if the reminder is
   * still scheduled with exactly this `at` and `at ≤ now`. Does NOT change updatedAt and
   * does NOT enter the outbox (firing is not an edit, D-30). Returns the reminder or null.
   */
  markDue(noteId: string, at: string): Promise<Reminder | null>;

  /** Records waiting in the outbox. */
  pendingCount(): Promise<number>;
  /** Change listener; returns the unsubscribe function. */
  subscribe(listener: (change: DataChange) => void): () => void;

  getAccount(): Promise<Account | null>;
  /** Deletes the local database (the UI asks first if pendingCount() > 0). */
  signOut(): Promise<void>;
  /** The clock used for stamps (offset maintained by the sync engine). */
  readonly clock: Clock;
}

export interface DataStoreOptions {
  /** IndexedDB name, default "display-buddy" (tests use unique names). */
  dbName?: string;
  /** Default: the process-wide clock from src/lib/clock.ts. */
  clock?: Clock;
  /** IndexedDB factory (tests: fake-indexeddb). Default: globalThis.indexedDB. */
  indexedDB?: IDBFactory;
  /** Device zone fallback for reminders without a zone (default: Intl device zone). */
  deviceZone?: () => string;
}

/** Factory exported by src/web/data/index.ts. */
export type OpenDataStore = (options?: DataStoreOptions) => Promise<DataStore>;

// ---- sync engine ---------------------------------------------------------------

export type WebSyncState = "signedOut" | "idle" | "syncing" | "offline" | "error" | "unauthorized";

export interface WebSyncStatus {
  state: WebSyncState;
  pending: number;
  lastSyncAt: string | null;
  clockOffsetMs: number;
  /** |offset| > 2 min → UI shows the clock warning. */
  clockWarning: boolean;
  /**
   * Technical detail (UI shows German texts per state). v4: on `error` the message starts
   * with a server error code where the UI needs its own text: `quota_exceeded` (413, outbox
   * kept), `device_limit` (409), `account_disabled` (403, token kept – the lock is
   * reversible), `content_format_unsupported` (sync stopped, no writes; PLAN_V4 §7.3).
   */
  message: string | null;
}

/** Hints for the UI (German texts are the UI's job). */
export type SyncNotice =
  /** Our copy lost (server newer): server version taken over. */
  | { kind: "stale"; recordKind: RecordKind; id: string }
  /** A note open in the UI was deleted remotely. */
  | { kind: "remoteDeleted"; id: string }
  /** Server asked for a full resync (410); done, outbox kept. */
  | { kind: "fullResync" };

export interface SyncEngine {
  status(): WebSyncStatus;
  onStatus(listener: (s: WebSyncStatus) => void): () => void;
  onNotice(listener: (n: SyncNotice) => void): () => void;
  /** PWA: POST /session (cookie); native: POST /devices (kind mobile) + token storage. */
  login(username: string, password: string, deviceName: string): Promise<void>;
  /** Server logout (DELETE /session or /devices/current); the UI then calls DataStore.signOut. */
  logout(): Promise<void>;
  /**
   * v4: sign in with a pairing code (any input form; normalised with src/lib/pairing.ts).
   * PWA: POST /session/pairing (cookie, deviceId reused); native: POST /devices/pairing (the
   * adapter stores the token like after POST /devices). Then like login(): GET /me,
   * account_mismatch rule (D-71), first sync. Rejects with SyncError code `pairing_invalid`
   * (also for malformed input), `device_limit`, `account_disabled`, `too_many_requests`.
   */
  loginWithCode(code: string, deviceName: string): Promise<void>;
  /** v4: GET /info of the own server; null if the server is older than v4 (404). */
  serverInfo(): Promise<ServerInfo | null>;
  /**
   * v4: POST /me/delete, then like logout(); the UI then calls DataStore.signOut.
   * Rejects with `unauthorized` (wrong password) or `bad_request` (username mismatch).
   */
  deleteAccount(password: string, confirmUsername: string): Promise<void>;
  /** Runs a sync now (push outbox → pull → merge); resolves when done or failed. */
  syncNow(): Promise<void>;
  /** Debounced trigger (2 s after a change). */
  requestSync(reason: "change" | "online" | "visible" | "timer" | "start" | "push"): void;
  /** Installs triggers (online, visibilitychange, 60 s timer while visible). */
  start(): void;
  stop(): void;
}

export interface HttpResponse<T> {
  status: number;
  /** Parsed JSON body (null for 204). */
  body: T | null;
  /** Unix ms when the request was sent / the response arrived (clock offset). */
  sentAt: number;
  receivedAt: number;
}

/** Platform adapter (src/web/sync/http.ts): PWA = same-origin cookie + X-Buddy-Request; native = Bearer. */
export interface HttpAdapter {
  readonly kind: Extract<DeviceKind, "web" | "mobile">;
  request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<HttpResponse<T>>;
}

export interface TokenProvider {
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
}

export interface SyncEngineOptions {
  store: DataStore;
  http: HttpAdapter;
  /** Native shell only: reported with every push (§10.3). */
  deviceState?: () => DeviceState | null;
  /** Injectable timers for tests. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** Factory exported by src/web/sync/index.ts. */
export type CreateSyncEngine = (options: SyncEngineOptions) => SyncEngine;

// ---- v4: QR scanner and server choice (PLAN_V4 §6.2, §6.5, §7.3) -------------------------

/**
 * Reads a QR code with the camera. PWA: src/web/pairing/web-scanner.ts (getUserMedia +
 * BarcodeDetector or jsQR); native app: tauri-plugin-barcode-scanner (mobile/src/main.tsx).
 * The UI shows „QR-Code scannen“ only if a scanner is passed and isAvailable() is true.
 */
export interface QrScanner {
  /** Cheap check WITHOUT asking for the camera (no permission prompt). */
  isAvailable(): boolean;
  /**
   * Opens the camera, resolves with the raw QR text or null if cancelled. Rejects with an
   * Error whose message is `camera_denied` (permission refused) or `camera_failed`.
   * The camera is always released when the promise settles.
   */
  scan(): Promise<string | null>;
  /** Stops a running scan (scan() then resolves null). */
  cancel(): Promise<void>;
}

/** server_get of the native app. */
export interface ServerChoice {
  /** Effective origin (server.json before the build default). */
  origin: string;
  defaultOrigin: string;
  isDefault: boolean;
}

/**
 * Native app only (the PWA always talks to its own origin, D-98). The UI shows the server
 * line and „ändern“ only if a selector is passed.
 */
export interface ServerSelector {
  current(): Promise<ServerChoice>;
  /**
   * server_set: origin (https://, http:// only localhost/10.0.2.2) or null = default. Only
   * while signed out (rejects with `signed_in`); `invalid_url` for a bad origin. On success
   * the app reloads (scope change, D-97) – callers must not rely on code after it.
   */
  set(origin: string | null): Promise<void>;
}
