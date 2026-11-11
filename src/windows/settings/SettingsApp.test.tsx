import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type SkinInfo } from "../../types";
import { resetSkinCache } from "../buddy/skinStore";

const listeners: Array<(s: Settings) => void> = [];
const skinListeners: Array<(s: SkinInfo[]) => void> = [];
const IMPORTED: SkinInfo = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Mein Hund",
  kind: "image",
  mime: "image/png",
};
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
    listSkins: vi.fn(async () => []),
    importSkin: vi.fn(async () => null),
    deleteSkin: vi.fn(async () => undefined),
    loadSkin: vi.fn(async (id: string) => ({
      info: { id, name: "x", kind: "image", mime: "image/png" },
      data: "data:image/png;base64,iVBORw0KGgo=",
    })),
    onSkinsChanged: vi.fn(async (cb: (s: SkinInfo[]) => void) => {
      skinListeners.push(cb);
      return () => undefined;
    }),
    syncStatus: vi.fn(async () => ({
      enabled: false,
      serverUrl: "",
      deviceName: "",
      state: "off",
      lastSyncAt: null,
      pending: 0,
      message: null,
      clockOffsetMs: 0,
    })),
    onSyncStatus: vi.fn(async () => () => undefined),
    syncConnect: vi.fn(),
    syncDisconnect: vi.fn(),
    syncNow: vi.fn(),
    accountServerInfo: vi.fn(async () => {
      throw "offline: test";
    }),
    onSettingsSection: vi.fn(async () => () => undefined),
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
  skinListeners.length = 0;
  resetSkinCache();
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

const withSkin = (skin: string): Settings => ({ ...DEFAULT_SETTINGS, buddy: { ...DEFAULT_SETTINGS.buddy, skin } });

test("skin picker lists the built-ins with German names and the imported skins", async () => {
  vi.mocked(api.listSkins).mockResolvedValueOnce([IMPORTED]);
  await setup();
  const group = screen.getByRole("radiogroup", { name: "Figur" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((r) => r.getAttribute("value"))).toEqual(["smiley", "cat", "robot", "ghost", IMPORTED.id]);
  for (const name of ["Smiley", "Katze", "Roboter", "Geist", "Mein Hund"]) {
    expect(within(group).getByRole("radio", { name })).toBeInTheDocument();
  }
  expect(within(group).getByRole("radio", { name: "Smiley" })).toBeChecked();
  // Live mini previews.
  expect(within(screen.getByTestId("skin-tile-cat")).getByTestId("skin-cat")).toBeInTheDocument();
});

test("picking a skin saves it as a buddy patch", async () => {
  await setup();
  fireEvent.click(screen.getByRole("radio", { name: "Katze" }));
  expect(api.saveSettings).toHaveBeenCalledWith({ buddy: { skin: "cat" } });
  expect(screen.getByRole("radio", { name: "Katze" })).toBeChecked();
});

test("options a skin does not support are hidden", async () => {
  vi.mocked(api.loadSettings).mockResolvedValueOnce(withSkin("cat"));
  await setup();
  expect(screen.getByText("Augen")).toBeInTheDocument();
  expect(screen.queryByText("Mund")).toBeNull();
  expect(screen.getByLabelText("Eigene Farbe")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("radio", { name: "Roboter" }));
  expect(screen.getByText("Mund")).toBeInTheDocument();
});

test("imported skins only offer size, opacity and animation", async () => {
  vi.mocked(api.listSkins).mockResolvedValueOnce([IMPORTED]);
  vi.mocked(api.loadSettings).mockResolvedValueOnce(withSkin(IMPORTED.id));
  await setup();
  expect(screen.queryByText("Augen")).toBeNull();
  expect(screen.queryByText("Mund")).toBeNull();
  expect(screen.queryByLabelText("Eigene Farbe")).toBeNull();
  expect(screen.getByRole("slider", { name: "Größe" })).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Deckkraft" })).toBeInTheDocument();
  expect(screen.getByLabelText("Animationsgeschwindigkeit")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Mein Hund" })).toBeChecked();
});

test("import selects the new skin; cancelling changes nothing", async () => {
  await setup();
  const btn = screen.getByRole("button", { name: "Eigenes Bild oder Lottie importieren …" });
  await act(async () => {
    fireEvent.click(btn);
  });
  expect(api.importSkin).toHaveBeenCalledTimes(1);
  expect(api.saveSettings).not.toHaveBeenCalled();

  vi.mocked(api.importSkin).mockResolvedValueOnce(IMPORTED);
  await act(async () => {
    fireEvent.click(btn);
  });
  expect(api.saveSettings).toHaveBeenCalledWith({ buddy: { skin: IMPORTED.id } });
  expect(screen.getByRole("radio", { name: "Mein Hund" })).toBeChecked();
});

test("import failure shows an error", async () => {
  vi.mocked(api.importSkin).mockRejectedValueOnce("too large");
  await setup();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Eigenes Bild oder Lottie importieren …" }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Import fehlgeschlagen");
});

test("deleting asks in-app first; cancel keeps the skin", async () => {
  const confirmSpy = vi.spyOn(window, "confirm");
  vi.mocked(api.listSkins).mockResolvedValueOnce([IMPORTED]);
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Figur „Mein Hund“ löschen" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("Figur „Mein Hund“ löschen?");
  expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api.deleteSkin).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();

  // Escape also cancels.
  fireEvent.click(screen.getByRole("button", { name: "Figur „Mein Hund“ löschen" }));
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api.deleteSkin).not.toHaveBeenCalled();
});

test("confirmed delete removes the skin and falls back to the smiley locally", async () => {
  vi.mocked(api.listSkins).mockResolvedValueOnce([IMPORTED]);
  vi.mocked(api.loadSettings).mockResolvedValueOnce(withSkin(IMPORTED.id));
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Figur „Mein Hund“ löschen" }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Löschen" }));
  });
  expect(api.deleteSkin).toHaveBeenCalledWith(IMPORTED.id);
  expect(screen.queryByRole("radio", { name: "Mein Hund" })).toBeNull();
  expect(screen.getByRole("radio", { name: "Smiley" })).toBeChecked();
  // Rust resets the skin; the settings window does not save on its own.
  expect(api.saveSettings).not.toHaveBeenCalled();
});

test("skins-changed refreshes the imported list", async () => {
  await setup();
  expect(screen.queryByRole("radio", { name: "Mein Hund" })).toBeNull();
  act(() => skinListeners.forEach((cb) => cb([IMPORTED])));
  expect(screen.getByRole("radio", { name: "Mein Hund" })).toBeInTheDocument();
});

test("reminder checkboxes save patches", async () => {
  await setup();
  const toast = screen.getByLabelText("Windows-Benachrichtigung anzeigen");
  const sound = screen.getByLabelText("Ton abspielen");
  expect(toast).toBeChecked();
  expect(sound).toBeChecked();
  fireEvent.click(toast);
  expect(api.saveSettings).toHaveBeenCalledWith({ reminderNotification: false });
  fireEvent.click(sound);
  expect(api.saveSettings).toHaveBeenCalledWith({ reminderSound: false });
});
