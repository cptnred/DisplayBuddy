// @vitest-environment node
/**
 * Local planning of the native shell (PLAN_V3_SYNC §10.3) with a fake notification
 * plugin, the real IndexedDB data layer (fake-indexeddb), the real sync engine and the
 * in-memory server of the C1 testkit. No network, simulated clock.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../../lib/clock";
import type { DeviceState } from "../../lib/sync/types";
import type { Note } from "../../types";
import type { DataStore, SyncEngine } from "../contract";
import { openDataStore, syncAccess } from "../data";
import { createSyncEngine } from "../sync";
import { FakeServer, ManualTimers } from "../sync/testkit";
import { createNativeNotifier, followSync, type NativeNotifier, type NativePrefs } from "./native";
import { MAX_PLANNED, notificationId, TEST_NOTIFICATION_ID } from "./native-plan";
import type { ActionEvent, LocalNotification, NativePermission, NotificationPlugin } from "./native-plugin";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");
let real = T0;
const stores: DataStore[] = [];
const engines: SyncEngine[] = [];
const notifiers: NativeNotifier[] = [];

afterEach(() => {
  for (const n of notifiers.splice(0)) n.stop();
  for (const e of engines.splice(0)) e.stop();
  for (const s of stores.splice(0)) syncAccess(s).close();
  real = T0;
});

class FakePlugin implements NotificationPlugin {
  perm: NativePermission = "granted";
  askAnswer: NativePermission = "granted";
  pendingMap = new Map<number, LocalNotification>();
  delivered: number[] = [];
  shown: LocalNotification[] = [];
  calls: string[] = [];
  failFor = new Set<number>();
  setupCount = 0;
  private actionCb: ((e: ActionEvent) => void) | null = null;
  private receivedCb: ((id: number) => void) | null = null;

  async permission() {
    return this.perm;
  }
  async requestPermission() {
    this.calls.push("request");
    if (this.perm === "prompt") this.perm = this.askAnswer;
    return this.perm;
  }
  async setup() {
    this.setupCount++;
  }
  async schedule(n: LocalNotification) {
    this.calls.push(`schedule:${n.id}`);
    if (this.failFor.has(n.id)) throw new Error("pastScheduledTime");
    if (n.atMs === null) this.shown.push(n);
    else this.pendingMap.set(n.id, n);
  }
  async pending() {
    return [...this.pendingMap.values()].map((n) => ({ id: n.id, title: n.title, body: n.body }));
  }
  async cancel(ids: number[]) {
    this.calls.push(`cancel:${ids.join(",")}`);
    for (const id of ids) this.pendingMap.delete(id);
  }
  async active() {
    return [...this.delivered];
  }
  async removeActive(ids: number[]) {
    this.calls.push(`removeActive:${ids.join(",")}`);
    this.delivered = this.delivered.filter((d) => !ids.includes(d));
  }
  async onAction(cb: (e: ActionEvent) => void) {
    this.actionCb = cb;
    return () => {
      this.actionCb = null;
    };
  }
  async onReceived(cb: (id: number) => void) {
    this.receivedCb = cb;
    return () => {
      this.receivedCb = null;
    };
  }
  /** The OS rings: pending → delivered. */
  deliver(id: number) {
    this.pendingMap.delete(id);
    this.delivered.push(id);
    this.receivedCb?.(id);
  }
  action(e: ActionEvent) {
    this.actionCb?.(e);
  }
  ids(): number[] {
    return [...this.pendingMap.keys()].sort((a, b) => a - b);
  }
}

function memPrefs(initial: boolean | null = null): NativePrefs {
  let v = initial;
  return { enabled: () => v, setEnabled: (on) => void (v = on) };
}

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

