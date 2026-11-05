import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, type Settings, type Shortcut, type ShortcutKind, type ShortcutsData } from "../../../types";
import { DROP_HINT, MESSAGE_MS, ShortcutBar } from "./ShortcutBar";
import { resetIconCache } from "./icons";

const h = vi.hoisted(() => {
  const handlers: Record<string, ((payload: unknown) => void) | undefined> = {};
  const unlisten = vi.fn();
  const on = (name: string) =>
    vi.fn((cb: (payload: unknown) => void) => {
      handlers[name] = cb;
      return Promise.resolve(unlisten);
    });
  const api = {
    listShortcuts: vi.fn(),
    pickShortcuts: vi.fn(),
    addBookmark: vi.fn(),
    updateShortcut: vi.fn(),
    removeShortcut: vi.fn(),
    reorderShortcuts: vi.fn(),
    openShortcut: vi.fn(),
    shortcutIcon: vi.fn(),
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    onShortcutsChanged: on("shortcutsChanged"),
    onShortcutDrag: on("shortcutDrag"),
  };
  return { api, handlers, unlisten };
});

vi.mock("../../../lib/api", () => ({ api: h.api }));

const { api, handlers } = h;

const sc = (id: string, name: string, kind: ShortcutKind = "file", target = `C:\\Daten\\${name}`): Shortcut => ({
  id,
  kind,
  name,
  target,
});
const data = (items: Shortcut[], bookmarks: Shortcut[] = []): ShortcutsData => ({ schemaVersion: 1, items, bookmarks });

const ITEMS = [sc("a", "Word", "program", "C:\\Office\\winword.exe"), sc("b", "Projekte", "folder", "D:\\Projekte"), sc("c", "Bericht.pdf")];
const BOOKMARKS = [sc("w", "Wikipedia", "url", "https://de.wikipedia.org")];
const DATA = data(ITEMS, BOOKMARKS);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setup(settings: Partial<Settings> = {}, d: ShortcutsData = DATA) {
  api.listShortcuts.mockResolvedValue(d);
  api.loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, ...settings });
  const user = userEvent.setup();
  const utils = render(<ShortcutBar />);
  await flush();
  return { user, ...utils };
}

const tile = (name: string) => screen.getByRole("button", { name });
const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-shortcut-id]")];
/** Visible names (the bookmark globe contains a letter, so not textContent of the whole tile). */
const names = () => tiles().map((t) => t.lastElementChild?.textContent);

