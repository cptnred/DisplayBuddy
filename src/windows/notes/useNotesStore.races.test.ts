/**
 * Regression tests for review findings M2 (order saves serialized) and M3 (retry uses latest
 * state), plus v3 sync races (remote changes vs. pending/in-flight saves, PLAN_V3_SYNC §8).
 */
import { vi } from "vitest";
import type { Note } from "../../types";

const h = vi.hoisted(() => ({
  api: {
    listNotes: vi.fn(),
    loadSettings: vi.fn(),
    saveNote: vi.fn(),
    saveOrder: vi.fn(),
    saveSettings: vi.fn(async () => ({})),
    deleteNote: vi.fn(),
    listReminders: vi.fn(async () => []),
    syncStatus: vi.fn(async () => ({ enabled: false, clockOffsetMs: 0 })),
  },
}));
vi.mock("../../lib/api", () => ({ api: h.api }));
import { clock } from "../../lib/clock";
import {
  createNotesController,
  NOTICE_MS,
  REMOTE_DELETED_TEXT,
  RETRY_DELAY_MS,
  SAVE_DELAY_MS,
} from "./useNotesStore";

const id = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const mk = (i: string, text: string): Note => ({
  id: i,
  title: "",
  color: "yellow",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1,
});
const A = id("a"), B = id("b"), C = id("c");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.api.listNotes.mockResolvedValue([mk(A, "a"), mk(B, "b"), mk(C, "c")]);
  h.api.loadSettings.mockResolvedValue({ activeNoteId: A, notesPinned: false });
});
afterEach(() => vi.useRealTimers());

test("M2: quick reorders are saved one after another, newest last", async () => {
  const ctrl = createNotesController();
  await ctrl.load();
  const resolvers: Array<() => void> = [];
  h.api.saveOrder.mockImplementation(() => new Promise<void>((r) => resolvers.push(r)));

  ctrl.moveActive(1);
  ctrl.moveActive(1);
  await vi.advanceTimersByTimeAsync(0);
  // second save must not start while the first is in flight
  expect(h.api.saveOrder).toHaveBeenCalledTimes(1);
  resolvers[0]();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.api.saveOrder).toHaveBeenCalledTimes(2);
  resolvers[1]();
  const last = h.api.saveOrder.mock.calls.at(-1)![0] as string[];
  expect(last).toEqual(ctrl.getState().notes.map((n) => n.id));
});

test("M3: after a failed retry the latest content is re-scheduled, not the failed snapshot", async () => {
  const ctrl = createNotesController();
  await ctrl.load();
  let calls = 0;
  h.api.saveNote.mockImplementation(async (n: Note) => {
    calls++;
    if (calls <= 2) {
      // while the first save is failing, the user keeps typing
      // and the window gets hidden → flush chains the newer snapshot behind this run
      if (calls === 1) {
        ctrl.updateNote(A, { title: "newer" });
        void ctrl.flushAll();
      }
      throw new Error("disk busy");
    }
    return n;
  });
  ctrl.updateNote(A, { title: "old" });
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + RETRY_DELAY_MS + SAVE_DELAY_MS * 3);
  await ctrl.flushAll();
  const saved = h.api.saveNote.mock.calls.map((c) => (c[0] as Note).title);
  expect(saved.at(-1)).toBe("newer");
});

// ---- v3: sync (PLAN_V3_SYNC §8) ---------------------------------------------------

