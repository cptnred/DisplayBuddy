// @vitest-environment node
/**
 * Background sync hand-over of the Android shell (D-107) with a mocked buddy-push plugin,
 * fake store, tokens and notifier. No platform.
 */
import { describe, expect, it } from "vitest";
import type { Account, DataChange } from "../contract";
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
  }
  async stop() {
    this.calls.push("stop");
  }
  async state() {
    return this.battery;
  }
  async requestBatteryExemption() {
    this.calls.push("battery");
  }
}

function setup(opts: { account?: Account | null; token?: string | null; notifications?: "enabled" | "available" } = {}) {
  const plugin = new FakePlugin();
  let account: Account | null = opts.account === undefined ? ACCOUNT : opts.account;
  let token: string | null = opts.token === undefined ? "secret-token" : opts.token;
  let notifications = opts.notifications ?? "enabled";
  const listeners: ((c: DataChange) => void)[] = [];
  const memory = new Map<string, string>();
  const logs: string[] = [];
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
    baseUrl: "https://buddy.example.org",
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

  it("never logs the token", async () => {
    const t = setup();
    await t.bg.start();
    expect(t.logs.join("\n")).not.toContain("secret-token");
  });
});
