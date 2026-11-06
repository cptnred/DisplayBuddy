/**
 * Service-worker logic for Web Push (PLAN_V3_SYNC §9.4), free of globals so it can be
 * unit-tested; `src/web/sw.ts` wires it to `self`.
 *
 * Browser support (mdn/browser-compat-data 8.1.8, checked 2026-11-06):
 * - push event + showNotification: Chrome Android 40/42, Firefox 44, Safari iOS 16.4
 *   (home-screen apps) → mandatory, a push ALWAYS shows a notification (Apple: no silent
 *   pushes, otherwise Safari revokes the permission).
 * - showNotification `actions`: Chrome Android 48, Firefox 152, Safari iOS no → only
 *   when `Notification.maxActions ≥ 2` (feature check).
 * - `navigate` option: Safari (iOS) 18.5, Firefox 158, Chrome no; `tag`: Safari iOS no;
 *   `data` option: Safari iOS no. Unknown/unsupported dictionary members are ignored by
 *   WebIDL, so they are passed as optional extras; the note id is also in the URL.
 * - notificationclick: Chrome Android 40, Firefox 44, Safari iOS NO → optional: on iOS a
 *   tap opens the app (or `navigate`) and the app shows due reminders with buttons.
 * - getNotifications: Chrome Android 40, Safari iOS 16.4 → used where present.
 */
import { parseInstant } from "../../lib/schedule";
import type { ReminderPushPayload } from "../../lib/sync/types";
import type { Reminder } from "../../types";
import type { DataStore } from "../contract";
import { dueText } from "../ui/format";

export const ACTION_ACK = "ack";
export const ACTION_SNOOZE = "snooze10";
export const SNOOZE_MINUTES = 10;
export const ICON = "/icons/icon-192.png";
export const BADGE = "/icons/badge-96.png";

export interface NotificationAction {
  action: string;
  title: string;
}

/** Superset of NotificationOptions incl. members missing in the DOM typings. */
export interface BuddyNotificationOptions {
  body: string;
  icon?: string;
  badge?: string;
  lang?: string;
  tag?: string;
  renotify?: boolean;
  data?: NotificationData;
  actions?: NotificationAction[];
  /** Declarative web push / Safari 18.5: URL opened on tap. */
  navigate?: string;
  timestamp?: number;
}

export interface NotificationData {
  noteId: string | null;
  at: string | null;
  url: string;
}

export interface ShownNotification {
  tag?: string;
  data?: unknown;
  close(): void;
}

export interface SwRegistration {
  showNotification(title: string, options: BuddyNotificationOptions): Promise<void>;
  getNotifications?(filter?: { tag?: string }): Promise<ShownNotification[]>;
}

