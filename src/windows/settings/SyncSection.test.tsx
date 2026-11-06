import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { SyncStatus } from "../../types";

const h = vi.hoisted(() => ({
  listeners: [] as Array<(s: unknown) => void>,
  api: {
    syncStatus: vi.fn(),
    syncConnect: vi.fn(),
    syncDisconnect: vi.fn(),
    syncNow: vi.fn(),
    onSyncStatus: vi.fn(),
  },
}));
vi.mock("../../lib/api", () => ({ api: h.api }));
import { SyncSection, clockWarningText, connectErrorText, staleText, statusText } from "./SyncSection";

const OFF: SyncStatus = {
  enabled: false,
  serverUrl: "",
  deviceName: "",
  state: "off",
  lastSyncAt: null,
  pending: 0,
  message: null,
  clockOffsetMs: 0,
};
const ON: SyncStatus = {
  ...OFF,
  enabled: true,
  serverUrl: "https://buddy.example.org",
  deviceName: "Büro-PC",
  state: "idle",
  lastSyncAt: "2026-11-06T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.length = 0;
  h.api.onSyncStatus.mockImplementation(async (cb: (s: unknown) => void) => {
    h.listeners.push(cb);
    return () => undefined;
  });
});

async function setup(status: SyncStatus) {
  h.api.syncStatus.mockResolvedValue(status);
  render(<SyncSection />);
  await act(async () => {});
}
const push = (s: SyncStatus) => act(() => h.listeners.forEach((l) => l(s)));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("texts", () => {
  it("status lines", () => {
    expect(statusText(OFF)).toBe("Nicht verbunden");
    expect(statusText({ ...ON, state: "syncing" })).toBe("Synchronisiere …");
    expect(statusText({ ...ON, state: "offline", pending: 3 })).toBe("Offline – 3 Änderungen warten");
    expect(statusText({ ...ON, state: "offline", pending: 1 })).toBe("Offline – 1 Änderung wartet");
    expect(statusText({ ...ON, state: "unauthorized" })).toBe("Abgemeldet – bitte neu verbinden");
    expect(statusText({ ...ON, state: "error", pending: 2 })).toBe("Fehler bei der Synchronisation – 2 Änderungen warten");
    expect(statusText(ON)).toMatch(/^Synchronisiert – zuletzt /);
    expect(statusText({ ...ON, lastSyncAt: null })).toBe("Verbunden");
  });

  it("connect errors map to German texts", () => {
    expect(connectErrorText("unauthorized")).toBe("Benutzername oder Passwort ist falsch.");
    expect(connectErrorText("offline: connection refused")).toMatch(/nicht erreichbar/);
    expect(connectErrorText("invalid_url: scheme http not allowed")).toMatch(/https/);
    expect(connectErrorText("server: HTTP 429 too_many_requests")).toMatch(/Zu viele/);
    expect(connectErrorText(new Error("?"))).toBe("Verbinden fehlgeschlagen.");
  });

  it("clock warning above 2 minutes and stale hint", () => {
    expect(clockWarningText({ ...ON, clockOffsetMs: 120_000 })).toBeNull();
    expect(clockWarningText({ ...ON, clockOffsetMs: 600_000 })).toMatch(/etwa 10 Min\. nach/);
    expect(clockWarningText({ ...ON, clockOffsetMs: -180_000 })).toMatch(/etwa 3 Min\. vor/);
    expect(clockWarningText({ ...OFF, clockOffsetMs: -180_000 })).toBeNull();
    expect(staleText({ ...ON, message: "stale:2" })).toMatch(/^2 Änderungen wurden/);
    expect(staleText({ ...ON, message: "offline: x" })).toBeNull();
  });
});

describe("SyncSection", () => {
  it("connects with the entered data and clears the password", async () => {
    await setup(OFF);
    expect(screen.getByRole("status")).toHaveTextContent("Nicht verbunden");
    expect(field("Gerätename").value).toBe("Windows-PC");
    h.api.syncConnect.mockResolvedValue({ ...ON, state: "syncing" });
    fireEvent.change(field("Server-Adresse"), { target: { value: " https://buddy.example.org " } });
    fireEvent.change(field("Benutzer"), { target: { value: "anna" } });
    fireEvent.change(field("Passwort"), { target: { value: "sehr-geheim-123" } });
    fireEvent.change(field("Gerätename"), { target: { value: "Büro-PC" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verbinden" }));
    });
    expect(h.api.syncConnect).toHaveBeenCalledWith("https://buddy.example.org", "anna", "sehr-geheim-123", "Büro-PC");
    expect(screen.getByRole("status")).toHaveTextContent("Synchronisiere …");
    expect(screen.queryByLabelText("Passwort")).toBeNull(); // form hidden once connected
    expect(screen.getByRole("button", { name: "Jetzt synchronisieren" })).toBeDisabled();
  });

  it("shows a German error and keeps the form on a failed connect", async () => {
    await setup(OFF);
    h.api.syncConnect.mockRejectedValue("unauthorized");
    fireEvent.change(field("Server-Adresse"), { target: { value: "https://buddy.example.org" } });
    fireEvent.change(field("Benutzer"), { target: { value: "anna" } });
    fireEvent.change(field("Passwort"), { target: { value: "falsch" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verbinden" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Benutzername oder Passwort ist falsch.");
    expect(field("Passwort").value).toBe("falsch");
  });

  it("follows sync-status events: offline, clock warning, unauthorized → reconnect form", async () => {
    await setup(ON);
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    push({ ...ON, state: "offline", pending: 2, clockOffsetMs: 300_000 });
    expect(screen.getByRole("status")).toHaveTextContent("Offline – 2 Änderungen warten");
    expect(screen.getByRole("alert")).toHaveTextContent("etwa 5 Min. nach");
    push({ ...ON, state: "unauthorized" });
    expect(screen.getByRole("status")).toHaveTextContent("Abgemeldet – bitte neu verbinden");
    expect(field("Server-Adresse").value).toBe("https://buddy.example.org");
    expect(field("Gerätename").value).toBe("Büro-PC");
    expect(screen.getByRole("button", { name: "Neu verbinden" })).toBeInTheDocument();
  });

  it("sync now and disconnect (with confirmation while changes wait)", async () => {
    await setup({ ...ON, pending: 2 });
    h.api.syncNow.mockResolvedValue({ ...ON, state: "syncing" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Jetzt synchronisieren" }));
    });
    expect(h.api.syncNow).toHaveBeenCalledTimes(1);
    push({ ...ON, pending: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Trennen" }));
    expect(h.api.syncDisconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/2 Änderungen warten noch nicht übertragen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    fireEvent.click(screen.getByRole("button", { name: "Trennen" }));
    h.api.syncDisconnect.mockResolvedValue(OFF);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trotzdem trennen" }));
    });
    expect(h.api.syncDisconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Nicht verbunden");
    expect(screen.getByRole("button", { name: "Verbinden" })).toBeInTheDocument();
  });

  it("disconnects right away when nothing waits", async () => {
    await setup(ON);
    h.api.syncDisconnect.mockResolvedValue(OFF);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trennen" }));
    });
    expect(h.api.syncDisconnect).toHaveBeenCalledTimes(1);
  });
});
