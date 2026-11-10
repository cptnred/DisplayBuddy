import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { DEFAULT_SETTINGS, NOTE_SCHEMA_VERSION, type Note, type Reminder, type Settings } from "../../types";
import { formatReminder, toRfc3339Local } from "../../lib/datetime";
import { deviceZone } from "../../lib/zoned";
import type { NoteEditorProps } from "./NotesApp";
import { NotesApp } from "./NotesApp";
import { REMINDER_ERROR_TEXT, RETRY_DELAY_MS, SAVE_ERROR_TEXT } from "./useNotesStore";
import { PAST_TEXT } from "./Reminder";
import { docToPlainText, plainTextToDoc } from "./docText";

const h = vi.hoisted(() => {
  const SYNC_OFF = {
    enabled: false,
    serverUrl: "",
    deviceName: "",
    state: "off",
    lastSyncAt: null,
    pending: 0,
    message: null,
    clockOffsetMs: 0,
  };
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
    onSyncStatus: on("syncStatus"),
    onNotesChanged: on("notesChanged"),
    syncStatus: vi.fn(async () => ({ ...SYNC_OFF })),
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
    // 9 store/app subscriptions (hidden, flush, create, settings, reminders, sync-status,
    // notes-changed, shown, open-note) + settings of the account hint (v4)
    expect(h.unlisten).toHaveBeenCalledTimes(10);
  });
});

