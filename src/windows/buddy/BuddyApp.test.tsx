import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Reminder, type Settings } from "../../types";

const startDragging = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    loadSettings: vi.fn(),
    onSettingsChanged: vi.fn(),
    toggleNotes: vi.fn(() => Promise.resolve()),
    showBuddyMenu: vi.fn(() => Promise.resolve()),
    listReminders: vi.fn(),
    onRemindersChanged: vi.fn(),
    openNote: vi.fn(() => Promise.resolve()),
    loadSkin: vi.fn(),
    onSkinsChanged: vi.fn(() => Promise.resolve(() => {})),
  },
}));

import { api } from "../../lib/api";
import { BUDDY_ALERT_LABEL, BUDDY_LABEL, BuddyApp, dueReminders } from "./BuddyApp";

const mockedApi = vi.mocked(api);
let settingsListener: ((s: Settings) => void) | null = null;
let remindersListener: ((r: Reminder[]) => void) | null = null;
let reducedMotion = false;
const unlisten = vi.fn();

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

const settings = (buddy: Partial<Settings["buddy"]> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  buddy: { ...DEFAULT_SETTINGS.buddy, ...buddy },
});

async function renderApp() {
  render(<BuddyApp />);
  // wait for loadSettings to resolve and the smiley to appear
  await screen.findByTestId("smiley");
  return screen.getByRole("button", { name: BUDDY_LABEL });
}

