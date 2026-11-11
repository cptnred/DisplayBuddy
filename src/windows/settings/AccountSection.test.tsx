import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { AccountInfo, DeviceInfo, PairingInfo, ServerInfo, SyncStatus } from "../../types";

const h = vi.hoisted(() => ({
  listeners: [] as Array<(s: unknown) => void>,
  api: {
    syncStatus: vi.fn(),
    syncConnect: vi.fn(),
    syncDisconnect: vi.fn(),
    syncNow: vi.fn(),
    onSyncStatus: vi.fn(),
    accountServerInfo: vi.fn(),
    accountRegister: vi.fn(),
    accountRecover: vi.fn(),
    accountInfo: vi.fn(),
    accountDevices: vi.fn(),
    accountRevokeDevice: vi.fn(),
    accountChangePassword: vi.fn(),
    accountNewRecoveryCode: vi.fn(),
    accountExport: vi.fn(),
    accountDelete: vi.fn(),
    accountOpenLink: vi.fn(),
    pairingStart: vi.fn(),
    pairingStatus: vi.fn(),
    pairingCancel: vi.fn(),
  },
}));
vi.mock("../../lib/api", () => ({ api: h.api }));
import { AccountSection } from "./AccountSection";
import { POLL_MS } from "./PairingPanel";
import {
  accountErrorText,
  clockWarningText,
  formatBytes,
  formatCountdown,
  lastSeenText,
  serverHost,
  staleText,
  statusText,
  syncProblemText,
} from "./accountTexts";

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
const ON: SyncStatus = { ...OFF, enabled: true, deviceName: "Büro-PC", state: "idle", lastSyncAt: "2026-11-10T10:00:00.000Z" };
const INFO: ServerInfo = {
  serverTime: "2026-11-10T10:00:00.000Z",
  version: "0.4.0",
  apiLevel: 2,
  registration: "open",
  features: ["accounts", "pairing", "recovery", "export", "quota"],
  passwordMinChars: 12,
  legal: { imprintUrl: "https://example.org/impressum", privacyUrl: "https://example.org/datenschutz", termsUrl: null },
  operator: null,
};
const RECOVERY = "ABCDEFGHJKMNPQRSTVWXYZ01";
const ACCOUNT: AccountInfo = {
  username: "anna",
  createdAt: "2026-11-01T10:00:00.000Z",
  timeZone: "Europe/Berlin",
  contentFormat: 1,
  usage: { bytes: 12 * 1024 * 1024, notes: 3, devices: 2 },
  quota: { bytes: 50 * 1024 * 1024, notes: 5000, devices: 10 },
  recoveryCodeCreatedAt: "2026-11-01T10:00:00.000Z",
  serverTime: "2026-11-10T10:00:00.000Z",
};
const PC: DeviceInfo = {
  id: "d1",
  kind: "desktop",
  name: "Büro-PC",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastSeenAt: null,
  createdVia: "register",
  current: true,
  push: false,
};
const PHONE: DeviceInfo = { ...PC, id: "m1", kind: "mobile", name: "Pixel 8", current: false, createdVia: "pairing" };
const PAIRING: PairingInfo = {
  pairingId: "p1",
  code: "ABCDEFGHJKMN",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  expiresAt: "2026-11-10T10:03:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.length = 0;
  h.api.onSyncStatus.mockImplementation(async (cb: (s: unknown) => void) => {
    h.listeners.push(cb);
    return () => undefined;
  });
  h.api.accountServerInfo.mockResolvedValue(INFO);
  h.api.accountInfo.mockResolvedValue(ACCOUNT);
  h.api.accountDevices.mockResolvedValue([PC, PHONE]);
  h.api.pairingCancel.mockResolvedValue(undefined);
  h.api.accountOpenLink.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => vi.useRealTimers());

async function setup(status: SyncStatus) {
  h.api.syncStatus.mockResolvedValue(status);
  const r = render(<AccountSection />);
  await act(async () => {});
  return r;
}
const push = (s: SyncStatus) => act(() => h.listeners.forEach((l) => l(s)));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
/** Clicks the last button with that name (the mode switch and the submit button share „Konto anlegen“). */
const click = async (name: string | RegExp) => {
  const all = screen.getAllByRole("button", { name });
  await act(async () => {
    fireEvent.click(all[all.length - 1]);
  });
};

