// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { createClock } from "../../lib/clock";
import type { NoteRecord } from "../../lib/sync/types";
import type { Note } from "../../types";
import type { DataChange, DataStore } from "../contract";
import { openDataStore, syncAccess } from "./index";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");

function note(id: string, createdAt = "2026-11-01T08:00:00.000Z", title = id): Note {
  return {
    id,
    title,
    color: "yellow",
    content: { type: "doc", content: [] },
    createdAt,
    updatedAt: createdAt,
    schemaVersion: 1,
  };
}

const open: DataStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) syncAccess(s).close();
});

async function setup(opts: { factory?: IDBFactory; name?: string; now?: () => number; zone?: string } = {}) {
  let now = T0;
  const clock = createClock(opts.now ?? (() => now));
  const factory = opts.factory ?? new IDBFactory();
  const store = await openDataStore({
    dbName: opts.name ?? "test",
    indexedDB: factory,
    clock,
    deviceZone: () => opts.zone ?? "Europe/Berlin",
  });
  open.push(store);
  return {
    store,
    factory,
    clock,
    sync: syncAccess(store),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function nextChange(store: DataStore, pred: (c: DataChange) => boolean = () => true): Promise<DataChange> {
  return new Promise((resolve) => {
    const off = store.subscribe((c) => {
      if (pred(c)) {
        off();
        resolve(c);
      }
    });
  });
}

describe("notes", () => {
  it("stamps updatedAt with the corrected clock and queues the record", async () => {
    const { store, clock, sync } = await setup();
    clock.setOffsetMs(-60_000);
    const saved = await store.saveNote(note("a"));
    expect(saved.updatedAt).toBe("2026-11-06T09:59:00.000Z");
    expect(await store.getNote("a")).toEqual(saved);
    const outbox = await sync.outbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      key: "note:a",
      kind: "note",
      record: { id: "a", updatedAt: saved.updatedAt, deleted: false, note: saved },
    });
    expect(outbox[0].record.updatedBy).toBe(await sync.getDeviceId());
  });

  it("coalesces the outbox to the latest version per document", async () => {
    const { store, sync, advance } = await setup();
    await store.saveNote(note("a"));
    advance(1000);
    await store.saveNote({ ...note("a"), title: "zwei" });
    advance(1000);
    await store.saveNote(note("b"));
    await store.saveOrder(["b", "a"]);
    await store.saveOrder(["a", "b"]);
    expect(await store.pendingCount()).toBe(3);
    const a = (await sync.outbox()).find((e) => e.key === "note:a");
    expect((a?.record as NoteRecord).note?.title).toBe("zwei");
    expect((await sync.outbox()).find((e) => e.key === "order:order")?.record).toMatchObject({ ids: ["a", "b"] });
  });

  it("lists live notes in saved order, others appended by createdAt", async () => {
    const { store } = await setup();
    await store.saveNote(note("late", "2026-11-03T00:00:00.000Z"));
    await store.saveNote(note("early", "2026-11-02T00:00:00.000Z"));
    await store.saveNote(note("x", "2026-11-04T00:00:00.000Z"));
    await store.saveOrder(["x", "gone", "x"]);
    expect((await store.listNotes()).map((n) => n.id)).toEqual(["x", "early", "late"]);
    expect(await store.getOrder()).toEqual(["x", "gone"]);
  });

  it("delete writes tombstones for note and reminder; a later edit resurrects the note", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("a"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await store.deleteNote("a");
    expect(await store.getNote("a")).toBeNull();
    expect(await store.listNotes()).toEqual([]);
    expect(await store.getReminder("a")).toBeNull();
    const out = await sync.outbox();
    expect(out.map((e) => [e.key, (e.record as { deleted: boolean }).deleted]).sort()).toEqual([
      ["note:a", true],
      ["reminder:a", true],
    ]);
    await store.deleteNote("missing"); // no-op
    expect(await store.pendingCount()).toBe(2);
    await store.saveNote(note("a"));
    expect(await store.getNote("a")).not.toBeNull();
  });

  it("survives a restart (same database reopened)", async () => {
    const factory = new IDBFactory();
    const first = await setup({ factory, name: "persist" });
    await first.store.saveNote(note("a"));
    await first.sync.addClockSample(-600_000);
    const deviceId = await first.sync.getDeviceId();
    first.sync.close();
    const second = await setup({ factory, name: "persist" });
    expect((await second.store.listNotes()).map((n) => n.id)).toEqual(["a"]);
    expect(await second.store.pendingCount()).toBe(1);
    expect(await second.sync.getDeviceId()).toBe(deviceId);
    // offline after restart: the last measured offset applies
    expect(second.clock.offsetMs()).toBe(-600_000);
  });

  it("notifies subscribers and other tabs (BroadcastChannel)", async () => {
    const factory = new IDBFactory();
    const tabA = await setup({ factory, name: "tabs" });
    const tabB = await setup({ factory, name: "tabs" });
    const other = await setup({ name: "unrelated" });
    const seenOther: DataChange[] = [];
    other.store.subscribe((c) => seenOther.push(c));
    const local = nextChange(tabA.store);
    const remote = nextChange(tabB.store);
    await tabA.store.saveNote(note("a"));
    expect(await local).toEqual({ kind: "notes", ids: ["a"], source: "local" });
    expect(await remote).toEqual({ kind: "notes", ids: ["a"], source: "other-tab" });
    expect((await tabB.store.getNote("a"))?.id).toBe("a");
    expect(seenOther).toEqual([]);
  });

  it("signOut deletes the local database, also with another tab open", async () => {
    const factory = new IDBFactory();
    const tabA = await setup({ factory, name: "out" });
    const tabB = await setup({ factory, name: "out" });
    await tabA.store.saveNote(note("a"));
    await tabA.sync.setAccount({ username: "u", deviceId: "dev-1", serverUrl: "https://x", timeZone: "UTC" });
    expect(await tabB.store.getNote("a")).not.toBeNull();
    await tabA.store.signOut();
    expect(await tabA.store.getAccount()).toBeNull();
    expect(await tabA.store.listNotes()).toEqual([]);
    expect(await tabA.store.pendingCount()).toBe(0);
    expect(await tabB.store.listNotes()).toEqual([]);
    expect(await tabA.sync.getDeviceId()).not.toBe("dev-1");
  });
});

