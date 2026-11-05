import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { DEFAULT_SETTINGS, NOTE_SCHEMA_VERSION, type Note, type Settings } from "../../types";
import type { NoteEditorProps } from "./NotesApp";
import { NotesApp } from "./NotesApp";
import { RETRY_DELAY_MS, SAVE_ERROR_TEXT } from "./useNotesStore";
import { docToPlainText, plainTextToDoc } from "./docText";

const h = vi.hoisted(() => {
  const handlers: Record<string, ((payload?: unknown) => void) | undefined> = {};
  const unlisten = vi.fn();
  const on = (name: string) =>
    vi.fn((cb: (payload?: unknown) => void) => {
      handlers[name] = cb;
      return Promise.resolve(unlisten);
    });
  const api = {
    listNotes: vi.fn(),
    loadNote: vi.fn(),
    saveNote: vi.fn(),
    deleteNote: vi.fn(),
    saveOrder: vi.fn(),
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    getAutostart: vi.fn(),
    setAutostart: vi.fn(),
    toggleNotes: vi.fn(),
    showNotes: vi.fn(),
    hideNotes: vi.fn(),
    openSettings: vi.fn(),
    showBuddyMenu: vi.fn(),
    flushDone: vi.fn(),
    quitApp: vi.fn(),
    onSettingsChanged: on("settingsChanged"),
    onNotesShown: on("notesShown"),
    onNotesHidden: on("notesHidden"),
    onNoteCreateRequest: on("noteCreateRequest"),
    onFlushRequest: on("flushRequest"),
    onRemindersChanged: on("remindersChanged"),
    onOpenNote: on("openNote"),
    listReminders: vi.fn(),
    setReminder: vi.fn(),
    ackReminder: vi.fn(),
    snoozeReminder: vi.fn(),
  };
  return { api, handlers, unlisten };
});

vi.mock("../../lib/api", () => ({ api: h.api }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn(() => Promise.resolve()) }),
}));

const { api, handlers } = h;

/** Records every content prop the fake editor was mounted with. */
const mounts: { content: JSONContent | null }[] = [];

function FakeEditor({ content, onChange, autoFocus }: NoteEditorProps) {
  mounts.push({ content });
  return (
    <textarea
      data-testid="editor"
      aria-label="Notizinhalt"
      autoFocus={autoFocus}
      defaultValue={docToPlainText(content)}
      onChange={(e) => onChange(plainTextToDoc(e.target.value))}
    />
  );
}

const ID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
};

function note(id: string, title: string, text: string): Note {
  return {
    id,
    title,
    color: "yellow",
    content: plainTextToDoc(text),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: NOTE_SCHEMA_VERSION,
  };
}

const A = () => note(ID.a, "Alpha", "a-text");
const B = () => note(ID.b, "Beta", "b-text");
const C = () => note(ID.c, "Gamma", "c-text");

const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function setup(notes: Note[], settings: Partial<Settings> = {}) {
  api.listNotes.mockResolvedValue(notes);
  api.loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, ...settings });
  const utils = render(<NotesApp Editor={FakeEditor} />);
  await tick();
  return utils;
}

