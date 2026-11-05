/**
 * Local date/time helpers for reminders (pure; use the JS runtime's local time zone).
 * Wire format: RFC 3339 with the local offset, e.g. "2026-11-05T14:30:00+01:00".
 */

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, "0");

const WEEKDAYS_SHORT = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];

/** "YYYY-MM-DD" of a Date in local time (value format of `<input type="date">`). */
export function toDateInput(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "HH:MM" of a Date in local time (value format of `<input type="time">`). */
export function toTimeInput(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local offset of `d` as "+01:00" / "-05:00". */
export function offsetOf(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** RFC 3339 with seconds and local offset of an instant. */
export function dateToRfc3339Local(d: Date): string {
  return `${toDateInput(d)}T${toTimeInput(d)}:${pad(d.getSeconds())}${offsetOf(d)}`;
}

/** Parses "YYYY-MM-DD" + "HH:MM" as local wall-clock time. null if invalid. */
export function parseLocal(date: string, time: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, da, h, mi] = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const d = new Date(y, mo - 1, da, h, mi, 0, 0);
  // reject overflow like 2026-02-31 (but allow DST shifts of the hour)
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

/**
 * "2026-11-05" + "14:30" → "2026-11-05T14:30:00+01:00". The offset is the local one *at that
 * moment* (correct across DST). A wall-clock time inside a DST gap is moved forward like
 * `Date` does (02:30 → 03:30). Throws RangeError on invalid input.
 */
export function toRfc3339Local(date: string, time: string): string {
  const d = parseLocal(date, time);
  if (!d) throw new RangeError(`invalid local date/time: ${date} ${time}`);
  return dateToRfc3339Local(d);
}

/** RFC 3339 → local { date: "YYYY-MM-DD", time: "HH:MM" }; null if unparsable. */
export function fromRfc3339(s: string): { date: string; time: string } | null {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return { date: toDateInput(d), time: toTimeInput(d) };
}

function dayNumber(d: Date): number {
  // calendar-day index independent of DST (UTC of the local Y/M/D)
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/**
 * German short label of a reminder time relative to `now`:
 * „Heute, 14:30“, „Morgen, 09:00“, „Gestern, 18:00“, „Fr., 07.11., 14:30“ (same year),
 * „07.11.2027, 14:30“ (other year). Unparsable input is returned unchanged.
 */
export function formatReminder(s: string, now: Date = new Date()): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const time = toTimeInput(d);
  const diff = dayNumber(d) - dayNumber(now);
  if (diff === 0) return `Heute, ${time}`;
  if (diff === 1) return `Morgen, ${time}`;
  if (diff === -1) return `Gestern, ${time}`;
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  if (d.getFullYear() === now.getFullYear()) return `${WEEKDAYS_SHORT[d.getDay()]}, ${dm}, ${time}`;
  return `${dm}${d.getFullYear()}, ${time}`;
}

/** The next full local hour strictly after `now` (14:00:00 → 15:00, 14:05 → 15:00). */
export function nextFullHour(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}
