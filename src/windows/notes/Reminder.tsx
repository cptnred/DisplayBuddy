import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { clock } from "../../lib/clock";
import {
  deviceZone as currentDeviceZone,
  formatWallDate,
  formatWallTime,
  instantToWall,
  isValidZone,
  reminderWalls,
  sameWallAt,
  supportedZones,
  utcAsWall,
  wallAsUtc,
  wallFromInputs,
  wallToInstant,
  type Wall,
} from "../../lib/zoned";
import { REMINDER_REPEAT_LABELS, type Reminder, type ReminderRepeat } from "../../types";
import styles from "./Reminder.module.css";

export const PAST_TEXT = "Zeitpunkt liegt in der Vergangenheit";

const REPEATS = Object.keys(REMINDER_REPEAT_LABELS) as ReminderRepeat[];
const WEEKDAYS_SHORT = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];
const HOUR = 3_600_000;
const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");
const correctedNow = () => new Date(clock.correctedNow());

/** A reminder that still matters for the UI (done = acknowledged, shown like none). */
export function activeReminder(r: Reminder | undefined | null): Reminder | null {
  return r && (r.state === "scheduled" || r.state === "due") ? r : null;
}

/** Calendar-day index of a wall date (zone free). */
function dayIndex(w: Wall): number {
  return Math.round(wallAsUtc({ ...w, hour: 0, minute: 0, second: 0, millisecond: 0 }) / DAY);
}

/**
 * German short label of an instant in `zone`, relative to `nowMs` in the same zone:
 * „Heute, 14:30“, „Morgen, 09:00“, „Gestern, 18:00“, „Fr., 07.11., 14:30“ (same year),
 * „07.11.2027, 14:30“ (other year).
 */
export function formatInZone(atMs: number, nowMs: number, zone: string): string {
  const w = instantToWall(atMs, zone);
  const n = instantToWall(nowMs, zone);
  const time = formatWallTime(w);
  const diff = dayIndex(w) - dayIndex(n);
  if (diff === 0) return `Heute, ${time}`;
  if (diff === 1) return `Morgen, ${time}`;
  if (diff === -1) return `Gestern, ${time}`;
  const dm = `${pad(w.day)}.${pad(w.month)}.`;
  if (w.year === n.year) {
    const weekday = new Date(dayIndex(w) * DAY).getUTCDay();
    return `${WEEKDAYS_SHORT[weekday]}, ${dm}, ${time}`;
  }
  return `${dm}${w.year}, ${time}`;
}

/**
 * Label of a reminder time on this device (§5.5): local time of the device zone; if the
 * reminder zone shows a different wall time, the original is added – „Heute, 03:00 (09:00 Berlin)“.
 */
export function reminderLabel(at: string, reminderZone: string | null, now: Date, device: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  const zone = reminderZone && isValidZone(reminderZone) ? reminderZone : device;
  const base = formatInZone(ms, now.getTime(), device);
  const { original } = reminderWalls(ms, zone, device);
  return original ? `${base} (${formatWallTime(original.wall)} ${original.zone})` : base;
}

/** The next full hour after `nowMs`, as wall time in `zone`. */
function nextFullHourWall(nowMs: number, zone: string): Wall {
  const w = instantToWall(nowMs, zone);
  return utcAsWall(wallAsUtc({ ...w, minute: 0, second: 0, millisecond: 0 }) + HOUR);
}

