import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

const h = vi.hoisted(() => ({
  listeners: [] as Array<(s: unknown) => void>,
  api: {
    loadSettings: vi.fn(),
    saveSettings: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    onSettingsChanged: vi.fn(),
  },
}));
vi.mock("../../lib/api", () => ({ api: h.api }));
import { AccountHint } from "./AccountHint";

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.length = 0;
  h.api.onSettingsChanged.mockImplementation(async (cb: (s: unknown) => void) => {
    h.listeners.push(cb);
    return () => undefined;
  });
});

async function setup(s: Partial<Settings>) {
  h.api.loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, ...s });
  const r = render(<AccountHint />);
  await act(async () => {});
  return r;
}

it("shows while not connected and opens the account section", async () => {
  await setup({});
  expect(screen.getByText("Notizen auch aufs Handy?")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Konto anlegen" }));
  });
  expect(h.api.openSettings).toHaveBeenCalledWith("account");
});

it("never shows when connected or dismissed", async () => {
  const a = await setup({ syncEnabled: true });
  expect(screen.queryByText("Notizen auch aufs Handy?")).toBeNull();
  a.unmount();
  await setup({ accountHintDismissed: true });
  expect(screen.queryByText("Notizen auch aufs Handy?")).toBeNull();
});

it("„Später“ hides it for this run, „Nicht mehr zeigen“ saves the flag", async () => {
  const a = await setup({});
  fireEvent.click(screen.getByRole("button", { name: "Später" }));
  expect(screen.queryByText("Notizen auch aufs Handy?")).toBeNull();
  expect(h.api.saveSettings).not.toHaveBeenCalled();
  a.unmount();

  await setup({});
  fireEvent.click(screen.getByRole("button", { name: "Nicht mehr zeigen" }));
  expect(h.api.saveSettings).toHaveBeenCalledWith({ accountHintDismissed: true });
  expect(screen.queryByText("Notizen auch aufs Handy?")).toBeNull();
});

it("follows settings-changed (connecting hides it)", async () => {
  await setup({});
  act(() => h.listeners.forEach((l) => l({ ...DEFAULT_SETTINGS, syncEnabled: true })));
  expect(screen.queryByText("Notizen auch aufs Handy?")).toBeNull();
});
