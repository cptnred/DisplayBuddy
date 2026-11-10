import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { insertAfter, move, normalizeIndex, removeAt } from "../../lib/carousel";
import { clock } from "../../lib/clock";
import { createKeyedDebouncer } from "../../lib/debounce";
import {
  NOTE_COLORS,
  NOTE_SCHEMA_VERSION,
  type Note,
  type NoteColor,
  type NotesChangedPayload,
  type Reminder,
  type ReminderRepeat,
  type SyncStatus,
} from "../../types";
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
  /** Reminders by note id (Rust owns them; replaced on every `reminders-changed`). */
  reminders: Record<string, Reminder>;
  /**
   * v3: bumped when the content of a note was replaced by a remote version, so the
   * open editor reloads it (`setContent(…, { emitUpdate: false })`).
   */
  remoteRevision: Record<string, number>;
  /** v3: transient German hint about remote changes (e.g. active note deleted elsewhere). */
  syncNotice: string | null;
  /** v3: last sync status (null until known). */
  sync: SyncStatus | null;
}

export const REMOTE_DELETED_TEXT = "Diese Notiz wurde auf einem anderen Gerät gelöscht.";
export const NOTICE_MS = 5000;

export const REMINDER_ERROR_TEXT = "Erinnerung konnte nicht gespeichert werden";

function reminderMap(list: Reminder[]): Record<string, Reminder> {
  const map: Record<string, Reminder> = {};
  for (const r of list) map[r.noteId] = r;
  return map;
}

const COLOR_ORDER = Object.keys(NOTE_COLORS) as NoteColor[];