describe("v3 sync: notes-changed and corrected clock", () => {
  type Handler = (payload: unknown) => void;
  const handlers: Record<string, Handler> = {};
  const listen = (name: string) =>
    vi.fn(async (cb: Handler) => {
      handlers[name] = cb;
      return () => undefined;
    });
  const status = (enabled: boolean, clockOffsetMs: number) => ({
    enabled,
    serverUrl: "https://buddy.example.org",
    deviceName: "PC",
    state: "idle",
    lastSyncAt: null,
    pending: 0,
    message: null,
    clockOffsetMs,
  });

  beforeEach(() => {
    Object.assign(h.api, {
      onNotesHidden: listen("hidden"),
      onFlushRequest: listen("flush"),
      onNoteCreateRequest: listen("create"),
      onSettingsChanged: listen("settings"),
      onRemindersChanged: listen("reminders"),
      onSyncStatus: listen("syncStatus"),
      onNotesChanged: listen("notesChanged"),
      flushDone: vi.fn(async () => undefined),
    });
    h.api.saveNote.mockImplementation(async (n: Note) => n);
    h.api.syncStatus.mockResolvedValue(status(false, 0));
  });
  afterEach(() => clock.setOffsetMs(0));

  async function connected() {
    const ctrl = createNotesController();
    const cleanup = ctrl.connect();
    await ctrl.load();
    await vi.advanceTimersByTimeAsync(0);
    return { ctrl, cleanup };
  }
  const remote = (notes: Note[], deletedIds: string[] = [], order: string[] | null = null) =>
    handlers.notesChanged({ notes, deletedIds, order });
  const ids = (ctrl: ReturnType<typeof createNotesController>) => ctrl.getState().notes.map((n) => n.id);
  const active = (ctrl: ReturnType<typeof createNotesController>) =>
    ctrl.getState().notes[ctrl.getState().activeIndex].id;

  test("updatedAt uses the corrected clock from sync-status", async () => {
    vi.setSystemTime(new Date("2026-11-06T10:00:00.000Z"));
    const { ctrl } = await connected();
    handlers.syncStatus(status(true, 90_000)); // PC 90 s behind the server
    ctrl.updateNote(A, { title: "x" });
    expect(ctrl.getState().notes[0].updatedAt).toBe("2026-11-06T10:01:30.000Z");
    expect(ctrl.getState().sync?.clockOffsetMs).toBe(90_000);
    // sync switched off → plain device time again (behaviour of 0.2.0)
    handlers.syncStatus(status(false, 90_000));
    ctrl.updateNote(A, { title: "y" });
    expect(ctrl.getState().notes[0].updatedAt).toBe("2026-11-06T10:00:00.000Z");
  });

  test("remote version of an inactive note is taken over without a save", async () => {
    const { ctrl } = await connected();
    remote([{ ...mk(B, "remote b"), title: "B!" }]);
    expect(ctrl.getState().notes[1].title).toBe("B!");
    expect(ctrl.getState().remoteRevision[B]).toBe(1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(h.api.saveNote).not.toHaveBeenCalled();
  });

  test("active note with a pending autosave ignores the remote version, local text is saved", async () => {
    const { ctrl } = await connected();
    ctrl.updateNote(A, { title: "typing" });
    remote([{ ...mk(A, "remote"), title: "remote" }]);
    expect(ctrl.getState().notes[0].title).toBe("typing");
    expect(ctrl.getState().remoteRevision[A]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect((h.api.saveNote.mock.calls.at(-1)![0] as Note).title).toBe("typing");
  });

  test("a save in flight also wins over the remote version", async () => {
    const { ctrl } = await connected();
    let release!: () => void;
    h.api.saveNote.mockImplementation((n: Note) => new Promise<Note>((r) => (release = () => r(n))));
    ctrl.updateNote(A, { title: "local" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); // save started, not finished
    remote([{ ...mk(A, "remote"), title: "remote" }]);
    expect(ctrl.getState().notes[0].title).toBe("local");
    release();
    await vi.advanceTimersByTimeAsync(0);
    // once saved, the next remote version is taken over again
    remote([{ ...mk(A, "remote 2"), title: "remote 2" }]);
    expect(ctrl.getState().notes[0].title).toBe("remote 2");
    expect(ctrl.getState().remoteRevision[A]).toBe(1);
  });

  test("same content (e.g. clamped stamp) does not reload the editor", async () => {
    const { ctrl } = await connected();
    remote([{ ...mk(A, "a"), updatedAt: "2026-11-06T11:00:00.000Z" }]);
    expect(ctrl.getState().notes[0].updatedAt).toBe("2026-11-06T11:00:00.000Z");
    expect(ctrl.getState().remoteRevision[A]).toBeUndefined();
  });

  test("active note deleted elsewhere: neighbour selected and hint shown", async () => {
    const { ctrl } = await connected();
    ctrl.select(1); // B active
    remote([], [B]);
    expect(ids(ctrl)).toEqual([A, C]);
    expect(active(ctrl)).toBe(C);
    expect(ctrl.getState().syncNotice).toBe(REMOTE_DELETED_TEXT);
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(ctrl.getState().syncNotice).toBeNull();
  });

  test("remote deletion of a note with unsaved edits is ignored (the edit is newer)", async () => {
    const { ctrl } = await connected();
    ctrl.updateNote(B, { title: "still typing" });
    remote([], [B]);
    expect(ids(ctrl)).toEqual([A, B, C]);
    expect(ctrl.getState().syncNotice).toBeNull();
  });

  test("remote order and new notes; the active note stays selected", async () => {
    const { ctrl } = await connected();
    ctrl.select(2); // C
    const D = id("d");
    remote([mk(D, "d")], [], [C, D, A, B]);
    expect(ids(ctrl)).toEqual([C, D, A, B]);
    expect(active(ctrl)).toBe(C);
  });

  test("notes-changed before the initial load is ignored (the load brings the data)", async () => {
    const ctrl = createNotesController();
    ctrl.connect();
    remote([mk(id("e"), "e")]);
    await ctrl.load();
    expect(ids(ctrl)).toEqual([A, B, C]);
  });
});
