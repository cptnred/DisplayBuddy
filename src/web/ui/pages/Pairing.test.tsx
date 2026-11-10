import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QrScanner, ServerSelector } from "../../contract";
import { PENDING_CODE_KEY } from "../../pairing/parse";
import { SyncError } from "../../sync/engine";
import { FAKE_PAIRING_CODE } from "../testing/fakeSync";
import { createFakeNotifier, renderApp } from "../testing/renderApp";
import { CAMERA_DENIED_TEXT, CODE_INVALID_TEXT, NOT_A_CODE_TEXT } from "./LoginPage";

const own = () => globalThis.location.origin;
const INFO = {
  serverTime: "2026-11-11T06:00:00.000Z",
  version: "0.4.0",
  apiLevel: 2,
  registration: "open" as const,
  features: [],
  passwordMinChars: 12,
  legal: { privacyUrl: "https://buddy.test/datenschutz", imprintUrl: "http://buddy.test/impressum", termsUrl: null },
  operator: null,
};
const qr = (origin: string, code = FAKE_PAIRING_CODE) => `${origin}/pair#c=${code}`;

function scanner(result: () => Promise<string | null>, available = true): QrScanner & { scan: ReturnType<typeof vi.fn> } {
  return { isAvailable: () => available, scan: vi.fn(result), cancel: vi.fn(async () => undefined) };
}

function selector(origin = "https://buddy.example.org"): ServerSelector & { set: ReturnType<typeof vi.fn> } {
  return {
    current: vi.fn(async () => ({ origin, defaultOrigin: "https://buddy.example.org", isDefault: true })),
    set: vi.fn(async () => undefined),
  };
}

afterEach(() => sessionStorage.clear());