const savedNotes = () => api.saveNote.mock.calls.map((c) => c[0] as Note);
const indicator = (text: string) => screen.getByText(text, { selector: "[aria-live]" });
const titleInput = () => screen.getByLabelText("Titel") as HTMLInputElement;
const ctrl = (key: string, extra: Partial<KeyboardEventInit> = {}, target: Element | Window = window) =>
  act(() => {
    fireEvent.keyDown(target, { key, ctrlKey: true, ...extra });
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mounts.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  api.saveNote.mockImplementation(async (n: Note) => n);
  api.saveOrder.mockResolvedValue(undefined);
  api.deleteNote.mockResolvedValue(undefined);
  api.saveSettings.mockImplementation(async (patch: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...patch }));
  api.hideNotes.mockResolvedValue(undefined);
  api.flushDone.mockResolvedValue(undefined);
  api.listReminders.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesApp / useNotesStore", () => {
  it("restores the active note from settings.activeNoteId", async () => {
    await setup([A(), B(), C()], { activeNoteId: ID.b });
    expect(titleInput().value).toBe("Beta");
    expect(indicator("2 / 3")).toBeInTheDocument();
    expect((screen.getByTestId("editor") as HTMLTextAreaElement).value).toBe("b-text");
  });

  it("falls back to index 0 when activeNoteId is unknown", async () => {
    await setup([A(), B()], { activeNoteId: "nope" });
    expect(titleInput().value).toBe("Alpha");
  });

  it("shows the empty state and creates the first note", async () => {
    await setup([]);
    expect(screen.getByText("Noch keine Notizen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erste Notiz anlegen" }));
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    const created = savedNotes()[0];
    expect(created.content).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(api.saveOrder).toHaveBeenCalledWith([created.id]);
    expect(indicator("1 / 1")).toBeInTheDocument();
  });

  it("creates a note after the active one and saves it plus the order", async () => {
    await setup([A(), B()]);
    fireEvent.click(screen.getByRole("button", { name: "Neue Notiz" }));
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    const created = savedNotes()[0];
    expect(created).toMatchObject({ title: "", schemaVersion: NOTE_SCHEMA_VERSION, color: "pink" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(api.saveOrder).toHaveBeenCalledWith([ID.a, created.id, ID.b]);
    expect(api.saveOrder.mock.invocationCallOrder[0]).toBeGreaterThan(api.saveNote.mock.invocationCallOrder[0]);
    expect(indicator("2 / 3")).toBeInTheDocument();
    expect(titleInput().value).toBe("");
    await tick(300);
    expect(api.saveSettings).toHaveBeenCalledWith({ activeNoteId: created.id });
  });

  it("Ctrl+N and note-create-request create notes", async () => {
    await setup([A()]);
    await ctrl("n");
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    await act(async () => handlers.noteCreateRequest?.());
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(2);
    expect(indicator("3 / 3")).toBeInTheDocument();
  });

  it("deletes the active note after confirmation; the next one becomes active", async () => {
    await setup([A(), B(), C()], { activeNoteId: ID.b });
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = screen.getByRole("alertdialog", { name: "Notiz wirklich löschen?" });
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await tick();
    expect(api.deleteNote).toHaveBeenCalledWith(ID.b);
    expect(api.saveOrder).toHaveBeenCalledWith([ID.a, ID.c]);
    expect(titleInput().value).toBe("Gamma");
    expect(indicator("2 / 2")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Esc closes the confirm dialog without deleting or hiding; Esc again hides", async () => {
    await setup([A()]);
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = screen.getByRole("alertdialog");
    await act(() => {
      fireEvent.keyDown(within(dialog).getByRole("button", { name: "Abbrechen" }), { key: "Escape" });
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(api.hideNotes).not.toHaveBeenCalled();
    await act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.hideNotes).toHaveBeenCalledTimes(1);
  });

  it("traps focus inside the confirm dialog", async () => {
    await setup([A()]);
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Abbrechen" });
    const confirm = within(dialog).getByRole("button", { name: "Löschen" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("debounces edits: one save with the latest content after 500 ms", async () => {
    await setup([A()]);
    const editor = screen.getByTestId("editor");
    fireEvent.change(editor, { target: { value: "x1" } });
    await tick(200);
    fireEvent.change(editor, { target: { value: "x12" } });
    await tick(499);
    expect(api.saveNote).not.toHaveBeenCalled();
    await tick(1);
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(docToPlainText(savedNotes()[0].content)).toBe("x12");
    expect(savedNotes()[0].updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("race: rapid edits on A then switching to B within 500 ms saves A once with the latest content and never leaks into B", async () => {
    await setup([A(), B()]);
    const editorA = screen.getByTestId("editor");
    fireEvent.change(editorA, { target: { value: "a-1" } });
    fireEvent.change(editorA, { target: { value: "a-12" } });
    fireEvent.change(titleInput(), { target: { value: "Alpha!" } });
    await tick(100);
    await ctrl("ArrowRight");
    await tick();

    // switching flushed A immediately
    const aSaves = () => savedNotes().filter((n) => n.id === ID.a);
    expect(aSaves()).toHaveLength(1);
    expect(docToPlainText(aSaves()[0].content)).toBe("a-12");
    expect(aSaves()[0].title).toBe("Alpha!");

    // B is mounted with its own content
    expect(titleInput().value).toBe("Beta");
    expect((screen.getByTestId("editor") as HTMLTextAreaElement).value).toBe("b-text");
    expect(docToPlainText(mounts[mounts.length - 1].content)).toBe("b-text");

    await tick(2000);
    expect(aSaves()).toHaveLength(1);
    expect(savedNotes().filter((n) => n.id === ID.b)).toHaveLength(0);
    // activeNoteId persisted after the flush
    expect(api.saveSettings).toHaveBeenCalledWith({ activeNoteId: ID.b });

    // editing B only ever writes B's content
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "b-new" } });
    await tick(600);
    const bSaves = savedNotes().filter((n) => n.id === ID.b);
    expect(bSaves).toHaveLength(1);
    expect(docToPlainText(bSaves[0].content)).toBe("b-new");
    expect(bSaves[0].title).toBe("Beta");
  });

  it("never writes an older snapshot after a newer one while a save is in flight", async () => {
    await setup([A()]);
    let release!: () => void;
    api.saveNote.mockImplementationOnce(
      (n: Note) => new Promise<Note>((res) => (release = () => res(n))),
    );
    const editor = screen.getByTestId("editor");
    fireEvent.change(editor, { target: { value: "v1" } });
    await tick(500); // v1 in flight
    fireEvent.change(editor, { target: { value: "v2" } });
    await tick(500); // v2 due but must wait
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await tick();
    expect(savedNotes().map((n) => docToPlainText(n.content))).toEqual(["v1", "v2"]);
  });

  it("notes-hidden flushes pending saves immediately", async () => {
    await setup([A()]);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hide me" } });
    await act(async () => handlers.notesHidden?.());
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(docToPlainText(savedNotes()[0].content)).toBe("hide me");
  });

  it("flush-request flushes everything, then calls flushDone", async () => {
    await setup([A()]);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "bye" } });
    await act(async () => handlers.flushRequest?.());
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(api.flushDone).toHaveBeenCalledTimes(1);
    expect(api.flushDone.mock.invocationCallOrder[0]).toBeGreaterThan(api.saveNote.mock.invocationCallOrder[0]);
  });

  it("pagehide flushes pending saves", async () => {
    await setup([A()]);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "unload" } });
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await tick();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+→ navigates even while focus is inside the title input; Ctrl+← wraps", async () => {
    await setup([A(), B(), C()]);
    const input = titleInput();
    input.focus();
    await ctrl("ArrowRight", {}, input);
    expect(indicator("2 / 3")).toBeInTheDocument();
    await ctrl("ArrowLeft", {}, screen.getByTestId("editor"));
    await ctrl("ArrowLeft", {}, screen.getByTestId("editor"));
    expect(indicator("3 / 3")).toBeInTheDocument();
    expect(titleInput().value).toBe("Gamma");
  });

  it("Ctrl+Shift+→ moves the active note and saves the order", async () => {
    await setup([A(), B(), C()]);
    await ctrl("ArrowRight", { shiftKey: true }, titleInput());
    expect(api.saveOrder).toHaveBeenCalledWith([ID.b, ID.a, ID.c]);
    expect(titleInput().value).toBe("Alpha");
    expect(indicator("2 / 3")).toBeInTheDocument();
  });

  it("side card click selects; arrow button steps", async () => {
    await setup([A(), B(), C()]);
    fireEvent.click(screen.getByRole("button", { name: "Nächste Notiz: Beta" }));
    expect(titleInput().value).toBe("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Vorherige Notiz" }));
    expect(titleInput().value).toBe("Alpha");
  });

  it("colour picker changes the colour and schedules a save", async () => {
    await setup([A()]);
    const group = screen.getByRole("radiogroup", { name: "Notizfarbe" });
    expect(within(group).getByRole("radio", { name: "Gelb" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(group).getByRole("radio", { name: "Blau" }));
    expect(within(group).getByRole("radio", { name: "Blau" })).toHaveAttribute("aria-checked", "true");
    await tick(500);
    expect(savedNotes()[0].color).toBe("blue");
  });

  it("toggles „Anheften“ and follows settings-changed", async () => {
    await setup([A()]);
    const pin = screen.getByRole("button", { name: "Anheften" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(api.saveSettings).toHaveBeenCalledWith({ notesPinned: true });
    await act(async () => handlers.settingsChanged?.({ ...DEFAULT_SETTINGS, notesPinned: false }));
    expect(pin).toHaveAttribute("aria-pressed", "false");
  });

  it("„Schließen“ hides the window", async () => {
    await setup([A()]);
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(api.hideNotes).toHaveBeenCalledTimes(1);
  });

  it("failed save shows a German banner and retries once", async () => {
    await setup([A()]);
    api.saveNote.mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "retry" } });
    await tick(500);
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_TEXT);
    await tick(RETRY_DELAY_MS);
    expect(api.saveNote).toHaveBeenCalledTimes(2);
    expect(docToPlainText(savedNotes()[1].content)).toBe("retry");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cleans up all listeners on unmount", async () => {
    const { unmount } = await setup([A()]);
    unmount();
    await tick();
    // 7 store/app subscriptions (hidden, flush, create, settings, reminders, shown, open-note)
    expect(h.unlisten).toHaveBeenCalledTimes(7);
  });
});
