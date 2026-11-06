/**
 * Instants and wall-clock times in IANA zones (PLAN_V3_SYNC §5.5, D-39, D-49).
 * Mirror of `crates/buddy-core/src/zoned.rs`; both pass `schedule_vectors.json`.
 *
 * Instants are Unix milliseconds (UTC) and never depend on a zone. Zones only matter
 * for wall time ↔ instant and for repetition. Uses `Intl.DateTimeFormat` with
 * `timeZone`/`formatToParts` – no `Temporal` (Safari does not ship it yet).
 * The device zone (`process.env.TZ`, OS setting) never influences any result here.
 */

/** A wall-clock time (calendar fields, no zone). `month` is 1–12. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for zone names `Intl` knows (IANA names and aliases). */
export function isValidZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    formatter(timeZone.trim());
    return true;
  } catch {
    return false;
  }
}

/** The device's IANA zone (`Intl`), "UTC" if unknown. */
export function deviceZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

/** All zones for a picker (`Intl.supportedValuesOf`), with a small fallback list. */
export function supportedZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list;
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/Berlin", "Europe/London", "America/New_York", "Asia/Tokyo"];
}

/** UTC instant → wall time in `timeZone`. */
export function instantToWall(ms: number, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const era = parts.find((p) => p.type === "era")?.value;
  let year = get("year");
  if (era === "BC" || era === "B") year = 1 - year;
  const hour = get("hour");
  return {
    year,
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

/** Wall fields read as if they were UTC (calendar arithmetic without a zone). */
export function wallAsUtc(w: Wall): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, w.millisecond);
  return d.getTime();
}

/** Inverse of {@link wallAsUtc}. */
export function utcAsWall(ms: number): Wall {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
  };
}

/** Offset of `timeZone` at instant `ms` in milliseconds (wall − UTC). */
export function offsetMs(ms: number, timeZone: string): number {
  const w = instantToWall(ms, timeZone);
  return wallAsUtc(w) - ms;
}

function sameWall(a: Wall, b: Wall): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/** All instants whose wall time in `timeZone` is exactly `w` (0, 1 or 2). */
function instantsForWall(w: Wall, timeZone: string): number[] {
  const naive = wallAsUtc(w);
  const offsets = new Set<number>();
  for (const probe of [naive - DAY, naive, naive + DAY]) offsets.add(offsetMs(probe, timeZone));
  const out: number[] = [];
  for (const off of offsets) {
    const t = naive - off;
    if (sameWall(instantToWall(t, timeZone), w) && !out.includes(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Wall time in `timeZone` → UTC instant. DST fold → the earlier instant; DST gap →
 * the first valid wall minute after it (02:30 in a 02:00→03:00 gap becomes 03:00).
 * Null if nothing valid follows within a day (never for real zones).
 */
export function wallToInstant(w: Wall, timeZone: string): number | null {
  let candidate = w;
  for (let i = 0; i <= 24 * 60; i++) {
    const hits = instantsForWall(candidate, timeZone);
    if (hits.length > 0) return hits[0];
    // next whole minute
    const next = wallAsUtc(candidate) + MINUTE;
    candidate = utcAsWall(next - (next % MINUTE));
  }
  return null;
}

/** Parses "YYYY-MM-DDTHH:MM" (optional ":SS"). Null if malformed. */
export function parseWall(s: string): Wall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const w: Wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
    millisecond: 0,
  };
  // reject 2026-02-31 and 25:00
  return sameWall(utcAsWall(wallAsUtc(w)), w) ? w : null;
}

/** Builds a wall from an `<input type="date">` and `<input type="time">` value. */
export function wallFromInputs(date: string, time: string): Wall | null {
  return parseWall(`${date}T${time}`);
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** "YYYY-MM-DD" */
export function formatWallDate(w: Wall): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** "HH:MM" */
export function formatWallTime(w: Wall): string {
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** "YYYY-MM-DDTHH:MM" */
export function formatWall(w: Wall): string {
  return `${formatWallDate(w)}T${formatWallTime(w)}`;
}

/** Short German label of a zone: "Europe/Berlin" → "Berlin", "America/New_York" → "New York". */
export function zoneLabel(timeZone: string): string {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
}

/** Whether two zone names give the same wall time at `ms` (aliases, equal offsets). */
export function sameWallAt(ms: number, a: string, b: string): boolean {
  return a === b || offsetMs(ms, a) === offsetMs(ms, b);
}

/**
 * Display parts for a reminder time: the wall time on this device and – if the
 * reminder zone shows a different wall time – the original one, e.g.
 * `{ local: …, original: { wall, zone: "Berlin" } }` → „03:00 (09:00 Berlin)“.
 */
export function reminderWalls(
  atMs: number,
  reminderZone: string,
  deviceTimeZone: string,
): { local: Wall; original: { wall: Wall; zone: string } | null } {
  const local = instantToWall(atMs, deviceTimeZone);
  if (sameWallAt(atMs, reminderZone, deviceTimeZone)) return { local, original: null };
  return {
    local,
    original: { wall: instantToWall(atMs, reminderZone), zone: zoneLabel(reminderZone) },
  };
}
