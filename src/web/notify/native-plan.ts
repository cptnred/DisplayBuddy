/**
 * Pure planning logic of the native shell (PLAN_V3_SYNC §10.3). No plugin, no DOM, no
 * clock of its own: "now" and the device zone come from the caller.
 *
 * - One local notification per reminder with `state = scheduled` and `at > now`, at the
 *   absolute instant `at` (zone-independent, survives travelling).
 * - Stable 32-bit id from noteId + at (FNV-1a), so the same occurrence keeps its id
 *   across restarts and devices, and a moved/acknowledged occurrence gets a new one.
 * - At most {@link MAX_PLANNED} (iOS allows 64 pending local notifications per app).
 */
import { parseInstant } from "../../lib/schedule";
import { noteSearchText } from "../../lib/search";
import { formatWallTime, reminderWalls } from "../../lib/zoned";
import type { Note, Reminder } from "../../types";

/** iOS keeps at most 64 pending local notifications per app; 60 leaves room (test etc.). */
export const MAX_PLANNED = 60;
/** Id of the „in 2 min erinnern“ check (§10.4); never produced by {@link notificationId}. */
export const TEST_NOTIFICATION_ID = 2_000_000_001;
/** Action type with the two buttons (registerActionTypes). */
export const ACTION_TYPE_ID = "buddy-reminder";
export const ACTION_ACK = "ack";
export const ACTION_SNOOZE = "snooze10";
export const SNOOZE_MINUTES = 10;
/** Android channel „Erinnerungen“ (high importance). */
export const CHANNEL_ID = "reminders";

const TITLE_MAX = 60;
const SNIPPET_MAX = 120;

/** FNV-1a (32 bit) over the UTF-16 code units of `s`, as unsigned number. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable notification id of the occurrence (noteId, at): signed 32-bit integer (the
 * plugin's Rust/Kotlin/Swift side uses i32/Int). `at` is normalised to the instant so
 * "…+01:00" and "…Z" spellings of the same time give the same id. Null if `at` is
 * unreadable.
 */
export function notificationId(noteId: string, at: string): number | null {
  const ms = parseInstant(at);
  if (ms === null) return null;
  const id = fnv1a32(`${noteId}|${ms}`) | 0;
  return id === TEST_NOTIFICATION_ID ? id ^ 1 : id;
}

export interface PlannedNotification {
  id: number;
  noteId: string;
  /** The reminder's `at` as stored. */
  at: string;
  atMs: number;
  title: string;
  body: string;
}