describe("NotesApp / search", () => {
  const searchInput = () => screen.getByLabelText("Notizen durchsuchen") as HTMLInputElement;
  const notes = () => [note(ID.a, "Einkauf", "Milch und Brot"), note(ID.b, "Arbeit", "Müll rausbringen"), note(ID.c, "Müllabfuhr", "Dienstag")];

  it("Strg+F opens the search (also from inside the editor), typing filters, Enter jumps to the note", async () => {
    await setup(notes());
    const editor = screen.getByTestId("editor");
    editor.focus();
    fireEvent.change(editor, { target: { value: "pending edit" } });
    await ctrl("f", {}, editor);
    expect(searchInput()).toHaveFocus();
    expect(screen.getByRole("listbox")).toBeEmptyDOMElement();

    fireEvent.change(searchInput(), { target: { value: "mull" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // title hit ranks first
    expect(options[0]).toHaveTextContent("Müllabfuhr");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(within(options[1]).getByText("Müll", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("2 Treffer")).toBeInTheDocument();

    fireEvent.keyDown(searchInput(), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    await tick(50);
    expect(screen.queryByRole("search")).toBeNull();
    expect(titleInput().value).toBe("Arbeit");
    expect(indicator("2 / 3")).toBeInTheDocument();
    // the previous note's pending edit was flushed by the switch
    expect(savedNotes().find((n) => n.id === ID.a)?.content).toEqual(plainTextToDoc("pending edit"));
    expect(screen.getByTestId("editor")).toHaveFocus();
  });

  it("magnifier button opens the search; click on a result selects; empty state", async () => {
    await setup(notes());
    fireEvent.click(screen.getByRole("button", { name: "Suchen (Strg+F)" }));
    fireEvent.change(searchInput(), { target: { value: "xyz" } });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(searchInput(), { target: { value: "dienstag" } });
    fireEvent.click(screen.getByRole("option"));
    await tick(50);
    expect(titleInput().value).toBe("Müllabfuhr");
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("Esc closes the search without hiding the window; the next Esc hides", async () => {
    await setup(notes());
    await ctrl("f");
    fireEvent.change(searchInput(), { target: { value: "milch" } });
    await act(() => {
      fireEvent.keyDown(searchInput(), { key: "Escape" });
    });
    expect(screen.queryByRole("search")).toBeNull();
    expect(api.hideNotes).not.toHaveBeenCalled();
    expect(titleInput().value).toBe("Einkauf");
    await act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(api.hideNotes).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+→ inside the search field does not switch notes", async () => {
    await setup(notes());
    await ctrl("f");
    await ctrl("ArrowRight", {}, searchInput());
    expect(indicator("1 / 3")).toBeInTheDocument();
  });
});

describe("NotesApp / reminders", () => {
  const NOW = new Date(2026, 10, 5, 10, 0); // Thu 05.11.2026 10:00 local
  const rem = (
    noteId: string,
    at: string,
    state: Reminder["state"] = "scheduled",
    repeat: Reminder["repeat"] = "none",
  ): Reminder => ({
    noteId,
    at,
    repeat,
    state,
    firedAt: state === "due" ? at : null,
    updatedAt: null,
    timeZone: null,
  });
  const bell = () => screen.getByRole("button", { name: "Erinnerung" });

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it("popover saves date/time/repeat as a UTC instant plus the PC zone (v3)", async () => {
    await setup([A(), B()]);
    const at = toRfc3339Local("2026-11-06", "14:30");
    api.setReminder.mockResolvedValue(rem(ID.a, at, "scheduled", "weekly"));
    expect(bell()).toHaveAttribute("data-state", "none");
    fireEvent.click(bell());
    const dialog = screen.getByRole("dialog", { name: "Erinnerung festlegen" });
    expect(within(dialog).getByText("Keine Erinnerung")).toBeInTheDocument();
    const date = within(dialog).getByLabelText("Datum") as HTMLInputElement;
    expect(date).toHaveFocus();
    // defaults to the next full hour
    expect(date.value).toBe("2026-11-05");
    expect((within(dialog).getByLabelText("Uhrzeit") as HTMLInputElement).value).toBe("11:00");
    fireEvent.change(date, { target: { value: "2026-11-06" } });
    fireEvent.change(within(dialog).getByLabelText("Uhrzeit"), { target: { value: "14:30" } });
    fireEvent.change(within(dialog).getByLabelText("Wiederholung"), { target: { value: "weekly" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await tick();
    // entered in the reminder zone (default: this PC's zone) → UTC instant + zone
    expect(api.setReminder).toHaveBeenCalledWith(ID.a, new Date(at).toISOString(), "weekly", deviceZone());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell()).toHaveAttribute("data-state", "scheduled");
    expect(bell()).toHaveAttribute("title", "Erinnerung: Morgen, 14:30");
  });

  it("rejects a past one-off time inline; Esc closes the popover without hiding", async () => {
    await setup([A()]);
    fireEvent.click(bell());
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Uhrzeit"), { target: { value: "09:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await tick();
    expect(within(dialog).getByText(PAST_TEXT)).toBeInTheDocument();
    expect(api.setReminder).not.toHaveBeenCalled();
    await act(() => {
      fireEvent.keyDown(within(dialog).getByLabelText("Datum"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.hideNotes).not.toHaveBeenCalled();
    expect(bell()).toHaveFocus();
  });

  it("shows the current reminder and removes it", async () => {
    const at = toRfc3339Local("2026-11-05", "14:30");
    api.listReminders.mockResolvedValue([rem(ID.a, at, "scheduled", "daily")]);
    api.setReminder.mockResolvedValue(null);
    await setup([A()]);
    expect(bell()).toHaveAttribute("data-state", "scheduled");
    fireEvent.click(bell());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Geplant: Heute, 14:30")).toBeInTheDocument();
    expect((within(dialog).getByLabelText("Uhrzeit") as HTMLInputElement).value).toBe("14:30");
    expect((within(dialog).getByLabelText("Wiederholung") as HTMLSelectElement).value).toBe("daily");
    fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    await tick();
    expect(api.setReminder).toHaveBeenCalledWith(ID.a, null, "none", null);
    expect(bell()).toHaveAttribute("data-state", "none");
  });

  it("failed save shows the action error banner and keeps the popover open", async () => {
    await setup([A()]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.setReminder.mockRejectedValue(new Error("nope"));
    fireEvent.click(bell());
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await tick();
    expect(screen.getByText(REMINDER_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("due banner: Erledigt acks, the snooze buttons snooze 10 / 60 minutes", async () => {
    const at = toRfc3339Local("2026-11-05", "09:30");
    api.listReminders.mockResolvedValue([rem(ID.a, at, "due")]);
    api.ackReminder.mockResolvedValue(null);
    api.snoozeReminder.mockResolvedValue(rem(ID.a, toRfc3339Local("2026-11-05", "10:10")));
    await setup([A()]);
    expect(bell()).toHaveAttribute("data-state", "due");
    expect(screen.getByText(`🔔 Erinnerung fällig – ${formatReminder(at, NOW)}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "10 Min. später" }));
    await tick();
    expect(api.snoozeReminder).toHaveBeenCalledWith(ID.a, 10);
    expect(screen.queryByText(/Erinnerung fällig/)).toBeNull();

    await act(async () => handlers.remindersChanged?.([rem(ID.a, at, "due")]));
    fireEvent.click(screen.getByRole("button", { name: "1 Std. später" }));
    await tick();
    expect(api.snoozeReminder).toHaveBeenCalledWith(ID.a, 60);

    await act(async () => handlers.remindersChanged?.([rem(ID.a, at, "due")]));
    fireEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    await tick();
    expect(api.ackReminder).toHaveBeenCalledWith(ID.a);
    expect(bell()).toHaveAttribute("data-state", "none");
  });

  it("reminders-changed replaces the map: bell state and side-card badge follow", async () => {
    await setup([A(), B()]);
    const at = toRfc3339Local("2026-11-05", "18:00");
    await act(async () => handlers.remindersChanged?.([rem(ID.a, at), rem(ID.b, at, "due")]));
    expect(bell()).toHaveAttribute("data-state", "scheduled");
    const side = screen.getByRole("button", { name: "Nächste Notiz: Beta" });
    expect(side.querySelector('[data-reminder-badge="due"]')).toHaveTextContent("Heute, 18:00");
    await act(async () => handlers.remindersChanged?.([]));
    expect(bell()).toHaveAttribute("data-state", "none");
    expect(side.querySelector("[data-reminder-badge]")).toBeNull();
  });

  it("a late initial list never overwrites a newer reminders-changed", async () => {
    let resolveList!: (r: Reminder[]) => void;
    api.listReminders.mockReturnValue(new Promise<Reminder[]>((r) => (resolveList = r)));
    await setup([A()]);
    const at = toRfc3339Local("2026-11-05", "18:00");
    await act(async () => handlers.remindersChanged?.([rem(ID.a, at)]));
    await act(async () => resolveList([]));
    expect(bell()).toHaveAttribute("data-state", "scheduled");
  });
});

describe("NotesApp / open-note", () => {
  it("selects the note, flushes the previous one and focuses the editor", async () => {
    await setup([A(), B(), C()]);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "a-new" } });
    await act(async () => handlers.openNote?.(ID.c));
    await tick(50);
    expect(titleInput().value).toBe("Gamma");
    expect(savedNotes().find((n) => n.id === ID.a)?.content).toEqual(plainTextToDoc("a-new"));
    expect(screen.getByTestId("editor")).toHaveFocus();
    // unknown id: nothing happens
    await act(async () => handlers.openNote?.("nope"));
    await tick(50);
    expect(titleInput().value).toBe("Gamma");
  });

  it("is queued while the store is still loading", async () => {
    let resolveNotes!: (n: Note[]) => void;
    api.listNotes.mockReturnValue(new Promise<Note[]>((r) => (resolveNotes = r)));
    api.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
    render(<NotesApp Editor={FakeEditor} />);
    await tick();
    await act(async () => handlers.openNote?.(ID.b));
    await act(async () => resolveNotes([A(), B(), C()]));
    await tick(50);
    expect(titleInput().value).toBe("Beta");
  });
});
