/** Regression tests for review findings M2 (order saves serialized) and M3 (retry uses latest state). */
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
  },
}));
vi.mock("../../lib/api", () => ({ api: h.api }));
import { createNotesController, RETRY_DELAY_MS, SAVE_DELAY_MS } from "./useNotesStore";

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