async function phone(
  opts: {
    zone?: () => string;
    plugin?: FakePlugin;
    prefs?: NativePrefs;
    factory?: IDBFactory;
    onDeviceState?: (s: DeviceState) => void;
  } = {},
) {
  const store = await openDataStore({
    dbName: "phone",
    indexedDB: opts.factory ?? new IDBFactory(),
    clock: createClock(() => real),
    deviceZone: () => "Europe/Berlin",
  });
  stores.push(store);
  await syncAccess(store).setAccount({
    username: "martin",
    deviceId: "phone-1",
    serverUrl: "https://buddy.test",
    timeZone: "Europe/Berlin",
  });
  const plugin = opts.plugin ?? new FakePlugin();
  const states: DeviceState[] = [];
  const opened: string[] = [];
  const notifier = createNativeNotifier({
    store,
    getCursor: () => syncAccess(store).getCursor(),
    plugin,
    deviceZone: opts.zone ?? (() => "Europe/Berlin"),
    prefs: opts.prefs ?? memPrefs(),
    onDeviceState: (s) => {
      states.push(s);
      opts.onDeviceState?.(s);
    },
    onOpenNote: (id) => opened.push(id),
  });
  notifiers.push(notifier);
  return { store, plugin, notifier, states, opened };
}

/** Waits until the store's change listeners and the coalesced plan have settled. */
async function settle(n: NativeNotifier) {
  await new Promise((r) => setTimeout(r, 0));
  await n.replan("change");
}

const idOf = (noteId: string, at: string) => notificationId(noteId, at)!;

describe("planning", () => {
  it("plans at start: one notification per future reminder at its absolute time", async () => {
    const { store, plugin, notifier, states } = await phone();
    await store.saveNote(note("a", "Arzt"));
    const r = await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    expect(plugin.setupCount).toBe(1);
    expect(plugin.ids()).toEqual([idOf("a", r.at)]);
    const n = plugin.pendingMap.get(idOf("a", r.at))!;
    expect(n).toMatchObject({ title: "Arzt", body: "Erinnerung um 09:00", actions: true });
    expect(new Date(n.atMs!).toISOString()).toBe("2026-11-07T08:00:00.000Z");
    expect(n.extra).toEqual({ noteId: "a", at: r.at });
    expect(notifier.deviceState()).toEqual({ scheduledSeq: 0, localNotifications: "granted" });
    expect(states).toHaveLength(1);
    expect(await notifier.status()).toEqual({ state: "enabled" });
  });

  it("re-plans after a local change: moved reminder gets a new id, the old one is cancelled", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "Arzt"));
    const r1 = await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    const r2 = await store.setReminder("a", "2026-11-07", "10:30", "Europe/Berlin", "none");
    await settle(notifier);
    expect(plugin.ids()).toEqual([idOf("a", r2.at)]);
    expect(plugin.calls).toContain(`cancel:${idOf("a", r1.at)}`);
    await store.removeReminder("a");
    await settle(notifier);
    expect(plugin.ids()).toEqual([]);
  });

  it(`never plans more than ${MAX_PLANNED} (iOS limit 64)`, async () => {
    const { store, plugin, notifier, states } = await phone();
    for (let i = 0; i < 70; i++) {
      await store.saveNote(note(`n${i}`, `Notiz ${i}`));
      const t = new Date(T0 + (i + 1) * 3_600_000);
      const hh = String(t.getUTCHours()).padStart(2, "0");
      await store.setReminder(`n${i}`, t.toISOString().slice(0, 10), `${hh}:00`, "UTC", "none");
    }
    await notifier.start();
    expect(plugin.pendingMap.size).toBe(MAX_PLANNED);
    expect(notifier.lastReport()).toMatchObject({ planned: MAX_PLANNED, truncated: 10 });
    // the nearest ones
    expect([...plugin.pendingMap.values()].every((n) => n.atMs! <= T0 + 60 * 3_600_000)).toBe(true);
    // the test notification slot stays free
    await notifier.checkTiming();
    expect(plugin.pendingMap.size).toBe(MAX_PLANNED + 1);
    expect(states.at(-1)?.localNotifications).toBe("granted");
  });

  it("zone change on a trip: same ids and instants, only the text is replaced", async () => {
    let zone = "Europe/Berlin";
    const { store, plugin, notifier } = await phone({ zone: () => zone });
    await store.saveNote(note("a", "Arzt"));
    const r = await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "daily");
    await notifier.start();
    const before = plugin.pendingMap.get(idOf("a", r.at))!;
    zone = "America/New_York";
    await notifier.replan("resume");
    const after = plugin.pendingMap.get(idOf("a", r.at))!;
    expect(after.atMs).toBe(before.atMs);
    expect(after.body).toBe("Erinnerung um 03:00 (09:00 Berlin)");
    expect(plugin.ids()).toEqual([idOf("a", r.at)]);
  });

  it("removes delivered notifications whose reminder was resolved elsewhere", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "Arzt"));
    const r = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "none");
    await notifier.start();
    real = Date.parse(r.at) + 1000;
    plugin.deliver(idOf("a", r.at));
    await notifier.replan("resume");
    expect(plugin.delivered).toEqual([idOf("a", r.at)]); // still due → stays
    await store.ackReminder("a");
    await settle(notifier);
    expect(plugin.delivered).toEqual([]);
  });

  it("sign-out: the old account's notifications are cancelled", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "A"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    expect(plugin.pendingMap.size).toBe(1);
    await store.signOut();
    await settle(notifier);
    expect(plugin.pendingMap.size).toBe(0);
    expect(notifier.deviceState()).toBeNull();
  });

  it("coalesces bursts of triggers into at most one extra run", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "A"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    const pendingCalls = vi.spyOn(plugin, "pending");
    await Promise.all([1, 2, 3, 4, 5].map(() => notifier.replan("sync")));
    expect(pendingCalls.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("a failed schedule does not advance scheduledSeq", async () => {
    const plugin = new FakePlugin();
    const { store, notifier } = await phone({ plugin });
    await store.saveNote(note("a", "A"));
    const r = await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    plugin.failFor.add(idOf("a", r.at));
    vi.spyOn(syncAccess(store), "getCursor").mockResolvedValue(7);
    await notifier.start();
    expect(notifier.deviceState()).toEqual({ scheduledSeq: 0, localNotifications: "granted" });
    plugin.failFor.clear();
    await notifier.replan("resume");
    expect(notifier.deviceState()).toEqual({ scheduledSeq: 7, localNotifications: "granted" });
  });
});

