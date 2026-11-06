/**
 * /notes/<id>: title, colour, the shared TipTap editor (NoteEditor/Toolbar from
 * src/components/editor), reminder, delete. Autosave 500 ms after the last change
 * (PLAN_V3_SYNC §9.2) through the keyed debouncer used by the desktop.
 * Remote changes reload the note only when no local save is pending (§8 rule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { NoteEditor } from "../../../components/editor/NoteEditor";
import { createKeyedDebouncer } from "../../../lib/debounce";
import { NOTE_COLORS, type Note, type NoteColor, type Reminder } from "../../../types";
import { formatReminderAt } from "../format";
import { useNow } from "../hooks";
import { ReminderDialog } from "../ReminderDialog";
import { Link, useRouter } from "../router";
import { useSaveTracker } from "../saves";
import { useServices } from "../services";
import styles from "../ui.module.css";

export const AUTOSAVE_MS = 500;
const SOURCE = "note-page";

export function NotePage({ id, reminder }: { id: string; reminder: Reminder | null }) {
  const { store, deviceZone } = useServices();
  const saves = useSaveTracker();
  const { navigate } = useRouter();
  const now = useNow();
  const [note, setNote] = useState<Note | null | undefined>(undefined);
  const [editorKey, setEditorKey] = useState(0);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef<Note | null>(null);
  const running = useRef(0);
  const { report } = saves;

  const debouncer = useMemo(() => {
    const d = createKeyedDebouncer<Note>(
      AUTOSAVE_MS,
      async (_key, value) => {
        running.current++;
        try {
          await store.saveNote(value);
        } finally {
          running.current--;
          // a queued run starts in a microtask; check after it had the chance
          setTimeout(() => {
            if (d.pending().length === 0 && running.current === 0) report(SOURCE, false);
          }, 0);
        }
      },
      { onError: () => setError("Speichern fehlgeschlagen. Die Änderung bleibt hier stehen.") },
    );
    return d;
  }, [store, report]);

  const idle = useCallback(() => debouncer.pending().length === 0 && running.current === 0, [debouncer]);

  const schedule = useCallback(
    (next: Note, immediate = false) => {
      draft.current = next;
      setError(null);
      report(SOURCE, true);
      debouncer.schedule(next.id, next);
      if (immediate) void debouncer.flush(next.id);
    },
    [debouncer, report],
  );

  // load + remote updates
  useEffect(() => {
    let alive = true;
    const load = async (remount: boolean) => {
      const n = await store.getNote(id);
      if (!alive) return;
      draft.current = n;
      setNote(n);
      if (remount) setEditorKey((k) => k + 1);
    };
    void load(false);
    const off = store.subscribe((c) => {
      if (c.source === "local") return;
      if (c.kind !== "all" && c.kind !== "notes") return;
      if (c.ids && !c.ids.includes(id)) return;
      // never overwrite unsaved typing with a remote version
      if (!idle()) return;
      void load(true);
    });
    return () => {
      alive = false;
      off();
    };
  }, [store, id, idle]);

  // flush on leave; register for the update banner
  useEffect(() => {
    const off = saves.registerFlush(SOURCE, () => debouncer.flush());
    return () => {
      off();
      void debouncer.flush().then(() => report(SOURCE, false));
    };
  }, [debouncer, saves.registerFlush, report]);

  const onContent = useCallback(
    (doc: JSONContent) => {
      if (draft.current) schedule({ ...draft.current, content: doc });
    },
    [schedule],
  );

  if (note === undefined) {
    return (
      <main className={styles.main}>
        <p className={styles.muted}>Lade …</p>
      </main>
    );
  }
  if (note === null) {
    return (
      <main className={styles.main}>
        <p>Diese Notiz gibt es nicht (mehr).</p>
        <Link to="/" className={styles.linkButton}>
          Zur Übersicht
        </Link>
      </main>
    );
  }

  const color = NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow;
  const title = note.title.trim() || "Notiz ohne Titel";

  return (
    <main className={styles.main}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          aria-label={reminder && reminder.state !== "done" ? "Erinnerung ändern" : "Erinnerung setzen"}
          aria-expanded={reminderOpen}
          onClick={() => setReminderOpen((o) => !o)}
        >
          {reminder && reminder.state !== "done"
            ? `Erinnerung: ${formatReminderAt(reminder, deviceZone(), now)}`
            : "Erinnerung setzen"}
        </button>
      </div>
      {reminderOpen && (
        <ReminderDialog
          noteId={note.id}
          existing={reminder && reminder.state !== "done" ? reminder : null}
          onClose={() => setReminderOpen(false)}
        />
      )}
      <div className={styles.notePaper} style={{ background: color.value }}>
        <input
          className={styles.titleInput}
          value={note.title}
          placeholder="Titel"
          aria-label="Titel der Notiz"
          maxLength={200}
          onChange={(e) => {
            const next = { ...(draft.current ?? note), title: e.target.value };
            setNote(next);
            schedule(next);
          }}
        />
        <div className={styles.editorHost}>
          <NoteEditor key={`${note.id}:${editorKey}`} content={note.content} onChange={onContent} />
        </div>
      </div>
      <fieldset className={styles.colors} aria-label="Farbe der Notiz" style={{ border: "none", padding: 0, margin: 0 }}>
        {(Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
          <button
            key={c}
            type="button"
            className={styles.swatch}
            style={{ background: NOTE_COLORS[c].value }}
            aria-label={`Farbe ${NOTE_COLORS[c].label}`}
            aria-pressed={note.color === c}
            onClick={() => {
              const next = { ...(draft.current ?? note), color: c };
              setNote(next);
              schedule(next, true);
            }}
          />
        ))}
      </fieldset>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        {!confirmDelete ? (
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            aria-label={`Notiz „${title}“ löschen`}
            onClick={() => setConfirmDelete(true)}
          >
            Löschen
          </button>
        ) : (
          <>
            <span role="alert">Notiz wirklich löschen?</span>
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              aria-label="Ja, Notiz löschen"
              onClick={() => {
                debouncer.cancel(note.id);
                report(SOURCE, false);
                void store.deleteNote(note.id).then(() => navigate("/", { replace: true }));
              }}
            >
              Ja, löschen
            </button>
            <button type="button" className={styles.button} aria-label="Nicht löschen" onClick={() => setConfirmDelete(false)}>
              Abbrechen
            </button>
          </>
        )}
      </div>
    </main>
  );
}