describe("texts", () => {
  it("status lines, clock warning, stale and quota hints", () => {
    expect(statusText(OFF)).toBe("Nicht verbunden");
    expect(statusText({ ...ON, state: "offline", pending: 1 })).toBe("Offline – 1 Änderung wartet");
    expect(statusText({ ...ON, state: "unauthorized" })).toBe("Abgemeldet – bitte neu verbinden");
    expect(statusText({ ...ON, lastSyncAt: null })).toBe("Verbunden");
    expect(clockWarningText({ ...ON, clockOffsetMs: 600_000 })).toMatch(/etwa 10 Min\. nach/);
    expect(clockWarningText({ ...OFF, clockOffsetMs: -180_000 })).toBeNull();
    expect(staleText({ ...ON, message: "stale:2" })).toMatch(/^2 Änderungen wurden/);
    expect(syncProblemText({ ...ON, state: "error", message: "server: HTTP 413 quota_exceeded" })).toMatch(/Speicher deines Kontos ist voll/);
    expect(syncProblemText({ ...ON, state: "error", message: "server: HTTP 403 account_disabled" })).toBe("Das Konto ist gesperrt.");
  });

  it("errors map to the German texts of PLAN_V4 §10 by code", () => {
    expect(accountErrorText("username_taken: HTTP 409")).toBe("Dieser Benutzername ist schon vergeben.");
    expect(accountErrorText("username_invalid: x")).toBe("Der Benutzername erfüllt die Regeln nicht.");
    expect(accountErrorText("password_weak: x")).toBe("Dieses Passwort ist zu kurz oder zu leicht zu erraten.");
    expect(accountErrorText("invite_invalid: HTTP 403")).toBe("Der Einladungscode ist ungültig oder abgelaufen.");
    expect(accountErrorText("too_many_requests: HTTP 429")).toBe("Zu viele Versuche. Bitte später erneut versuchen.");
    expect(accountErrorText("server_too_old: HTTP 404")).toMatch(/Server ist zu alt/);
    expect(accountErrorText("device_limit: HTTP 409")).toBe("Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden.");
    expect(accountErrorText("account_disabled: HTTP 403")).toBe("Das Konto ist gesperrt.");
    expect(accountErrorText("unauthorized", "login")).toBe("Benutzername oder Passwort ist falsch.");
    expect(accountErrorText("unauthorized", "recover")).toBe("Benutzername oder Wiederherstellungscode ist falsch.");
    // wrong confirmation password = 403 forbidden (server, Phase A); 401 means signed out
    expect(accountErrorText("forbidden: HTTP 403", "password")).toBe("Das Passwort ist falsch.");
    expect(accountErrorText("unauthorized", "password")).toBe("Abgemeldet – bitte neu verbinden.");
    expect(accountErrorText("password_required: HTTP 403", "password")).toMatch(/mindestens 24 Stunden/);
    expect(accountErrorText("password_required: HTTP 403")).toMatch(/vor deinem angemeldet/);
    expect(accountErrorText(new Error("?"), "login")).toBe("Verbinden fehlgeschlagen.");
  });

  it("formats host, bytes, countdown and last seen", () => {
    expect(serverHost("")).toBe("buddy.pev-point.de");
    expect(serverHost("https://own.example/")).toBe("own.example");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatBytes(52_428_800)).toBe("50 MB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatCountdown(161_000)).toBe("2:41");
    expect(formatCountdown(-5)).toBe("0:00");
    const now = new Date(2026, 10, 10, 12, 0);
    expect(lastSeenText(new Date(2026, 10, 10, 9, 12).toISOString(), now)).toBe("zuletzt aktiv: heute 09:12");
    expect(lastSeenText(new Date(2026, 10, 9, 18, 0).toISOString(), now)).toBe("zuletzt aktiv: gestern 18:00");
    expect(lastSeenText(null, now)).toBe("zuletzt aktiv: unbekannt");
  });
});