describe("login page (v4)", () => {
  it("offers QR only with an available scanner, plus code and password, and no registration", async () => {
    const { unmount } = renderApp({ account: null, scanner: scanner(async () => null) });
    expect(await screen.findByRole("button", { name: "QR-Code scannen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code eingeben" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mit Passwort anmelden" })).toBeInTheDocument();
    expect(screen.getByText("Noch kein Konto? Lege es am PC in Display Buddy an.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /registrieren|Konto anlegen/i })).toBeNull();
    unmount();
    const second = renderApp({ account: null, scanner: scanner(async () => null, false) });
    await screen.findByRole("button", { name: "Code eingeben" });
    expect(screen.queryByRole("button", { name: "QR-Code scannen" })).toBeNull();
    second.unmount();
    renderApp({ account: null });
    await screen.findByRole("button", { name: "Code eingeben" });
    expect(screen.queryByRole("button", { name: "QR-Code scannen" })).toBeNull();
  });

  it("code entry: keyboard only, normalised code, then /setup", async () => {
    const { sync, history } = renderApp({ account: null });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Code eingeben" });
    screen.getByRole("button", { name: "Code eingeben" }).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByLabelText("Anmeldecode");
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("placeholder", "XXXX-XXXX-XXXX");
    await user.type(field, "abcd efgh jkmn{Enter}");
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain(`loginWithCode:${FAKE_PAIRING_CODE}:Testgerät`);
  });

  it("error texts: invalid code, not a code, device limit, account disabled", async () => {
    const { sync } = renderApp({ account: null });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Code eingeben" }));
    const field = screen.getByLabelText("Anmeldecode");
    await user.type(field, "ZZZZ-ZZZZ-ZZZZ{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(CODE_INVALID_TEXT);
    await user.clear(field);
    await user.type(field, "hallo{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_A_CODE_TEXT);
    expect(sync.calls.filter((c) => c.startsWith("loginWithCode"))).toHaveLength(1);
    await user.clear(field);
    sync.nextError = new SyncError("device_limit", "device_limit: x", 409);
    await user.type(field, `${FAKE_PAIRING_CODE}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden.");
    sync.nextError = new SyncError("account_disabled", "account_disabled: x", 403);
    await user.click(screen.getByRole("button", { name: "Mit Code anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Konto ist gesperrt.");
  });

  it("scanning a code of the own server signs in; camera errors and cancel are handled", async () => {
    const scan = scanner(async () => qr(own()));
    const { sync, history } = renderApp({ account: null, scanner: scan });
    const user = userEvent.setup();
    scan.scan.mockRejectedValueOnce(new Error("camera_denied")).mockResolvedValueOnce(null);
    await user.click(await screen.findByRole("button", { name: "QR-Code scannen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(CAMERA_DENIED_TEXT);
    await user.click(screen.getByRole("button", { name: "QR-Code scannen" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "QR-Code scannen" }));
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain(`loginWithCode:${FAKE_PAIRING_CODE}:Testgerät`);
  });

  it("PWA (no ServerSelector): a code of another server is refused", async () => {
    const { sync } = renderApp({ account: null, scanner: scanner(async () => qr("https://evil.test")) });
    await userEvent.click(await screen.findByRole("button", { name: "QR-Code scannen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dieser Code gehört zu einem anderen Server (evil.test). Öffne ihn dort.",
    );
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("native: a code of another server asks first; „Abbrechen“ is the default and stores nothing", async () => {
    const server = selector();
    const { sync } = renderApp({ account: null, server, scanner: scanner(async () => qr("https://notes.example.net")) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "QR-Code scannen" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Anderer Server" });
    expect(dialog).toHaveTextContent("Dieser Code gehört zum Server notes.example.net.");
    expect(dialog).toHaveTextContent("(buddy.example.org)");
    const cancel = within(dialog).getByRole("button", { name: "Abbrechen, Server nicht wechseln" });
    expect(cancel).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.set).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();

    await user.click(screen.getByRole("button", { name: "QR-Code scannen" }));
    await user.click(await screen.findByRole("button", { name: "Server verwenden und anmelden" }));
    expect(server.set).toHaveBeenCalledWith("https://notes.example.net");
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBe(FAKE_PAIRING_CODE);
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
  });

  it("native: a failed server switch drops the pending code and shows why", async () => {
    const server = selector();
    server.set.mockRejectedValueOnce(new Error("signed_in"));
    renderApp({ account: null, server, scanner: scanner(async () => qr("https://notes.example.net")) });
    await userEvent.click(await screen.findByRole("button", { name: "QR-Code scannen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Server verwenden und anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("solange niemand angemeldet ist");
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();
  });

  it("native: the pending code is redeemed once after the reload; the PWA never does that", async () => {
    sessionStorage.setItem(PENDING_CODE_KEY, FAKE_PAIRING_CODE);
    const pwa = renderApp({ account: null });
    await screen.findByRole("button", { name: "Code eingeben" });
    expect(pwa.sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
    pwa.unmount();
    const { sync, history } = renderApp({ account: null, server: selector("https://notes.example.net") });
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain(`loginWithCode:${FAKE_PAIRING_CODE}:Testgerät`);
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();
  });

  it("server line and dialog only with a ServerSelector", async () => {
    const { unmount } = renderApp({ account: null });
    await screen.findByRole("button", { name: "Code eingeben" });
    expect(screen.queryByRole("button", { name: "Server ändern" })).toBeNull();
    unmount();
    const server = selector();
    renderApp({ account: null, server });
    const user = userEvent.setup();
    expect(await screen.findByText(/Server: buddy\.example\.org/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Server ändern" }));
    await screen.findByRole("dialog", { name: "Eigenen Server verwenden" });
    server.set.mockRejectedValueOnce(new Error("invalid_url"));
    await user.type(screen.getByLabelText("Adresse deines Servers"), "ftp://x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Diese Adresse ist ungültig.");
    await user.clear(screen.getByLabelText("Adresse deines Servers"));
    await user.type(screen.getByLabelText("Adresse deines Servers"), "https://notes.example.net{Enter}");
    expect(server.set).toHaveBeenLastCalledWith("https://notes.example.net");
  });

  it("shows only https legal links from /info", async () => {
    renderApp({ account: null, info: INFO });
    expect(await screen.findByRole("link", { name: /Datenschutz/ })).toHaveAttribute("href", "https://buddy.test/datenschutz");
    expect(screen.queryByRole("link", { name: /Impressum/ })).toBeNull();
  });
});

describe("/pair (QR opened by the camera app)", () => {
  it("removes the fragment at once, never redeems without a click, shows server and code", async () => {
    const { sync, history } = renderApp({ account: null, path: "/pair#c=abcd-efgh-jkmn" });
    const form = await screen.findByRole("form", { name: "Dieses Gerät anmelden" });
    expect(history.path()).toBe("/pair");
    expect(history.entries.join(" ")).not.toMatch(/#|abcd/i);
    expect(within(form).getByText(`Server: ${globalThis.location.host}`)).toBeInTheDocument();
    expect(within(form).getByText("ABCD-EFGH-JKMN")).toBeInTheDocument();
    expect(within(form).getByLabelText("Gerätename")).toHaveValue("Testgerät");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
    await userEvent.click(within(form).getByRole("button", { name: "Hier anmelden" }));
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain(`loginWithCode:${FAKE_PAIRING_CODE}:Testgerät`);
  });

  it("shows the error of a used or expired code", async () => {
    const { sync } = renderApp({ account: null, path: `/pair#c=${FAKE_PAIRING_CODE}` });
    sync.codes.clear();
    await userEvent.click(await screen.findByRole("button", { name: "Hier anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(CODE_INVALID_TEXT);
  });

  it("refuses a broken fragment", async () => {
    const { history } = renderApp({ account: null, path: "/pair#c=ABCD&x=1" });
    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_A_CODE_TEXT);
    expect(history.path()).toBe("/pair");
    expect(screen.queryByRole("button", { name: "Hier anmelden" })).toBeNull();
  });

  it("already signed in: says so and offers nothing else", async () => {
    const { sync, history } = renderApp({ path: `/pair#c=${FAKE_PAIRING_CODE}` });
    expect(await screen.findByText("Du bist schon als ‚anna‘ angemeldet.")).toBeInTheDocument();
    expect(history.path()).toBe("/pair");
    expect(screen.queryByRole("button", { name: "Hier anmelden" })).toBeNull();
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
  });
});

describe("settings: account (v4)", () => {
  it("shows account and server host, deletes the account with password + name, then signs out locally", async () => {
    const notifier = createFakeNotifier("enabled");
    const { sync, store, history } = renderApp({ path: "/settings", notifier, info: INFO });
    expect(await screen.findByText(/auf buddy\.test$/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Datenschutz/ })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Konto löschen …" }));
    const form = screen.getByRole("form", { name: "Konto endgültig löschen" });
    expect(form).toHaveTextContent("Auf diesem Gerät werden die Daten ebenfalls gelöscht.");
    await user.type(within(form).getByLabelText("Passwort"), "ein-langes-passwort");
    await user.type(within(form).getByLabelText("Benutzername zur Bestätigung"), "bert");
    await user.click(within(form).getByRole("button", { name: "Endgültig löschen" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Der Benutzername stimmt nicht.");
    expect(sync.calls.some((c) => c.startsWith("deleteAccount"))).toBe(false);

    await user.clear(within(form).getByLabelText("Benutzername zur Bestätigung"));
    await user.type(within(form).getByLabelText("Benutzername zur Bestätigung"), "anna");
    await user.clear(within(form).getByLabelText("Passwort"));
    await user.type(within(form).getByLabelText("Passwort"), "falsch");
    await user.click(within(form).getByRole("button", { name: "Endgültig löschen" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Das Passwort ist falsch.");

    await user.clear(within(form).getByLabelText("Passwort"));
    await user.type(within(form).getByLabelText("Passwort"), "ein-langes-passwort");
    await user.click(within(form).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(history.path()).toBe("/login"));
    expect(sync.calls).toContain("deleteAccount:anna");
    expect(await store.getAccount()).toBeNull();
    expect(notifier.disable).toHaveBeenCalled();
  });

  it("status line shows the v4 error texts", async () => {
    const { sync } = renderApp({ path: "/" });
    act(() => sync.setStatus({ state: "error", message: "quota_exceeded: HTTP 413 POST /sync/push" }));
    expect(await screen.findByText(/Der Speicher deines Kontos ist voll/)).toBeInTheDocument();
    act(() => sync.setStatus({ state: "error", message: "content_format_unsupported" }));
    expect(await screen.findByText(/neueres Datenformat/)).toBeInTheDocument();
    act(() => sync.setStatus({ state: "error", message: "account_disabled: HTTP 403 GET /sync/changes" }));
    expect(await screen.findByText("Das Konto ist gesperrt.", { exact: false })).toBeInTheDocument();
  });
});
