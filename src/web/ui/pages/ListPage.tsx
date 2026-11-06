import { useMemo, useState } from "react";
import { noteSearchText, searchNotes, type SnippetPart } from "../../../lib/search";
import { NOTE_COLORS, type Note, type Reminder } from "../../../types";
import { formatReminderAt } from "../format";
import { useNow } from "../hooks";
import { Link } from "../router";
import { useServices } from "../services";
import styles from "../ui.module.css";

function Parts({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className={styles.mark}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const SNIPPET = 80;

export function ListPage({ notes, reminders, loaded }: { notes: Note[]; reminders: Reminder[]; loaded: boolean }) {
  const { deviceZone } = useServices();
  const now = useNow();
  const [query, setQuery] = useState("");
  const remindersById = useMemo(() => new Map(reminders.map((r) => [r.noteId, r])), [reminders]);
  const results = useMemo(() => (query.trim() ? searchNotes(notes, query) : null), [notes, query]);
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);

  const rows = results
    ? results.map((r) => ({ note: byId.get(r.noteId) as Note, title: r.titleParts, snippet: r.snippet }))
    : notes.map((n) => {
        const text = noteSearchText(n);
        return {
          note: n,
          title: n.title ? [{ text: n.title, match: false }] : [],
          snippet: [{ text: text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text, match: false }],
        };
      });

  return (
    <main className={styles.main}>
      <label className={styles.field}>
        <span className={styles.visuallyHidden}>Notizen durchsuchen</span>
        <input
          className={`${styles.input} ${styles.search}`}
          type="search"
          placeholder="Suchen …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Notizen durchsuchen"
        />
      </label>
      {loaded && notes.length === 0 && <p className={styles.muted}>Noch keine Notizen. Lege die erste an.</p>}
      {results && (
        <p className={styles.muted} role="status">
          {results.length === 0 ? "Keine Treffer." : results.length === 1 ? "1 Treffer" : `${results.length} Treffer`}
        </p>
      )}
      <ul className={styles.noteList} aria-label="Notizen">
        {rows.map(({ note, title, snippet }) => {
          const r = remindersById.get(note.id);
          return (
            <li key={note.id}>
              <Link
                to={`/notes/${note.id}`}
                className={styles.noteItem}
                style={{ background: (NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow).value }}
              >
                <span className={styles.noteTitle}>
                  {title.length > 0 ? <Parts parts={title} /> : "Notiz ohne Titel"}
                </span>
                <span className={styles.noteSnippet}>
                  <Parts parts={snippet} />
                </span>
                {r && r.state !== "done" && (
                  <span className={styles.chip}>
                    {r.state === "due" ? "Fällig: " : "Erinnerung: "}
                    {formatReminderAt(r, deviceZone(), now)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <Link to="/new" className={`${styles.button} ${styles.primary} ${styles.fab}`} aria-label="Neue Notiz anlegen">
        + Neue Notiz
      </Link>
    </main>
  );
}
