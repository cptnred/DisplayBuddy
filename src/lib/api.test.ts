/**
 * Guards against frontend/backend drift: every wrapper in `api.ts` must invoke
 * exactly the Rust command name and argument names from docs/PLAN.md §5, and
 * listen to exactly the event names from §6.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, unlisten } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { api } from "./api";
import { DEFAULT_SETTINGS, EVENTS, type Note } from "../types";

const NOTE: Note = {
  id: "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
  title: "T",
  color: "blue",
  content: { type: "doc", content: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("result");
  listenMock.mockReset();
  listenMock.mockResolvedValue(unlisten);
});

type CommandCase = [method: keyof typeof api, args: unknown[], command: string, invokeArgs?: Record<string, unknown>];

/** [api method, call args, expected command, expected invoke args (omitted = none)] */
const COMMAND_CASES: CommandCase[] = [
  ["listNotes", [], "list_notes"],
  ["loadNote", [NOTE.id], "load_note", { id: NOTE.id }],
  ["saveNote", [NOTE], "save_note", { note: NOTE }],
  ["deleteNote", [NOTE.id], "delete_note", { id: NOTE.id }],
  ["saveOrder", [[NOTE.id]], "save_order", { ids: [NOTE.id] }],
  ["loadSettings", [], "load_settings"],
  ["saveSettings", [{ buddy: { size: 128 } }], "save_settings", { patch: { buddy: { size: 128 } } }],
  ["getAutostart", [], "get_autostart"],
  ["setAutostart", [true], "set_autostart", { enabled: true }],
  ["toggleNotes", [], "toggle_notes"],
  ["showNotes", [], "show_notes"],
  ["hideNotes", [], "hide_notes"],
  ["openSettings", [], "open_settings"],
  ["showBuddyMenu", [], "show_buddy_menu"],
  ["flushDone", [], "flush_done"],
  ["quitApp", [], "quit_app"],
  // v2 (PLAN §11) – JS args camelCase
  ["listReminders", [], "list_reminders"],
  ["setReminder", ["11111111-1111-4111-8111-111111111111", "2026-11-05T14:30:00+01:00", "daily"], "set_reminder", { noteId: "11111111-1111-4111-8111-111111111111", at: "2026-11-05T14:30:00+01:00", repeat: "daily", timeZone: null }],
  ["ackReminder", ["11111111-1111-4111-8111-111111111111"], "ack_reminder", { noteId: "11111111-1111-4111-8111-111111111111" }],
  ["snoozeReminder", ["11111111-1111-4111-8111-111111111111", 10], "snooze_reminder", { noteId: "11111111-1111-4111-8111-111111111111", minutes: 10 }],
  ["openNote", ["11111111-1111-4111-8111-111111111111"], "open_note", { noteId: "11111111-1111-4111-8111-111111111111" }],
  ["listShortcuts", [], "list_shortcuts"],
  ["pickShortcuts", [true], "pick_shortcuts", { folder: true }],
  ["addBookmark", ["Wiki", "https://example.org"], "add_bookmark", { name: "Wiki", url: "https://example.org" }],
  ["updateShortcut", ["s1", "Neu"], "update_shortcut", { id: "s1", name: "Neu", target: null }],
  ["removeShortcut", ["s1"], "remove_shortcut", { id: "s1" }],
  ["reorderShortcuts", ["bookmarks", ["a", "b"]], "reorder_shortcuts", { list: "bookmarks", ids: ["a", "b"] }],
  ["openShortcut", ["s1"], "open_shortcut", { id: "s1" }],
  ["shortcutIcon", ["s1"], "shortcut_icon", { id: "s1" }],
  ["listSkins", [], "list_skins"],
  ["importSkin", [], "import_skin"],
  ["deleteSkin", ["k1"], "delete_skin", { id: "k1" }],
  ["loadSkin", ["k1"], "load_skin", { id: "k1" }],
];

/**
 * The commands of PLAN §5 (v1) and §11 (v2). The Rust test `contract::commands_are_consistent`
 * checks the same list against build.rs, lib.rs and capabilities/*.json.
 */
const PLAN_COMMANDS = [
  "list_notes",
  "load_note",
  "save_note",
  "delete_note",
  "save_order",
  "load_settings",
  "save_settings",
  "get_autostart",
  "set_autostart",
  "toggle_notes",
  "show_notes",
  "hide_notes",
  "open_settings",
  "show_buddy_menu",
  "flush_done",
  "quit_app",
  "list_reminders",
  "set_reminder",
  "ack_reminder",
  "snooze_reminder",
  "open_note",
  "list_shortcuts",
  "pick_shortcuts",
  "add_bookmark",
  "update_shortcut",
  "remove_shortcut",
  "reorder_shortcuts",
  "open_shortcut",
  "shortcut_icon",
  "list_skins",
  "import_skin",
  "delete_skin",
  "load_skin",
];

