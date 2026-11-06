/**
 * Sync records and API messages (PLAN_V3_SYNC §5.2, §6). Mirror of
 * `crates/buddy-core/src/sync.rs`; `api_examples.json` is type-checked against these.
 */
import type { Note, Reminder } from "../../types";

/** Server change-log sequence number (the sync cursor). */
export type Seq = number;

export interface NoteRecord {
  id: string;
  /** Edit time on the editing device (corrected clock, UTC). */
  updatedAt: string;
  /** Editing device id. */
  updatedBy: string;
  deleted: boolean;
  /** null for tombstones. */
  note: Note | null;
}

export interface ReminderRecord {
  noteId: string;
  updatedAt: string;
  updatedBy: string;
  deleted: boolean;
  /** null for tombstones (reminder removed). */
  reminder: Reminder | null;
}

export interface OrderRecord {
  updatedAt: string;
  updatedBy: string;
  ids: string[];
}

export interface SyncChanges {
  cursor: Seq;
  hasMore: boolean;
  notes: NoteRecord[];
  reminders: ReminderRecord[];
  order: OrderRecord | null;
  serverTime: string;
}

export type LocalNotifications = "granted" | "denied";

export interface DeviceState {
  /** Cursor up to which every reminder is planned locally (native shell). */
  scheduledSeq: Seq;
  localNotifications: LocalNotifications;
}

export interface PushRequest {
  notes: NoteRecord[];
  reminders: ReminderRecord[];
  order?: OrderRecord | null;
  deviceState?: DeviceState | null;
}

/** Maximum records per kind in one push. */
export const PUSH_BATCH_MAX = 200;

export type RecordKind = "note" | "reminder" | "order";
export type PushStatus = "applied" | "stale" | "invalid";

export interface PushResult {
  kind: RecordKind;
  /** Note id (notes, reminders) or "order". */
  id: string;
  status: PushStatus;
  /** Record as stored on the server (for "stale": the winner to take over). */
  note?: NoteRecord;
  reminder?: ReminderRecord;
  order?: OrderRecord;
  /** Stored timestamp if the server clamped a far-future one. */
  clampedUpdatedAt?: string;
  message?: string;
}

export interface PushResponse {
  results: PushResult[];
  cursor: Seq;
  serverTime: string;
}

export type DeviceKind = "desktop" | "web" | "mobile";

export interface DeviceLogin {
  username: string;
  password: string;
  deviceName: string;
  kind: DeviceKind;
}

export interface DeviceLoginResponse {
  deviceId: string;
  token: string;
  serverTime: string;
}

export interface SessionLogin {
  username: string;
  password: string;
  deviceName: string;
  deviceId?: string | null;
}

export interface SessionResponse {
  deviceId: string;
  serverTime: string;
}

export interface Me {
  username: string;
  timeZone: string;
  deviceId: string;
  serverTime: string;
}

export interface MeUpdate {
  timeZone: string;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type NativePushPlatform = "fcm" | "apns";

export interface NativePushToken {
  platform: NativePushPlatform;
  token: string;
}

export interface VapidPublicKey {
  /** Uncompressed P-256 point, base64url (applicationServerKey). */
  key: string;
}

/** Decrypted payload of a reminder push. */
export interface ReminderPushPayload {
  v: number;
  type: "reminder" | "test";
  noteId?: string | null;
  at?: string | null;
  timeZone?: string | null;
  title: string;
  body: string;
  url: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export const ERROR_CODES = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  badRequest: "bad_request",
  notFound: "not_found",
  tooManyRequests: "too_many_requests",
  fullResyncRequired: "full_resync_required",
  internal: "internal",
} as const;

/** Base path of the API on the server. */
export const API_BASE = "/api/v1";
/** Custom header required on cookie requests with unsafe methods (CSRF, §7.5). */
export const CSRF_HEADER = "X-Buddy-Request";