export function nextColor(current: NoteColor | undefined): NoteColor {
  if (!current) return COLOR_ORDER[0];
  return COLOR_ORDER[(COLOR_ORDER.indexOf(current) + 1) % COLOR_ORDER.length];
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
  /** `at` = RFC 3339 or null (remove). Resolves false on error (action banner shown). */
  setReminder(noteId: string, at: string | null, repeat: ReminderRepeat, timeZone?: string | null): Promise<boolean>;
  ackReminder(noteId: string): Promise<boolean>;
  snoozeReminder(noteId: string, minutes: number): Promise<boolean>;
  /** Selects the note with this id (waits for the initial load). False if unknown. */
  openNote(noteId: string): Promise<boolean>;
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
    reminders: {},
    remoteRevision: {},
    syncNotice: null,
    sync: null,
  };
  const listeners = new Set<() => void>();
  const failing = new Set<string>();
  /** Notes being deleted (until `delete_note` finished): no saves, no remote copies. */
  const deleted = new Set<string>();
  /** `notes-changed` payloads that arrived while the initial list was loading. */
  const remoteDuringLoad: NotesChangedPayload[] = [];
  let createQueued = false;
  /** Bumped by every reminders update so a late initial list never overwrites newer data. */
  let remindersVersion = 0;
  const replaceReminders = (list: Reminder[]) => {
    remindersVersion++;
    set({ reminders: reminderMap(list) });
  };
  const putReminder = (noteId: string, r: Reminder | null) => {
    remindersVersion++;
    const reminders = { ...state.reminders };
    if (r) reminders[r.noteId] = r;
    else delete reminders[noteId];
    set({ reminders });
  };
  const loadReminders = async () => {
    const version = remindersVersion;
    try {
      const list = await api.listReminders();
      if (version === remindersVersion) replaceReminders(list);
    } catch (error) {
      console.error("[notes] loading reminders failed", error);
    }
  };
  const reminderAction = async (noteId: string, run: () => Promise<Reminder | null>): Promise<boolean> => {
    try {
      putReminder(noteId, await run());
      return true;
    } catch (error) {
      reportActionError(REMINDER_ERROR_TEXT, error);
      return false;
    }
  };
  let actionErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Notes with a save currently running (not visible in `saver.pending()`). */
  const inFlight = new Map<string, number>();
  const hasLocalChange = (id: string) =>
    saver.pending().includes(id) || (inFlight.get(id) ?? 0) > 0 || failing.has(id) || deleted.has(id);

  const showNotice = (message: string) => {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ syncNotice: message });
    noticeTimer = setTimeout(() => set({ syncNotice: null }), NOTICE_MS);
  };

  const applySyncStatus = (s: SyncStatus) => {
    // stamps use the corrected device clock (§5.3); without sync the offset is 0
    clock.setOffsetMs(s.enabled ? s.clockOffsetMs : 0);
    set({ sync: s });
  };

  /**
   * Remote changes merged by Rust (`notes-changed`). Notes with an unsaved or running
   * local save keep the local version (it is newer and will be pushed); everything else
   * takes the remote version. The editor of the active note reloads via `remoteRevision`.
   */
  const applyRemote = (p: NotesChangedPayload) => {
    // The initial list may have been read before this merge: replay after the load.
    if (state.status !== "ready") {
      remoteDuringLoad.push(p);
      return;
    }
    const activeId = state.notes[state.activeIndex]?.id;
    let notes = state.notes.slice();
    const remoteRevision = { ...state.remoteRevision };
    for (const remote of p.notes) {
      if (hasLocalChange(remote.id)) continue;
      const idx = notes.findIndex((n) => n.id === remote.id);
      if (idx < 0) {
        notes.push(remote);
        continue;
      }
      if (JSON.stringify(notes[idx].content) !== JSON.stringify(remote.content)) {
        remoteRevision[remote.id] = (remoteRevision[remote.id] ?? 0) + 1;
      }
      notes[idx] = remote;
    }
    let activeDeleted = false;
    for (const id of p.deletedIds) {
      if (hasLocalChange(id)) continue; // a pending save brings the note back (newer edit)
      const before = notes.length;
      notes = notes.filter((n) => n.id !== id);
      if (notes.length !== before && id === activeId) activeDeleted = true;
    }
    if (p.order) {
      const rank = new Map(p.order.map((id, i) => [id, i]));
      notes = notes
        .map((n, i) => ({ n, i }))
        .sort((a, b) => (rank.get(a.n.id) ?? p.order!.length + a.i) - (rank.get(b.n.id) ?? p.order!.length + b.i))
        .map((x) => x.n);
    }
    let activeIndex = activeId ? notes.findIndex((n) => n.id === activeId) : -1;
    if (activeIndex < 0) {
      // neighbour of the removed active note
      activeIndex = notes.length === 0 ? 0 : Math.min(state.activeIndex, notes.length - 1);
    }
    set({ notes, activeIndex, remoteRevision });
    if (activeDeleted) {
      showNotice(REMOTE_DELETED_TEXT);
      persistActiveId();
    }
  };

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
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    try {
      await runSaveInner(id, note);
    } finally {
      const n = (inFlight.get(id) ?? 1) - 1;
      if (n > 0) inFlight.set(id, n);
      else inFlight.delete(id);
    }
  };

  const runSaveInner = async (id: string, note: Note): Promise<void> => {
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
      // Keep the change pending – with the *latest* state of this note, never the failed
      // snapshot: a newer one may already be chained behind this run (not in pending()).
      const latest = state.notes.find((n) => n.id === id) ?? note;
      if (!deleted.has(id) && !saver.pending().includes(id)) saver.schedule(id, latest);
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

  // Order saves are serialized: async commands run concurrently on the Rust side, so two
  // quick reorders could otherwise be applied out of order. The ids are captured now.
  let orderTail: Promise<void> = Promise.resolve();
  const persistOrder = (): Promise<void> => {
    const ids = state.notes.map((n) => n.id);
    orderTail = orderTail
      .then(() => api.saveOrder(ids))
      .catch((error: unknown) => reportActionError("Reihenfolge konnte nicht gespeichert werden", error));
    return orderTail;
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
    remoteDuringLoad.splice(0).forEach(applyRemote);
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
      if (!loadPromise) {
        loadPromise = doLoad();
        void loadReminders();
        api.syncStatus().then(applySyncStatus, (error: unknown) => console.error("[notes] sync status failed", error));
      }
      return loadPromise;
    },

    updateNote(id, patch) {
      const idx = state.notes.findIndex((n) => n.id === id);
      if (idx < 0 || deleted.has(id)) return;
      const updated: Note = { ...state.notes[idx], ...patch, updatedAt: clock.correctedNowIso() };
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
      const now = clock.correctedNowIso();
      const note: Note = {
        id: crypto.randomUUID(),
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
      // a newer edit from another device may bring the note back (LWW), so stop ignoring it
      deleted.delete(note.id);
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
      await Promise.all([saver.flush(), activeIdSaver.flush(), orderTail]);
    },

    setReminder: (noteId, at, repeat, timeZone = null) =>
      reminderAction(noteId, () => api.setReminder(noteId, at, repeat, timeZone)),
    ackReminder: (noteId) => reminderAction(noteId, () => api.ackReminder(noteId)),
    snoozeReminder: (noteId, minutes) => reminderAction(noteId, () => api.snoozeReminder(noteId, minutes)),

    async openNote(noteId) {
      // queued behind the initial load (the event may arrive while the window is still loading)
      await ctrl.load();
      const idx = state.notes.findIndex((n) => n.id === noteId);
      if (idx < 0) return false;
      ctrl.select(idx);
      return true;
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
        api.onRemindersChanged((list) => replaceReminders(list)),
        api.onSyncStatus((s) => applySyncStatus(s)),
        api.onNotesChanged((p) => applyRemote(p)),
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
        if (noticeTimer) clearTimeout(noticeTimer);
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
  setReminder: NotesController["setReminder"];
  ackReminder: NotesController["ackReminder"];
  snoozeReminder: NotesController["snoozeReminder"];
  openNote: NotesController["openNote"];
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
    setReminder: ctrl.setReminder,
    ackReminder: ctrl.ackReminder,
    snoozeReminder: ctrl.snoozeReminder,
    openNote: ctrl.openNote,
  };
}
