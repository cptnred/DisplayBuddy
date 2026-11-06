/**
 * Reminder math (PLAN_V3_SYNC §5.5). TypeScript port of
 * `crates/buddy-core/src/schedule.rs`; both pass `schedule_vectors.json`.
 *
 * Every reminder has its own IANA zone; wall time and repetition are computed in it,
 * never in the device zone. "Now", `at`, `firedAt`, `updatedAt` are UTC instants.
 * Only the acting device computes a new `at`; everybody else takes it as is.
 * All functions are pure: "now" is always passed in (corrected device time).
 */
import type { Reminder, ReminderRepeat } from "../types";
import { instantToWall, isValidZone, utcAsWall, type Wall, wallAsUtc, wallToInstant } from "./zoned";

export const SNOOZE_MIN = 1;
export const SNOOZE_MAX = 1440;
const MAX_STEPS = 1000;
const DAY = 86_400_000;

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 instant → Unix ms, null if malformed. */
export function parseInstant(s: string): number | null {
  const t = s.trim();
  if (!RFC3339.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** Unix ms → `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/** The reminder's zone, or `fallback` if missing/unknown. */
export function reminderZone(r: Pick<Reminder, "timeZone">, fallback: string): string {
  return r.timeZone && isValidZone(r.timeZone) ? r.timeZone : fallback;
}

function daysInMonth(year: number, month: number): number {
  return utcAsWall(wallAsUtc({ year, month: month + 1, day: 0, hour: 0, minute: 0, second: 0, millisecond: 0 })).day;
}

/** Date part of `w` shifted by `days` (calendar arithmetic, no zone). */
function addDays(w: Wall, days: number): Wall {
  const shifted = utcAsWall(wallAsUtc({ ...w, hour: 12, minute: 0, second: 0, millisecond: 0 }) + days * DAY);
  return { ...w, year: shifted.year, month: shifted.month, day: shifted.day };
}

function addMonthsClamped(w: Wall, anchorDay: number, months: number): Wall {
  const index = w.year * 12 + (w.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { ...w, year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
}

function weekday(w: Wall): number {
  return new Date(wallAsUtc({ ...w, hour: 12 })).getUTCDay();
}

function dayIndex(w: Wall): number {
  return Math.round(wallAsUtc({ ...w, hour: 12, minute: 0, second: 0, millisecond: 0 }) / DAY);
}

/**
 * First occurrence of a repeating reminder strictly after `now`, in `timeZone`.
 * `at` itself counts. Later occurrences keep at's wall time: daily +1 day, weekdays
 * Mon–Fri, weekly +7 days, monthly same day (clamped to month end). Null for "none".
 */
export function nextOccurrence(
  at: number,
  repeat: ReminderRepeat,
  now: number,
  timeZone: string,
): number | null {
  if (repeat === "none") return null;
  if (at > now) return at;
  const w0 = instantToWall(at, timeZone);
  const nowWall = instantToWall(now, timeZone);
  const gapDays = Math.max(dayIndex(nowWall) - dayIndex(w0), 0);
  const atDate = (w: Wall) => wallToInstant(w, timeZone);

  if (repeat === "daily" || repeat === "weekdays") {
    let d = addDays(w0, Math.max(gapDays - 1, 1));
    for (let i = 0; i < MAX_STEPS; i++) {
      const wd = weekday(d);
      if (repeat === "daily" || (wd !== 0 && wd !== 6)) {
        const t = atDate(d);
        if (t !== null && t > now) return t;
      }
      d = addDays(d, 1);
    }
    return null;
  }
  if (repeat === "weekly") {
    const first = Math.max(Math.floor(gapDays / 7) - 1, 1);
    for (let k = first; k < first + MAX_STEPS; k++) {
      const t = atDate(addDays(w0, 7 * k));
      if (t !== null && t > now) return t;
    }
    return null;
  }
  // monthly
  const monthsBetween = (nowWall.year - w0.year) * 12 + nowWall.month - w0.month;
  const first = Math.max(monthsBetween - 1, 1);
  for (let k = first; k < first + MAX_STEPS; k++) {
    const t = atDate(addMonthsClamped(w0, w0.day, k));
    if (t !== null && t > now) return t;
  }
  return null;
}

/** Scheduled and `at ≤ now` (zone independent). */
export function isDue(r: Reminder, now: number): boolean {
  if (r.state !== "scheduled") return false;
  const at = parseInstant(r.at);
  return at !== null && at <= now;
}

/** Marks a reminder due. Does NOT touch `updatedAt` (firing is not an edit, D-30). */
export function fire(r: Reminder, now: number): Reminder {
  return { ...r, state: "due", firedAt: formatUtc(now) };
}

/** Creates/replaces a reminder at the instant `at` (state scheduled, firedAt kept). */
export function setReminder(
  existing: Reminder | null,
  noteId: string,
  at: number,
  repeat: ReminderRepeat,
  timeZone: string,
  now: number,
): Reminder {
  return {
    noteId,
    at: formatUtc(at),
    repeat,
    state: "scheduled",
    firedAt: existing?.firedAt ?? null,
    updatedAt: formatUtc(now),
    timeZone,
  };
}

/** {@link setReminder} from a wall time in the reminder zone (gap → next minute, fold → earlier). */
export function setReminderWall(
  existing: Reminder | null,
  noteId: string,
  wall: Wall,
  repeat: ReminderRepeat,
  timeZone: string,
  now: number,
): Reminder {
  const at = wallToInstant(wall, timeZone);
  if (at === null) throw new Error(`no valid time near the given wall time in ${timeZone}`);
  return setReminder(existing, noteId, at, repeat, timeZone, now);
}

/**
 * „Erledigt“: one-off → done; repeating → next occurrence after max(now, at) in the
 * reminder zone (fallback `defaultZone`), scheduled. Sets `updatedAt = now`.
 */
export function ackReminder(r: Reminder, now: number, defaultZone: string): Reminder {
  const timeZone = reminderZone(r, defaultZone);
  if (r.repeat === "none") {
    return { ...r, state: "done", timeZone, updatedAt: formatUtc(now) };
  }
  const at = parseInstant(r.at);
  if (at === null) throw new Error(`invalid reminder time: ${r.at}`);
  const after = at > now ? at : now;
  const next = nextOccurrence(at, r.repeat, after, timeZone);
  if (next === null) throw new Error("could not compute the next occurrence");
  return { ...r, at: formatUtc(next), state: "scheduled", timeZone, updatedAt: formatUtc(now) };
}

/** „Später“: at = now + minutes (1..=1440), scheduled, `updatedAt = now`. */
export function snoozeReminder(r: Reminder, minutes: number, now: number): Reminder {
  if (!Number.isInteger(minutes) || minutes < SNOOZE_MIN || minutes > SNOOZE_MAX) {
    throw new Error(`minutes must be between ${SNOOZE_MIN} and ${SNOOZE_MAX}, got ${minutes}`);
  }
  return {
    ...r,
    at: formatUtc(now + minutes * 60_000),
    state: "scheduled",
    updatedAt: formatUtc(now),
  };
}

/** Earliest `at` of all scheduled reminders (ms) or null. */
export function earliestScheduled(list: Reminder[]): number | null {
  let min: number | null = null;
  for (const r of list) {
    if (r.state !== "scheduled") continue;
    const at = parseInstant(r.at);
    if (at !== null && (min === null || at < min)) min = at;
  }
  return min;
}
