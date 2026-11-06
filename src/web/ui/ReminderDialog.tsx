/**
 * Reminder dialog with zone (PLAN_V3_SYNC §5.5, §8 „Erinnerungs-Popover“, §9.5):
 * date and time are entered in the reminder's zone (default: device zone), the zone
 * picker is collapsed behind „Zeitzone: … – ändern“, and „Bei dir: …“ shows the device
 * time when the zones differ. All math via src/lib/zoned.ts; the store computes `at`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { parseInstant, reminderZone } from "../../lib/schedule";
import {
  formatWallDate,
  formatWallTime,
  instantToWall,
  isValidZone,
  sameWallAt,
  supportedZones,
  wallFromInputs,
  wallToInstant,
} from "../../lib/zoned";
import { REMINDER_REPEAT_LABELS, type Reminder, type ReminderRepeat } from "../../types";
import { reminderTimeText } from "./format";
import { useServices } from "./services";
import styles from "./ui.module.css";

const HOUR = 3_600_000;

/** Start values: existing reminder in its zone, else the next full hour in `zone`. */
export function initialInputs(existing: Reminder | null, zone: string, now: number): { date: string; time: string } {
  const at = existing ? parseInstant(existing.at) : null;
  if (at !== null) {
    const w = instantToWall(at, zone);
    return { date: formatWallDate(w), time: formatWallTime(w) };
  }
  const w = instantToWall(now, zone);
  const hourStart = wallToInstant({ ...w, minute: 0, second: 0, millisecond: 0 }, zone) ?? now;
  const next = instantToWall(hourStart + HOUR, zone);
  return { date: formatWallDate(next), time: formatWallTime(next) };
}

export interface ReminderDialogProps {
  noteId: string;
  existing: Reminder | null;
  onClose(): void;
}

export function ReminderDialog({ noteId, existing, onClose }: ReminderDialogProps) {
  const { store, deviceZone } = useServices();
  const device = deviceZone();
  const startZone = existing ? reminderZone(existing, device) : device;
  const [now] = useState(() => store.clock.correctedNow());
  const [init] = useState(() => initialInputs(existing, startZone, now));
  const [zone, setZone] = useState(startZone);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [repeat, setRepeat] = useState<ReminderRepeat>(existing?.repeat ?? "none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const zones = useMemo(() => {
    const list = supportedZones();
    return list.includes(zone) ? list : [zone, ...list];
  }, [zone]);

  useEffect(() => firstRef.current?.focus(), []);

  const wall = wallFromInputs(date, time);
  const at = wall ? wallToInstant(wall, zone) : null;
  const localHint =
    at !== null && !sameWallAt(at, zone, device) ? reminderTimeText(at, zone, device, now).local : null;

  const save = async () => {
    setError(null);
    if (!wall || at === null) {
      setError("Bitte ein gültiges Datum und eine gültige Uhrzeit eingeben.");
      return;
    }
    if (!isValidZone(zone)) {
      setError("Unbekannte Zeitzone.");
      return;
    }
    setSaving(true);
    try {
      await store.setReminder(noteId, date, time, zone, repeat);
      onClose();
    } catch {
      setError("Die Erinnerung konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await store.removeReminder(noteId);
      onClose();
    } catch {
      setError("Die Erinnerung konnte nicht entfernt werden.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={styles.dialog}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <h2 id={titleId}>{existing ? "Erinnerung ändern" : "Erinnerung setzen"}</h2>
      <div className={styles.row}>
        <label className={styles.field}>
          Datum
          <input
            ref={firstRef}
            className={styles.input}
            type="date"
            value={date}
            aria-label="Datum der Erinnerung"
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Uhrzeit
          <input
            className={styles.input}
            type="time"
            value={time}
            aria-label="Uhrzeit der Erinnerung"
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Wiederholung
          <select
            className={styles.select}
            value={repeat}
            aria-label="Wiederholung"
            onChange={(e) => setRepeat(e.target.value as ReminderRepeat)}
          >
            {(Object.keys(REMINDER_REPEAT_LABELS) as ReminderRepeat[]).map((r) => (
              <option key={r} value={r}>
                {REMINDER_REPEAT_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.row}>
        <span>Zeitzone: {zone}</span>
        <button
          type="button"
          className={styles.linkButton}
          aria-expanded={zoneOpen}
          aria-label={`Zeitzone ${zone} ändern`}
          onClick={() => setZoneOpen((o) => !o)}
        >
          {zoneOpen ? "fertig" : "ändern"}
        </button>
      </div>
      {zoneOpen && (
        <label className={styles.field}>
          Zeitzone der Erinnerung
          <select className={styles.select} value={zone} aria-label="Zeitzone" onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
      )}
      {localHint && (
        <p className={styles.muted} aria-live="polite">
          Bei dir: {localHint} ({device})
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={saving}
          aria-label="Erinnerung speichern"
          onClick={() => void save()}
        >
          Speichern
        </button>
        {existing && (
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={saving}
            aria-label="Erinnerung entfernen"
            onClick={() => void remove()}
          >
            Entfernen
          </button>
        )}
        <button type="button" className={styles.button} aria-label="Abbrechen" onClick={onClose}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
