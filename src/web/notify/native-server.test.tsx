/**
 * Server choice of the native shell (PLAN_V4 §6.2, §6.5, §9.2): server_get/server_set adapter,
 * the restart flow with a pending code (3-minute rule) and the origin check at start.
 */
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, QrScanner } from "../contract";
import { PENDING_CODE_KEY } from "../pairing/parse";
import { FAKE_PAIRING_CODE } from "../ui/testing/fakeSync";
import { renderApp } from "../ui/testing/renderApp";
import {
  PENDING_CODE_AT_KEY,
  createMismatchSync,
  createServerSelector,
  expirePendingCode,
  isServerOrigin,
  originMismatch,
  stampPendingCode,
  type Invoke,
} from "./native-shell";

const DEFAULT = "https://buddy.pev-point.de";
const NOW = Date.parse("2026-11-11T06:00:00.000Z");

/** Fake shell: server_get/server_set with the Rust rules that matter here. */
function fakeShell(token: string | null = null) {
  let origin = DEFAULT;
  const calls: string[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "server_get") return { origin, defaultOrigin: DEFAULT, isDefault: origin === DEFAULT };
    if (cmd === "server_set") {
      const o = args?.origin as string | null;
      if (o !== null && !isServerOrigin(o)) throw "invalid_url: BUDDY_PUBLIC_URL must use https://";
      origin = o ?? DEFAULT;
      return null;
    }
    throw new Error(`unknown ${cmd}`);
  }) as unknown as Invoke;
  const reload = vi.fn();
  const stopBackground = vi.fn(async () => {
    calls.push("stop_background_sync");
  });
  const selector = createServerSelector(invoke, { tokens: { getToken: async () => token }, stopBackground, reload });
  return { selector, calls, reload, stopBackground, origin: () => origin };
}

afterEach(() => sessionStorage.clear());

describe("server origin rule (same as server_url::normalize output)", () => {
  it("accepts https and loopback/emulator http only, without path, query, fragment or user info", () => {
    for (const ok of ["https://beispiel.de", "https://buddy.pev-point.de:8443", "http://10.0.2.2:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      expect(isServerOrigin(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://beispiel.de",
      "https://beispiel.de/pfad",
      "https://beispiel.de/",
      "https://beispiel.de?x=1",
      "https://beispiel.de#c=1",
      "https://user@beispiel.de",
      "http://192.168.1.2:8080",
      "ftp://beispiel.de",
      "https://",
      "beispiel.de",
    ]) {
      expect(isServerOrigin(bad), bad).toBe(false);
    }
  });
});

