import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { searchNotes, type SnippetPart } from "../../lib/search";
import type { Note } from "../../types";
import { UNTITLED } from "./NoteCard";
import styles from "./SearchPanel.module.css";

export interface SearchPanelProps {
  notes: Note[];
  /** Jump to this note (panel closes afterwards). */
  onPick: (noteId: string) => void;
  onClose: () => void;
}

export interface SearchPanelHandle {
  /** Focus + select the query (Strg+F while already open). */
  focus(): void;
}

function Parts({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Overlay over the carousel: live search over all notes (docs/PLAN.md §12). */
export const SearchPanel = forwardRef<SearchPanelHandle, SearchPanelProps>(function SearchPanel({ notes, onPick, onClose }, ref) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const results = useMemo(() => searchNotes(notes, query), [notes, query]);
  const active = Math.min(selected, Math.max(0, results.length - 1));

  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSelected((active + d + results.length) % results.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) onPick(r.noteId);
    }
  };

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const hasQuery = query.trim().length > 0;

  return (
    <div className={styles.panel} role="search" data-local-escape="" onKeyDown={onKeyDown}>
      <div className={styles.field}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={styles.icon}>
          <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className={styles.input}
          type="search"
          role="combobox"
          aria-label="Notizen durchsuchen"
          aria-expanded={results.length > 0}
          aria-controls={`${baseId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
          placeholder="Notizen durchsuchen …"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
        />
        <button type="button" className={styles.close} aria-label="Suche schließen" title="Suche schließen (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={styles.count} aria-live="polite" aria-atomic="true">
        {hasQuery ? (results.length > 0 ? `${results.length} Treffer` : "Keine Treffer") : ""}
      </div>
      <ul ref={listRef} id={`${baseId}-list`} className={styles.list} role="listbox" aria-label="Suchergebnisse">
        {results.map((r, i) => (
          <li
            key={r.noteId}
            id={optionId(i)}
            data-index={i}
            role="option"
            aria-selected={i === active}
            className={`${styles.option} ${i === active ? styles.selected : ""}`}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
            onMouseEnter={() => setSelected(i)}
            onClick={() => onPick(r.noteId)}
          >
            <div className={`${styles.title} ${r.title ? "" : styles.untitled}`}>
              {r.title ? <Parts parts={r.titleParts} /> : UNTITLED}
            </div>
            {r.snippet.length > 0 && (
              <div className={styles.snippet}>
                <Parts parts={r.snippet} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
});
