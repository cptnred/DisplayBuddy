import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

const listeners: Array<(s: Settings) => void> = [];
vi.mock("../../lib/api", () => ({
  api: {
    loadSettings: vi.fn(async () => structuredClone(DEFAULT_SETTINGS)),
    getAutostart: vi.fn(async () => true),
    setAutostart: vi.fn(async (on: boolean) => on),
    saveSettings: vi.fn(async (p: unknown) => ({ ...DEFAULT_SETTINGS, ...(p as object) })),
    onSettingsChanged: vi.fn(async (cb: (s: Settings) => void) => {
      listeners.push(cb);
      return () => undefined;
    }),
  },
}));
import { api } from "../../lib/api";
import { SettingsApp } from "./SettingsApp";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }),
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
});

async function setup() {
  render(<SettingsApp />);
  await act(async () => {});
}

test("shows autostart state from the OS", async () => {
  await setup();
  expect(screen.getByLabelText("Mit Windows starten")).toBeChecked();
});

test("radio choice saves immediately as a buddy patch", async () => {
  await setup();
  fireEvent.click(screen.getByLabelText("Herzen"));
  expect(api.saveSettings).toHaveBeenCalledWith({ buddy: { eyeStyle: "hearts" } });
});

test("slider changes are debounced and merged into one patch", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    fireEvent.change(screen.getByRole("slider", { name: "Größe" }), { target: { value: "120" } });
    fireEvent.change(screen.getByRole("slider", { name: "Deckkraft" }), { target: { value: "50" } });
    expect(api.saveSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(api.saveSettings).toHaveBeenCalledWith({ buddy: { size: 120, opacity: 0.5 } });
  } finally {
    vi.useRealTimers();
  }
});

test("quiet mode inverts animate and disables speed slider", async () => {
  await setup();
  fireEvent.click(screen.getByLabelText("Ruhiger Modus (keine Animationen)"));
  expect(api.saveSettings).toHaveBeenCalledWith({ buddy: { animate: false } });
  expect(screen.getByLabelText("Animationsgeschwindigkeit")).toBeDisabled();
});

test("autostart toggle goes through set_autostart", async () => {
  await setup();
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Mit Windows starten"));
  });
  expect(api.setAutostart).toHaveBeenCalledWith(false);
  expect(screen.getByLabelText("Mit Windows starten")).not.toBeChecked();
});

test("external settings-changed updates the form", async () => {
  await setup();
  act(() => listeners[0]({ ...DEFAULT_SETTINGS, buddy: { ...DEFAULT_SETTINGS.buddy, size: 160 } }));
  expect(screen.getByText("160 px")).toBeInTheDocument();
});

test("click-through checkbox saves immediately", async () => {
  await setup();
  fireEvent.click(screen.getByLabelText(/transparenten Ecken/));
  expect(api.saveSettings).toHaveBeenCalledWith({ clickThrough: true });
});

test("unsaved slider value survives an unrelated settings-changed broadcast", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    fireEvent.change(screen.getByRole("slider", { name: "Größe" }), { target: { value: "150" } });
    act(() => listeners[0]({ ...DEFAULT_SETTINGS, activeNoteId: "x" }));
    expect(screen.getByText("150 px")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