describe("permissions", () => {
  it("not asked yet: nothing planned, reported as denied; enable() asks and plans", async () => {
    const plugin = new FakePlugin();
    plugin.perm = "prompt";
    const { store, notifier } = await phone({ plugin });
    await store.saveNote(note("a", "A"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    expect(plugin.pendingMap.size).toBe(0);
    expect(notifier.deviceState()?.localNotifications).toBe("denied");
    expect(await notifier.status()).toEqual({ state: "available" });
    const s = await notifier.enable();
    expect(plugin.calls[0]).toBe("request");
    expect(s).toEqual({ state: "enabled" });
    expect(plugin.pendingMap.size).toBe(1);
    expect(notifier.deviceState()?.localNotifications).toBe("granted");
  });

  it("denied by the user: status denied, nothing planned", async () => {
    const plugin = new FakePlugin();
    plugin.perm = "prompt";
    plugin.askAnswer = "denied";
    const { store, notifier } = await phone({ plugin });
    await store.saveNote(note("a", "A"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    expect(await notifier.enable()).toEqual({ state: "denied" });
    expect(plugin.pendingMap.size).toBe(0);
  });

  it("disable() cancels the plan and reports denied; the test notification is kept", async () => {
    const prefs = memPrefs();
    const { store, plugin, notifier } = await phone({ prefs });
    await store.saveNote(note("a", "A"));
    await store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await notifier.start();
    await notifier.checkTiming();
    expect(await notifier.disable()).toEqual({ state: "available" });
    expect(plugin.ids()).toEqual([TEST_NOTIFICATION_ID]);
    expect(prefs.enabled()).toBe(false);
    expect(notifier.deviceState()?.localNotifications).toBe("denied");
  });
});

describe("actions (offline, through the data layer)", () => {
  it("„10 Min. später“ (Android: extra) moves the reminder, queues it and re-plans", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "A"));
    const r = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "none");
    await notifier.start();
    real = Date.parse(r.at) + 2000;
    plugin.deliver(idOf("a", r.at));
    const before = await store.pendingCount();
    plugin.action({ actionId: "snooze10", id: idOf("a", r.at), extra: { noteId: "a", at: r.at } });
    await vi.waitFor(async () => expect((await store.getReminder("a"))?.at).not.toBe(r.at));
    const moved = (await store.getReminder("a"))!;
    expect(Date.parse(moved.at)).toBe(real + 10 * 60_000);
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(before);
    await settle(notifier);
    expect(plugin.ids()).toEqual([idOf("a", moved.at)]);
    expect(plugin.delivered).toEqual([]);
  });

  it("„Erledigt“ (iOS: only the id) on a daily reminder → next day 09:00 Berlin, even in New York", async () => {
    const { store, plugin, notifier } = await phone({ zone: () => "America/New_York" });
    await store.saveNote(note("a", "A"));
    const r = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "daily");
    await notifier.start();
    real = Date.parse(r.at) + 1000;
    plugin.deliver(idOf("a", r.at));
    plugin.action({ actionId: "ack", id: idOf("a", r.at), extra: null });
    await vi.waitFor(async () => expect((await store.getReminder("a"))?.at).toBe("2026-11-07T10:05:00.000Z"));
    await settle(notifier);
    expect(plugin.ids()).toEqual([idOf("a", "2026-11-07T10:05:00.000Z")]);
    expect(plugin.pendingMap.get(idOf("a", "2026-11-07T10:05:00.000Z"))?.body).toBe(
      "Erinnerung um 05:05 (11:05 Berlin)",
    );
  });

  it("ignores an action for an occurrence that changed meanwhile", async () => {
    const { store, plugin, notifier } = await phone();
    await store.saveNote(note("a", "A"));
    const old = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "none");
    await notifier.start();
    const now = await store.setReminder("a", "2026-11-08", "08:00", "Europe/Berlin", "none");
    plugin.action({ actionId: "ack", id: idOf("a", old.at), extra: null });
    plugin.action({ actionId: "snooze10", id: idOf("a", old.at), extra: { noteId: "a", at: old.at } });
    await settle(notifier);
    expect(await store.getReminder("a")).toEqual(now);
  });

  it("a tap opens the note", async () => {
    const { store, plugin, notifier, opened } = await phone();
    await store.saveNote(note("a", "A"));
    const r = await store.setReminder("a", "2026-11-06", "11:05", "Europe/Berlin", "none");
    await notifier.start();
    plugin.action({ actionId: "tap", id: idOf("a", r.at), extra: null });
    await vi.waitFor(() => expect(opened).toEqual(["a"]));
  });
});