function BellIcon({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" className={styles.icon}>
      <path
        d="M8 2.2c-2.2 0-3.8 1.7-3.8 3.9v2.4L3 10.6v.9h10v-.9l-1.2-2.1V6.1C11.8 3.9 10.2 2.2 8 2.2zM6.5 12.6a1.6 1.6 0 0 0 3 0"
        fill={filled ? "currentColor" : "none"}
        fillOpacity={filled ? 0.9 : 0}
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ReminderControlProps {
  reminder: Reminder | null;
  /**
   * `at` = UTC instant (`…Z`), `timeZone` = IANA zone in which date/time were entered.
   * Resolve true when stored (popover closes), false on error.
   */
  onSave: (at: string, repeat: ReminderRepeat, timeZone: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  /** For tests: the current time (default: corrected device clock). */
  now?: () => Date;
  /** For tests: the zone of this PC (default: `Intl`). */
  deviceZone?: string;
}

/** Bell button in the active card header + popover editor. */
export function ReminderControl({
  reminder,
  onSave,
  onRemove,
  now = correctedNow,
  deviceZone = currentDeviceZone(),
}: ReminderControlProps) {
  const current = activeReminder(reminder);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [zone, setZone] = useState(deviceZone);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [repeat, setRepeat] = useState<ReminderRepeat>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const popId = useId();
  const zoneId = useId();
  const state = current?.state ?? "none";

  const openPopover = () => {
    const z = current?.timeZone && isValidZone(current.timeZone) ? current.timeZone : deviceZone;
    const atMs = current ? Date.parse(current.at) : NaN;
    // date and time are shown and entered in the zone of the reminder
    const wall = Number.isNaN(atMs) ? nextFullHourWall(now().getTime(), z) : instantToWall(atMs, z);
    setZone(z);
    setZoneOpen(false);
    setDate(formatWallDate(wall));
    setTime(formatWallTime(wall));
    setRepeat(current?.repeat ?? "none");
    setError(null);
    setOpen(true);
  };

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    dateRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const zones = useMemo(() => {
    if (!open) return [];
    const list = supportedZones();
    return [...new Set([zone, deviceZone, ...list])].sort((a, b) => a.localeCompare(b));
  }, [open, zone, deviceZone]);

  /** Instant of the entered wall time in the reminder zone (DST gap → next valid minute). */
  const enteredMs = (): number | null => {
    const wall = wallFromInputs(date, time);
    return wall ? wallToInstant(wall, zone) : null;
  };

  const entered = open ? enteredMs() : null;
  const localHint =
    entered !== null && !sameWallAt(entered, zone, deviceZone)
      ? `Bei dir: ${formatInZone(entered, now().getTime(), deviceZone)}`
      : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ms = enteredMs();
    if (ms === null) {
      setError("Bitte Datum und Uhrzeit angeben");
      return;
    }
    if (repeat === "none" && ms <= now().getTime()) {
      setError(PAST_TEXT);
      return;
    }
    setError(null);
    setBusy(true);
    const ok = await onSave(new Date(ms).toISOString(), repeat, zone);
    setBusy(false);
    if (ok) close();
  };

  const remove = async () => {
    setBusy(true);
    const ok = await onRemove();
    setBusy(false);
    if (ok) close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      // keep focus inside the popover
      const items = [...(popRef.current?.querySelectorAll<HTMLElement>("input, select, button:not(:disabled)") ?? [])];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const label = current ? reminderLabel(current.at, current.timeZone, now(), deviceZone) : null;

  return (
    <div className={styles.control}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.bell} ${state === "scheduled" ? styles.scheduled : ""} ${state === "due" ? styles.due : ""}`}
        aria-label="Erinnerung"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        data-state={state}
        title={label ? `Erinnerung: ${label}` : "Erinnerung festlegen"}
        onClick={() => (open ? close(false) : openPopover())}
      >
        <BellIcon filled={state !== "none"} />
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          className={styles.popover}
          role="dialog"
          aria-label="Erinnerung festlegen"
          data-local-escape=""
          onKeyDown={onKeyDown}
        >
          <form onSubmit={(e) => void save(e)}>
            <p className={styles.current}>
              {current ? `${current.state === "due" ? "Fällig" : "Geplant"}: ${label}` : "Keine Erinnerung"}
            </p>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Datum</span>
                <input ref={dateRef} type="date" aria-label="Datum" value={date} onChange={(e) => setDate(e.target.value)} required />
              </label>
              <label className={styles.field}>
                <span>Uhrzeit</span>
                <input type="time" aria-label="Uhrzeit" value={time} onChange={(e) => setTime(e.target.value)} required />
              </label>
            </div>
            <p className={styles.zone}>
              <span>Zeitzone: {zone}</span>
              <button
                type="button"
                className={styles.link}
                aria-label="Zeitzone ändern"
                aria-expanded={zoneOpen}
                aria-controls={zoneOpen ? zoneId : undefined}
                onClick={() => setZoneOpen((v) => !v)}
              >
                {zoneOpen ? "fertig" : "ändern"}
              </button>
            </p>
            {zoneOpen && (
              <label className={styles.field} id={zoneId}>
                <span>Zeitzone der Erinnerung</span>
                <select aria-label="Zeitzone" value={zone} onChange={(e) => setZone(e.target.value)}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {localHint && (
              <p className={styles.hint} aria-live="polite" data-local-hint="">
                {localHint}
              </p>
            )}
            <label className={styles.field}>
              <span>Wiederholung</span>
              <select aria-label="Wiederholung" value={repeat} onChange={(e) => setRepeat(e.target.value as ReminderRepeat)}>
                {REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {REMINDER_REPEAT_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={() => void remove()} disabled={busy || !current}>
                Entfernen
              </button>
              <button type="submit" className={styles.primary} disabled={busy}>
                Speichern
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export interface DueBannerProps {
  reminder: Reminder;
  onAck: () => void;
  onSnooze: (minutes: number) => void;
  now?: () => Date;
  deviceZone?: string;
}

/** Shown at the top of the active card while its reminder is due. */
export function DueBanner({ reminder, onAck, onSnooze, now = correctedNow, deviceZone = currentDeviceZone() }: DueBannerProps) {
  const label = reminderLabel(reminder.at, reminder.timeZone, now(), deviceZone);
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerText}>🔔 Erinnerung fällig – {label}</span>
      <span className={styles.bannerActions}>
        <button type="button" onClick={onAck}>
          Erledigt
        </button>
        <button type="button" onClick={() => onSnooze(10)}>
          10 Min. später
        </button>
        <button type="button" onClick={() => onSnooze(60)}>
          1 Std. später
        </button>
      </span>
    </div>
  );
}

/** Small bell + time on side (preview) cards. */
export function ReminderBadge({
  reminder,
  now = correctedNow,
  deviceZone = currentDeviceZone(),
}: {
  reminder: Reminder;
  now?: () => Date;
  deviceZone?: string;
}) {
  const label = reminderLabel(reminder.at, reminder.timeZone, now(), deviceZone);
  return (
    <span
      className={`${styles.badge} ${reminder.state === "due" ? styles.badgeDue : ""}`}
      data-reminder-badge={reminder.state}
      title={`Erinnerung${reminder.state === "due" ? " fällig" : ""}: ${label}`}
    >
      <BellIcon filled />
      <span>{label}</span>
    </span>
  );
}
