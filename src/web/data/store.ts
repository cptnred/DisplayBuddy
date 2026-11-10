/**
 * Local-first data layer (PLAN_V3_SYNC §9.2) over IndexedDB.
 *
 * - Every edit is stamped with the corrected device time (`clock.correctedNowIso()`) and
 *   written together with its outbox entry in ONE readwrite transaction.
 * - The outbox holds only the latest version per document (key `"<kind>:<id>"`, `put`
 *   overwrites = coalescing).
 * - Deletions are tombstones and take part in LWW (src/lib/sync/lww.ts).
 * - No DOM: usable in the service worker and in the native shell.
 * - Changes are announced to subscribers and, via `BroadcastChannel("buddy-data")`
 *   (MDN Broadcast Channel API), to other tabs of the same origin.
 *
 * The sync engine reaches the sync-only operations through {@link syncAccess}.
 */
import { clock as processClock, type Clock, medianOffset, pushOffset } from "../../lib/clock";
import { cmpStamp, noteWinner, orderWinner, reminderWinner } from "../../lib/sync/lww";
import type {
  NoteRecord,
  OrderRecord,
  PushResult,
  RecordKind,
  ReminderRecord,
  SyncChanges,
} from "../../lib/sync/types";
import {
  ackReminder as ackReminderMath,
  fire,
  parseInstant,
  setReminderWall,
  snoozeReminder as snoozeReminderMath,
} from "../../lib/schedule";
import { deviceZone as intlDeviceZone, isValidZone, wallFromInputs } from "../../lib/zoned";
import type { Note, Reminder, ReminderRepeat } from "../../types";
import type { Account, DataChange, DataStore, DataStoreOptions, SyncNotice } from "../contract";
import {
  ALL_STORES,
  type BuddyDatabase,
  DEFAULT_DB_NAME,
  deleteBuddyDb,
  getMeta,
  type MetaKey,
  type MetaValues,
  openBuddyDb,
  type OutboxEntry,
  outboxKey,
  type WriteTx,
} from "./db";

export const BROADCAST_CHANNEL = "buddy-data";

/** Result of applying server data (push results or pulled changes). */
export interface ApplyOutcome {
  notices: SyncNotice[];
  /** Push results with status "invalid" (dropped from the outbox). */
  invalid: PushResult[];
}

/** Sync-only operations on the store (not part of the UI contract). */
export interface SyncAccess {
  getDeviceId(): Promise<string>;
  /** Stores the account; if the device id changes, pending local stamps are re-attributed. */
  setAccount(account: Account): Promise<void>;
  getCursor(): Promise<number>;
  outbox(): Promise<OutboxEntry[]>;
  /** Applies `/sync/push` results for the entries sent (only unchanged entries leave the outbox). */
  applyPushResults(sent: OutboxEntry[], results: PushResult[]): Promise<ApplyOutcome>;
  /** LWW-merges one pulled page and stores its cursor in the same transaction. */
  mergeChanges(changes: Pick<SyncChanges, "cursor" | "notes" | "reminders" | "order">): Promise<ApplyOutcome>;
  /** After a full resync: puts live local documents the server did not send back into the outbox. */
  requeueUnseen(seenNotes: ReadonlySet<string>, seenReminders: ReadonlySet<string>): Promise<void>;
  /** Adds an offset sample, stores the last 5 and sets the clock to their median. */
  addClockSample(offsetMs: number): Promise<number>;
  getLastSyncAt(): Promise<string | null>;
  setLastSyncAt(at: string): Promise<void>;
  setPersisted(persisted: boolean): Promise<void>;
  /** Closes the connection and the BroadcastChannel (tests, shutdown). */
  close(): void;
}

const access = new WeakMap<DataStore, SyncAccess>();

/** The sync-only interface of a store created by `openDataStore`. */
export function syncAccess(store: DataStore): SyncAccess {
  const a = access.get(store);
  if (!a) throw new Error("this DataStore was not created by openDataStore (no sync access)");
  return a;
}