describe("§10.4 timing check", () => {
  it("plans a test in 2 min, finds it in pending(), measures the delivery", async () => {
    const { plugin, notifier } = await phone({ zone: () => "America/New_York" });
    await notifier.start();
    const check = await notifier.checkTiming();
    expect(check).toEqual({
      plannedFor: "2026-11-06T10:02:00.000Z",
      deviceZone: "America/New_York",
      pendingFound: true,
      deliveredAt: null,
      deviationMs: null,
    });
    expect(plugin.pendingMap.get(TEST_NOTIFICATION_ID)?.body).toContain("Geplant für 05:02 Uhr (New York)");
    // the plan never touches the test notification
    await notifier.replan("resume");
    expect(plugin.ids()).toEqual([TEST_NOTIFICATION_ID]);
    real = T0 + 2 * 60_000 + 3000;
    plugin.deliver(TEST_NOTIFICATION_ID);
    expect(notifier.lastTimingCheck()).toMatchObject({ deviationMs: 3000 });
    await vi.waitFor(() => expect(plugin.shown[0]?.title).toBe("Zeitplanung stimmt"));
    expect(plugin.shown[0].body).toBe("Abweichung +3 s (Zone New York)");
  });

  it("test() fails when the notification is not pending", async () => {
    const plugin = new FakePlugin();
    plugin.pending = async () => [];
    const { notifier } = await phone({ plugin });
    await expect(notifier.test()).rejects.toThrow();
  });
});