/** Title of a note for the notification (title, else start of the text). */
export function noteTitle(note: Note | undefined): string {
  if (!note) return "Erinnerung";
  const t = note.title.trim() || noteSearchText(note);
  if (!t) return "Erinnerung";
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/**
 * Body: start of the note text (if the title is a separate field) and the time in the
 * device zone, with the original time if the reminder zone differs – e.g.
 * „Erinnerung um 03:00 (09:00 Berlin)“. No „heute/morgen“: the text is fixed when the
 * notification is planned, not when it rings.
 */
export function notificationBody(note: Note | undefined, atMs: number, reminderZone: string, deviceZone: string): string {
  const { local, original } = reminderWalls(atMs, reminderZone, deviceZone);
  const time = original
    ? `Erinnerung um ${formatWallTime(local)} (${formatWallTime(original.wall)} ${original.zone})`
    : `Erinnerung um ${formatWallTime(local)}`;
  const text = note && note.title.trim() ? noteSearchText(note) : "";
  const snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
  return snippet ? `${snippet}\n${time}` : time;
}

export interface PlanInput {
  reminders: readonly Reminder[];
  notes: readonly Note[];
  now: number;
  deviceZone: string;
  limit?: number;
}

export interface Plan {
  notifications: PlannedNotification[];
  /** Future scheduled reminders left out because of the limit. */
  truncated: number;
}

/** The notifications that should be pending right now (sorted by time). */
export function planReminders(input: PlanInput): Plan {
  const limit = input.limit ?? MAX_PLANNED;
  const notes = new Map(input.notes.map((n) => [n.id, n]));
  const all: PlannedNotification[] = [];
  for (const r of input.reminders) {
    if (r.state !== "scheduled") continue;
    const atMs = parseInstant(r.at);
    if (atMs === null || atMs <= input.now) continue;
    const id = notificationId(r.noteId, r.at);
    if (id === null) continue;
    const note = notes.get(r.noteId);
    // reminder of a note that is not (yet) known locally: still ring, generic title
    const zone = r.timeZone || input.deviceZone;
    all.push({
      id,
      noteId: r.noteId,
      at: r.at,
      atMs,
      title: noteTitle(note),
      body: notificationBody(note, atMs, zone, input.deviceZone),
    });
  }
  all.sort((a, b) => a.atMs - b.atMs || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  return { notifications: all.slice(0, limit), truncated: Math.max(0, all.length - limit) };
}

export interface PendingInfo {
  id: number;
  title?: string | null;
  body?: string | null;
}

export interface PlanDiff {
  /** Pending ids to cancel (no longer wanted, or replaced because the text changed). */
  cancel: number[];
  /** Notifications to schedule. */
  schedule: PlannedNotification[];
}

/**
 * Compares the wanted plan with what the OS has pending. Unknown pending ids are
 * cancelled (moved/acknowledged/removed reminders – their (noteId, at) id is gone);
 * the test notification is left alone. A pending notification with the same id but
 * another title/body (note renamed, device zone changed) is replaced.
 */
export function diffPlan(wanted: readonly PlannedNotification[], pending: readonly PendingInfo[]): PlanDiff {
  const want = new Map(wanted.map((n) => [n.id, n]));
  const have = new Map(pending.map((p) => [p.id, p]));
  const cancel: number[] = [];
  const schedule: PlannedNotification[] = [];
  for (const p of pending) {
    if (p.id === TEST_NOTIFICATION_ID) continue;
    const w = want.get(p.id);
    if (!w) cancel.push(p.id);
    else if (textDiffers(p, w)) cancel.push(p.id);
  }
  for (const w of wanted) {
    const p = have.get(w.id);
    if (!p || textDiffers(p, w)) schedule.push(w);
  }
  return { cancel, schedule };
}

/** Only compared where the platform reports the text (Android and iOS both do). */
function textDiffers(p: PendingInfo, w: PlannedNotification): boolean {
  const titleKnown = typeof p.title === "string";
  const bodyKnown = typeof p.body === "string";
  return (titleKnown && p.title !== w.title) || (bodyKnown && p.body !== w.body);
}

/**
 * Delivered notifications (`active()`) to remove: those whose occurrence is resolved –
 * the reminder is done, moved to another `at`, or gone. A delivered notification of a
 * reminder that is still scheduled/due with the same `at` stays.
 */
export function resolvedActive(activeIds: readonly number[], reminders: readonly Reminder[]): number[] {
  const live = new Set<number>();
  for (const r of reminders) {
    if (r.state !== "scheduled" && r.state !== "due") continue;
    const id = notificationId(r.noteId, r.at);
    if (id !== null) live.add(id);
  }
  return activeIds.filter((id) => id !== TEST_NOTIFICATION_ID && !live.has(id));
}

/** The reminder a notification id belongs to (actions: iOS reports only the id). */
export function reminderForNotification(id: number, reminders: readonly Reminder[]): Reminder | null {
  for (const r of reminders) {
    if (notificationId(r.noteId, r.at) === id) return r;
  }
  return null;
}

/**
 * Date handed to `Schedule.at`: rounded up to the whole second, so the notification
 * never rings before `at` and no fraction reaches the native date parsers (see the
 * plugin patch in mobile/patches, README „Plugin-Patch“).
 */
export function scheduleDate(atMs: number): Date {
  return new Date(Math.ceil(atMs / 1000) * 1000);
}
