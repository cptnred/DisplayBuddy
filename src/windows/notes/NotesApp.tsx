import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { api } from "../../lib/api";
import type { Note, NoteColor } from "../../types";
import { Carousel } from "./Carousel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ActiveNoteCard, DefaultPreview, PreviewNoteCard, UNTITLED, type NoteEditorProps } from "./NoteCard";
import { DueBanner, ReminderBadge, ReminderControl, activeReminder } from "./Reminder";
import { SearchPanel, type SearchPanelHandle } from "./SearchPanel";
import { TitleBar } from "./TitleBar";
import { SAVE_ERROR_TEXT, useNotesStore } from "./useNotesStore";
import styles from "./NotesApp.module.css";

export type { NoteEditorProps } from "./NoteCard";

export interface NotesAppProps {
  Editor: ComponentType<NoteEditorProps>;
  renderPreview?: (note: Note) => ReactNode;
  /** Rendered below the carousel (v2: the shortcut bar). */
  footer?: ReactNode;
}

const defaultRenderPreview = (note: Note) => <DefaultPreview note={note} />;

function focusActiveEditor() {
  const slot = document.querySelector<HTMLElement>("[data-editor-slot]");
  const target =
    slot?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input') ??
    document.querySelector<HTMLInputElement>('input[aria-label="Titel"]');
  target?.focus();
}

