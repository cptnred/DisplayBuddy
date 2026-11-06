import { describe, expect, it, vi } from "vitest";
import { createClock } from "../../lib/clock";
import type { Note, Reminder } from "../../types";
import { createFakeStore } from "../ui/testing/fakeStore";
import {
  buildNotification,
  closeResolved,
  handleNotificationClick,
  handlePush,
  parsePayload,
  safeUrl,
  type BuddyNotificationOptions,
  type ShownNotification,
  type SwDeps,
} from "./swHandlers";

const ORIGIN = "https://buddy.test";
const NOW = Date.parse("2026-11-11T08:00:30.000Z");
const AT = "2026-11-11T08:00:00.000Z";

const note: Note = {
  id: "n1",
  title: "Müll",
  color: "yellow",
  content: { type: "doc", content: [{ type: "paragraph" }] },
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  schemaVersion: 1,
};
const reminder = (patch: Partial<Reminder> = {}): Reminder => ({
  noteId: "n1",
  at: AT,
  repeat: "daily",
  state: "scheduled",
  firedAt: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
  timeZone: "Europe/Berlin",
  ...patch,
});

const payload = {
  v: 1,
  type: "reminder",
  noteId: "n1",
  at: AT,
  timeZone: "Europe/Berlin",
  title: "Erinnerung: Müll",
  body: "Tonne rausstellen",
  url: "/notes/n1",
};

