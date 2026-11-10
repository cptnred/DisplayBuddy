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
  // v4 (PLAN_V4 §5.3)
  usernameTaken: "username_taken",
  usernameInvalid: "username_invalid",
  passwordWeak: "password_weak",
  registrationClosed: "registration_closed",
  inviteRequired: "invite_required",
  inviteInvalid: "invite_invalid",
  challengeInvalid: "challenge_invalid",
  /** Unknown, expired, cancelled or used: deliberately one code. */
  pairingInvalid: "pairing_invalid",
  passwordRequired: "password_required",
  accountDisabled: "account_disabled",
  quotaExceeded: "quota_exceeded",
  deviceLimit: "device_limit",
  /** The client does not know the account's content format (D-101). */
  contentFormatUnsupported: "content_format_unsupported",
} as const;

/** Base path of the API on the server. */
export const API_BASE = "/api/v1";
/** Custom header required on cookie requests with unsafe methods (CSRF, §7.5). */
export const CSRF_HEADER = "X-Buddy-Request";

// ---- v4: accounts and pairing (PLAN_V4 §5; mirror of buddy-core accounts.rs/pairing.rs) ----

/** GET /info apiLevel of a v4 server (v3 servers answer 404 on /info). */
export const API_LEVEL = 2;
/** users.content_format: 1 = plain JSON; anything else → stop syncing (D-101). */
export const CONTENT_FORMAT_PLAIN = 1;
export const EXPORT_FORMAT = "display-buddy-export/1";
export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_BYTES = 1024;

export type RegistrationMode = "open" | "invite" | "closed";
export type ServerFeature = "accounts" | "pairing" | "recovery" | "export" | "quota";

export interface LegalLinks {
  imprintUrl: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
}

/** GET /info (public). */
export interface ServerInfo {
  serverTime: string;
  version: string;
  apiLevel: number;
  registration: RegistrationMode;
  /** Subset of ServerFeature; unknown names are ignored. */
  features: string[];
  passwordMinChars: number;
  legal: LegalLinks;
  operator: string | null;
}

/** POST /accounts/challenge (body {}). */
export interface RegistrationChallenge {
  id: string;
  /** 16 random bytes, base64url without padding. */
  challenge: string;
  bits: number;
  expiresAt: string;
  serverTime: string;
}

/** POST /accounts (desktop only; PoW nonce = u32). */
export interface AccountCreate {
  username: string;
  password: string;
  deviceName: string;
  timeZone?: string | null;
  inviteCode?: string | null;
  challengeId: string;
  nonce: number;
}

/** Answer of POST /accounts and POST /accounts/recover. */
export interface AccountAccess {
  deviceId: string;
  token: string;
  /** Normalised 24 chars; shown once (formatRecoveryCode). */
  recoveryCode: string;
  serverTime: string;
}

export interface AccountRecover {
  username: string;
  recoveryCode: string;
  newPassword: string;
  deviceName: string;
}

export interface Usage {
  bytes: number;
  notes: number;
  devices: number;
}

/** Effective limits; null = unlimited. */
export interface Quota {
  bytes: number | null;
  notes: number | null;
  devices: number | null;
}

/** GET /me/account. */
export interface AccountInfo {
  username: string;
  createdAt: string;
  timeZone: string;
  contentFormat: number;
  usage: Usage;
  quota: Quota;
  /** null = the account has no recovery code (v3 accounts). */
  recoveryCodeCreatedAt: string | null;
  serverTime: string;
}

export type DeviceCreatedVia = "password" | "register" | "pairing" | "recovery";

/** One entry of GET /me/devices (not revoked). */
export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  name: string;
  createdAt: string;
  /** „zuletzt aktiv“ (also set by the Android background sync). */
  lastSeenAt: string | null;
  createdVia: DeviceCreatedVia;
  current: boolean;
  /** Has a push channel (Web Push subscription or native token). */
  push: boolean;
}

export interface DeviceList {
  devices: DeviceInfo[];
  serverTime: string;
}

/** POST /me/devices/{id}/revoke: without password only the own or a younger device (D-91). */
export interface DeviceRevoke {
  password?: string | null;
}

/** PUT /me/password: without currentPassword only desktop/mobile ≥ 24 h, signOutOthers forced. */
export interface PasswordChange {
  currentPassword?: string | null;
  newPassword: string;
  signOutOthers: boolean;
}

export interface RecoveryCodeRequest {
  password: string;
}

export interface RecoveryCodeResponse {
  recoveryCode: string;
  serverTime: string;
}

/** POST /me/delete (immediate, cascade). */
export interface AccountDelete {
  password: string;
  confirmUsername: string;
}

export interface ExportAccount {
  username: string;
  createdAt: string;
  timeZone: string;
  contentFormat: number;
}

/** DeviceInfo without `current`. */
export type ExportDevice = Omit<DeviceInfo, "current">;

export interface RevisionExport {
  noteId: string;
  reason: "replaced" | "rejected";
  storedAt: string;
  /** null if the losing version was a tombstone. */
  note: Note | null;
}

/** GET /me/export (attachment). No hashes, tokens or push endpoints. */
export interface AccountExport {
  format: string;
  exportedAt: string;
  account: ExportAccount;
  devices: ExportDevice[];
  notes: NoteRecord[];
  reminders: ReminderRecord[];
  order: OrderRecord | null;
  revisions: RevisionExport[];
}

/** POST /pairing (desktop only). */
export interface PairingStart {
  pairingId: string;
  /** Normalised 12 chars (display with formatCode). */
  code: string;
  /** QR content: <origin>/pair#c=<code>. */
  url: string;
  expiresAt: string;
  serverTime: string;
}

export type PairingState = "pending" | "redeemed" | "expired" | "cancelled";

export interface PairedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
}

/** GET /pairing/{id} (creating device only). */
export interface PairingStatus {
  pairingId: string;
  state: PairingState;
  expiresAt: string;
  device: PairedDevice | null;
  redeemedAt: string | null;
  serverTime: string;
}

/** POST /devices/pairing (native app, bearer answer). */
export interface PairingRedeem {
  code: string;
  deviceName: string;
  kind: DeviceKind;
}

export interface PairingAccess {
  deviceId: string;
  token: string;
  username: string;
  serverTime: string;
}

/** POST /session/pairing (PWA; answer SessionResponse + cookie; CSRF applies). */
export interface SessionPairing {
  code: string;
  deviceName: string;
  deviceId?: string | null;
}
