/**
 * In-memory fake of the web DataStore (src/web/contract.ts, PLAN_V3_SYNC §9.2).
 *
 * Used by the UI tests and – until phase C1 lands – by the temporary data shim.
 * Behaves like the real store where the UI can observe it: notes in the saved order,
 * `updatedAt` stamped from the injected clock, reminder math only via
 * src/lib/schedule.ts / src/lib/zoned.ts, an outbox counter, change events.
 */
import { createClock, type Clock } from "../../../lib/clock";
import {
  ackReminder as ackMath,
  fire,
  parseInstant,
  setReminderWall,
  snoozeReminder as snoozeMath,
} from "../../../lib/schedule";
import { deviceZone as intlDeviceZone, wallFromInputs } from "../../../lib/zoned";
import type { Note, Reminder, ReminderRepeat } from "../../../types";
import type { Account, DataChange, DataStore, DataStoreOptions } from "../../contract";

export interface FakeDataStore extends DataStore {
  /** Test helper: sets the signed-in account (the fake sync engine calls this on login). */
  setAccount(account: Account | null): void;
  /** Test helper: puts a note/reminder in as if it came from the server (no outbox). */
  seedNote(note: Note): void;
  seedReminder(reminder: Reminder): void;
  /** Test helper: empties the outbox (as after a successful sync). */
  clearOutbox(): void;
  /** Test helper: emits a change as if another tab / the sync engine changed data. */
  emit(change: DataChange): void;
  /** Number of saveNote calls (autosave tests). */
  readonly saveCount: number;
}

export interface FakeStoreOptions extends DataStoreOptions {
  account?: Account | null;
  notes?: Note[];
  reminders?: Reminder[];
}

const clone = <T>(v: T): T => structuredClone(v);

export function createFakeStore(options: FakeStoreOptions = {}): FakeDataStore {
  const clock: Clock = options.clock ?? createClock();
  const zone = options.deviceZone ?? intlDeviceZone;
  const notes = new Map<string, Note>();
  const reminders = new Map<string, Reminder>();
  let order: string[] = [];
  let account: Account | null = options.account ?? null;
  const outbox = new Set<string>();
  const listeners = new Set<(c: DataChange) => void>();
  let saveCount = 0;

  for (const n of options.notes ?? []) {
    notes.set(n.id, clone(n));
    order.push(n.id);
  }
  for (const r of options.reminders ?? []) reminders.set(r.noteId, clone(r));

  const emit = (change: DataChange) => {
    for (const l of [...listeners]) l(change);
  };
  const now = () => clock.correctedNow();
  const nowIso = () => clock.correctedNowIso();

  const writeReminder = (r: Reminder) => {
    reminders.set(r.noteId, clone(r));
    outbox.add(`reminder:${r.noteId}`);
    emit({ kind: "reminders", ids: [r.noteId], source: "local" });
    return clone(r);
  };

  const store: FakeDataStore = {
    clock,
    get saveCount() {
      return saveCount;
    },

    async listNotes() {
      const known = order.filter((id) => notes.has(id));
      const rest = [...notes.values()]
        .filter((n) => !known.includes(n.id))
        .sort((a, b) => (parseInstant(a.createdAt) ?? 0) - (parseInstant(b.createdAt) ?? 0))
        .map((n) => n.id);
      return [...known, ...rest].map((id) => clone(notes.get(id) as Note));
    },
    async getNote(id) {
      const n = notes.get(id);
      return n ? clone(n) : null;
    },
    async saveNote(note) {
      saveCount++;
      const stored: Note = { ...clone(note), updatedAt: nowIso() };
      const isNew = !notes.has(note.id);
      notes.set(note.id, stored);
      if (isNew && !order.includes(note.id)) order = [...order, note.id];
      outbox.add(`note:${note.id}`);
      emit({ kind: "notes", ids: [note.id], source: "local" });
      return clone(stored);
    },
    async deleteNote(id) {
      notes.delete(id);
      order = order.filter((x) => x !== id);
      outbox.add(`note:${id}`);
      if (reminders.delete(id)) outbox.add(`reminder:${id}`);
      emit({ kind: "notes", ids: [id], source: "local" });
      emit({ kind: "reminders", ids: [id], source: "local" });
    },
    async getOrder() {
      return [...order];
    },
    async saveOrder(ids) {
      order = [...ids];
      outbox.add("order:order");
      emit({ kind: "order", source: "local" });
    },

    async listReminders() {
      return [...reminders.values()].map(clone);
    },
    async getReminder(noteId) {
      const r = reminders.get(noteId);
      return r ? clone(r) : null;
    },
    async setReminder(noteId, wallDate, wallTime, timeZone, repeat: ReminderRepeat) {
      if (!notes.has(noteId)) throw new Error("note not found");
      const wall = wallFromInputs(wallDate, wallTime);
      if (!wall) throw new Error("invalid date/time");
      const r = setReminderWall(reminders.get(noteId) ?? null, noteId, wall, repeat, timeZone, now());
      return writeReminder(r);
    },
    async removeReminder(noteId) {
      if (reminders.delete(noteId)) {
        outbox.add(`reminder:${noteId}`);
        emit({ kind: "reminders", ids: [noteId], source: "local" });
      }
    },
    async ackReminder(noteId) {
      const r = reminders.get(noteId);
      if (!r) return null;
      return writeReminder(ackMath(r, now(), zone()));
    },
    async snoozeReminder(noteId, minutes) {
      const r = reminders.get(noteId);
      if (!r) throw new Error("reminder not found");
      return writeReminder(snoozeMath(r, minutes, now()));
    },
    async markDue(noteId, at) {
      const r = reminders.get(noteId);
      if (!r || r.state !== "scheduled") return null;
      const a = parseInstant(r.at);
      const b = parseInstant(at);
      if (a === null || b === null || a !== b || a > now()) return null;
      const fired = fire(r, now());
      reminders.set(noteId, fired);
      emit({ kind: "reminders", ids: [noteId], source: "local" });
      return clone(fired);
    },

    async pendingCount() {
      return outbox.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async getAccount() {
      return account ? { ...account } : null;
    },
    async signOut() {
      notes.clear();
      reminders.clear();
      order = [];
      outbox.clear();
      account = null;
      emit({ kind: "all", source: "local" });
    },

    setAccount(a) {
      account = a ? { ...a } : null;
      emit({ kind: "account", source: "local" });
    },
    seedNote(n) {
      notes.set(n.id, clone(n));
      if (!order.includes(n.id)) order = [...order, n.id];
      emit({ kind: "notes", ids: [n.id], source: "remote" });
    },
    seedReminder(r) {
      reminders.set(r.noteId, clone(r));
      emit({ kind: "reminders", ids: [r.noteId], source: "remote" });
    },
    clearOutbox() {
      outbox.clear();
    },
    emit,
  };
  return store;
}

/** Same signature as the real `openDataStore` (contract `OpenDataStore`). */
export async function openFakeDataStore(options?: DataStoreOptions): Promise<DataStore> {
  return createFakeStore(options);
}