export interface SwWindowClient {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface SwClients {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly SwWindowClient[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface SwDeps {
  registration: SwRegistration;
  clients: SwClients;
  /** Opens the data layer (cached by the caller). */
  openStore(): Promise<DataStore>;
  /** One sync attempt (push outbox → pull); errors are swallowed by the caller. */
  sync(store: DataStore): Promise<void>;
  deviceZone(): string;
  /** `Notification.maxActions` (0 if unknown). */
  maxActions(): number;
  /** Corrected "now" in Unix ms if the store is not available. */
  now(): number;
  /** Origin for same-origin checks of URLs from the payload. */
  origin: string;
  /** Optional: app badge in the worker (feature-checked by the caller). */
  setBadge?(count: number): Promise<void>;
  log?(message: string): void;
}

/** Message the worker posts to an open window to route it to a note. */
export interface OpenMessage {
  type: "buddy-open";
  url: string;
}

const FALLBACK_TITLE = "Display Buddy";
const FALLBACK_BODY = "Neue Benachrichtigung";

/** Parses the push payload; tolerant (null for anything unreadable). */
export function parsePayload(raw: unknown): ReminderPushPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<ReminderPushPayload>;
  if (p.type !== "reminder" && p.type !== "test") return null;
  return {
    v: typeof p.v === "number" ? p.v : 1,
    type: p.type,
    noteId: typeof p.noteId === "string" ? p.noteId : null,
    at: typeof p.at === "string" ? p.at : null,
    timeZone: typeof p.timeZone === "string" ? p.timeZone : null,
    title: typeof p.title === "string" && p.title.trim() ? p.title : FALLBACK_TITLE,
    body: typeof p.body === "string" ? p.body : "",
    url: typeof p.url === "string" ? p.url : "/",
  };
}

/** Only same-origin paths are opened ("/notes/<id>"), everything else falls back to "/". */
export function safeUrl(url: string | null | undefined, origin: string): string {
  if (!url) return "/";
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

/** Title + options for a payload (null payload → generic notification). */
export function buildNotification(
  payload: ReminderPushPayload | null,
  ctx: { deviceZone: string; now: number; maxActions: number; origin: string },
): { title: string; options: BuddyNotificationOptions } {
  if (!payload) {
    return { title: FALLBACK_TITLE, options: { body: FALLBACK_BODY, icon: ICON, badge: BADGE, lang: "de" } };
  }
  const url = safeUrl(payload.url, ctx.origin);
  const lines: string[] = [];
  if (payload.body.trim()) lines.push(payload.body.trim());
  const atMs = payload.at ? parseInstant(payload.at) : null;
  if (payload.type === "reminder" && atMs !== null) {
    lines.push(dueText(atMs, payload.timeZone || ctx.deviceZone, ctx.deviceZone, ctx.now));
  }
  const isReminder = payload.type === "reminder" && !!payload.noteId;
  const options: BuddyNotificationOptions = {
    body: lines.join("\n") || FALLBACK_BODY,
    icon: ICON,
    badge: BADGE,
    lang: "de",
    tag: isReminder ? `r-${payload.noteId}` : "buddy-test",
    // renotify needs a tag (Chrome throws otherwise); a snoozed reminder must ring again.
    renotify: true,
    data: { noteId: payload.noteId ?? null, at: payload.at ?? null, url },
    navigate: new URL(url, ctx.origin).href,
  };
  if (atMs !== null) options.timestamp = atMs;
  if (isReminder && ctx.maxActions >= 2) {
    options.actions = [
      { action: ACTION_ACK, title: "Erledigt" },
      { action: ACTION_SNOOZE, title: "10 Min. später" },
    ];
  }
  return { title: payload.title, options };
}

async function updateBadge(store: DataStore, deps: SwDeps): Promise<void> {
  if (!deps.setBadge) return;
  const due = (await store.listReminders()).filter((r) => r.state === "due").length;
  await deps.setBadge(due);
}

/**
 * `push` event. Always shows a notification first; the "due" state is stored in
 * IndexedDB via the data layer afterwards (errors there never suppress the notification).
 */
export async function handlePush(data: unknown, deps: SwDeps): Promise<void> {
  const payload = parsePayload(data);
  let now = deps.now();
  let store: DataStore | null = null;
  try {
    store = await deps.openStore();
    now = store.clock.correctedNow();
  } catch {
    deps.log?.("push: data layer unavailable");
  }
  const { title, options } = buildNotification(payload, {
    deviceZone: deps.deviceZone(),
    now,
    maxActions: deps.maxActions(),
    origin: deps.origin,
  });
  const shown = deps.registration.showNotification(title, options);
  const bookkeeping = (async () => {
    if (!store || payload?.type !== "reminder" || !payload.noteId || !payload.at) return;
    await store.markDue(payload.noteId, payload.at);
    await updateBadge(store, deps);
  })();
  const [show, book] = await Promise.allSettled([shown, bookkeeping]);
  if (book.status === "rejected") deps.log?.("push: could not store the due state");
  if (show.status === "rejected") {
    // Last resort: a plain notification (never leave a push invisible).
    await deps.registration.showNotification(FALLBACK_TITLE, { body: options.body, icon: ICON });
  }
}

/** Reads {noteId, at, url} from a clicked notification (data or tag). */
export function notificationData(n: ShownNotification, origin: string): NotificationData {
  const d = (n.data ?? {}) as Partial<NotificationData>;
  const fromTag = n.tag?.startsWith("r-") ? n.tag.slice(2) : null;
  const noteId = typeof d.noteId === "string" ? d.noteId : fromTag;
  const url = safeUrl(typeof d.url === "string" ? d.url : noteId ? `/notes/${noteId}` : "/", origin);
  return { noteId, at: typeof d.at === "string" ? d.at : null, url };
}

/**
 * `notificationclick` (Chromium/Firefox only). „Erledigt“/„10 Min. später“ run through
 * the data layer (corrected time, outbox) – only if the reminder is still at the
 * notified occurrence, so a stale notification never skips an occurrence – then a sync
 * attempt (works offline: the outbox keeps the change). A plain click opens the note.
 */
export async function handleNotificationClick(
  notification: ShownNotification,
  action: string,
  deps: SwDeps,
): Promise<void> {
  notification.close();
  const { noteId, at, url } = notificationData(notification, deps.origin);
  if ((action === ACTION_ACK || action === ACTION_SNOOZE) && noteId) {
    const store = await deps.openStore();
    const r = await store.getReminder(noteId);
    const current = r ? parseInstant(r.at) : null;
    const notified = at ? parseInstant(at) : null;
    const matches = r !== null && r.state !== "done" && (notified === null || current === notified);
    if (matches) {
      if (action === ACTION_ACK) await store.ackReminder(noteId);
      else await store.snoozeReminder(noteId, SNOOZE_MINUTES);
    }
    try {
      await updateBadge(store, deps);
    } catch {
      /* badge is optional */
    }
    try {
      await deps.sync(store);
    } catch {
      deps.log?.("notificationclick: sync failed, outbox keeps the change");
    }
    return;
  }
  await openApp(url, deps);
}

/** Focuses an open window and routes it to `url`, or opens a new one. */
export async function openApp(url: string, deps: SwDeps): Promise<void> {
  const list = await deps.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = list.find((c) => {
    try {
      return new URL(c.url).origin === deps.origin;
    } catch {
      return false;
    }
  });
  if (client) {
    await client.focus();
    const msg: OpenMessage = { type: "buddy-open", url };
    client.postMessage(msg);
    return;
  }
  await deps.clients.openWindow(url);
}

/**
 * Whether a notification for the occurrence `notifiedAt` is resolved: the reminder was
 * removed, acknowledged (done) or moved to another occurrence (ack of a repeating one,
 * snooze). A reminder the store does not know yet (push arrived before the sync) is
 * NOT resolved – it may simply not be synced yet.
 */
export function isResolved(
  reminder: Reminder | undefined,
  notifiedAt: string | null,
  knownNoteIds: ReadonlySet<string>,
  noteId: string,
): boolean {
  if (!reminder) return knownNoteIds.has(noteId);
  if (reminder.state === "done") return true;
  if (notifiedAt === null) return false;
  return parseInstant(reminder.at) !== parseInstant(notifiedAt);
}

/**
 * Closes shown notifications whose reminder is no longer due (acknowledged/snoozed on
 * another device, PLAN §7.4 „Kein Entfernen aus der Ferne“). Uses getNotifications()
 * where present. `knownNoteIds` = ids of notes in the local store.
 */
export async function closeResolved(
  registration: SwRegistration,
  reminders: readonly Reminder[],
  knownNoteIds: ReadonlySet<string>,
  origin: string,
): Promise<number> {
  if (!registration.getNotifications) return 0;
  const byId = new Map(reminders.map((r) => [r.noteId, r]));
  const shown = await registration.getNotifications();
  let closed = 0;
  for (const n of shown) {
    const { noteId, at } = notificationData(n, origin);
    if (noteId && isResolved(byId.get(noteId), at, knownNoteIds, noteId)) {
      n.close();
      closed++;
    }
  }
  return closed;
}
