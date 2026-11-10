// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../../lib/clock";
import type { DeviceState } from "../../lib/sync/types";
import type { Note } from "../../types";
import type { DataChange, DataStore, SyncEngine, SyncNotice, WebSyncStatus } from "../contract";
import { openDataStore, syncAccess } from "../data";
import { BACKOFF_MS, CHANGE_DEBOUNCE_MS, createSyncEngine, SyncError } from "./index";
import { FakeLocks, FakeServer, ManualTimers } from "./testkit";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** "Real" time shared by server and devices; devices may run off by `skew`. */
let real = T0;
const stores: DataStore[] = [];
const engines: SyncEngine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  for (const s of stores.splice(0)) syncAccess(s).close();
  vi.unstubAllGlobals();
  real = T0;
});

function note(id: string, title: string): Note {
  return {
    id,
    title,
    color: "yellow",
    content: { type: "doc", content: [] },
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    schemaVersion: 1,
  };
}

interface Client {
  store: DataStore;
  engine: SyncEngine;
  dev: ReturnType<FakeServer["device"]>;
  timers: ManualTimers;
  notices: SyncNotice[];
  statuses: WebSyncStatus[];
  factory: IDBFactory;
}

async function client(
  server: FakeServer,
  opts: {
    kind?: "web" | "mobile";
    factory?: IDBFactory;
    name?: string;
    skewMs?: number;
    deviceState?: () => DeviceState | null;
    dev?: ReturnType<FakeServer["device"]>;
  } = {},
): Promise<Client> {
  const skew = opts.skewMs ?? 0;
  const deviceNow = () => real + skew;
  const factory = opts.factory ?? new IDBFactory();
  const store = await openDataStore({
    dbName: opts.name ?? "db",
    indexedDB: factory,
    clock: createClock(deviceNow),
    deviceZone: () => "Europe/Berlin",
  });
  stores.push(store);
  const dev = opts.dev ?? server.device(opts.kind ?? "web", deviceNow);
  const timers = new ManualTimers();
  const engine = createSyncEngine({
    store,
    http: dev.adapter,
    deviceState: opts.deviceState,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  engines.push(engine);
  const notices: SyncNotice[] = [];
  const statuses: WebSyncStatus[] = [];
  engine.onNotice((n) => notices.push(n));
  engine.onStatus((s) => statuses.push(s));
  return { store, engine, dev, timers, notices, statuses, factory };
}

async function loggedIn(server: FakeServer, opts: Parameters<typeof client>[1] = {}): Promise<Client> {
  const c = await client(server, opts);
  await c.engine.login(server.username, server.password, "Handy");
  return c;
}

const waitState = (c: Client, state: WebSyncStatus["state"]) =>
  vi.waitFor(() => expect(c.engine.status().state).toBe(state));

describe("login", () => {
  it("PWA: POST /session, GET /me, persists account and syncs pending offline edits", async () => {
    const server = new FakeServer(() => real);
    const c = await client(server);
    await vi.waitFor(() => expect(c.engine.status().state).toBe("signedOut"));
    await c.store.saveNote(note("a", "offline vor Login"));
    await c.engine.login(server.username, server.password, "Handy (Chrome)");
    expect(server.log[0]).toMatchObject({
      method: "POST",
      path: "/session",
      body: { username: "martin", deviceName: "Handy (Chrome)", deviceId: null },
    });
    expect(server.log[1]).toMatchObject({ method: "GET", path: "/me" });
    const account = await c.store.getAccount();
    expect(account).toMatchObject({ username: "martin", serverUrl: "https://buddy.test", timeZone: "Europe/Berlin" });
    expect(server.notes.get("a")?.rec.updatedBy).toBe(account?.deviceId);
    expect(c.engine.status()).toMatchObject({ state: "idle", pending: 0, lastSyncAt: "2026-11-06T10:00:00.000Z" });
  });

  it("re-login reuses the device id; wrong password and other accounts are rejected", async () => {
    const server = new FakeServer(() => real);
    const c = await loggedIn(server);
    const deviceId = (await c.store.getAccount())?.deviceId;
    await expect(c.engine.login(server.username, "falsch", "Handy")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(c.engine.login("eve", "x", "Handy")).rejects.toBeInstanceOf(SyncError);
    await c.engine.login(server.username, server.password, "Handy");
    const sessions = server.log.filter((l) => l.path === "/session");
    expect(sessions.at(-1)?.body).toMatchObject({ deviceId });
  });

  it("native: POST /devices with kind mobile", async () => {
    const server = new FakeServer(() => real);
    await loggedIn(server, { kind: "mobile" });
    expect(server.log[0]).toMatchObject({ method: "POST", path: "/devices", body: { kind: "mobile" } });
  });

  it("logout ends the server session and keeps the engine signed out", async () => {
    const server = new FakeServer(() => real);
    const c = await loggedIn(server);
    await c.engine.logout();
    expect(server.log.at(-1)).toMatchObject({ method: "DELETE", path: "/session" });
    expect(c.engine.status().state).toBe("signedOut");
    await c.store.saveNote(note("x", "x"));
    await new Promise((r) => setTimeout(r, 20));
    expect(c.engine.status().state).toBe("signedOut");
    await c.store.signOut();
    await vi.waitFor(() => expect(c.engine.status().state).toBe("signedOut"));
    expect(await c.store.getAccount()).toBeNull();
  });
});

describe("offline editing, restart, reconnect (scenario 15)", () => {
  it("keeps the outbox across a restart and syncs automatically when online", async () => {
    const server = new FakeServer(() => real);
    const factory = new IDBFactory();
    const first = await loggedIn(server, { factory, name: "phone" });
    const dev = first.dev;
    dev.offline = true;
    await first.store.saveNote(note("a", "offline"));
    await first.store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "daily");
    await first.store.saveNote(note("b", "offline 2"));
    await first.store.deleteNote("b");
    await first.engine.syncNow();
    expect(first.engine.status()).toMatchObject({ state: "offline", pending: 3 });

    // app closed while offline
    first.engine.stop();
    syncAccess(first.store).close();

    const second = await client(server, { factory, name: "phone", dev });
    expect(await second.store.pendingCount()).toBe(3);
    expect((await second.store.listNotes()).map((n) => n.title)).toEqual(["offline"]);
    second.engine.start();
    await vi.waitFor(() => expect(second.timers.pending()).toContain(0));
    second.timers.advance(0);
    await waitState(second, "offline");
    expect(second.timers.pending()).toContain(BACKOFF_MS[0]);

    dev.offline = false;
    globalThis.dispatchEvent?.(new Event("online"));
    second.engine.requestSync("online");
    second.timers.advance(0);
    await vi.waitFor(() => expect(second.engine.status()).toMatchObject({ state: "idle", pending: 0 }));
    expect(server.notes.get("a")?.rec.note?.title).toBe("offline");
    expect(server.notes.get("b")?.rec.deleted).toBe(true);
    expect(server.reminders.get("a")?.rec.reminder).toMatchObject({ at: "2026-11-07T08:00:00.000Z", timeZone: "Europe/Berlin" });
  });
});

describe("conflicts (scenarios 16a–16c)", () => {
  it("16a: phone offline T1, PC T2 > T1 → PC wins, stale notice, phone version rejected", async () => {
    const server = new FakeServer(() => real);
    const phone = await loggedIn(server);
    const pc = await loggedIn(server, { kind: "mobile" });
    await phone.store.saveNote(note("n", "Start"));
    await phone.engine.syncNow();
    await pc.engine.syncNow();

    phone.dev.offline = true;
    await phone.store.saveNote({ ...note("n", "Handy T1") }); // T1
    real += 5 * MIN;
    await pc.store.saveNote({ ...note("n", "PC T2") }); // T2 > T1
    await pc.engine.syncNow();

    real += HOUR;
    phone.dev.offline = false;
    await phone.engine.syncNow();
    expect((await phone.store.getNote("n"))?.title).toBe("PC T2");
    expect(phone.notices).toContainEqual({ kind: "stale", recordKind: "note", id: "n" });
    expect(server.revisions.some((r) => r.reason === "rejected" && r.rec.note?.title === "Handy T1")).toBe(true);
    expect(phone.engine.status().pending).toBe(0);
  });

  it("16b: PC T1 synced, phone offline T2 > T1, online hours later → phone wins", async () => {
    const server = new FakeServer(() => real);
    const phone = await loggedIn(server);
    const pc = await loggedIn(server, { kind: "mobile" });
    await pc.store.saveNote(note("n", "PC T1"));
    await pc.engine.syncNow();
    await phone.engine.syncNow();

    phone.dev.offline = true;
    real += MIN;
    await phone.store.saveNote(note("n", "Handy T2"));
    real += 5 * HOUR; // arrives much later
    await pc.engine.syncNow();
    phone.dev.offline = false;
    await phone.engine.syncNow();
    expect(server.notes.get("n")?.rec.note?.title).toBe("Handy T2");
    expect(server.notes.get("n")?.rec.updatedAt).toBe("2026-11-06T10:01:00.000Z");
    expect(phone.notices).toEqual([]);
    await pc.engine.syncNow();
    expect((await pc.store.getNote("n"))?.title).toBe("Handy T2");
  });

  it("16c: phone clock 10 min ahead → clamp without measurement, then corrected stamps + warning", async () => {
    const server = new FakeServer(() => real);
    const phone = await client(server, { skewMs: 10 * MIN });
    // offline before any measurement: stamped with the (wrong) device time
    const saved = await phone.store.saveNote(note("n", "vorgestellt"));
    expect(saved.updatedAt).toBe("2026-11-06T10:10:00.000Z");
    await phone.engine.login(server.username, server.password, "Handy");
    // the server clamped it; the local copy follows
    expect(server.notes.get("n")?.rec.updatedAt).toBe("2026-11-06T10:00:00.000Z");
    expect((await phone.store.getNote("n"))?.updatedAt).toBe("2026-11-06T10:00:00.000Z");
    // the login responses measured the offset
    expect(phone.engine.status()).toMatchObject({ clockOffsetMs: -10 * MIN, clockWarning: true });
    real += MIN;
    const next = await phone.store.saveNote(note("n", "korrigiert"));
    expect(next.updatedAt).toBe("2026-11-06T10:01:00.000Z");
  });
});

describe("responses", () => {
  it("401 → unauthorized, outbox kept, no automatic retry; after login the outbox is sent (scenario 17)", async () => {
    const server = new FakeServer(() => real);
    const c = await loggedIn(server);
    c.engine.start();
    await vi.waitFor(() => expect(c.timers.pending()).toContain(0));
    c.timers.advance(0);
    await waitState(c, "idle");
    c.dev.authorized = false; // session expired
    await c.store.saveNote(note("a", "x"));
    await c.engine.syncNow();
    expect(c.engine.status()).toMatchObject({ state: "unauthorized", pending: 1 });
    c.engine.requestSync("change");
    c.engine.requestSync("visible");
    expect(c.timers.pending()).toEqual([60_000]); // only the visible-interval timer
    await c.engine.login(server.username, server.password, "Handy");
    expect(server.notes.get("a")).toBeDefined();
    expect(c.engine.status()).toMatchObject({ state: "idle", pending: 0 });
  });

  it("410 after a server restore → notes the backup lacks are uploaded again, not deleted", async () => {
    const server = new FakeServer(() => real);
    const phone = await loggedIn(server);
    await phone.store.saveNote(note("new", "nach der Sicherung"));
    await phone.engine.syncNow();
    expect(phone.engine.status().pending).toBe(0);
    server.notes.delete("new"); // backup from before the note was written
    phone.dev.failNext(410, "full_resync_required");
    await phone.engine.syncNow();
    expect((await phone.store.listNotes()).map((n) => n.id)).toEqual(["new"]);
    expect(server.notes.get("new")?.rec.deleted).toBe(false);
    expect(phone.engine.status()).toMatchObject({ state: "idle", pending: 0 });
  });

  it("410 → full resync with LWW, outbox kept and pushed, unseen live notes re-uploaded", async () => {
    const server = new FakeServer(() => real);
    const phone = await loggedIn(server);
    const pc = await loggedIn(server, { kind: "mobile" });
    await pc.store.saveNote(note("gone", "wird gelöscht"));
    await pc.store.saveNote(note("kept", "bleibt"));
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    expect((await phone.store.listNotes()).length).toBe(2);
    phone.dev.offline = true;
    await phone.store.saveNote(note("mine", "lokal"));
    await pc.store.deleteNote("gone");
    await pc.engine.syncNow();
    server.purgeTombstones();
    phone.dev.offline = false;
    phone.dev.failNext(410, "full_resync_required");
    await phone.engine.syncNow();
    expect(phone.notices).toContainEqual({ kind: "fullResync" });
    // accepted trade-off (same as the desktop): a deletion whose tombstone was purged loses
    // against a device that was offline longer than that — the note comes back, nothing is lost
    expect((await phone.store.listNotes()).map((n) => n.id).sort()).toEqual(["gone", "kept", "mine"]);
    expect(server.notes.get("mine")).toBeDefined();
    expect(server.notes.get("gone")?.rec.deleted).toBe(false);
    expect(phone.engine.status()).toMatchObject({ state: "idle", pending: 0 });
  });

  it("5xx → error with backoff 5 s → 30 s → 2 min → 5 min (capped); online resets", async () => {
    const server = new FakeServer(() => real);
    const c = await loggedIn(server);
    c.engine.start();
    await c.store.saveNote(note("a", "x"));
    await vi.waitFor(() => expect(c.timers.pending()).toContain(CHANGE_DEBOUNCE_MS));
    c.dev.offline = true;
    const seen: number[] = [];
    c.timers.advance(CHANGE_DEBOUNCE_MS);
    for (const expected of [...BACKOFF_MS, BACKOFF_MS[3]]) {
      await waitState(c, "offline");
      await vi.waitFor(() => expect(c.timers.pending()).toContain(expected));
      seen.push(expected);
      // a change while backing off does not postpone the retry
      c.engine.requestSync("change");
      expect(c.timers.pending()).toContain(expected);
      c.timers.advance(expected);
    }
    expect(seen).toEqual([5_000, 30_000, 120_000, 300_000, 300_000]);
    await waitState(c, "offline");
    await vi.waitFor(() => expect(c.timers.pending()).toContain(BACKOFF_MS[3]));
    c.dev.offline = false;
    c.dev.failNext(503, "internal");
    c.engine.requestSync("online");
    c.timers.advance(0);
    await waitState(c, "error");
    await vi.waitFor(() => expect(c.timers.pending()).toContain(BACKOFF_MS[0]));
    c.timers.advance(BACKOFF_MS[0]);
    await vi.waitFor(() => expect(c.engine.status()).toMatchObject({ state: "idle", pending: 0 }));
  });

  it("change trigger is debounced by 2 s", async () => {
    const server = new FakeServer(() => real);
    const c = await loggedIn(server);
    c.engine.start();
    const before = server.log.length;
    await c.store.saveNote(note("a", "1"));
    await vi.waitFor(() => expect(c.timers.pending()).toContain(CHANGE_DEBOUNCE_MS));
    c.timers.advance(1_500);
    await c.store.saveNote(note("a", "2"));
    await vi.waitFor(() => expect(c.timers.pending()).toContain(CHANGE_DEBOUNCE_MS));
    c.timers.advance(1_999);
    expect(server.log.length).toBe(before);
    c.timers.advance(1);
    await vi.waitFor(() => expect(c.engine.status().pending).toBe(0));
    const pushes = server.log.slice(before).filter((l) => l.path === "/sync/push");
    expect(pushes).toHaveLength(1);
    expect(server.notes.get("a")?.rec.note?.title).toBe("2");
  });

  it("pulls in pages and takes over server firing and remote deletes", async () => {
    const server = new FakeServer(() => real);
    const pc = await loggedIn(server, { kind: "mobile" });
    for (let i = 0; i < 250; i++) await pc.store.saveNote(note(`n${String(i).padStart(3, "0")}`, `N${i}`));
    await pc.store.setReminder("n000", "2026-11-06", "11:00", "Europe/Berlin", "none");
    await pc.engine.syncNow();
    expect(server.log.filter((l) => l.path === "/sync/push")).toHaveLength(3); // 200 + 50 notes, then reminders
    const phone = await loggedIn(server);
    expect((await phone.store.listNotes()).length).toBe(250);
    server.fireReminder("n000");
    await pc.store.deleteNote("n001");
    await pc.engine.syncNow();
    await phone.engine.syncNow();
    expect((await phone.store.getReminder("n000"))?.state).toBe("due");
    expect(phone.notices).toContainEqual({ kind: "remoteDeleted", id: "n001" });
  });
});

describe("multiple tabs", () => {
  it("Web Locks: never two syncs in parallel; BroadcastChannel informs the other tab", async () => {
    const locks = new FakeLocks();
    vi.stubGlobal("navigator", { locks });
    const server = new FakeServer(() => real);
    const factory = new IDBFactory();
    const tabA = await loggedIn(server, { factory, name: "shared" });
    const tabB = await client(server, { factory, name: "shared", dev: tabA.dev });
    const changesB: DataChange[] = [];
    tabB.store.subscribe((c) => changesB.push(c));

    const pc = await loggedIn(server, { kind: "mobile" });
    await pc.store.saveNote(note("remote", "vom PC"));
    await pc.engine.syncNow();

    server.pushDelayMs = 20;
    await tabA.store.saveNote(note("a", "Tab A"));
    await tabB.store.saveNote(note("b", "Tab B"));
    await Promise.all([tabA.engine.syncNow(), tabB.engine.syncNow(), tabA.engine.syncNow()]);
    expect(locks.maxHeld).toBe(1);
    expect(server.maxInFlightPushes).toBe(1);
    expect(server.notes.get("a")).toBeDefined();
    expect(server.notes.get("b")).toBeDefined();
    expect(await tabB.store.getNote("remote")).not.toBeNull();
    await vi.waitFor(() => expect(changesB.some((c) => c.source === "other-tab")).toBe(true));
    expect(tabA.engine.status().pending).toBe(0);
  });
});

describe("native deviceState", () => {
  it("is reported with pushes, also without outbox, once per change", async () => {
    const server = new FakeServer(() => real);
    let state: DeviceState | null = { scheduledSeq: 0, localNotifications: "granted" };
    const c = await loggedIn(server, { kind: "mobile", deviceState: () => state });
    const pushes = () => server.log.filter((l) => l.path === "/sync/push");
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].body).toMatchObject({ notes: [], reminders: [], deviceState: state });
    await c.engine.syncNow();
    expect(pushes()).toHaveLength(1);
    state = { scheduledSeq: 7, localNotifications: "denied" };
    await c.engine.syncNow();
    expect(pushes()).toHaveLength(2);
    expect(server.deviceStates.get("last")).toEqual(state);
  });
});
