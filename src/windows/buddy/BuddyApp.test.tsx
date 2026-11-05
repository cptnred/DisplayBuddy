import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

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
  },
}));

import { api } from "../../lib/api";
import { BUDDY_LABEL, BuddyApp } from "./BuddyApp";

const mockedApi = vi.mocked(api);
let settingsListener: ((s: Settings) => void) | null = null;
const unlisten = vi.fn();

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
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
  stubMatchMedia();
  vi.clearAllMocks();
  settingsListener = null;
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