/** Tiny fake backend so command results reflect the request. */
function backendFrom(initial: ShortcutsData) {
  let state = structuredClone(initial);
  const listOf = (id: string) => (state.items.some((s) => s.id === id) ? "items" : "bookmarks");
  api.reorderShortcuts.mockImplementation((list: "items" | "bookmarks", ids: string[]) => {
    state = { ...state, [list]: ids.map((id) => state[list].find((s) => s.id === id)!).filter(Boolean) };
    return Promise.resolve(state);
  });
  api.removeShortcut.mockImplementation((id: string) => {
    const l = listOf(id);
    state = { ...state, [l]: state[l].filter((s) => s.id !== id) };
    return Promise.resolve(state);
  });
  api.updateShortcut.mockImplementation((id: string, name: string) => {
    const l = listOf(id);
    state = { ...state, [l]: state[l].map((s) => (s.id === id ? { ...s, name } : s)) };
    return Promise.resolve(state);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetIconCache();
  for (const k of Object.keys(handlers)) handlers[k] = undefined;
  api.saveSettings.mockResolvedValue(DEFAULT_SETTINGS);
  api.shortcutIcon.mockResolvedValue(null);
  api.openShortcut.mockResolvedValue(undefined);
  api.pickShortcuts.mockResolvedValue(DATA);
  api.addBookmark.mockResolvedValue(DATA);
  backendFrom(DATA);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ShortcutBar – tabs & settings", () => {
  it("renders both tabs and the item tiles", async () => {
    await setup();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Programme & Ordner", "Lesezeichen"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(names()).toEqual(["Word", "Projekte", "Bericht.pdf"]);
    expect(tile("Word")).toHaveAttribute("title", "Word\nC:\\Office\\winword.exe");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[0].id);
  });

  it("switching the tab shows bookmarks and saves the setting", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("tab", { name: "Lesezeichen" }));
    expect(api.saveSettings).toHaveBeenCalledWith({ shortcutBarTab: "bookmarks" });
    expect(names()).toEqual(["Wikipedia"]);
    expect(screen.getByRole("tab", { name: "Lesezeichen" })).toHaveAttribute("aria-selected", "true");
  });

  it("starts with the tab and collapsed state from the settings", async () => {
    await setup({ shortcutBarTab: "bookmarks", shortcutBarCollapsed: true });
    expect(screen.getByRole("tab", { name: "Lesezeichen" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Verknüpfungsleiste ausklappen" })).toHaveAttribute("aria-expanded", "false");
    expect(tiles()).toHaveLength(0);
  });

  it("arrow keys move between tabs (ARIA tabs pattern)", async () => {
    const { user } = await setup();
    screen.getByRole("tab", { name: "Programme & Ordner" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Lesezeichen" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Lesezeichen" })).toHaveAttribute("aria-selected", "true");
    expect(api.saveSettings).toHaveBeenLastCalledWith({ shortcutBarTab: "bookmarks" });
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Programme & Ordner" })).toHaveFocus();
  });

  it("collapse toggle hides the tiles and saves the setting", async () => {
    const { user } = await setup();
    const toggle = screen.getByRole("button", { name: "Verknüpfungsleiste einklappen" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(api.saveSettings).toHaveBeenCalledWith({ shortcutBarCollapsed: true });
    expect(tiles()).toHaveLength(0);
    expect(screen.getByRole("tabpanel", { hidden: true })).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Verknüpfungsleiste ausklappen" }));
    expect(api.saveSettings).toHaveBeenLastCalledWith({ shortcutBarCollapsed: false });
    expect(tiles()).toHaveLength(3);
  });

  it("shows the empty states", async () => {
    const { user } = await setup({}, data([], []));
    expect(screen.getByText("Dateien, Programme oder Ordner hierher ziehen oder mit + hinzufügen")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Lesezeichen" }));
    expect(screen.getByText("Noch keine Lesezeichen – mit + hinzufügen")).toBeInTheDocument();
  });
});

describe("ShortcutBar – adding", () => {
  it("„+“ in the items tab offers file and folder pickers", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-local-escape");
    await user.click(within(menu).getByRole("menuitem", { name: "Dateien oder Programme …" }));
    expect(api.pickShortcuts).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    await user.click(screen.getByRole("menuitem", { name: "Ordner …" }));
    expect(api.pickShortcuts).toHaveBeenLastCalledWith(true);
  });

  it("Esc closes the add menu and keeps the event local", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("menuitem", { name: "Dateien oder Programme …" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Hinzufügen" })).toHaveFocus();
  });

  it("bookmark form validates and adds with https:// prefix", async () => {
    const { user } = await setup({ shortcutBarTab: "bookmarks" });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    const form = screen.getByRole("form", { name: "Lesezeichen hinzufügen" });
    expect(form).toHaveAttribute("data-local-escape");

    await user.click(within(form).getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte eine Adresse eingeben.");
    expect(within(form).getByLabelText("Adresse")).toHaveAttribute("aria-invalid", "true");

    await user.type(within(form).getByLabelText("Adresse"), "ftp://x.de{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Nur http- und https-Adressen sind erlaubt.");
    expect(api.addBookmark).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText("Adresse"));
    await user.type(within(form).getByLabelText("Name (optional)"), "  Beispiel ");
    await user.type(within(form).getByLabelText("Adresse"), "example.com/docs{Enter}");
    expect(api.addBookmark).toHaveBeenCalledWith("Beispiel", "https://example.com/docs");
    await flush();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("bookmark form shows backend errors and Esc cancels", async () => {
    api.addBookmark.mockRejectedValueOnce("invalid url");
    const { user } = await setup({ shortcutBarTab: "bookmarks" });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    await user.type(screen.getByLabelText("Adresse"), "http://a.de{Enter}");
    await flush();
    expect(api.addBookmark).toHaveBeenCalledWith("", "http://a.de");
    expect(screen.getByRole("alert")).toHaveTextContent("invalid url");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form")).toBeNull();
    expect(names()).toEqual(["Wikipedia"]);
  });
});

describe("ShortcutBar – tiles", () => {
  it("click opens the shortcut", async () => {
    const { user } = await setup();
    await user.click(tile("Projekte"));
    expect(api.openShortcut).toHaveBeenCalledWith("b");
  });

  it("shows „Ziel nicht gefunden“ for a missing target, then hides the message", async () => {
    api.openShortcut.mockRejectedValueOnce("not found: C:\\Daten\\Bericht.pdf");
    await setup();
    vi.useFakeTimers();
    fireEvent.click(tile("Bericht.pdf"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Ziel nicht gefunden");
    act(() => vi.advanceTimersByTime(MESSAGE_MS + 10));
    expect(screen.queryByText("Ziel nicht gefunden")).toBeNull();
  });

  it("shows other open errors verbatim", async () => {
    api.openShortcut.mockRejectedValueOnce("Zugriff verweigert");
    const { user } = await setup();
    await user.click(tile("Word"));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Öffnen fehlgeschlagen: Zugriff verweigert");
  });

  it("uses a fallback icon when shortcutIcon resolves null, the shell icon otherwise", async () => {
    api.shortcutIcon.mockImplementation((id: string) =>
      Promise.resolve(id === "c" ? "data:image/png;base64,AAAA" : null),
    );
    const { user } = await setup();
    await flush();
    expect(tile("Word").querySelector('[data-fallback-icon="program"]')).not.toBeNull();
    expect(tile("Projekte").querySelector('[data-fallback-icon="folder"]')).not.toBeNull();
    expect(tile("Bericht.pdf").querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(api.shortcutIcon).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("tab", { name: "Lesezeichen" }));
    const globe = tile("Wikipedia").querySelector('[data-fallback-icon="url"]');
    expect(globe).toHaveTextContent("D");
    expect(api.shortcutIcon).not.toHaveBeenCalledWith("w");

    // cached across remounts
    await user.click(screen.getByRole("tab", { name: "Programme & Ordner" }));
    await flush();
    expect(api.shortcutIcon).toHaveBeenCalledTimes(3);
  });

  it("shortcuts-changed replaces the tiles", async () => {
    await setup();
    act(() => handlers.shortcutsChanged?.(data([sc("z", "Neu", "folder")], [])));
    expect(names()).toEqual(["Neu"]);
  });

  it("ignores a late listShortcuts result after an event", async () => {
    let resolveList!: (d: ShortcutsData) => void;
    api.listShortcuts.mockReturnValue(new Promise<ShortcutsData>((r) => (resolveList = r)));
    api.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
    render(<ShortcutBar />);
    await flush();
    act(() => handlers.shortcutsChanged?.(data([sc("z", "Neu")])));
    await act(async () => resolveList(DATA));
    expect(names()).toEqual(["Neu"]);
  });

  it("cleans up its event listeners on unmount", async () => {
    const { unmount } = await setup();
    unmount();
    await flush();
    expect(h.unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("ShortcutBar – context menu", () => {
  it("rename via context menu saves on Enter", async () => {
    const { user } = await setup();
    fireEvent.contextMenu(tile("Word"), { clientX: 40, clientY: 300 });
    const menu = screen.getByRole("menu", { name: "Aktionen für Word" });
    expect(menu).toHaveAttribute("data-local-escape");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Öffnen",
      "Umbenennen",
      "Nach links",
      "Nach rechts",
      "Entfernen",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Nach links" })).toBeDisabled();
    await user.click(within(menu).getByRole("menuitem", { name: "Umbenennen" }));
    const input = screen.getByRole("textbox", { name: "Neuer Name" });
    expect(input).toHaveAttribute("data-local-escape");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Textverarbeitung{Enter}");
    expect(api.updateShortcut).toHaveBeenCalledWith("a", "Textverarbeitung");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("move right / left and remove", async () => {
    const { user } = await setup();
    fireEvent.contextMenu(tile("Word"), { clientX: 40, clientY: 300 });
    await user.click(screen.getByRole("menuitem", { name: "Nach rechts" }));
    expect(api.reorderShortcuts).toHaveBeenCalledWith("items", ["b", "a", "c"]);
    expect(tiles().map((t) => t.dataset.shortcutId)).toEqual(["b", "a", "c"]);
    await flush();

    fireEvent.contextMenu(tile("Bericht.pdf"), { clientX: 40, clientY: 300 });
    expect(screen.getByRole("menuitem", { name: "Nach rechts" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "Nach links" }));
    expect(api.reorderShortcuts).toHaveBeenLastCalledWith("items", ["b", "c", "a"]);
    await flush();

    fireEvent.contextMenu(tile("Projekte"), { clientX: 40, clientY: 300 });
    await user.click(screen.getByRole("menuitem", { name: "Entfernen" }));
    expect(api.removeShortcut).toHaveBeenCalledWith("b");
  });

  it("„Öffnen“ opens and Esc closes the menu", async () => {
    const { user } = await setup();
    fireEvent.contextMenu(tile("Projekte"), { clientX: 40, clientY: 300 });
    await user.click(screen.getByRole("menuitem", { name: "Öffnen" }));
    expect(api.openShortcut).toHaveBeenCalledWith("b");

    fireEvent.contextMenu(tile("Projekte"), { clientX: 40, clientY: 300 });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(tile("Projekte")).toHaveFocus();
  });

  it("the „…“ affordance opens the menu too", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Optionen für Projekte" }));
    expect(screen.getByRole("menu", { name: "Aktionen für Projekte" })).toBeInTheDocument();
  });
});

describe("ShortcutBar – keyboard", () => {
  it("roving tabindex with arrow keys", async () => {
    const { user } = await setup();
    expect(tiles().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tile("Word").focus();
    await user.keyboard("{ArrowRight}");
    expect(tile("Projekte")).toHaveFocus();
    expect(tiles().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard("{End}");
    expect(tile("Bericht.pdf")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tile("Projekte")).toHaveFocus();
  });

  it("Enter opens, Delete removes, F2 renames (Esc cancels)", async () => {
    const { user } = await setup();
    tile("Projekte").focus();
    await user.keyboard("{Enter}");
    expect(api.openShortcut).toHaveBeenCalledTimes(1);
    expect(api.openShortcut).toHaveBeenCalledWith("b");

    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Neuer Name" });
    await user.type(input, "xyz{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.updateShortcut).not.toHaveBeenCalled();
    expect(tile("Projekte")).toHaveFocus();

    await user.keyboard("{Delete}");
    expect(api.removeShortcut).toHaveBeenCalledWith("b");
    expect(tile("Bericht.pdf")).toHaveFocus();
  });

  it("Shift+F10 opens the context menu", async () => {
    const { user } = await setup();
    tile("Word").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Aktionen für Word" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Öffnen" })).toHaveFocus();
  });
});

describe("ShortcutBar – OS file drag", () => {
  it("highlights on enter, removes on leave", async () => {
    const { container } = await setup();
    const bar = container.querySelector("[data-shortcut-bar]")!;
    act(() => handlers.shortcutDrag?.("enter"));
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();
    expect(bar.className).toContain("dragOver");
    act(() => handlers.shortcutDrag?.("leave"));
    expect(screen.queryByText(DROP_HINT)).toBeNull();
    expect(bar.className).not.toContain("dragOver");
  });

  it("expands while dragging and switches to the items tab on drop", async () => {
    await setup({ shortcutBarTab: "bookmarks", shortcutBarCollapsed: true });
    act(() => handlers.shortcutDrag?.("enter"));
    expect(screen.getByRole("tabpanel")).toBeVisible();
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();
    act(() => handlers.shortcutDrag?.("drop"));
    expect(screen.queryByText(DROP_HINT)).toBeNull();
    expect(screen.getByRole("tab", { name: "Programme & Ordner" })).toHaveAttribute("aria-selected", "true");
    expect(api.saveSettings).toHaveBeenCalledWith({ shortcutBarTab: "items", shortcutBarCollapsed: false });
    expect(tiles()).toHaveLength(3);
  });
});

describe("ShortcutBar – pointer reorder", () => {
  function mockLayout() {
    // tiles 56 px wide, 60 px apart → midpoints 28, 88, 148
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = tiles().indexOf(this as HTMLButtonElement);
      const left = Math.max(i, 0) * 60;
      return { left, right: left + 56, width: 56, top: 400, bottom: 444, height: 44, x: left, y: 400, toJSON: () => ({}) } as DOMRect;
    });
  }

  it("dragging a tile past a neighbour's midpoint reorders without opening", async () => {
    await setup();
    mockLayout();
    const word = tile("Word");
    fireEvent.pointerDown(word, { pointerId: 1, button: 0, clientX: 20 });
    fireEvent.pointerMove(word, { pointerId: 1, clientX: 23 }); // below threshold
    expect(word.parentElement!.style.transform).toBe("");
    fireEvent.pointerMove(word, { pointerId: 1, clientX: 90 });
    expect(word.parentElement!.style.transform).toBe("translateX(70px)");
    expect(tile("Projekte").parentElement!.style.transform).toBe("translateX(-60px)");
    fireEvent.pointerUp(word, { pointerId: 1, clientX: 90 });
    fireEvent.click(word);
    expect(api.reorderShortcuts).toHaveBeenCalledWith("items", ["b", "a", "c"]);
    expect(api.openShortcut).not.toHaveBeenCalled();
    expect(tiles().map((t) => t.dataset.shortcutId)).toEqual(["b", "a", "c"]);
  });

  it("a small movement is still a click", async () => {
    await setup();
    mockLayout();
    const word = tile("Word");
    fireEvent.pointerDown(word, { pointerId: 1, button: 0, clientX: 20 });
    fireEvent.pointerMove(word, { pointerId: 1, clientX: 24 });
    fireEvent.pointerUp(word, { pointerId: 1, clientX: 24 });
    fireEvent.click(word);
    expect(api.reorderShortcuts).not.toHaveBeenCalled();
    expect(api.openShortcut).toHaveBeenCalledWith("a");
  });

  it("pointer cancel aborts the drag", async () => {
    await setup();
    mockLayout();
    const word = tile("Word");
    fireEvent.pointerDown(word, { pointerId: 1, button: 0, clientX: 20 });
    fireEvent.pointerMove(word, { pointerId: 1, clientX: 150 });
    fireEvent.pointerCancel(word, { pointerId: 1, clientX: 150 });
    expect(api.reorderShortcuts).not.toHaveBeenCalled();
    expect(word.parentElement!.style.transform).toBe("");
  });
});

describe("ShortcutBar – wheel", () => {
  it("vertical wheel scrolls the tile row horizontally", async () => {
    await setup();
    const row = screen.getByRole("toolbar");
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 200 });
    fireEvent.wheel(row, { deltaY: 40 });
    expect(row.scrollLeft).toBe(40);
  });
});
