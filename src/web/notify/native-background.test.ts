// @vitest-environment node
/**
 * Background sync hand-over of the Android shell (D-107) with a mocked buddy-push plugin,
 * fake store, tokens and notifier. No platform.
 */
import { describe, expect, it } from "vitest";
import type { Account, DataChange, WebSyncStatus } from "../contract";
import { BATTERY_ASKED_KEY, type BackgroundPlugin, type BackgroundState, createBackgroundSync } from "./native-background";

const ACCOUNT: Account = { username: "martin", deviceId: "dev-1", serverUrl: "https://buddy.example.org", timeZone: "Europe/Berlin" };

class FakePlugin implements BackgroundPlugin {
  calls: string[] = [];
  started: { baseUrl: string; token: string }[] = [];
  battery: BackgroundState = { configured: true, batteryUnrestricted: false };
  failStart = false;
  async start(config: { baseUrl: string; token: string }) {
    if (this.failStart) throw new Error("nope");
    this.calls.push("start");
    this.started.push(config);
    this.battery = { ...this.battery, configured: true };
  }
  async stop() {
    this.calls.push("stop");
    this.battery = { ...this.battery, configured: false };
  }
  async state() {
    return this.battery;
  }
  async requestBatteryExemption() {
    this.calls.push("battery");
  }
}

const IDLE: WebSyncStatus = { state: "idle", pending: 0, lastSyncAt: null, clockOffsetMs: 0, clockWarning: false, message: null };

function setup(
  opts: {
    account?: Account | null;
    token?: string | null;
    notifications?: "enabled" | "available";
    baseUrl?: string;
    status?: Partial<WebSyncStatus>;
  } = {},
) {
  const plugin = new FakePlugin();
  let account: Account | null = opts.account === undefined ? ACCOUNT : opts.account;
  let token: string | null = opts.token === undefined ? "secret-token" : opts.token;
  let notifications = opts.notifications ?? "enabled";
  const listeners: ((c: DataChange) => void)[] = [];
  const memory = new Map<string, string>();
  const logs: string[] = [];
  let status: WebSyncStatus = { ...IDLE, ...opts.status };
  const statusListeners: ((s: WebSyncStatus) => void)[] = [];
  const bg = createBackgroundSync({
    plugin,
    tokens: { getToken: async () => token },
    store: {
      async getAccount() {
        return account;
      },
      subscribe(l) {
        listeners.push(l);
        return () => undefined;
      },
    },
    notifier: { status: async () => ({ state: notifications }) },
    sync: {
      status: () => status,
      onStatus(l) {
        statusListeners.push(l);
        return () => undefined;
      },
    },
    baseUrl: opts.baseUrl ?? "https://buddy.example.org",
    storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) },
    log: (m) => logs.push(m),
  });
  return {
    plugin,
    bg,
    memory,
    logs,
    setAccount: (a: Account | null) => (account = a),
    setToken: (t: string | null) => (token = t),
    setNotifications: (s: "enabled" | "available") => (notifications = s),
    emit: (kind: DataChange["kind"]) => listeners.forEach((l) => l({ kind, source: "local" })),
    /** New engine status; resolves once the triggered check is done. */
    setStatus: async (patch: Partial<WebSyncStatus>) => {
      status = { ...IDLE, ...patch };
      statusListeners.forEach((l) => l(status));
      await bg.ensure();
    },
  };
}