describe("server selector", () => {
  it("reads server_get", async () => {
    const s = fakeShell();
    expect(await s.selector.current()).toEqual({ origin: DEFAULT, defaultOrigin: DEFAULT, isDefault: true });
  });

  it("stops the background sync, stores the origin and reloads", async () => {
    const s = fakeShell();
    await s.selector.set("https://notes.example.net");
    expect(s.calls).toEqual(["stop_background_sync", "server_set"]);
    expect(s.origin()).toBe("https://notes.example.net");
    expect(s.reload).toHaveBeenCalledTimes(1);
    await s.selector.set(null);
    expect(s.origin()).toBe(DEFAULT);
  });

  it("signed in → signed_in, nothing stopped or stored", async () => {
    const s = fakeShell("token");
    await expect(s.selector.set("https://notes.example.net")).rejects.toThrow("signed_in");
    expect(s.calls).toEqual([]);
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("Rust error strings become Errors with the code in the message; no reload", async () => {
    const s = fakeShell();
    const e = await s.selector.set("http://beispiel.de").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/^invalid_url/);
    expect(s.reload).not.toHaveBeenCalled();
  });
});

describe("pending code across the reload (3-minute rule)", () => {
  const foreignQr = `https://notes.example.net/pair#c=${FAKE_PAIRING_CODE}`;
  const scanner = (): QrScanner => ({ isAvailable: () => true, scan: async () => foreignQr, cancel: async () => undefined });

  /** Scan a code of another server, confirm, server_set + reload (stamped like main.tsx does). */
  async function switchServer() {
    const s = fakeShell();
    s.reload.mockImplementation(() => stampPendingCode(sessionStorage, NOW));
    const first = renderApp({ account: null, server: s.selector, scanner: scanner() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "QR-Code scannen" }));
    await user.click(await screen.findByRole("button", { name: "Server verwenden und anmelden" }));
    await waitFor(() => expect(s.reload).toHaveBeenCalled());
    expect(first.sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);
    expect(sessionStorage.getItem(PENDING_CODE_AT_KEY)).toBe(String(NOW));
    first.unmount();
    return s;
  }

  it("is redeemed once after the restart when younger than 3 minutes", async () => {
    const s = await switchServer();
    // restart: main.tsx expires stale codes before the UI starts
    expirePendingCode(sessionStorage, NOW + 170_000);
    const { sync, history } = renderApp({ account: null, server: s.selector, scanner: scanner() });
    await waitFor(() => expect(history.path()).toBe("/setup"));
    expect(sync.calls).toContain(`loginWithCode:${FAKE_PAIRING_CODE}:Testgerät`);
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_CODE_AT_KEY)).toBeNull();
  });

  it("is dropped when 3 minutes or older, unstamped or from the future", async () => {
    const s = await switchServer();
    expirePendingCode(sessionStorage, NOW + 180_000);
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();
    const { sync } = renderApp({ account: null, server: s.selector });
    await screen.findByRole("button", { name: "Code eingeben" });
    await act(async () => undefined);
    expect(sync.calls.some((c) => c.startsWith("loginWithCode"))).toBe(false);

    sessionStorage.setItem(PENDING_CODE_KEY, FAKE_PAIRING_CODE);
    expirePendingCode(sessionStorage, NOW);
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();

    sessionStorage.setItem(PENDING_CODE_KEY, FAKE_PAIRING_CODE);
    stampPendingCode(sessionStorage, NOW + 60_000);
    expirePendingCode(sessionStorage, NOW);
    expect(sessionStorage.getItem(PENDING_CODE_KEY)).toBeNull();
  });

  it("stamps nothing without a pending code", () => {
    stampPendingCode(sessionStorage, NOW);
    expect(sessionStorage.getItem(PENDING_CODE_AT_KEY)).toBeNull();
  });
});

describe("origin check at start (PLAN_V4 §9.2)", () => {
  const account = (serverUrl: string): Account => ({ username: "anna", deviceId: "d1", serverUrl, timeZone: null });

  it("flags only a stored account of another server with a token present", () => {
    expect(originMismatch(account("https://buddy.example.org"), "t", DEFAULT)).toContain(
      "Diese App-Version ist für einen anderen Server eingerichtet (buddy.pev-point.de).",
    );
    expect(originMismatch(account("https://buddy.example.org"), "t", DEFAULT)).toContain("Melde dich ab und neu an.");
    expect(originMismatch(account("https://Buddy.Pev-Point.de:443"), "t", DEFAULT)).toBeNull();
    expect(originMismatch(account("https://buddy.example.org"), null, DEFAULT)).toBeNull();
    expect(originMismatch(null, "t", DEFAULT)).toBeNull();
  });

  it("the stand-in engine sends nothing, keeps the outbox and only forgets the token on logout", async () => {
    const setToken = vi.fn(async () => undefined);
    const sync = createMismatchSync({ setToken });
    expect(sync.status()).toMatchObject({ state: "error" });
    expect(sync.status().message).toMatch(/^server_mismatch/);
    await sync.syncNow();
    sync.requestSync("start");
    await expect(sync.login("anna", "pw", "x")).rejects.toThrow("server_mismatch");
    await expect(sync.loginWithCode(FAKE_PAIRING_CODE, "x")).rejects.toThrow("server_mismatch");
    await expect(sync.deleteAccount("pw", "anna")).rejects.toThrow("server_mismatch");
    const seen: string[] = [];
    sync.onStatus((s) => seen.push(s.state));
    await sync.logout();
    expect(setToken).toHaveBeenCalledWith(null);
    expect(seen).toEqual(["signedOut"]);
  });
});
