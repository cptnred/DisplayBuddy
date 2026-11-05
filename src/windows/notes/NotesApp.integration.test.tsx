/**
 * Integration: NotesApp with the real TipTap NoteEditor (not the fake used in NotesApp.test).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { DEFAULT_SETTINGS, type Note } from "../../types";
import { NoteEditor, type NoteEditorProps } from "../../components/editor/NoteEditor";
import { NotesApp } from "./NotesApp";

const h = vi.hoisted(() => {
  const api = {
    listNotes: vi.fn(),
    saveNote: vi.fn(async (n: unknown) => n),
    saveOrder: vi.fn(async () => undefined),
    deleteNote: vi.fn(async () => undefined),
    loadSettings: vi.fn(),
    saveSettings: vi.fn(async () => ({})),
    hideNotes: vi.fn(async () => undefined),
    flushDone: vi.fn(async () => undefined),
    onSettingsChanged: vi.fn(async () => () => undefined),
    onNotesShown: vi.fn(async () => () => undefined),
    onNotesHidden: vi.fn(async () => () => undefined),
    onNoteCreateRequest: vi.fn(async () => () => undefined),
    onFlushRequest: vi.fn(async () => () => undefined),
    onRemindersChanged: vi.fn(async () => () => undefined),
    onOpenNote: vi.fn(async () => () => undefined),
    listReminders: vi.fn(async () => []),
  };
  return { api };
});
vi.mock("../../lib/api", () => ({ api: h.api }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn(async () => undefined) }),
}));

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const mk = (id: string, text: string): Note => ({
  id,
  title: "",
  color: "yellow",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1,
});

let editors: Editor[] = [];
function TestEditor(props: NoteEditorProps) {
  return <NoteEditor {...props} onReady={(e) => editors.push(e)} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  editors = [];
  h.api.listNotes.mockResolvedValue([mk(A, "alpha"), mk(B, "beta")]);
  h.api.loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, activeNoteId: A });
});

async function setup() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotesApp Editor={TestEditor} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
afterEach(() => vi.useRealTimers());

test("real editor: typing then switching quickly saves the edit to the right note only", async () => {
  await setup();
  const ed = editors.at(-1)!;
  expect(ed.getText()).toBe("alpha");
  act(() => {
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, " edited");
  });
  // switch before the 500 ms autosave elapses
  fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const saved = h.api.saveNote.mock.calls.map((c) => c[0] as Note);
  const forA = saved.filter((n) => n.id === A);
  expect(forA).toHaveLength(1);
  expect(JSON.stringify(forA[0].content)).toContain("alpha edited");
  expect(saved.filter((n) => n.id === B)).toHaveLength(0);
  expect(editors.at(-1)!.getText()).toBe("beta");
});

test("Esc inside the colour palette closes the palette, not the window", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: /^Textfarbe/ }));
  const palette = screen.getByRole("group", { name: "Textfarbe wählen" });
  const swatch = palette.querySelector("button")!;
  fireEvent.keyDown(swatch, { key: "Escape" });
  expect(h.api.hideNotes).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Textfarbe wählen" })).toBeNull();
  // A second Esc (now outside the palette) hides the window.
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(h.api.hideNotes).toHaveBeenCalledTimes(1);
});