describe("createBackgroundSync", () => {
  it("hands address and token to the service once per account", async () => {
    const t = setup();
    await t.bg.start();
    await t.bg.ensure();
    expect(t.plugin.started).toEqual([{ baseUrl: "https://buddy.example.org", token: "secret-token" }]);
  });

  it("does nothing without an account and stops after a sign-out", async () => {
    const t = setup({ account: null });
    t.plugin.battery = { configured: false, batteryUnrestricted: true };
    await t.bg.start();
    expect(t.plugin.calls).toEqual([]);
    t.setAccount(ACCOUNT);
    t.emit("account");
    await t.bg.ensure();
    expect(t.plugin.calls).toContain("start");
    t.setAccount(null);
    t.emit("account");
    await t.bg.ensure();
    expect(t.plugin.calls.at(-1)).toBe("stop");
  });

  it("waits for the token", async () => {
    const t = setup({ token: null });
    await t.bg.start();
    expect(t.plugin.started).toEqual([]);
    t.setToken("new-token");
    await t.bg.ensure();
    expect(t.plugin.started).toHaveLength(1);
  });

  it("retries a failed start on the next trigger", async () => {
    const t = setup();
    t.plugin.failStart = true;
    await t.bg.start();
    expect(t.plugin.started).toEqual([]);
    t.plugin.failStart = false;
    await t.bg.ensure();
    expect(t.plugin.started).toHaveLength(1);
  });

  it("asks for the battery exemption once, and only after the notification permission", async () => {
    const t = setup({ notifications: "available" });
    await t.bg.start();
    expect(t.plugin.calls).not.toContain("battery");
    t.setNotifications("enabled");
    await t.bg.ensure();
    await t.bg.ensure();
    expect(t.plugin.calls.filter((c) => c === "battery")).toHaveLength(1);
    expect(t.memory.get(BATTERY_ASKED_KEY)).toBe("1");
  });

  it("does not ask when the app is already unrestricted", async () => {
    const t = setup();
    t.plugin.battery = { configured: true, batteryUnrestricted: true };
    await t.bg.start();
    expect(t.plugin.calls).not.toContain("battery");
  });

  it("hands the token over again after the native side forgot the account", async () => {
    const t = setup();
    await t.bg.start();
    expect(t.plugin.started).toHaveLength(1);
    t.plugin.battery = { configured: false, batteryUnrestricted: true };
    await t.bg.ensure();
    expect(t.plugin.started).toHaveLength(2);
    t.plugin.battery = { configured: true, batteryUnrestricted: true };
    await t.bg.ensure();
    expect(t.plugin.started).toHaveLength(2);
  });

  it("stops a service an earlier process configured when nobody is signed in", async () => {
    const t = setup({ account: null });
    await t.bg.start();
    expect(t.plugin.calls).toEqual(["stop"]);
  });

  it("hands over after a code login (account event while the engine still says signedOut)", async () => {
    const t = setup({ account: null, status: { state: "signedOut" } });
    t.plugin.battery = { configured: false, batteryUnrestricted: true };
    await t.bg.start();
    // completeLogin: setAccount → store event, then status idle
    t.setAccount(ACCOUNT);
    t.emit("account");
    await t.bg.ensure();
    expect(t.plugin.started).toEqual([]);
    await t.setStatus({ state: "idle" });
    expect(t.plugin.started).toEqual([{ baseUrl: "https://buddy.example.org", token: "secret-token" }]);
  });

  it("stops after logout or account deletion even before the local data is gone", async () => {
    const t = setup();
    await t.bg.start();
    expect(t.plugin.calls).toContain("start");
    await t.setStatus({ state: "signedOut" });
    expect(t.plugin.calls.at(-1)).toBe("stop");
    t.emit("account");
    await t.bg.ensure();
    expect(t.plugin.calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("stops when the device was revoked (401)", async () => {
    const t = setup();
    await t.bg.start();
    await t.setStatus({ state: "unauthorized" });
    expect(t.plugin.calls.at(-1)).toBe("stop");
  });

  it("stops for an unknown content format and does not start again", async () => {
    const t = setup();
    await t.bg.start();
    await t.setStatus({ state: "error", message: "content_format_unsupported: account format 2" });
    expect(t.plugin.calls.at(-1)).toBe("stop");
    t.plugin.battery = { configured: false, batteryUnrestricted: true };
    t.emit("account");
    await t.bg.ensure();
    expect(t.plugin.calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("keeps the token while the account is locked and hands over again after the unlock", async () => {
    const t = setup();
    await t.bg.start();
    await t.setStatus({ state: "error", message: "account_disabled: account is disabled" });
    expect(t.plugin.calls).not.toContain("stop");
    // the service got 403 itself and dropped its copy
    t.plugin.battery = { configured: false, batteryUnrestricted: true };
    await t.bg.ensure();
    expect(t.plugin.started).toHaveLength(1);
    await t.setStatus({ state: "idle" });
    expect(t.plugin.started).toHaveLength(2);
  });

  it("hands over only a valid origin (PLAN_V4 §13 no. 31)", async () => {
    for (const [baseUrl, ok] of [
      ["http://beispiel.de", false],
      ["https://beispiel.de/pfad", false],
      ["https://beispiel.de", true],
    ] as const) {
      const t = setup({ baseUrl });
      await t.bg.start();
      expect(t.plugin.started.length, baseUrl).toBe(ok ? 1 : 0);
    }
  });

  it("never logs the token", async () => {
    const t = setup();
    await t.bg.start();
    expect(t.logs.join("\n")).not.toContain("secret-token");
  });
});
