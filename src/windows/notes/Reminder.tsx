import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { formatReminder, fromRfc3339, nextFullHour, parseLocal, toDateInput, toRfc3339Local, toTimeInput } from "../../lib/datetime";
import { REMINDER_REPEAT_LABELS, type Reminder, type ReminderRepeat } from "../../types";
import styles from "./Reminder.module.css";

export const PAST_TEXT = "Zeitpunkt liegt in der Vergangenheit";

const REPEATS = Object.keys(REMINDER_REPEAT_LABELS) as ReminderRepeat[];

/** A reminder that still matters for the UI (done = acknowledged, shown like none). */
export function activeReminder(r: Reminder | undefined | null): Reminder | null {
  return r && (r.state === "scheduled" || r.state === "due") ? r : null;
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
  /** Resolve true when stored (popover closes), false on error. */
  onSave: (at: string, repeat: ReminderRepeat) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  /** For tests: the current time. */
  now?: () => Date;
}

/** Bell button in the active card header + popover editor. */
export function ReminderControl({ reminder, onSave, onRemove, now = () => new Date() }: ReminderControlProps) {
  const current = activeReminder(reminder);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [repeat, setRepeat] = useState<ReminderRepeat>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const popId = useId();
  const state = current?.state ?? "none";

  const openPopover = () => {
    const parts = current ? fromRfc3339(current.at) : null;
    const fallback = nextFullHour(now());
    setDate(parts?.date ?? toDateInput(fallback));
    setTime(parts?.time ?? toTimeInput(fallback));
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

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const d = parseLocal(date, time);
    if (!d) {
      setError("Bitte Datum und Uhrzeit angeben");
      return;
    }
    if (repeat === "none" && d.getTime() <= now().getTime()) {
      setError(PAST_TEXT);
      return;
    }
    setError(null);
    setBusy(true);
    const ok = await onSave(toRfc3339Local(date, time), repeat);
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

  const label = current ? formatReminder(current.at, now()) : null;

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
}

/** Shown at the top of the active card while its reminder is due. */
export function DueBanner({ reminder, onAck, onSnooze, now = () => new Date() }: DueBannerProps) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerText}>🔔 Erinnerung fällig – {formatReminder(reminder.at, now())}</span>
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
export function ReminderBadge({ reminder, now = () => new Date() }: { reminder: Reminder; now?: () => Date }) {
  const label = formatReminder(reminder.at, now());
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