describe("not connected", () => {
  it("shows the standard server, legal links and registers with the mandatory code dialog", async () => {
    await setup(OFF);
    expect(h.api.accountServerInfo).toHaveBeenCalledWith("");
    expect(screen.getByText("Server: buddy.pev-point.de")).toBeInTheDocument();
    await click("Datenschutz");
    expect(h.api.accountOpenLink).toHaveBeenCalledWith("privacy");
    expect(screen.queryByLabelText("Einladungscode")).toBeNull();

    type("Benutzername", " anna ");
    type("Passwort", "ein langer geheimer Satz");
    type("Passwort wiederholen", "ein langer geheimer Satz");
    let resolve!: (v: unknown) => void;
    h.api.accountRegister.mockReturnValue(new Promise((r) => (resolve = r)));
    await click("Konto anlegen");
    expect(screen.getByText("Konto wird angelegt …")).toBeInTheDocument();
    expect(h.api.accountRegister).toHaveBeenCalledWith("", "anna", "ein langer geheimer Satz", "Windows-PC", null);
    h.api.accountRegister.mockClear();
    await act(async () => resolve({ status: ON, recoveryCode: RECOVERY }));

    const dialog = screen.getByRole("dialog", { name: "Dein Wiederherstellungscode" });
    expect(within(dialog).getByText("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Kopieren" })).toHaveFocus();
    // Esc does not close it, „Weiter“ only after the box
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const next = within(dialog).getByRole("button", { name: "Weiter" });
    expect(next).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Kopieren" }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(next);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Jetzt Handy verbinden" })).toBeInTheDocument();
  });

  it("traps the focus inside the dialog", async () => {
    await setup(OFF);
    type("Benutzername", "anna");
    type("Passwort", "ein langer geheimer Satz");
    type("Passwort wiederholen", "ein langer geheimer Satz");
    h.api.accountRegister.mockResolvedValue({ status: ON, recoveryCode: RECOVERY });
    await click("Konto anlegen");
    const dialog = screen.getByRole("dialog");
    const copy = within(dialog).getByRole("button", { name: "Kopieren" });
    const box = within(dialog).getByRole("checkbox");
    box.focus();
    fireEvent.keyDown(dialog, { key: "Tab" }); // box is last enabled element → wraps
    expect(copy).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(box).toHaveFocus();
    expect(dialog.closest("[data-local-escape]")).not.toBeNull();
  });

  it("checks repeated passwords locally and shows server errors in German", async () => {
    await setup(OFF);
    type("Benutzername", "anna");
    type("Passwort", "ein langer geheimer Satz");
    type("Passwort wiederholen", "anders");
    await click("Konto anlegen");
    expect(screen.getByRole("alert")).toHaveTextContent("Die Passwörter stimmen nicht überein.");
    expect(h.api.accountRegister).not.toHaveBeenCalled();
    type("Passwort wiederholen", "ein langer geheimer Satz");
    h.api.accountRegister.mockRejectedValue("username_taken: HTTP 409");
    await click("Konto anlegen");
    expect(screen.getByRole("alert")).toHaveTextContent("Dieser Benutzername ist schon vergeben.");
    expect(field("Passwort").value).toBe("ein langer geheimer Satz");
  });

  it("invite mode asks for the code, closed mode explains, a v3 server is too old", async () => {
    h.api.accountServerInfo.mockResolvedValueOnce({ ...INFO, registration: "invite" });
    const { unmount } = await setup(OFF);
    type("Benutzername", "anna");
    type("Passwort", "ein langer geheimer Satz");
    type("Passwort wiederholen", "ein langer geheimer Satz");
    type("Einladungscode", " INV-1 ");
    h.api.accountRegister.mockRejectedValue("invite_invalid: HTTP 403");
    await click("Konto anlegen");
    expect(h.api.accountRegister).toHaveBeenCalledWith("", "anna", "ein langer geheimer Satz", "Windows-PC", "INV-1");
    expect(screen.getByRole("alert")).toHaveTextContent("Der Einladungscode ist ungültig oder abgelaufen.");
    unmount();

    h.api.accountServerInfo.mockResolvedValueOnce({ ...INFO, registration: "closed" });
    const second = await setup(OFF);
    expect(screen.getByText("Auf diesem Server kann man sich nicht selbst registrieren.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Benutzername")).toBeNull();
    await click("Anmelden"); // login still works
    expect(field("Benutzername")).toBeInTheDocument();
    second.unmount();

    h.api.accountServerInfo.mockRejectedValueOnce("server_too_old: HTTP 404");
    await setup(OFF);
    expect(screen.getByText(/Server ist zu alt/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Benutzername")).toBeNull();
  });

  it("own server: entered address is checked on blur and used; back to the standard", async () => {
    await setup(OFF);
    fireEvent.click(screen.getByRole("button", { name: "Eigenen Server verwenden …" }));
    type("Server-Adresse", " https://own.example ");
    await act(async () => {
      fireEvent.blur(field("Server-Adresse"));
    });
    expect(h.api.accountServerInfo).toHaveBeenLastCalledWith("https://own.example");
    await click("Anmelden");
    type("Benutzername", "anna");
    type("Passwort", "pw");
    h.api.syncConnect.mockResolvedValue(ON);
    await act(async () => {
      fireEvent.submit(field("Benutzername").closest("form")!);
    });
    expect(h.api.syncConnect).toHaveBeenCalledWith("https://own.example", "anna", "pw", "Windows-PC");
  });

  it("an installation with its own server keeps it (D-96)", async () => {
    await setup({ ...OFF, serverUrl: "https://own.example" });
    expect(field("Server-Adresse").value).toBe("https://own.example");
    expect(h.api.accountServerInfo).toHaveBeenLastCalledWith("https://own.example");
    fireEvent.click(screen.getByRole("button", { name: "Standard-Server verwenden" }));
    expect(screen.getByText("Server: buddy.pev-point.de")).toBeInTheDocument();
  });

  it("login errors and the recovery flow", async () => {
    await setup(OFF);
    await click("Anmelden");
    type("Benutzername", "anna");
    type("Passwort", "falsch");
    h.api.syncConnect.mockRejectedValue("unauthorized");
    await act(async () => {
      fireEvent.submit(field("Benutzername").closest("form")!);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Benutzername oder Passwort ist falsch.");

    fireEvent.click(screen.getByRole("button", { name: "Passwort vergessen?" }));
    type("Wiederherstellungscode", "abcd efgh jkmn pqrs tvwx yz01");
    type("Neues Passwort", "ein langer geheimer Satz");
    type("Passwort wiederholen", "ein langer geheimer Satz");
    h.api.accountRecover.mockResolvedValue({ status: ON, recoveryCode: "ZZZZZZZZZZZZZZZZZZZZZZZZ" });
    await click("Neues Passwort setzen");
    expect(h.api.accountRecover).toHaveBeenCalledWith("", "anna", "abcd efgh jkmn pqrs tvwx yz01", "ein langer geheimer Satz", "Windows-PC");
    expect(screen.getByRole("dialog")).toHaveTextContent("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });
});

describe("connected", () => {
  it("shows status, devices and storage; disconnect asks while changes wait", async () => {
    await setup({ ...ON, pending: 2 });
    expect(screen.getByText(/Angemeldet als anna/)).toBeInTheDocument();
    expect(screen.getByText("Speicher: 12 MB von 50 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Speicher" })).toHaveAttribute("aria-valuenow", "24");
    expect(screen.getByText("Dieses Gerät")).toBeInTheDocument();
    expect(screen.queryByText(/noch keinen Wiederherstellungscode/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trennen (nur dieser PC)" }));
    expect(h.api.syncDisconnect).not.toHaveBeenCalled();
    h.api.syncDisconnect.mockResolvedValue(OFF);
    await click("Trotzdem trennen");
    expect(h.api.syncDisconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Server: buddy.pev-point.de")).toBeInTheDocument();
  });

  it("unauthorized brings the form back", async () => {
    await setup(ON);
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    push({ ...ON, state: "unauthorized" });
    await act(async () => {});
    expect(screen.getByText("Abgemeldet – bitte neu verbinden")).toBeInTheDocument();
    expect(field("Benutzername")).toBeInTheDocument();
  });

  it("revoking an older device asks for the password", async () => {
    await setup(ON);
    h.api.accountRevokeDevice.mockRejectedValueOnce("password_required: HTTP 403").mockResolvedValueOnce([PC]);
    await click("Pixel 8 abmelden");
    expect(h.api.accountRevokeDevice).toHaveBeenLastCalledWith("m1", null);
    expect(screen.getByText(/wurde vor deinem angemeldet/)).toBeInTheDocument();
    type("Passwort", "pw");
    await click("Mit Passwort abmelden");
    expect(h.api.accountRevokeDevice).toHaveBeenLastCalledWith("m1", "pw");
    expect(screen.queryByText("Pixel 8")).toBeNull();
  });

  it("a wrong password when revoking or deleting says so", async () => {
    await setup(ON);
    h.api.accountRevokeDevice
      .mockRejectedValueOnce("password_required: HTTP 403")
      .mockRejectedValueOnce("forbidden: HTTP 403");
    await click("Pixel 8 abmelden");
    type("Passwort", "falsch");
    await click("Mit Passwort abmelden");
    expect(screen.getByRole("alert")).toHaveTextContent("Das Passwort ist falsch.");

    fireEvent.click(screen.getByRole("button", { name: "Konto löschen …" }));
    const form = screen.getByRole("button", { name: "Endgültig löschen" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Passwort"), { target: { value: "falsch" } });
    type("Benutzername zur Bestätigung", "anna");
    h.api.accountDelete.mockRejectedValue("forbidden: HTTP 403");
    await click("Endgültig löschen");
    expect(screen.getAllByRole("alert").some((a) => a.textContent === "Das Passwort ist falsch.")).toBe(true);
  });

  it("changes the password with and without the current one", async () => {
    await setup(ON);
    fireEvent.click(screen.getByRole("button", { name: "Passwort ändern" }));
    type("Aktuelles Passwort", "alt");
    type("Neues Passwort", "ein langer neuer Satz");
    type("Neues Passwort wiederholen", "ein langer neuer Satz");
    h.api.accountChangePassword.mockRejectedValueOnce("forbidden: HTTP 403").mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.submit(field("Neues Passwort").closest("form")!);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Das Passwort ist falsch.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Ich kenne mein aktuelles Passwort nicht" }));
    expect(screen.queryByLabelText("Aktuelles Passwort")).toBeNull();
    await act(async () => {
      fireEvent.submit(field("Neues Passwort").closest("form")!);
    });
    expect(h.api.accountChangePassword).toHaveBeenLastCalledWith(null, "ein langer neuer Satz");
    expect(screen.getByText(/Passwort wurde geändert/)).toBeInTheDocument();
  });

  it("accounts without a code get a hint and a new code goes through the dialog", async () => {
    h.api.accountInfo.mockResolvedValue({ ...ACCOUNT, recoveryCodeCreatedAt: null });
    await setup(ON);
    expect(screen.getByText("Für dieses Konto gibt es noch keinen Wiederherstellungscode.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Code erzeugen" }));
    type("Passwort", "pw");
    h.api.accountNewRecoveryCode.mockResolvedValue(RECOVERY);
    await act(async () => {
      fireEvent.submit(field("Passwort").closest("form")!);
    });
    expect(h.api.accountNewRecoveryCode).toHaveBeenCalledWith("pw");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(screen.queryByRole("button", { name: "Jetzt Handy verbinden" })).toBeNull();
  });

  it("export and delete (only with the matching username)", async () => {
    await setup(ON);
    h.api.accountExport.mockResolvedValueOnce(null).mockResolvedValueOnce("C:\\x.json");
    await click("Daten exportieren");
    expect(screen.queryByText(/Gespeichert/)).toBeNull();
    await click("Daten exportieren");
    expect(screen.getByText("Gespeichert: C:\\x.json")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Konto löschen …" }));
    expect(screen.getByText(/Auf diesem PC bleiben/)).toBeInTheDocument();
    type("Passwort", "pw");
    type("Benutzername zur Bestätigung", "bob");
    expect(screen.getByRole("button", { name: "Endgültig löschen" })).toBeDisabled();
    type("Benutzername zur Bestätigung", "Anna");
    h.api.accountDelete.mockResolvedValue(OFF);
    await click("Endgültig löschen");
    expect(h.api.accountDelete).toHaveBeenCalledWith("pw", "Anna");
    expect(screen.getByRole("status")).toHaveTextContent("Nicht verbunden");
  });
});

describe("pairing", () => {
  it("QR only after the click, polls every 2 s, success with „Das war ich nicht“", async () => {
    vi.useFakeTimers();
    await setup(ON);
    expect(screen.queryByRole("img")).toBeNull();
    h.api.pairingStart.mockResolvedValue(PAIRING);
    h.api.pairingStatus.mockResolvedValue({ pairingId: "p1", state: "pending", expiresAt: "", device: null, redeemedAt: null, serverTime: "" });
    await click("Handy verbinden");
    const img = screen.getByRole("img", { name: /QR-Code/ }) as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(screen.getByText("ABCD-EFGH-JKMN")).toBeInTheDocument();
    expect(screen.getAllByText("Gültig noch 3:00")).toHaveLength(2); // visible + live region
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("Gültig noch 3:00");

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(h.api.pairingStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Gültig noch 2:58")).toBeInTheDocument();
    expect(live).toHaveTextContent("Gültig noch 3:00"); // not announced every second

    h.api.pairingStatus.mockResolvedValue({
      pairingId: "p1",
      state: "redeemed",
      expiresAt: "",
      device: { id: "m9", name: "Pixel 8", kind: "mobile" },
      redeemedAt: "",
      serverTime: "",
    });
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(screen.getByText("✓ ‚Pixel 8‘ ist jetzt angemeldet.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /QR-Code/ })).toBeNull();
    h.api.accountRevokeDevice.mockResolvedValue([PC]);
    await click("Das war ich nicht – abmelden");
    expect(h.api.accountRevokeDevice).toHaveBeenCalledWith("m9");
    expect(screen.getByText("‚Pixel 8‘ wurde abgemeldet.")).toBeInTheDocument();
    expect(h.api.pairingCancel).not.toHaveBeenCalled();
  });

  it("announces below 30 s, expires after 3 min and offers a new code", async () => {
    vi.useFakeTimers();
    await setup(ON);
    h.api.pairingStart.mockResolvedValue(PAIRING);
    h.api.pairingStatus.mockRejectedValue("offline: x"); // keeps polling
    await click("Handy verbinden");
    const live = document.querySelector('[aria-live="polite"]')!;
    await act(async () => {
      vi.advanceTimersByTime(151_000);
    });
    expect(live).toHaveTextContent("Gültig noch 0:29");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Der Code ist abgelaufen.")).toBeInTheDocument();
    expect(h.api.pairingCancel).toHaveBeenCalledWith("p1");
    await click("Neuen Code");
    expect(h.api.pairingStart).toHaveBeenCalledTimes(2);
  });

  it("server-side expiry and cancelling (button and closing)", async () => {
    vi.useFakeTimers();
    const { unmount } = await setup(ON);
    h.api.pairingStart.mockResolvedValue(PAIRING);
    h.api.pairingStatus.mockRejectedValueOnce("pairing_invalid: HTTP 404");
    await click("Handy verbinden");
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(screen.getByText("Der Code ist abgelaufen.")).toBeInTheDocument();
    await click("Neuen Code");
    await click("Abbrechen");
    expect(h.api.pairingCancel).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("button", { name: "Handy verbinden" })).toBeInTheDocument();
    h.api.pairingCancel.mockClear();
    await click("Handy verbinden");
    unmount();
    expect(h.api.pairingCancel).toHaveBeenCalledWith("p1");
  });

  it("start errors are shown in German (v3 server)", async () => {
    await setup(ON);
    h.api.pairingStart.mockRejectedValue("server_too_old: HTTP 404");
    await click("Handy verbinden");
    expect(screen.getAllByRole("alert").some((a) => /Server ist zu alt/.test(a.textContent ?? ""))).toBe(true);
  });
});