describe("reminders", () => {
  it("setReminder converts a wall time in a foreign zone, independent of the device zone", async () => {
    const { store, sync } = await setup({ zone: "America/New_York" });
    await store.saveNote(note("a"));
    const r = await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "daily");
    expect(r).toMatchObject({
      noteId: "a",
      at: "2026-11-07T08:00:00.000Z",
      timeZone: "Europe/Berlin",
      repeat: "daily",
      state: "scheduled",
      updatedAt: "2026-11-06T10:00:00.000Z",
    });
    expect(await store.getReminder("a")).toEqual(r);
    expect((await sync.outbox()).find((e) => e.key === "reminder:a")?.record).toMatchObject({ reminder: r });

    // Tokyo (+09:00, no DST) and Kolkata (+05:30)
    expect((await store.setReminder("a", "2026-11-07", "09:00", "Asia/Tokyo", "none")).at).toBe(
      "2026-11-07T00:00:00.000Z",
    );
    expect((await store.setReminder("a", "2026-11-07", "09:00", "Asia/Kolkata", "none")).at).toBe(
      "2026-11-07T03:30:00.000Z",
    );
  });

  it("DST gap → next valid minute, fold → earlier, EU/US in-between week", async () => {
    const { store } = await setup();
    await store.saveNote(note("a"));
    // Berlin 2027-03-28 02:30 does not exist → 03:00 CEST = 01:00Z
    expect((await store.setReminder("a", "2027-03-28", "02:30", "Europe/Berlin", "none")).at).toBe(
      "2027-03-28T01:00:00.000Z",
    );
    // Berlin 2026-10-25 02:30 exists twice → earlier (CEST) = 00:30Z
    expect((await store.setReminder("a", "2026-10-25", "02:30", "Europe/Berlin", "none")).at).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // New York already on EST (Nov 1), Berlin on CET: 09:00 NY = 14:00Z
    expect((await store.setReminder("a", "2026-11-02", "09:00", "America/New_York", "none")).at).toBe(
      "2026-11-02T14:00:00.000Z",
    );
  });

  it("rejects unknown zones, bad input and missing notes", async () => {
    const { store } = await setup();
    await store.saveNote(note("a"));
    await expect(store.setReminder("a", "2026-11-07", "09:00", "Mars/Olympus", "none")).rejects.toThrow(/zone/);
    await expect(store.setReminder("a", "2026-02-31", "09:00", "UTC", "none")).rejects.toThrow(/invalid/);
    await expect(store.setReminder("nope", "2026-11-07", "09:00", "UTC", "none")).rejects.toThrow(/does not exist/);
    expect(await store.pendingCount()).toBe(1);
  });

  it("ack computes the next occurrence in the reminder zone; snooze and remove", async () => {
    const { store, advance } = await setup({ zone: "Asia/Tokyo" });
    await store.saveNote(note("a"));
    await store.setReminder("a", "2026-11-06", "09:00", "Europe/Berlin", "daily"); // 08:00Z, past
    advance(60_000);
    const acked = await store.ackReminder("a");
    expect(acked).toMatchObject({ at: "2026-11-07T08:00:00.000Z", state: "scheduled", updatedAt: "2026-11-06T10:01:00.000Z" });
    const snoozed = await store.snoozeReminder("a", 10);
    expect(snoozed.at).toBe("2026-11-06T10:11:00.000Z");
    await expect(store.snoozeReminder("a", 0)).rejects.toThrow();
    await store.removeReminder("a");
    expect(await store.getReminder("a")).toBeNull();
    expect(await store.ackReminder("a")).toBeNull();
    await expect(store.snoozeReminder("a", 10)).rejects.toThrow(/no reminder/);
  });

  it("ack of a legacy reminder without zone uses the account zone, then the device zone", async () => {
    const { store, sync } = await setup({ zone: "Asia/Tokyo" });
    await store.saveNote(note("a"));
    await store.setReminder("a", "2026-11-06", "09:00", "Europe/Berlin", "daily");
    // simulate legacy data from the server: no timeZone
    await sync.mergeChanges({
      cursor: 1,
      notes: [],
      order: null,
      reminders: [
        {
          noteId: "a",
          updatedAt: "2026-11-06T10:00:00.000Z",
          updatedBy: "zzz",
          deleted: false,
          reminder: {
            noteId: "a",
            at: "2026-11-06T08:00:00.000Z",
            repeat: "daily",
            state: "scheduled",
            firedAt: null,
            updatedAt: null,
            timeZone: null,
          },
        },
      ],
    });
    expect((await store.ackReminder("a"))?.timeZone).toBe("Asia/Tokyo");
  });

  it("markDue only for the exact scheduled instant once due; no stamp, no outbox", async () => {
    const { store, sync, advance } = await setup();
    await store.saveNote(note("a"));
    const r = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "none"); // 10:05Z
    for (const e of await sync.outbox()) await sync.applyPushResults([e], [{ kind: e.kind, id: e.id, status: "applied" }]);
    expect(await store.pendingCount()).toBe(0);
    expect(await store.markDue("a", r.at)).toBeNull(); // not yet
    advance(5 * 60_000);
    expect(await store.markDue("a", "2026-11-06T10:06:00.000Z")).toBeNull(); // other instant
    const due = await store.markDue("a", "2026-11-06T11:05:00.000+01:00"); // same instant, other notation
    expect(due).toMatchObject({ state: "due", firedAt: "2026-11-06T10:05:00.000Z", updatedAt: r.updatedAt });
    expect(await store.markDue("a", r.at)).toBeNull(); // already due
    expect(await store.pendingCount()).toBe(0);
  });
});