function setup(opts: { maxActions?: number; storeFails?: boolean; reminders?: Reminder[] } = {}) {
  const store = createFakeStore({
    clock: createClock(() => NOW),
    notes: [note],
    reminders: opts.reminders ?? [reminder()],
    deviceZone: () => "America/New_York",
  });
  const shown: Array<{ title: string; options: BuddyNotificationOptions }> = [];
  const client = { url: `${ORIGIN}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
  const deps: SwDeps & { clientList: (typeof client)[] } = {
    clientList: [],
    registration: {
      showNotification: vi.fn(async (title: string, options: BuddyNotificationOptions) => {
        shown.push({ title, options });
      }),
    },
    clients: {
      matchAll: vi.fn(async () => deps.clientList),
      openWindow: vi.fn(async () => null),
    },
    openStore: opts.storeFails ? vi.fn(async () => Promise.reject(new Error("idb"))) : vi.fn(async () => store),
    sync: vi.fn(async () => undefined),
    deviceZone: () => "America/New_York",
    maxActions: () => opts.maxActions ?? 0,
    now: () => NOW,
    origin: ORIGIN,
    setBadge: vi.fn(async () => undefined),
  };
  return { store, shown, deps, client };
}

const shownNotification = (data: unknown, tag?: string): ShownNotification & { close: ReturnType<typeof vi.fn> } => ({
  data,
  tag,
  close: vi.fn(),
});

describe("payload helpers", () => {
  it("parses tolerant and rejects unknown types", () => {
    expect(parsePayload(payload)?.noteId).toBe("n1");
    expect(parsePayload({ type: "other" })).toBeNull();
    expect(parsePayload("text")).toBeNull();
    expect(parsePayload({ type: "test" })?.title).toBe("Display Buddy");
  });

  it("only opens same-origin paths", () => {
    expect(safeUrl("/notes/n1", ORIGIN)).toBe("/notes/n1");
    expect(safeUrl("https://evil.example/x", ORIGIN)).toBe("/");
    expect(safeUrl(null, ORIGIN)).toBe("/");
  });

  it("shows device time with the original zone and adds actions only when supported", () => {
    const p = parsePayload(payload);
    const noActions = buildNotification(p, { deviceZone: "America/New_York", now: NOW, maxActions: 0, origin: ORIGIN });
    expect(noActions.title).toBe("Erinnerung: Müll");
    expect(noActions.options.body).toBe("Tonne rausstellen\nfällig heute, 03:00 (09:00 Berlin)");
    expect(noActions.options.actions).toBeUndefined();
    expect(noActions.options.tag).toBe("r-n1");
    expect(noActions.options.renotify).toBe(true);
    expect(noActions.options.data).toEqual({ noteId: "n1", at: AT, url: "/notes/n1" });
    expect(noActions.options.navigate).toBe(`${ORIGIN}/notes/n1`);
    const withActions = buildNotification(p, { deviceZone: "UTC", now: NOW, maxActions: 2, origin: ORIGIN });
    expect(withActions.options.actions?.map((a) => a.action)).toEqual(["ack", "snooze10"]);
  });
});

describe("handlePush", () => {
  it("always shows a notification and stores the due state", async () => {
    const { deps, shown, store } = setup();
    await handlePush(payload, deps);
    expect(shown).toHaveLength(1);
    expect((await store.getReminder("n1"))?.state).toBe("due");
    expect(deps.setBadge).toHaveBeenCalledWith(1);
  });

  it("shows a generic notification for an unreadable payload", async () => {
    const { deps, shown } = setup();
    await handlePush(null, deps);
    expect(shown).toEqual([{ title: "Display Buddy", options: expect.objectContaining({ body: "Neue Benachrichtigung" }) }]);
  });

  it("still shows the notification when the data layer fails", async () => {
    const { deps, shown } = setup({ storeFails: true });
    await handlePush(payload, deps);
    expect(shown).toHaveLength(1);
    expect(shown[0].options.body).toContain("fällig");
  });

  it("does not change updatedAt or the outbox when marking due (D-30)", async () => {
    const { deps, store } = setup();
    await handlePush(payload, deps);
    expect((await store.getReminder("n1"))?.updatedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(await store.pendingCount()).toBe(0);
  });

  it("falls back to a plain notification if the rich one is rejected", async () => {
    const { deps } = setup();
    const show = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("bad option"))
      .mockResolvedValueOnce(undefined);
    deps.registration.showNotification = show;
    await handlePush(payload, deps);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toBe("Display Buddy");
  });
});

describe("handleNotificationClick", () => {
  it("„Erledigt“ acknowledges via the data layer (next day 09:00 Berlin) and syncs", async () => {
    const { deps, store } = setup({ reminders: [reminder({ state: "due", firedAt: AT })] });
    const n = shownNotification({ noteId: "n1", at: AT, url: "/notes/n1" }, "r-n1");
    await handleNotificationClick(n, "ack", deps);
    expect(n.close).toHaveBeenCalled();
    const r = await store.getReminder("n1");
    expect(r?.at).toBe("2026-11-12T08:00:00.000Z");
    expect(r?.state).toBe("scheduled");
    expect(r?.updatedAt).toBe(new Date(NOW).toISOString());
    expect(await store.pendingCount()).toBe(1);
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.clients.openWindow).not.toHaveBeenCalled();
  });

  it("„10 Min. später“ snoozes from corrected now", async () => {
    const { deps, store } = setup({ reminders: [reminder({ state: "due" })] });
    await handleNotificationClick(shownNotification({ noteId: "n1", at: AT, url: "/notes/n1" }), "snooze10", deps);
    expect((await store.getReminder("n1"))?.at).toBe(new Date(NOW + 10 * 60_000).toISOString());
  });

  it("ignores a stale notification (reminder already moved elsewhere) but still syncs", async () => {
    const moved = reminder({ at: "2026-11-12T08:00:00.000Z" });
    const { deps, store } = setup({ reminders: [moved] });
    await handleNotificationClick(shownNotification({ noteId: "n1", at: AT, url: "/notes/n1" }), "ack", deps);
    expect(await store.getReminder("n1")).toEqual(moved);
    expect(deps.sync).toHaveBeenCalled();
  });

  it("keeps the change when the sync fails (offline)", async () => {
    const { deps, store } = setup({ reminders: [reminder({ state: "due" })] });
    deps.sync = vi.fn(async () => Promise.reject(new Error("offline")));
    await handleNotificationClick(shownNotification({ noteId: "n1", at: AT, url: "/notes/n1" }), "ack", deps);
    expect(await store.pendingCount()).toBe(1);
  });

  it("a plain click opens /notes/<id> or focuses an open window", async () => {
    const { deps, client } = setup();
    await handleNotificationClick(shownNotification({ noteId: "n1", at: AT, url: "/notes/n1" }), "", deps);
    expect(deps.clients.openWindow).toHaveBeenCalledWith("/notes/n1");
    deps.clientList.push(client);
    await handleNotificationClick(shownNotification(undefined, "r-n1"), "", deps);
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({ type: "buddy-open", url: "/notes/n1" });
  });
});

describe("closeResolved", () => {
  it("closes notifications of done/moved/removed reminders, keeps due and unknown ones", async () => {
    const due = shownNotification({ noteId: "a", at: AT }, "r-a");
    const done = shownNotification({ noteId: "b", at: AT }, "r-b");
    const moved = shownNotification({ noteId: "c", at: AT }, "r-c");
    const removed = shownNotification({ noteId: "d", at: AT }, "r-d");
    const unknown = shownNotification({ noteId: "e", at: AT }, "r-e");
    const test = shownNotification({ noteId: null, at: null }, "buddy-test");
    const reg = {
      showNotification: vi.fn(),
      getNotifications: vi.fn(async () => [due, done, moved, removed, unknown, test]),
    };
    const closed = await closeResolved(
      reg,
      [
        reminder({ noteId: "a", state: "due" }),
        reminder({ noteId: "b", state: "done" }),
        reminder({ noteId: "c", at: "2026-11-12T08:00:00.000Z" }),
      ],
      new Set(["a", "b", "c", "d"]),
      ORIGIN,
    );
    expect(closed).toBe(3);
    expect(due.close).not.toHaveBeenCalled();
    expect(unknown.close).not.toHaveBeenCalled();
    expect(test.close).not.toHaveBeenCalled();
    expect(done.close).toHaveBeenCalled();
    expect(moved.close).toHaveBeenCalled();
    expect(removed.close).toHaveBeenCalled();
  });

  it("does nothing without getNotifications", async () => {
    expect(await closeResolved({ showNotification: vi.fn() }, [], new Set(), ORIGIN)).toBe(0);
  });
});
