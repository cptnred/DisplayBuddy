import { useState } from "react";
import type { Note, Reminder } from "../../types";
import { formatReminderAt } from "./format";
import { useNow } from "./hooks";
import { Link } from "./router";
import { useServices } from "./services";
import styles from "./ui.module.css";

export function noteLabel(note: Note | undefined): string {
  return note?.title.trim() || "Notiz ohne Titel";
}

/**
 * Due reminders with „Erledigt“ / „10 Min. später“ (PLAN_V3_SYNC §9.5). On iOS this is
 * the only place for these actions (no notification buttons there).
 */
export function DueBanner({ reminders, notes }: { reminders: Reminder[]; notes: Note[] }) {
  const { store, deviceZone } = useServices();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const due = reminders.filter((r) => r.state === "due");
  if (due.length === 0) return null;
  const byId = new Map(notes.map((n) => [n.id, n]));

  const act = async (noteId: string, action: () => Promise<unknown>) => {
    setBusy(noteId);
    setError(null);
    try {
      await action();
    } catch {
      setError("Die Erinnerung konnte nicht geändert werden.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`${styles.banner} ${styles.due}`} aria-label="Fällige Erinnerungen">
      <strong>{due.length === 1 ? "1 fällige Erinnerung" : `${due.length} fällige Erinnerungen`}</strong>
      <ul className={styles.dueList}>
        {due.map((r) => {
          const label = noteLabel(byId.get(r.noteId));
          return (
            <li key={r.noteId} className={styles.dueItem}>
              <span className={styles.dueText}>
                <Link to={`/notes/${r.noteId}`}>{label}</Link>
                <br />
                <span className={styles.muted}>{formatReminderAt(r, deviceZone(), now)}</span>
              </span>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                aria-label={`Erinnerung „${label}“ erledigt`}
                disabled={busy === r.noteId}
                onClick={() => void act(r.noteId, () => store.ackReminder(r.noteId))}
              >
                Erledigt
              </button>
              <button
                type="button"
                className={styles.button}
                aria-label={`Erinnerung „${label}“ 10 Minuten später`}
                disabled={busy === r.noteId}
                onClick={() => void act(r.noteId, () => store.snoozeReminder(r.noteId, 10))}
              >
                10 Min. später
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