describe("sync access", () => {
  it("setAccount re-attributes pending edits to the server device id", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("a"));
    await sync.setAccount({ username: "u", deviceId: "server-dev", serverUrl: "", timeZone: "Europe/Berlin" });
    expect((await sync.outbox())[0].record.updatedBy).toBe("server-dev");
    expect(await sync.getDeviceId()).toBe("server-dev");
    expect(await store.getAccount()).toMatchObject({ username: "u", deviceId: "server-dev" });
  });

  it("applied removes only unchanged outbox entries and applies a clamp", async () => {
    const { store, sync, advance } = await setup();
    await store.saveNote(note("a"));
    await store.saveNote(note("b"));
    const sent = await sync.outbox();
    advance(1000);
    await store.saveNote({ ...note("b"), title: "neu" }); // edited during the push
    const out = await sync.applyPushResults(sent, [
      { kind: "note", id: "a", status: "applied", clampedUpdatedAt: "2026-11-06T09:00:00.000Z" },
      { kind: "note", id: "b", status: "applied" },
    ]);
    expect(out.notices).toEqual([]);
    expect((await sync.outbox()).map((e) => e.key)).toEqual(["note:b"]);
    expect((await store.getNote("a"))?.updatedAt).toBe("2026-11-06T09:00:00.000Z");
  });

  it("stale takes the server winner, notices, invalid is dropped", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("a", undefined, "lokal"));
    await store.saveNote(note("bad"));
    const sent = await sync.outbox();
    const winner: NoteRecord = {
      id: "a",
      updatedAt: "2026-11-06T11:00:00.000Z",
      updatedBy: "pc",
      deleted: false,
      note: { ...note("a", undefined, "PC"), updatedAt: "2026-11-06T11:00:00.000Z" },
    };
    const out = await sync.applyPushResults(sent, [
      { kind: "note", id: "a", status: "stale", note: winner },
      { kind: "note", id: "bad", status: "invalid", message: "invalid note id" },
    ]);
    expect(out.notices).toEqual([{ kind: "stale", recordKind: "note", id: "a" }]);
    expect(out.invalid.map((r) => r.id)).toEqual(["bad"]);
    expect((await store.getNote("a"))?.title).toBe("PC");
    expect(await store.pendingCount()).toBe(0);
  });

  it("merge: LWW per document, pending loser → stale notice, remote tombstone → remoteDeleted", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("mine", undefined, "neu")); // pending, 10:00
    await store.saveNote(note("gone"));
    for (const e of await sync.outbox()) {
      if (e.id === "gone") await sync.applyPushResults([e], [{ kind: "note", id: "gone", status: "applied" }]);
    }
    const out = await sync.mergeChanges({
      cursor: 7,
      notes: [
        { id: "mine", updatedAt: "2026-11-06T09:00:00.000Z", updatedBy: "pc", deleted: false, note: note("mine", undefined, "alt") },
        { id: "gone", updatedAt: "2026-11-06T10:30:00.000Z", updatedBy: "pc", deleted: true, note: null },
        { id: "new", updatedAt: "2026-11-06T10:30:00.000Z", updatedBy: "pc", deleted: false, note: note("new") },
      ],
      reminders: [],
      order: { updatedAt: "2026-11-06T10:30:00.000Z", updatedBy: "pc", ids: ["new", "mine"] },
    });
    expect(out.notices).toEqual([{ kind: "remoteDeleted", id: "gone" }]);
    expect((await store.getNote("mine"))?.title).toBe("neu");
    expect((await store.listNotes()).map((n) => n.id)).toEqual(["new", "mine"]);
    expect(await sync.getCursor()).toBe(7);
    expect((await sync.outbox()).map((e) => e.key)).toEqual(["note:mine"]);

    const out2 = await sync.mergeChanges({
      cursor: 8,
      notes: [{ id: "mine", updatedAt: "2026-11-06T10:45:00.000Z", updatedBy: "pc", deleted: false, note: note("mine", undefined, "PC") }],
      reminders: [],
      order: null,
    });
    expect(out2.notices).toEqual([{ kind: "stale", recordKind: "note", id: "mine" }]);
    expect((await store.getNote("mine"))?.title).toBe("PC");
    expect(await store.pendingCount()).toBe(0);
  });

  it("server firing (due, same stamp) is taken over without a conflict", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("a"));
    await store.setReminder("a", "2026-11-06", "10:30", "Europe/Berlin", "none");
    const pending = (await sync.outbox()).find((e) => e.key === "reminder:a");
    const rec = pending!.record as import("../../lib/sync/types").ReminderRecord;
    const out = await sync.mergeChanges({
      cursor: 2,
      notes: [],
      order: null,
      reminders: [{ ...rec, reminder: { ...rec.reminder!, state: "due", firedAt: "2026-11-06T09:30:00.000Z" } }],
    });
    expect((await store.getReminder("a"))?.state).toBe("due");
    expect(out.notices).toEqual([]);
    expect(await store.pendingCount()).toBe(2);
  });

  it("pruneUnseen removes unknown documents except pending ones", async () => {
    const { store, sync } = await setup();
    await store.saveNote(note("pending"));
    await sync.mergeChanges({
      cursor: 3,
      notes: [
        { id: "old", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "pc", deleted: false, note: note("old") },
        { id: "kept", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "pc", deleted: false, note: note("kept") },
      ],
      reminders: [],
      order: null,
    });
    await sync.pruneUnseen(new Set(["kept"]), new Set());
    expect((await store.listNotes()).map((n) => n.id).sort()).toEqual(["kept", "pending"]);
  });
});