export function NotesApp({ Editor, renderPreview = defaultRenderPreview, footer }: NotesAppProps) {
  const store = useNotesStore();
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Focus the editor of the next mounted active card (keyboard navigation, new note). */
  const [focusEditor, setFocusEditor] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<SearchPanelHandle>(null);
  /** Element focused before the search panel opened (focus returns there on Esc). */
  const beforeSearch = useRef<HTMLElement | null>(null);

  const n = store.notes.length;

  const requestDelete = useCallback(() => {
    if (store.activeNote) setConfirmOpen(true);
  }, [store.activeNote]);

  const confirmDelete = () => {
    setConfirmOpen(false);
    void store.deleteActive();
  };

  const createNote = useCallback(() => {
    setFocusEditor(true);
    void store.createNote();
  }, [store]);

  const openSearch = useCallback(() => {
    if (searchOpen) {
      searchRef.current?.focus();
      return;
    }
    const focused = document.activeElement;
    beforeSearch.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setSearchOpen(true);
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    const prev = beforeSearch.current;
    beforeSearch.current = null;
    requestAnimationFrame(() => {
      if (prev && prev.isConnected) prev.focus();
      else focusActiveEditor();
    });
  }, []);

  const pickSearchResult = useCallback(
    (noteId: string) => {
      setSearchOpen(false);
      beforeSearch.current = null;
      const idx = store.notes.findIndex((note) => note.id === noteId);
      if (idx >= 0) store.select(idx); // flushes the previous note's autosave
      requestAnimationFrame(() => focusActiveEditor());
    },
    [store],
  );

  // Latest values for the global key handler (registered once).
  const latest = useRef({ store, confirmOpen, createNote, searchOpen, openSearch, closeSearch });
  latest.current = { store, confirmOpen, createNote, searchOpen, openSearch, closeSearch };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const {
        store: s,
        confirmOpen: dialogOpen,
        createNote: create,
        searchOpen: searching,
        openSearch: search,
        closeSearch: endSearch,
      } = latest.current;
      if (e.key === "Escape") {
        // Popovers (e.g. the editor's colour palette) close themselves on Esc.
        if (e.target instanceof Element && e.target.closest("[data-local-escape]")) return;
        e.preventDefault();
        e.stopPropagation();
        if (dialogOpen) setConfirmOpen(false);
        else if (searching) endSearch();
        else void api.hideNotes().catch((err: unknown) => console.error("[notes] hide failed", err));
        return;
      }
      if (dialogOpen || !e.ctrlKey || e.altKey || e.metaKey) return;
      if (!e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        search();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // inside the search field Ctrl+Arrow keeps its word-jump meaning
        if (searching) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        if (e.shiftKey) {
          s.moveActive(delta);
        } else if (s.notes.length > 1) {
          setFocusEditor(true);
          if (delta < 0) s.prev();
          else s.next();
        }
        return;
      }
      if (!e.shiftKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(false);
        create();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const sub = api.onNotesShown(() => {
      // wait one frame so the window is actually visible/focusable
      requestAnimationFrame(() => focusActiveEditor());
    });
    return () => {
      Promise.resolve(sub)
        .then((un) => un?.())
        .catch(() => {});
    };
  }, []);

  // open-note (buddy badge / toast): select the note (queued behind the initial load) and focus it
  useEffect(() => {
    const sub = api.onOpenNote((noteId) => {
      setSearchOpen(false);
      setConfirmOpen(false);
      void latest.current.store.openNote(noteId).then((found) => {
        if (found) requestAnimationFrame(() => focusActiveEditor());
      });
    });
    return () => {
      Promise.resolve(sub)
        .then((un) => un?.())
        .catch(() => {});
    };
  }, []);

  // After a keyboard-driven switch the new card mounts with autoFocus; reset the flag afterwards.
  useEffect(() => {
    if (focusEditor) setFocusEditor(false);
  }, [store.activeNote?.id, focusEditor]);

  const renderActive = (note: Note) => {
    const reminder = activeReminder(store.reminders[note.id]);
    return (
      <ActiveNoteCard
        note={note}
        Editor={Editor}
        autoFocusEditor={focusEditor}
        onTitleChange={(title) => store.updateNote(note.id, { title })}
        onColorChange={(color: NoteColor) => store.updateNote(note.id, { color })}
        // bound to this note's id: a late onChange from an unmounting editor can never hit another note
        onContentChange={(content: JSONContent) => store.updateNote(note.id, { content })}
        banner={
          reminder?.state === "due" ? (
            <DueBanner
              reminder={reminder}
              onAck={() => void store.ackReminder(note.id)}
              onSnooze={(minutes) => void store.snoozeReminder(note.id, minutes)}
            />
          ) : null
        }
        headerExtra={
          <ReminderControl
            key={note.id}
            reminder={reminder}
            onSave={(at, repeat) => store.setReminder(note.id, at, repeat)}
            onRemove={() => store.setReminder(note.id, null, "none")}
          />
        }
      />
    );
  };

  const renderPreviewCard = (note: Note) => {
    const reminder = activeReminder(store.reminders[note.id]);
    return (
      <PreviewNoteCard note={note} badge={reminder ? <ReminderBadge reminder={reminder} /> : null}>
        {renderPreview(note)}
      </PreviewNoteCard>
    );
  };

  return (
    <div className={styles.app}>
      <TitleBar
        pinned={store.pinned}
        canDelete={n > 0}
        onNew={createNote}
        onDelete={requestDelete}
        onTogglePin={() => store.setPinned(!store.pinned)}
        onClose={() => void api.hideNotes().catch((err: unknown) => console.error("[notes] hide failed", err))}
        onSearch={openSearch}
        searchOpen={searchOpen}
      />

      {(store.saveError || store.actionError || store.loadError) && (
        <div className={styles.banner} role="alert">
          {store.saveError ? SAVE_ERROR_TEXT : (store.loadError ?? store.actionError)}
        </div>
      )}

      <main className={styles.main}>
        {store.status === "loading" ? (
          <div className={styles.loading} aria-busy="true" aria-label="Notizen werden geladen" />
        ) : n === 0 ? (
          <div className={styles.empty}>
            <svg className={styles.emptyIcon} viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
              <rect x="10" y="12" width="40" height="44" rx="8" fill="#ECE3FB" transform="rotate(-8 30 34)" />
              <rect x="14" y="8" width="40" height="44" rx="8" fill="#FFF6C7" stroke="#e8d98a" />
              <path d="M22 22h24M22 30h24M22 38h14" stroke="#c9b65a" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <p className={styles.emptyTitle}>Noch keine Notizen</p>
            <p className={styles.emptyText}>Halte Gedanken, Aufgaben und Ideen fest – sie bleiben hier für dich griffbereit.</p>
            <button type="button" className={styles.emptyButton} onClick={createNote}>
              Erste Notiz anlegen
            </button>
          </div>
        ) : (
          <Carousel
            items={store.notes}
            activeIndex={store.activeIndex}
            onSelect={(i) => {
              setFocusEditor(true);
              store.select(i);
            }}
            onStep={(d) => store.select(store.activeIndex + d)}
            getItemLabel={(note) => note.title || UNTITLED}
            renderActive={renderActive}
            renderPreview={renderPreviewCard}
          />
        )}
        {searchOpen && store.status === "ready" && (
          <SearchPanel ref={searchRef} notes={store.notes} onPick={pickSearchResult} onClose={closeSearch} />
        )}
      </main>

      {footer}

      <ConfirmDialog
        open={confirmOpen}
        title="Notiz wirklich löschen?"
        description="Das kann nicht rückgängig gemacht werden."
        confirmLabel="Löschen"
        cancelLabel="Abbrechen"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