beforeEach(() => {
  reducedMotion = false;
  stubMatchMedia();
  vi.clearAllMocks();
  settingsListener = null;
  remindersListener = null;
  mockedApi.listReminders.mockResolvedValue([]);
  mockedApi.onRemindersChanged.mockImplementation((cb) => {
    remindersListener = cb;
    return Promise.resolve(() => {});
  });
  mockedApi.loadSettings.mockResolvedValue(settings());
  mockedApi.onSettingsChanged.mockImplementation((cb) => {
    settingsListener = cb;
    return Promise.resolve(unlisten);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const down = (el: Element, x = 100, y = 100, button = 0) =>
  fireEvent.pointerDown(el, { button, screenX: x, screenY: y, isPrimary: true, pointerId: 1 });
const move = (el: Element, x: number, y: number) =>
  fireEvent.pointerMove(el, { screenX: x, screenY: y, isPrimary: true, pointerId: 1 });
const up = (el: Element, button = 0) => fireEvent.pointerUp(el, { button, isPrimary: true, pointerId: 1 });

describe("BuddyApp", () => {
  it("renders an accessible, focusable button", async () => {
    const btn = await renderApp();
    expect(btn).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("smiley")).toHaveAttribute("aria-hidden", "true");
  });

  it("applies loaded settings", async () => {
    mockedApi.loadSettings.mockResolvedValue(settings({ size: 140, faceColor: "#A0E0B0" }));
    await renderApp();
    expect(screen.getByTestId("smiley").style.width).toBe("140px");
    expect(screen.getByTestId("smiley-face-color")).toHaveAttribute("stop-color", "#a0e0b0");
  });

  it("falls back to the default buddy when loading fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockedApi.loadSettings.mockRejectedValue(new Error("boom"));
    await renderApp();
    expect(screen.getByTestId("smiley-face-color")).toHaveAttribute("stop-color", "#ffd54a");
  });

  it("click toggles notes exactly once and hops", async () => {
    const btn = await renderApp();
    down(btn);
    up(btn);
    expect(mockedApi.toggleNotes).toHaveBeenCalledTimes(1);
    expect(startDragging).not.toHaveBeenCalled();
    expect(screen.getByTestId("smiley")).toHaveClass("hopping");
  });

  it("small movement under the threshold is still a click", async () => {
    const btn = await renderApp();
    down(btn, 100, 100);
    move(btn, 102, 101);
    move(btn, 103, 102);
    up(btn);
    expect(mockedApi.toggleNotes).toHaveBeenCalledTimes(1);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("dragging beyond 4 px starts a window drag and does not toggle", async () => {
    const btn = await renderApp();
    down(btn, 100, 100);
    move(btn, 106, 100);
    move(btn, 120, 100);
    up(btn);
    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
  });

  it("recovers after a drag whose pointerup never arrived", async () => {
    const btn = await renderApp();
    down(btn, 100, 100);
    move(btn, 110, 100);
    fireEvent.lostPointerCapture(btn, { pointerId: 1 });
    // next, an ordinary click
    down(btn, 300, 300);
    up(btn);
    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(mockedApi.toggleNotes).toHaveBeenCalledTimes(1);
  });

  it("pointercancel and window blur abort the press", async () => {
    const btn = await renderApp();
    down(btn);
    fireEvent.pointerCancel(btn, { pointerId: 1 });
    up(btn);
    down(btn);
    fireEvent.blur(window);
    up(btn);
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
  });

  it("ignores non-primary buttons for click/drag", async () => {
    const btn = await renderApp();
    down(btn, 100, 100, 2);
    move(btn, 150, 100);
    up(btn, 2);
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("right click opens the buddy menu and prevents the native menu", async () => {
    const btn = await renderApp();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(mockedApi.showBuddyMenu).toHaveBeenCalledTimes(1);
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
  });

  it("Enter and Space toggle notes", async () => {
    const btn = await renderApp();
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(btn, { key: " " });
    expect(mockedApi.toggleNotes).toHaveBeenCalledTimes(2);
  });

  it("ignores key auto-repeat", async () => {
    const btn = await renderApp();
    fireEvent.keyDown(btn, { key: "Enter", repeat: true });
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
  });

  it("Shift+F10 and the ContextMenu key open the menu once each", async () => {
    const btn = await renderApp();
    fireEvent.keyDown(btn, { key: "F10", shiftKey: true });
    // the browser follows up with a contextmenu event for the same gesture
    fireEvent.contextMenu(btn);
    expect(mockedApi.showBuddyMenu).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(btn, { key: "F10" }); // without Shift: nothing
    expect(mockedApi.showBuddyMenu).toHaveBeenCalledTimes(1);
  });

  it("ContextMenu key opens the menu", async () => {
    const btn = await renderApp();
    fireEvent.keyDown(btn, { key: "ContextMenu" });
    expect(mockedApi.showBuddyMenu).toHaveBeenCalledTimes(1);
  });

  it("hover state follows pointerenter/leave", async () => {
    const btn = await renderApp();
    fireEvent.pointerEnter(btn);
    expect(screen.getByTestId("smiley")).toHaveClass("hovered");
    fireEvent.pointerLeave(btn);
    expect(screen.getByTestId("smiley")).not.toHaveClass("hovered");
  });

  it("settings-changed updates the rendered colour", async () => {
    await renderApp();
    expect(settingsListener).not.toBeNull();
    act(() => settingsListener!(settings({ faceColor: "#FF8800", eyeStyle: "hearts" })));
    expect(screen.getByTestId("smiley-face-color")).toHaveAttribute("stop-color", "#ff8800");
    expect(screen.getByTestId("smiley")).toHaveAttribute("data-eyes", "hearts");
  });

  it("a settings event before load completes is not overwritten by the load", async () => {
    let resolveLoad!: (s: Settings) => void;
    mockedApi.loadSettings.mockReturnValue(new Promise((r) => (resolveLoad = r)));
    render(<BuddyApp />);
    await act(async () => {});
    act(() => settingsListener!(settings({ faceColor: "#112233" })));
    await act(async () => resolveLoad(settings({ faceColor: "#445566" })));
    expect(screen.getByTestId("smiley-face-color")).toHaveAttribute("stop-color", "#112233");
  });

  it("unsubscribes from settings-changed on unmount", async () => {
    const { unmount } = render(<BuddyApp />);
    await screen.findByTestId("smiley");
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("hop ends after the hop duration", async () => {
    const btn = await renderApp();
    vi.useFakeTimers();
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(screen.getByTestId("smiley")).toHaveClass("hopping");
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId("smiley")).not.toHaveClass("hopping");
  });
});

const NOTE_A = "11111111-1111-4111-8111-111111111111";
const NOTE_B = "22222222-2222-4222-8222-222222222222";
const NOTE_C = "33333333-3333-4333-8333-333333333333";
const reminder = (noteId: string, patch: Partial<Reminder> = {}): Reminder => ({
  noteId,
  at: "2026-11-05T10:00:00+01:00",
  repeat: "none",
  state: "due",
  firedAt: "2026-11-05T10:00:00+01:00",
  ...patch,
});

describe("BuddyApp reminder alert", () => {
  const dueList = [
    reminder(NOTE_A, { firedAt: "2026-11-05T12:00:00+01:00" }),
    reminder(NOTE_B, { firedAt: "2026-11-05T09:30:00+01:00" }),
    reminder(NOTE_C, { state: "scheduled", firedAt: null, at: "2026-11-01T08:00:00+01:00" }),
  ];

  it("sorts due reminders oldest first and ignores the others", () => {
    expect(dueReminders(dueList).map((r) => r.noteId)).toEqual([NOTE_B, NOTE_A]);
  });

  it("shows a badge with the due count, wiggles and changes the label", async () => {
    mockedApi.listReminders.mockResolvedValue(dueList);
    render(<BuddyApp />);
    const badge = await screen.findByTestId("reminder-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: BUDDY_ALERT_LABEL })).toBeInTheDocument();
    expect(screen.getByTestId("smiley")).toHaveClass("alerting");
  });

  it("click and Enter open the oldest due note instead of toggling", async () => {
    mockedApi.listReminders.mockResolvedValue(dueList);
    render(<BuddyApp />);
    const btn = await screen.findByRole("button", { name: BUDDY_ALERT_LABEL });
    down(btn);
    up(btn);
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(mockedApi.openNote).toHaveBeenCalledTimes(2);
    expect(mockedApi.openNote).toHaveBeenCalledWith(NOTE_B);
    expect(mockedApi.toggleNotes).not.toHaveBeenCalled();
  });

  it("drag still moves the window while a reminder is due", async () => {
    mockedApi.listReminders.mockResolvedValue(dueList);
    render(<BuddyApp />);
    const btn = await screen.findByRole("button", { name: BUDDY_ALERT_LABEL });
    down(btn, 100, 100);
    move(btn, 120, 100);
    up(btn);
    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(mockedApi.openNote).not.toHaveBeenCalled();
  });

  it("without due reminders: no badge, click toggles notes", async () => {
    mockedApi.listReminders.mockResolvedValue([dueList[2]]);
    const btn = await renderApp();
    await act(async () => {});
    expect(screen.queryByTestId("reminder-badge")).toBeNull();
    expect(screen.getByTestId("smiley")).not.toHaveClass("alerting");
    down(btn);
    up(btn);
    expect(mockedApi.toggleNotes).toHaveBeenCalledTimes(1);
    expect(mockedApi.openNote).not.toHaveBeenCalled();
  });

  it("reminders-changed updates the alert live", async () => {
    await renderApp();
    await act(async () => {});
    act(() => remindersListener!([reminder(NOTE_A)]));
    expect(screen.getByTestId("reminder-badge")).toHaveTextContent("1");
    act(() => remindersListener!([reminder(NOTE_A, { state: "done" })]));
    expect(screen.queryByTestId("reminder-badge")).toBeNull();
    expect(screen.getByRole("button", { name: BUDDY_LABEL })).toBeInTheDocument();
  });

  it("reduced motion: badge but no wiggle", async () => {
    reducedMotion = true;
    mockedApi.listReminders.mockResolvedValue(dueList);
    render(<BuddyApp />);
    await screen.findByTestId("reminder-badge");
    expect(screen.getByTestId("smiley")).not.toHaveClass("alerting");
  });

  it("quiet mode: no wiggle, one pulse when a reminder becomes due", async () => {
    mockedApi.loadSettings.mockResolvedValue(settings({ animate: false }));
    await renderApp();
    await act(async () => {});
    vi.useFakeTimers();
    act(() => remindersListener!([reminder(NOTE_A)]));
    const smiley = screen.getByTestId("smiley");
    expect(smiley).not.toHaveClass("alerting");
    expect(smiley).toHaveClass("pulse");
    act(() => vi.advanceTimersByTime(800));
    expect(smiley).not.toHaveClass("pulse");
  });

  it("renders the configured built-in skin", async () => {
    mockedApi.loadSettings.mockResolvedValue(settings({ skin: "robot" }));
    render(<BuddyApp />);
    expect(await screen.findByTestId("skin-robot")).toBeInTheDocument();
  });
});
