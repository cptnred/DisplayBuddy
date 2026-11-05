import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { insertAfter, move, normalizeIndex, removeAt } from "../../lib/carousel";
import { createKeyedDebouncer } from "../../lib/debounce";
import { NOTE_COLORS, NOTE_SCHEMA_VERSION, type Note, type NoteColor } from "../../types";
import { emptyDoc } from "./docText";

/** Autosave debounce per note (docs/PLAN.md §8). */
export const SAVE_DELAY_MS = 500;
/** Light debounce for persisting `activeNoteId`. */
export const ACTIVE_ID_DELAY_MS = 250;
/** Delay before the single immediate retry of a failed save. */
export const RETRY_DELAY_MS = 300;

export const SAVE_ERROR_TEXT = "Speichern fehlgeschlagen – wird erneut versucht";

export type NotePatch = Partial<Pick<Note, "title" | "color" | "content">>;

export interface NotesState {
  status: "loading" | "ready";
  /** German message if loading failed. */
  loadError: string | null;
  notes: Note[];
  activeIndex: number;
  pinned: boolean;
  /** At least one note failed to save and is pending a retry. */
  saveError: boolean;
  /** Transient German message for failed non-save actions (delete, order). */
  actionError: string | null;
}

const COLOR_ORDER = Object.keys(NOTE_COLORS) as NoteColor[];