describe("with the sync engine (scenarios 28/29 logic)", () => {
  async function pc(server: FakeServer) {
    const store = await openDataStore({
      dbName: "pc",
      indexedDB: new IDBFactory(),
      clock: createClock(() => real),
      deviceZone: () => "Europe/Berlin",
    });
    stores.push(store);
    const timers = new ManualTimers();
    const engine = createSyncEngine({
      store,
      http: server.device("web", () => real, "pc").adapter,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    engines.push(engine);
    await engine.login(server.username, server.password, "PC");
    return { store, engine };
  }

  it("PC moves/acks a reminder → after the phone's sync the old plan is gone, the new one set, scheduledSeq reported", async () => {
    const server = new FakeServer(() => real);
    const desk = await pc(server);
    let engine: SyncEngine | null = null;
    const requested: string[] = [];
    const { store, plugin, notifier } = await phone({ onDeviceState: () => engine?.requestSync("change") });
    const timers = new ManualTimers();
    const sync = createSyncEngine({
      store,
      http: server.device("mobile", () => real, "phone").adapter,
      deviceState: () => notifier.deviceState(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    engines.push(sync);
    const realRequest = sync.requestSync.bind(sync);
    sync.requestSync = (reason) => {
      requested.push(reason);
      realRequest(reason);
    };
    engine = sync;
    const off = followSync(notifier, sync);
    await sync.login(server.username, server.password, "Handy");
    await notifier.start();

    // PC sets a reminder
    await desk.store.saveNote(note("a", "Arzt"));
    const r1 = await desk.store.setReminder("a", "2026-11-07", "09:00", "Europe/Berlin", "none");
    await desk.engine.syncNow();
    await sync.syncNow();
    await vi.waitFor(() => expect(plugin.ids()).toEqual([idOf("a", r1.at)]));
    const seqAfterSet = server.seq;
    await vi.waitFor(() => expect(notifier.deviceState()?.scheduledSeq).toBe(seqAfterSet));

    // reported with the next push (deviceState only)
    await sync.syncNow();
    expect(server.deviceStates.get("last")).toEqual({ scheduledSeq: seqAfterSet, localNotifications: "granted" });

    // PC snoozes (moves) it
    const r2 = await desk.store.snoozeReminder("a", 30);
    await desk.engine.syncNow();
    await sync.syncNow();
    await vi.waitFor(() => expect(plugin.ids()).toEqual([idOf("a", r2.at)]));
    expect(plugin.calls).toContain(`cancel:${idOf("a", r1.at)}`);
    await vi.waitFor(() => expect(notifier.deviceState()?.scheduledSeq).toBe(server.seq));
    await sync.syncNow();
    expect(server.deviceStates.get("last")).toEqual({ scheduledSeq: server.seq, localNotifications: "granted" });

    // PC acknowledges → nothing left
    await desk.store.ackReminder("a");
    await desk.engine.syncNow();
    await sync.syncNow();
    await vi.waitFor(() => expect(plugin.ids()).toEqual([]));
    expect(requested.length).toBeGreaterThan(0);
    off();
  });

  it("offline: the plan stays, „Erledigt“ is queued and synced after reconnecting", async () => {
    const server = new FakeServer(() => real);
    const desk = await pc(server);
    const { store, plugin, notifier } = await phone();
    const dev = server.device("mobile", () => real, "phone");
    const timers = new ManualTimers();
    const engine = createSyncEngine({
      store,
      http: dev.adapter,
      deviceState: () => notifier.deviceState(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    engines.push(engine);
    await engine.login(server.username, server.password, "Handy");
    await notifier.start();
    await desk.store.saveNote(note("a", "Arzt"));
    const r = await desk.store.setReminder("a", "2026-11-06", "12:00", "Europe/Berlin", "none");
    await desk.engine.syncNow();
    await engine.syncNow();
    await vi.waitFor(() => expect(plugin.ids()).toEqual([idOf("a", r.at)]));

    // flight mode: the OS rings by itself, the action works offline
    dev.offline = true;
    real = Date.parse(r.at) + 5000;
    plugin.deliver(idOf("a", r.at));
    plugin.action({ actionId: "ack", id: idOf("a", r.at), extra: { noteId: "a", at: r.at } });
    await vi.waitFor(async () => expect((await store.getReminder("a"))?.state).toBe("done"));
    await engine.syncNow();
    expect(engine.status().state).toBe("offline");
    expect(await store.pendingCount()).toBeGreaterThan(0);

    dev.offline = false;
    await engine.syncNow();
    expect(await store.pendingCount()).toBe(0);
    await desk.engine.syncNow();
    expect((await desk.store.getReminder("a"))?.state).toBe("done");
    await settle(notifier);
    expect(plugin.delivered).toEqual([]);
  });
});