export function uuidV4(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  // insecure contexts lack randomUUID; getRandomValues is available everywhere
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface BroadcastMessage {
  db: string;
  kind: DataChange["kind"];
  ids?: string[];
}

/** Same version = same stamp (updatedAt as instant + updatedBy). */
function sameStamp(a: { updatedAt: string; updatedBy: string }, b: { updatedAt: string; updatedBy: string }): boolean {
  return cmpStamp(a.updatedAt, a.updatedBy, b.updatedAt, b.updatedBy) === 0;
}

function sameDeleted(a: OutboxEntry["record"], b: OutboxEntry["record"]): boolean {
  return ("deleted" in a ? a.deleted : false) === ("deleted" in b ? b.deleted : false);
}

function compareCreated(a: Note, b: Note): number {
  const ta = parseInstant(a.createdAt) ?? 0;
  const tb = parseInstant(b.createdAt) ?? 0;
  return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Stamp {
  ms: number;
  iso: string;
}

interface WriteCtx {
  deviceId: string;
  /** Corrected now (ms) – for logic that is not a document stamp (markDue). */
  nowMs: number;
  /** Stamp for a document edit: corrected now, but strictly after its previous stamp. */
  stamp(kind: RecordKind, id: string): Promise<Stamp>;
}

/**
 * Two edits of one document within the same millisecond (or after the corrected clock
 * stepped back) must still get distinct, increasing stamps; otherwise the server treats
 * the second as an echo of the first (full LWW tie, D-58) and drops it.
 */
export function nextStampMs(previous: string | null | undefined, nowMs: number): number {
  const prev = previous ? parseInstant(previous) : null;
  return prev !== null && prev >= nowMs ? prev + 1 : nowMs;
}

class IdbDataStore implements DataStore {
  readonly clock: Clock;
  private readonly name: string;
  private readonly factory: IDBFactory;
  private readonly deviceZone: () => string;
  private dbPromise: Promise<BuddyDatabase> | null = null;
  private readonly listeners = new Set<(change: DataChange) => void>();
  private readonly channel: BroadcastChannel | null;
  private closed = false;

  constructor(options: DataStoreOptions) {
    this.name = options.dbName ?? DEFAULT_DB_NAME;
    this.clock = options.clock ?? processClock;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available");
    this.factory = factory;
    this.deviceZone = options.deviceZone ?? intlDeviceZone;
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(BROADCAST_CHANNEL) : null;
    if (this.channel) {
      // Node: do not keep the process alive for the channel alone
      (this.channel as unknown as { unref?: () => void }).unref?.();
      this.channel.onmessage = (event: MessageEvent<BroadcastMessage>) => this.onBroadcast(event.data);
    }
  }

  // ---- connection ----------------------------------------------------------------

  db(): Promise<BuddyDatabase> {
    if (this.closed) return Promise.reject(new Error("data store is closed"));
    if (!this.dbPromise) {
      const p = openBuddyDb(this.factory, this.name, {
        onVersionChange: () => {
          // another tab deletes the database (sign-out): reopen lazily later
          this.dbPromise = null;
          this.emit({ kind: "all", source: "other-tab" });
        },
        onClose: () => {
          this.dbPromise = null;
        },
      }).then(async (db) => {
        await this.init(db);
        return db;
      });
      p.catch(() => {
        if (this.dbPromise === p) this.dbPromise = null;
      });
      this.dbPromise = p;
    }
    return this.dbPromise;
  }

  /** Device id on first open; clock offset from the last measurements (offline: last value). */
  private async init(db: BuddyDatabase): Promise<void> {
    const tx = db.transaction("meta", "readwrite");
    const meta = tx.objectStore("meta");
    if (!(await meta.get("deviceId"))) await meta.put(uuidV4(), "deviceId");
    const samples = (await meta.get("clockOffsets")) as number[] | undefined;
    await tx.done;
    if (samples && samples.length > 0) this.clock.setOffsetMs(medianOffset(samples));
  }

  private async reloadClock(): Promise<void> {
    try {
      const db = await this.db();
      const samples = (await db.get("meta", "clockOffsets")) as number[] | undefined;
      if (samples && samples.length > 0) this.clock.setOffsetMs(medianOffset(samples));
    } catch {
      // closed or deleted – nothing to reload
    }
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    void this.dbPromise?.then((db) => db.close()).catch(() => undefined);
    this.dbPromise = null;
  }

  // ---- change notification ---------------------------------------------------------

  subscribe(listener: (change: DataChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: DataChange): void {
    for (const l of [...this.listeners]) {
      try {
        l(change);
      } catch (e) {
        console.error("data change listener failed", e);
      }
    }
    if (change.source !== "other-tab" && this.channel) {
      const msg: BroadcastMessage = { db: this.name, kind: change.kind, ids: change.ids };
      try {
        this.channel.postMessage(msg);
      } catch {
        // channel closed
      }
    }
  }

  private onBroadcast(msg: BroadcastMessage | undefined): void {
    if (!msg || msg.db !== this.name) return;
    void this.reloadClock();
    this.emit({ kind: msg.kind, ids: msg.ids, source: "other-tab" });
  }

  // ---- write helper: record + outbox in ONE transaction ------------------------------

  private async write<T>(
    fn: (tx: WriteTx, ctx: WriteCtx) => Promise<T>,
    change: (result: T) => Omit<DataChange, "source"> | null,
  ): Promise<T> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, "readwrite");
    const done = tx.done;
    done.catch(() => undefined);
    let result: T;
    try {
      const deviceId = (await getMeta(tx, "deviceId")) ?? uuidV4();
      const nowMs = this.clock.correctedNow();
      const stamp = async (kind: RecordKind, id: string): Promise<Stamp> => {
        const prev =
          kind === "note"
            ? await tx.objectStore("notes").get(id)
            : kind === "reminder"
              ? await tx.objectStore("reminders").get(id)
              : await getMeta(tx, "order");
        const ms = nextStampMs(prev?.updatedAt, nowMs);
        return { ms, iso: new Date(ms).toISOString() };
      };
      result = await fn(tx, { deviceId, nowMs, stamp });
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      throw e;
    }
    await done;
    const c = change(result);
    if (c) this.emit({ ...c, source: "local" });
    return result;
  }

  private static async enqueue(tx: WriteTx, entry: Omit<OutboxEntry, "key">): Promise<void> {
    await tx.objectStore("outbox").put({ ...entry, key: outboxKey(entry.kind, entry.id) } as OutboxEntry);
  }

  private static async putNote(tx: WriteTx, rec: NoteRecord): Promise<void> {
    await tx.objectStore("notes").put(rec);
    await IdbDataStore.enqueue(tx, { kind: "note", id: rec.id, record: rec });
  }

  private static async putReminder(tx: WriteTx, rec: ReminderRecord): Promise<void> {
    await tx.objectStore("reminders").put(rec);
    await IdbDataStore.enqueue(tx, { kind: "reminder", id: rec.noteId, record: rec });
  }

  // ---- notes ------------------------------------------------------------------------

  async listNotes(): Promise<Note[]> {
    const db = await this.db();
    const tx = db.transaction(["notes", "meta"], "readonly");
    const [records, order] = await Promise.all([
      tx.objectStore("notes").getAll(),
      tx.objectStore("meta").get("order") as Promise<OrderRecord | undefined>,
    ]);
    await tx.done;
    const live = new Map<string, Note>();
    for (const r of records) if (!r.deleted && r.note) live.set(r.id, r.note);
    const out: Note[] = [];
    for (const id of order?.ids ?? []) {
      const n = live.get(id);
      if (n) {
        out.push(n);
        live.delete(id);
      }
    }
    out.push(...[...live.values()].sort(compareCreated));
    return out;
  }

  async getNote(id: string): Promise<Note | null> {
    const r = await (await this.db()).get("notes", id);
    return r && !r.deleted && r.note ? r.note : null;
  }

  async saveNote(note: Note): Promise<Note> {
    if (!note.id) throw new Error("note id missing");
    return this.write(
      async (tx, { deviceId, stamp }) => {
        const now = (await stamp("note", note.id)).iso;
        const stored: Note = { ...note, updatedAt: now };
        await IdbDataStore.putNote(tx, { id: note.id, updatedAt: now, updatedBy: deviceId, deleted: false, note: stored });
        return stored;
      },
      () => ({ kind: "notes", ids: [note.id] }),
    );
  }

  async deleteNote(id: string): Promise<void> {
    await this.write(
      async (tx, { deviceId, stamp }) => {
        const existing = await tx.objectStore("notes").get(id);
        if (!existing || existing.deleted) return false;
        const now = (await stamp("note", id)).iso;
        await IdbDataStore.putNote(tx, { id, updatedAt: now, updatedBy: deviceId, deleted: true, note: null });
        const rem = await tx.objectStore("reminders").get(id);
        if (rem && !rem.deleted) {
          const remAt = (await stamp("reminder", id)).iso;
          await IdbDataStore.putReminder(tx, { noteId: id, updatedAt: remAt, updatedBy: deviceId, deleted: true, reminder: null });
        }
        return true;
      },
      (changed) => (changed ? { kind: "notes", ids: [id] } : null),
    );
  }

  async getOrder(): Promise<string[]> {
    const order = await getMeta((await this.db()).transaction("meta"), "order");
    return order ? [...order.ids] : [];
  }

  async saveOrder(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    await this.write(
      async (tx, { deviceId, stamp }) => {
        const now = (await stamp("order", "order")).iso;
        const rec: OrderRecord = { updatedAt: now, updatedBy: deviceId, ids: unique };
        await tx.objectStore("meta").put(rec, "order");
        await IdbDataStore.enqueue(tx, { kind: "order", id: "order", record: rec });
      },
      () => ({ kind: "order" }),
    );
  }

  // ---- reminders --------------------------------------------------------------------

  async listReminders(): Promise<Reminder[]> {
    const db = await this.db();
    const tx = db.transaction(["notes", "reminders"], "readonly");
    const [notes, reminders] = await Promise.all([tx.objectStore("notes").getAll(), tx.objectStore("reminders").getAll()]);
    await tx.done;
    const live = new Set(notes.filter((n) => !n.deleted && n.note).map((n) => n.id));
    return reminders.filter((r) => !r.deleted && r.reminder && live.has(r.noteId)).map((r) => r.reminder as Reminder);
  }

  async getReminder(noteId: string): Promise<Reminder | null> {
    const db = await this.db();
    const tx = db.transaction(["notes", "reminders"], "readonly");
    const [n, r] = await Promise.all([tx.objectStore("notes").get(noteId), tx.objectStore("reminders").get(noteId)]);
    await tx.done;
    if (!n || n.deleted || !r || r.deleted || !r.reminder) return null;
    return r.reminder;
  }

  private static async liveReminder(tx: WriteTx, noteId: string): Promise<Reminder | null> {
    const r = await tx.objectStore("reminders").get(noteId);
    return r && !r.deleted && r.reminder ? r.reminder : null;
  }

  private static async requireLiveNote(tx: WriteTx, noteId: string): Promise<void> {
    const n = await tx.objectStore("notes").get(noteId);
    if (!n || n.deleted || !n.note) throw new Error(`note ${noteId} does not exist`);
  }

  async setReminder(
    noteId: string,
    wallDate: string,
    wallTime: string,
    timeZone: string,
    repeat: ReminderRepeat,
  ): Promise<Reminder> {
    const zone = timeZone.trim();
    if (!isValidZone(zone)) throw new Error(`unknown time zone: ${timeZone}`);
    const wall = wallFromInputs(wallDate, wallTime);
    if (!wall) throw new Error(`invalid date/time: ${wallDate} ${wallTime}`);
    return this.write(
      async (tx, { deviceId, nowMs, stamp }) => {
        await IdbDataStore.requireLiveNote(tx, noteId);
        const existing = await IdbDataStore.liveReminder(tx, noteId);
        const now = await stamp("reminder", noteId);
        const r = { ...setReminderWall(existing, noteId, wall, repeat, zone, nowMs), updatedAt: now.iso };
        await IdbDataStore.putReminder(tx, { noteId, updatedAt: now.iso, updatedBy: deviceId, deleted: false, reminder: r });
        return r;
      },
      () => ({ kind: "reminders", ids: [noteId] }),
    );
  }

  async removeReminder(noteId: string): Promise<void> {
    await this.write(
      async (tx, { deviceId, stamp }) => {
        if (!(await IdbDataStore.liveReminder(tx, noteId))) return false;
        const now = (await stamp("reminder", noteId)).iso;
        await IdbDataStore.putReminder(tx, { noteId, updatedAt: now, updatedBy: deviceId, deleted: true, reminder: null });
        return true;
      },
      (changed) => (changed ? { kind: "reminders", ids: [noteId] } : null),
    );
  }

  async ackReminder(noteId: string): Promise<Reminder | null> {
    return this.write(
      async (tx, { deviceId, nowMs, stamp }) => {
        const existing = await IdbDataStore.liveReminder(tx, noteId);
        if (!existing) return null;
        const account = await getMeta(tx, "account");
        const fallback = account?.timeZone && isValidZone(account.timeZone) ? account.timeZone : this.deviceZone();
        const now = await stamp("reminder", noteId);
        const r = { ...ackReminderMath(existing, nowMs, fallback), updatedAt: now.iso };
        await IdbDataStore.putReminder(tx, { noteId, updatedAt: now.iso, updatedBy: deviceId, deleted: false, reminder: r });
        return r;
      },
      (r) => (r ? { kind: "reminders", ids: [noteId] } : null),
    );
  }

  async snoozeReminder(noteId: string, minutes: number): Promise<Reminder> {
    return this.write(
      async (tx, { deviceId, nowMs, stamp }) => {
        const existing = await IdbDataStore.liveReminder(tx, noteId);
        if (!existing) throw new Error(`no reminder for note ${noteId}`);
        const now = await stamp("reminder", noteId);
        const r = { ...snoozeReminderMath(existing, minutes, nowMs), updatedAt: now.iso };
        await IdbDataStore.putReminder(tx, { noteId, updatedAt: now.iso, updatedBy: deviceId, deleted: false, reminder: r });
        return r;
      },
      () => ({ kind: "reminders", ids: [noteId] }),
    );
  }

  async markDue(noteId: string, at: string): Promise<Reminder | null> {
    const wanted = parseInstant(at);
    if (wanted === null) return null;
    return this.write(
      async (tx, { nowMs }) => {
        const rec = await tx.objectStore("reminders").get(noteId);
        const r = rec && !rec.deleted ? rec.reminder : null;
        if (!rec || !r || r.state !== "scheduled") return null;
        const current = parseInstant(r.at);
        if (current === null || current !== wanted || current > nowMs) return null;
        const fired = fire(r, nowMs);
        // firing is not an edit (D-30): record stamp unchanged, no outbox entry
        await tx.objectStore("reminders").put({ ...rec, reminder: fired });
        return fired;
      },
      (r) => (r ? { kind: "reminders", ids: [noteId] } : null),
    );
  }

  // ---- misc -------------------------------------------------------------------------

  async pendingCount(): Promise<number> {
    return (await this.db()).count("outbox");
  }

  async getAccount(): Promise<Account | null> {
    return (await getMeta((await this.db()).transaction("meta"), "account")) ?? null;
  }

  async signOut(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) {
      try {
        (await pending).close();
      } catch {
        // open failed – nothing to close
      }
    }
    await deleteBuddyDb(this.factory, this.name);
    this.emit({ kind: "account", source: "local" });
  }

  // ---- sync access ------------------------------------------------------------------

  private async metaPut<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
    await (await this.db()).put("meta", value, key);
  }

  readonly sync: SyncAccess = {
    getDeviceId: async () => (await getMeta((await this.db()).transaction("meta"), "deviceId")) ?? "",
    setAccount: (account) => this.setAccountImpl(account),
    getCursor: async () => (await getMeta((await this.db()).transaction("meta"), "cursor")) ?? 0,
    outbox: async () => (await this.db()).getAll("outbox"),
    applyPushResults: (sent, results) => this.applyPushResultsImpl(sent, results),
    mergeChanges: (changes) => this.mergeChangesImpl(changes),
    requeueUnseen: (n, r) => this.requeueUnseenImpl(n, r),
    addClockSample: async (offsetMs) => {
      const db = await this.db();
      const tx = db.transaction("meta", "readwrite");
      const samples = pushOffset(((await tx.store.get("clockOffsets")) as number[] | undefined) ?? [], offsetMs);
      await tx.store.put(samples, "clockOffsets");
      await tx.done;
      const median = medianOffset(samples);
      this.clock.setOffsetMs(median);
      return median;
    },
    getLastSyncAt: async () => (await getMeta((await this.db()).transaction("meta"), "lastSyncAt")) ?? null,
    setLastSyncAt: (at) => this.metaPut("lastSyncAt", at),
    setPersisted: (p) => this.metaPut("persisted", p),
    close: () => this.close(),
  };

  private async setAccountImpl(account: Account): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, "readwrite");
    const oldId = await getMeta(tx, "deviceId");
    await tx.objectStore("meta").put(account, "account");
    await tx.objectStore("meta").put(account.deviceId, "deviceId");
    if (oldId && oldId !== account.deviceId) {
      // pending edits made under the previous id are re-attributed to the server's device id
      const by = <T extends { updatedBy: string }>(r: T): T =>
        r.updatedBy === oldId ? { ...r, updatedBy: account.deviceId } : r;
      for (const e of await tx.objectStore("outbox").getAll()) {
        const record = by(e.record);
        await tx.objectStore("outbox").put({ ...e, record } as OutboxEntry);
        if (e.kind === "note") await tx.objectStore("notes").put(record as NoteRecord);
        else if (e.kind === "reminder") await tx.objectStore("reminders").put(record as ReminderRecord);
        else await tx.objectStore("meta").put(record as OrderRecord, "order");
      }
    }
    await tx.done;
    this.emit({ kind: "account", source: "local" });
  }

  private async applyPushResultsImpl(sent: OutboxEntry[], results: PushResult[]): Promise<ApplyOutcome> {
    const outcome: ApplyOutcome = { notices: [], invalid: [] };
    const touched = new Set<"notes" | "reminders" | "order">();
    const ids = new Set<string>();
    const byKey = new Map(sent.map((e) => [e.key, e]));
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, "readwrite");
    for (const res of results) {
      const key = outboxKey(res.kind, res.kind === "order" ? "order" : res.id);
      const sentEntry = byKey.get(key);
      if (!sentEntry) continue;
      const current = await tx.objectStore("outbox").get(key);
      const unchanged =
        !!current && sameStamp(current.record, sentEntry.record) && sameDeleted(current.record, sentEntry.record);
      if (res.status === "applied") {
        if (!unchanged) continue; // edited again during the push: keep the newer version queued
        await tx.objectStore("outbox").delete(key);
        if (res.clampedUpdatedAt) await IdbDataStore.applyClamp(tx, sentEntry, res.clampedUpdatedAt);
      } else if (res.status === "stale") {
        const winner = res.note ?? res.reminder ?? res.order;
        if (unchanged) await tx.objectStore("outbox").delete(key);
        // unchanged: the server is authoritative for the version we sent; otherwise LWW
        if (winner) await this.mergeOne(tx, res.kind, winner, outcome, touched, ids, { quiet: true, force: unchanged });
        outcome.notices.push({ kind: "stale", recordKind: res.kind, id: res.kind === "order" ? "order" : res.id });
      } else {
        if (unchanged) await tx.objectStore("outbox").delete(key);
        outcome.invalid.push(res);
      }
    }
    await tx.done;
    this.emitTouched(touched, ids);
    return outcome;
  }

  private static async applyClamp(tx: WriteTx, entry: OutboxEntry, clamped: string): Promise<void> {
    if (entry.kind === "note") {
      const cur = await tx.objectStore("notes").get(entry.id);
      if (cur && sameStamp(cur, entry.record)) {
        await tx.objectStore("notes").put({
          ...cur,
          updatedAt: clamped,
          note: cur.note ? { ...cur.note, updatedAt: clamped } : null,
        });
      }
    } else if (entry.kind === "reminder") {
      const cur = await tx.objectStore("reminders").get(entry.id);
      if (cur && sameStamp(cur, entry.record)) {
        await tx.objectStore("reminders").put({
          ...cur,
          updatedAt: clamped,
          reminder: cur.reminder ? { ...cur.reminder, updatedAt: clamped } : null,
        });
      }
    } else {
      const cur = await getMeta(tx, "order");
      if (cur && sameStamp(cur, entry.record)) await tx.objectStore("meta").put({ ...cur, updatedAt: clamped }, "order");
    }
  }

  /**
   * LWW merge of one remote record. Remote wins → stored, pending outbox entry dropped
   * (stale notice if we had one; remoteDeleted if a live note became a tombstone).
   * Local strictly newer but not queued → queued again (server lost it, e.g. restore).
   */
  private async mergeOne(
    tx: WriteTx,
    kind: RecordKind,
    remote: NoteRecord | ReminderRecord | OrderRecord,
    outcome: ApplyOutcome,
    touched: Set<"notes" | "reminders" | "order">,
    ids: Set<string>,
    opts: { quiet?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const fromStale = opts.quiet ?? false;
    const force = opts.force ?? false;
    if (kind === "note") {
      const r = remote as NoteRecord;
      const local = await tx.objectStore("notes").get(r.id);
      const key = outboxKey("note", r.id);
      if (!local || force || noteWinner(local, r) === "remote") {
        await tx.objectStore("notes").put(r);
        if (await tx.objectStore("outbox").get(key)) {
          await tx.objectStore("outbox").delete(key);
          if (!fromStale) outcome.notices.push({ kind: "stale", recordKind: "note", id: r.id });
        }
        if (r.deleted && local && !local.deleted) outcome.notices.push({ kind: "remoteDeleted", id: r.id });
        touched.add("notes");
        ids.add(r.id);
      } else if (cmpStamp(r.updatedAt, r.updatedBy, local.updatedAt, local.updatedBy) < 0) {
        if (!(await tx.objectStore("outbox").get(key))) {
          await IdbDataStore.enqueue(tx, { kind: "note", id: r.id, record: local });
        }
      }
    } else if (kind === "reminder") {
      const r = remote as ReminderRecord;
      const local = await tx.objectStore("reminders").get(r.noteId);
      const key = outboxKey("reminder", r.noteId);
      if (!local || force || reminderWinner(local, r) === "remote") {
        await tx.objectStore("reminders").put(r);
        const pending = await tx.objectStore("outbox").get(key);
        // a remote "due" with our own pending stamp is the server firing it, not a conflict
        if (pending && !sameStamp(pending.record, r)) {
          await tx.objectStore("outbox").delete(key);
          if (!fromStale) outcome.notices.push({ kind: "stale", recordKind: "reminder", id: r.noteId });
        }
        touched.add("reminders");
        ids.add(r.noteId);
      } else if (cmpStamp(r.updatedAt, r.updatedBy, local.updatedAt, local.updatedBy) < 0) {
        if (!(await tx.objectStore("outbox").get(key))) {
          await IdbDataStore.enqueue(tx, { kind: "reminder", id: r.noteId, record: local });
        }
      }
    } else {
      const r = remote as OrderRecord;
      const local = await getMeta(tx, "order");
      const key = outboxKey("order", "order");
      if (!local || force || orderWinner(local, r) === "remote") {
        await tx.objectStore("meta").put(r, "order");
        if (await tx.objectStore("outbox").get(key)) {
          await tx.objectStore("outbox").delete(key);
          if (!fromStale) outcome.notices.push({ kind: "stale", recordKind: "order", id: "order" });
        }
        touched.add("order");
      } else if (cmpStamp(r.updatedAt, r.updatedBy, local.updatedAt, local.updatedBy) < 0) {
        if (!(await tx.objectStore("outbox").get(key))) {
          await IdbDataStore.enqueue(tx, { kind: "order", id: "order", record: local });
        }
      }
    }
  }

  private async mergeChangesImpl(
    changes: Pick<SyncChanges, "cursor" | "notes" | "reminders" | "order">,
  ): Promise<ApplyOutcome> {
    const outcome: ApplyOutcome = { notices: [], invalid: [] };
    const touched = new Set<"notes" | "reminders" | "order">();
    const ids = new Set<string>();
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, "readwrite");
    for (const n of changes.notes) await this.mergeOne(tx, "note", n, outcome, touched, ids);
    for (const r of changes.reminders) await this.mergeOne(tx, "reminder", r, outcome, touched, ids);
    if (changes.order) await this.mergeOne(tx, "order", changes.order, outcome, touched, ids);
    await tx.objectStore("meta").put(changes.cursor, "cursor");
    await tx.done;
    this.emitTouched(touched, ids);
    return outcome;
  }

  /**
   * Same rule as the desktop (`enqueue_all`): a live local document the server did not send
   * goes back into the outbox, so a server restored from a backup gets it again. Only
   * tombstones are dropped (the server purged them already).
   */
  private async requeueUnseenImpl(seenNotes: ReadonlySet<string>, seenReminders: ReadonlySet<string>): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(ALL_STORES, "readwrite");
    const pending = new Set(await tx.objectStore("outbox").getAllKeys());
    for (const rec of await tx.objectStore("notes").getAll()) {
      if (seenNotes.has(rec.id) || pending.has(outboxKey("note", rec.id))) continue;
      if (rec.deleted) await tx.objectStore("notes").delete(rec.id);
      else await IdbDataStore.enqueue(tx, { kind: "note", id: rec.id, record: rec });
    }
    for (const rec of await tx.objectStore("reminders").getAll()) {
      if (seenReminders.has(rec.noteId) || pending.has(outboxKey("reminder", rec.noteId))) continue;
      if (rec.deleted) await tx.objectStore("reminders").delete(rec.noteId);
      else await IdbDataStore.enqueue(tx, { kind: "reminder", id: rec.noteId, record: rec });
    }
    await tx.done;
  }

  private emitTouched(touched: Set<"notes" | "reminders" | "order">, ids: Set<string>): void {
    for (const kind of touched) {
      this.emit({ kind, ids: kind === "order" ? undefined : [...ids], source: "remote" });
    }
  }
}

/** Opens (and creates/upgrades) the local database. */
export async function openDataStore(options: DataStoreOptions = {}): Promise<DataStore> {
  const store = new IdbDataStore(options);
  await store.db();
  access.set(store, store.sync);
  return store;
}