describe("api commands", () => {
  it.each(COMMAND_CASES)("%s → invoke(%s)", async (method, args, command, invokeArgs) => {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
    await expect(fn(...args)).resolves.toBe("result");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const call = invokeMock.mock.calls[0];
    expect(call[0]).toBe(command);
    if (invokeArgs === undefined) {
      // no args object at all (Tauri would otherwise still accept it, but keep it exact)
      expect(call).toHaveLength(1);
    } else {
      expect(call).toHaveLength(2);
      expect(call[1]).toEqual(invokeArgs);
    }
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("covers every command of PLAN §5 exactly once and nothing else", () => {
    const commands = COMMAND_CASES.map((c) => c[2]);
    expect(new Set(commands).size).toBe(commands.length);
    expect([...commands].sort()).toEqual([...PLAN_COMMANDS].sort());
    const commandMethods = Object.keys(api).filter((k) => !/^on[A-Z]/.test(k));
    expect(commandMethods.sort()).toEqual(COMMAND_CASES.map((c) => c[0]).sort());
  });

  it("setReminder passes the reminder time zone (v3)", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await api.setReminder("11111111-1111-4111-8111-111111111111", "2026-11-05T13:30:00.000Z", "daily", "America/New_York");
    expect(invokeMock).toHaveBeenLastCalledWith("set_reminder", {
      noteId: "11111111-1111-4111-8111-111111111111",
      at: "2026-11-05T13:30:00.000Z",
      repeat: "daily",
      timeZone: "America/New_York",
    });
  });

  it("propagates backend errors as rejections", async () => {
    invokeMock.mockRejectedValueOnce("note not found: x");
    await expect(api.loadNote("x")).rejects.toBe("note not found: x");
  });
});

describe("api events", () => {
  type Handler = (e: { event: string; payload: unknown }) => void;
  type EventMethod = "onSettingsChanged" | "onNotesShown" | "onNotesHidden" | "onNoteCreateRequest" | "onFlushRequest";

  async function subscribe(method: EventMethod) {
    const cb = vi.fn();
    const un = await api[method](cb);
    expect(un).toBe(unlisten);
    expect(listenMock).toHaveBeenCalledTimes(1);
    const [name, handler] = listenMock.mock.calls[0] as [string, Handler];
    return { cb, name, handler };
  }

  it("event names match PLAN §6", () => {
    expect(EVENTS).toEqual({
      settingsChanged: "settings-changed",
      notesShown: "notes-shown",
      notesHidden: "notes-hidden",
      noteCreateRequest: "note-create-request",
      flushRequest: "flush-request",
      remindersChanged: "reminders-changed",
      openNote: "open-note",
      shortcutsChanged: "shortcuts-changed",
      shortcutDrag: "shortcut-drag",
      skinsChanged: "skins-changed",
      syncStatus: "sync-status",
      notesChanged: "notes-changed",
    });
  });

  it("onSettingsChanged listens to settings-changed and passes the payload", async () => {
    const { cb, name, handler } = await subscribe("onSettingsChanged");
    expect(name).toBe("settings-changed");
    handler({ event: name, payload: DEFAULT_SETTINGS });
    expect(cb).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it.each([
    ["onNotesShown", "notes-shown"],
    ["onNotesHidden", "notes-hidden"],
    ["onNoteCreateRequest", "note-create-request"],
    ["onFlushRequest", "flush-request"],
  ] as const)("%s listens to %s and calls back without arguments", async (method, event) => {
    const { cb, name, handler } = await subscribe(method);
    expect(name).toBe(event);
    handler({ event: name, payload: null });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
  });

  it.each([
    ["onRemindersChanged", "reminders-changed", [{ noteId: "n" }], [[{ noteId: "n" }]]],
    ["onOpenNote", "open-note", { noteId: "n" }, ["n"]],
    ["onShortcutsChanged", "shortcuts-changed", { items: [], bookmarks: [] }, [{ items: [], bookmarks: [] }]],
    ["onShortcutDrag", "shortcut-drag", { state: "enter" }, ["enter"]],
    ["onSkinsChanged", "skins-changed", [], [[]]],
  ] as const)("%s listens to %s and unwraps the payload", async (method, event, payload, expected) => {
    const cb = vi.fn();
    await (api[method] as (c: unknown) => Promise<unknown>)(cb);
    const [name, handler] = listenMock.mock.calls[0] as [string, Handler];
    expect(name).toBe(event);
    handler({ event: name, payload });
    expect(cb).toHaveBeenCalledWith(...expected);
  });

  it("does not invoke any command when subscribing", async () => {
    await api.onFlushRequest(() => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