export function nextColor(current: NoteColor | undefined): NoteColor {
  if (!current) return COLOR_ORDER[0];
  return COLOR_ORDER[(COLOR_ORDER.indexOf(current) + 1) % COLOR_ORDER.length];
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback (only for very old engines; WebView2 has randomUUID).
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface NotesController {
  subscribe(listener: () => void): () => void;
  getState(): NotesState;
  load(): Promise<void>;
  updateNote(id: string, patch: NotePatch): void;
  updateActive(patch: NotePatch): void;
  select(index: number): void;
  next(): void;
  prev(): void;
  createNote(): Promise<Note | null>;
  deleteActive(): Promise<void>;
  moveActive(delta: -1 | 1): void;
  setPinned(pinned: boolean): void;
  flushAll(): Promise<void>;
  /** Subscribes to backend events + page lifecycle; returns cleanup. */
  connect(): () => void;
}

/**
 * Framework-free notes state machine against `api`. The React hook below only wires it up.
 * All mutations update state synchronously; persistence happens in the background.
 */
export function createNotesController(): NotesController {
  let state: NotesState = {
    status: "loading",
    loadError: null,
    notes: [],
    activeIndex: 0,
    pinned: false,
    saveError: false,
    actionError: null,
  };
  const listeners = new Set<() => void>();
  const failing = new Set<string>();
  const deleted = new Set<string>();
  let createQueued = false;
  let actionErrorTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (patch: Partial<NotesState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const setFailing = (id: string, failed: boolean) => {
    if (failed) failing.add(id);
    else failing.delete(id);
    if (state.saveError !== failing.size > 0) set({ saveError: failing.size > 0 });
  };

  const reportActionError = (message: string, error: unknown) => {
    console.error(message, error);
    if (actionErrorTimer) clearTimeout(actionErrorTimer);
    set({ actionError: message });
    actionErrorTimer = setTimeout(() => set({ actionError: null }), 4000);
  };

  const runSave = async (id: string, note: Note): Promise<void> => {
    if (deleted.has(id)) return;
    try {
      await api.saveNote(note);
      setFailing(id, false);
      return;
    } catch (error) {
      console.error("[notes] save failed, retrying", error);
      setFailing(id, true);
    }
    await sleep(RETRY_DELAY_MS);
    if (deleted.has(id)) return setFailing(id, false);
    try {
      await api.saveNote(note);
      setFailing(id, false);
    } catch (error) {
      console.error("[notes] retry failed, keeping change pending", error);
      // keep it pending (unless a newer snapshot is already queued)
      if (!saver.pending().includes(id)) saver.schedule(id, note);
    }
  };

  const saver = createKeyedDebouncer<Note>(SAVE_DELAY_MS, runSave);
  const activeIdSaver = createKeyedDebouncer<string | null>(ACTIVE_ID_DELAY_MS, async (_k, activeNoteId) => {
    await api.saveSettings({ activeNoteId });
  });

  const persistActiveId = () => {
    const note = state.notes[state.activeIndex];
    activeIdSaver.schedule("activeNoteId", note ? note.id : null);
  };

  const persistOrder = async () => {
    try {
      await api.saveOrder(state.notes.map((n) => n.id));
    } catch (error) {
      reportActionError("Reihenfolge konnte nicht gespeichert werden", error);
    }
  };

  let loadPromise: Promise<void> | null = null;
  const doLoad = async (): Promise<void> => {
    try {
      const [notes, settings] = await Promise.all([api.listNotes(), api.loadSettings()]);
      const idx = settings.activeNoteId ? notes.findIndex((n) => n.id === settings.activeNoteId) : -1;
      set({ status: "ready", loadError: null, notes, activeIndex: Math.max(0, idx), pinned: settings.notesPinned });
    } catch (error) {
      console.error("[notes] load failed", error);
      set({ status: "ready", loadError: "Notizen konnten nicht geladen werden" });
    }
    if (createQueued) {
      createQueued = false;
      await ctrl.createNote();
    }
  };

  const activeNote = () => state.notes[state.activeIndex] as Note | undefined;

  const ctrl: NotesController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,

    load() {
      // idempotent: React StrictMode runs mount effects twice
      loadPromise ??= doLoad();
      return loadPromise;
    },

    updateNote(id, patch) {
      const idx = state.notes.findIndex((n) => n.id === id);
      if (idx < 0 || deleted.has(id)) return;
      const updated: Note = { ...state.notes[idx], ...patch, updatedAt: new Date().toISOString() };
      const notes = state.notes.slice();
      notes[idx] = updated;
      set({ notes });
      saver.schedule(id, updated);
    },

    updateActive(patch) {
      const note = activeNote();
      if (note) ctrl.updateNote(note.id, patch);
    },

    select(index) {
      const n = state.notes.length;
      if (n === 0) return;
      const target = normalizeIndex(index, n);
      if (target === state.activeIndex) return;
      const prevId = activeNote()?.id;
      set({ activeIndex: target });
      void (async () => {
        if (prevId) await saver.flush(prevId);
        persistActiveId();
      })();
    },
    next: () => ctrl.select(state.activeIndex + 1),
    prev: () => ctrl.select(state.activeIndex - 1),

    async createNote() {
      if (state.status === "loading") {
        createQueued = true;
        return null;
      }
      const current = activeNote();
      const now = new Date().toISOString();
      const note: Note = {
        id: newId(),
        title: "",
        color: nextColor(current?.color),
        content: emptyDoc(),
        createdAt: now,
        updatedAt: now,
        schemaVersion: NOTE_SCHEMA_VERSION,
      };
      const r = insertAfter(state.notes, state.activeIndex, note);
      set({ notes: r.items, activeIndex: r.active });
      const flushPrev = current ? saver.flush(current.id) : Promise.resolve();
      // save immediately (through the saver so retries/serialisation apply), then the order
      saver.schedule(note.id, note);
      await Promise.all([flushPrev, saver.flush(note.id)]);
      await persistOrder();
      persistActiveId();
      return note;
    },

    async deleteActive() {
      const note = activeNote();
      if (!note) return;
      deleted.add(note.id);
      saver.cancel(note.id);
      const r = removeAt(state.notes, state.activeIndex);
      set({ notes: r.items, activeIndex: r.active });
      setFailing(note.id, false);
      await saver.flush(note.id); // wait for an in-flight save so it cannot resurrect the file
      try {
        await api.deleteNote(note.id);
      } catch (error) {
        reportActionError("Notiz konnte nicht gelöscht werden", error);
      }
      await persistOrder();
      persistActiveId();
    },

    moveActive(delta) {
      if (state.notes.length < 2) return;
      const r = move(state.notes, state.activeIndex, delta);
      set({ notes: r.items, activeIndex: r.active });
      void persistOrder();
    },

    setPinned(pinned) {
      set({ pinned });
      api.saveSettings({ notesPinned: pinned }).catch((error: unknown) => {
        reportActionError("Einstellung konnte nicht gespeichert werden", error);
      });
    },

    async flushAll() {
      await Promise.all([saver.flush(), activeIdSaver.flush()]);
    },

    connect() {
      let disposed = false;
      const subs = [
        api.onNotesHidden(() => void ctrl.flushAll()),
        api.onFlushRequest(() => {
          void ctrl
            .flushAll()
            .then(() => api.flushDone())
            .catch((error: unknown) => console.error("[notes] flush_done failed", error));
        }),
        api.onNoteCreateRequest(() => void ctrl.createNote()),
        api.onSettingsChanged((s) => {
          if (s.notesPinned !== state.pinned) set({ pinned: s.notesPinned });
        }),
      ];
      const onUnload = () => void ctrl.flushAll();
      window.addEventListener("beforeunload", onUnload);
      window.addEventListener("pagehide", onUnload);
      return () => {
        if (disposed) return;
        disposed = true;
        for (const p of subs) {
          Promise.resolve(p)
            .then((unlisten) => unlisten?.())
            .catch(() => {});
        }
        window.removeEventListener("beforeunload", onUnload);
        window.removeEventListener("pagehide", onUnload);
        if (actionErrorTimer) clearTimeout(actionErrorTimer);
        void ctrl.flushAll();
      };
    },
  };
  return ctrl;
}

export interface NotesStore extends NotesState {
  activeNote: Note | null;
  updateNote: NotesController["updateNote"];
  updateActive: NotesController["updateActive"];
  select: NotesController["select"];
  next: NotesController["next"];
  prev: NotesController["prev"];
  createNote: NotesController["createNote"];
  deleteActive: NotesController["deleteActive"];
  moveActive: NotesController["moveActive"];
  setPinned: NotesController["setPinned"];
  flushAll: NotesController["flushAll"];
}

/** React binding: loads on mount, subscribes to backend events, cleans up on unmount. */
export function useNotesStore(): NotesStore {
  const [ctrl] = useState(createNotesController);
  const state = useSyncExternalStore(ctrl.subscribe, ctrl.getState);

  useEffect(() => {
    void ctrl.load();
  }, [ctrl]);
  useEffect(() => ctrl.connect(), [ctrl]);

  return {
    ...state,
    activeNote: state.notes[state.activeIndex] ?? null,
    updateNote: ctrl.updateNote,
    updateActive: ctrl.updateActive,
    select: ctrl.select,
    next: ctrl.next,
    prev: ctrl.prev,
    createNote: ctrl.createNote,
    deleteActive: ctrl.deleteActive,
    moveActive: ctrl.moveActive,
    setPinned: ctrl.setPinned,
    flushAll: ctrl.flushAll,
  };
}
