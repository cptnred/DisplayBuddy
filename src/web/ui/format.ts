/**
 * German display texts for reminder times (PLAN_V3_SYNC §5.5 „Anzeige“).
 *
 * Pure (no DOM, no React): also used by the service worker for notification bodies.
 * All calendar work goes through src/lib/zoned.ts; "today/tomorrow" refer to the
 * device zone, the original time is shown when the reminder zone shows another wall time.
 */
import { parseInstant } from "../../lib/schedule";
import {
  formatWallDate,
  formatWallTime,
  instantToWall,
  reminderWalls,
  utcAsWall,
  type Wall,
  wallAsUtc,
} from "../../lib/zoned";
import type { Reminder } from "../../types";

const WEEKDAYS = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

function weekday(w: Wall): string {
  return WEEKDAYS[new Date(wallAsUtc({ ...w, hour: 12, minute: 0, second: 0, millisecond: 0 })).getUTCDay()];
}

/** Calendar date `days` away from `w` (zone free). */
function shiftDate(w: Wall, days: number): string {
  return formatWallDate(utcAsWall(wallAsUtc({ ...w, hour: 12, minute: 0, second: 0, millisecond: 0 }) + days * DAY));
}

/** „Heute“, „Morgen“, „Gestern“, „Fr., 07.11.“ or „07.11.2027“ for `w` relative to `today`. */
export function dayLabel(w: Wall, today: Wall): string {
  const d = formatWallDate(w);
  if (d === formatWallDate(today)) return "Heute";
  if (d === shiftDate(today, 1)) return "Morgen";
  if (d === shiftDate(today, -1)) return "Gestern";
  const dm = `${pad(w.day)}.${pad(w.month)}.`;
  return w.year === today.year ? `${weekday(w)}, ${dm}` : `${dm}${w.year}`;
}

export interface ReminderTimeText {
  /** „Heute, 03:00“ in device time. */
  local: string;
  /** „09:00 Berlin“ (with weekday if the date differs), null if the zones agree. */
  original: string | null;
  /** „Heute, 03:00 (09:00 Berlin)“ */
  full: string;
}

/** Display parts of the instant `atMs` of a reminder in `reminderZone`, seen on this device. */
export function reminderTimeText(
  atMs: number,
  reminderZone: string,
  deviceZone: string,
  nowMs: number,
): ReminderTimeText {
  const { local, original } = reminderWalls(atMs, reminderZone, deviceZone);
  const today = instantToWall(nowMs, deviceZone);
  const localText = `${dayLabel(local, today)}, ${formatWallTime(local)}`;
  let originalText: string | null = null;
  if (original) {
    const sameDate = formatWallDate(original.wall) === formatWallDate(local);
    originalText = `${sameDate ? "" : `${weekday(original.wall)} `}${formatWallTime(original.wall)} ${original.zone}`;
  }
  return {
    local: localText,
    original: originalText,
    full: originalText ? `${localText} (${originalText})` : localText,
  };
}

/** Text for a stored reminder; falls back to the raw value if `at` is unreadable. */
export function formatReminderAt(r: Pick<Reminder, "at" | "timeZone">, deviceZone: string, nowMs: number): string {
  const at = parseInstant(r.at);
  if (at === null) return r.at;
  return reminderTimeText(at, r.timeZone || deviceZone, deviceZone, nowMs).full;
}

/** Minutes after which a delivered push says „fällig seit …“ instead of „fällig …“. */
export const LATE_AFTER_MS = 5 * 60_000;

/** „fällig heute, 03:00 (09:00 Berlin)“ or „fällig seit heute, 03:00 …“ (push delivered late). */
export function dueText(atMs: number, reminderZone: string, deviceZone: string, nowMs: number): string {
  const t = reminderTimeText(atMs, reminderZone, deviceZone, nowMs).full.replace(
    /^(Heute|Morgen|Gestern)/,
    (s) => s.toLowerCase(),
  );
  return nowMs - atMs > LATE_AFTER_MS ? `fällig seit ${t}` : `fällig ${t}`;
}
