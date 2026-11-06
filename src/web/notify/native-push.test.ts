// @vitest-environment node
/**
 * Native push of the Android shell (PLAN_V3_SYNC §10.5) with a mocked buddy-push plugin,
 * a fake HTTP adapter, store and sync engine. No network.
 */
import { describe, expect, it, vi } from "vitest";
import type { Account, DataChange, HttpResponse, WebSyncStatus } from "../contract";
import { NetworkError } from "../sync/http";
import {
  createNativePush,
  parsePushData,
  parsePushMessage,
  PUSH_PATH,
  type PushData,
  type PushMessage,
  type PushPlugin,
  PushPluginError,
} from "./native-push";
import { toPushError } from "./native-push-plugin";

const ACCOUNT: Account = { username: "martin", deviceId: "dev-1", serverUrl: "https://buddy.example.org", timeZone: "Europe/Berlin" };

class FakePlugin implements PushPlugin {
  token: string | Error = "fcm-token-1";
  launch: PushData | null = null;
  tokenCalls = 0;
  tokenCb: ((t: string) => void) | null = null;
  messageCb: ((m: PushMessage) => void) | null = null;
  openedCb: ((d: PushData) => void) | null = null;
  async getToken() {
    this.tokenCalls++;
    if (this.token instanceof Error) throw this.token;
    return this.token;
  }
  async takeLaunchData() {
    const l = this.launch;
    this.launch = null;
    return l;
  }
  async onToken(cb: (t: string) => void) {
    this.tokenCb = cb;
    return () => (this.tokenCb = null);
  }
  async onMessage(cb: (m: PushMessage) => void) {
    this.messageCb = cb;
    return () => (this.messageCb = null);
  }
  async onOpened(cb: (d: PushData) => void) {
    this.openedCb = cb;
    return () => (this.openedCb = null);
  }
}

function setup(opts: { account?: Account | null; status?: number | "network" } = {}) {
  const plugin = new FakePlugin();
  let account: Account | null = opts.account === undefined ? ACCOUNT : opts.account;
  const answers: (number | "network")[] = [];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const http = {
    async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<HttpResponse<T>> {
      requests.push({ method, path, body });
      const a = answers.shift() ?? opts.status ?? 204;
      if (a === "network") throw new NetworkError("offline");
      return { status: a, body: null, sentAt: 0, receivedAt: 0 };
    },
  };
  const changeListeners: ((c: DataChange) => void)[] = [];
  const store = {
    async getAccount() {
      return account;
    },
    subscribe(l: (c: DataChange) => void) {
      changeListeners.push(l);
      return () => undefined;
    },
  };
  let status: WebSyncStatus = { state: "idle", pending: 0, lastSyncAt: null, clockOffsetMs: 0, clockWarning: false, message: null };
  const statusListeners: ((s: WebSyncStatus) => void)[] = [];
  const events: string[] = [];
  const sync = {
    status: () => status,
    onStatus(l: (s: WebSyncStatus) => void) {
      statusListeners.push(l);
      return () => undefined;
    },
    syncNow: vi.fn(async () => {
      events.push("sync");
    }),
  };
  const notifier = {
    replan: vi.fn(async (reason: string) => {
      events.push(`replan:${reason}`);
    }),
  };
  const shown: PushMessage[] = [];
  const opened: string[] = [];
  const push = createNativePush({
    plugin,
    http,
    store,
    sync,
    notifier,
    showNow: async (m) => {
      events.push("show");
      shown.push(m);
    },
    onOpenNote: (id) => opened.push(id),
  });
  return {
    plugin,
    push,
    requests,
    answers,
    events,
    shown,
    opened,
    sync,
    notifier,
    setAccount(a: Account | null) {
      account = a;
      for (const l of changeListeners) l({ kind: "account", source: "local" });
    },
    synced(at: string) {
      status = { ...status, state: "idle", lastSyncAt: at };
      for (const l of statusListeners) l(status);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("token registration", () => {
  it("registers the FCM token once per start with PUT /devices/current/push", async () => {
    const t = setup();
    await t.push.start();
    expect(t.requests).toEqual([{ method: "PUT", path: PUSH_PATH, body: { platform: "fcm", token: "fcm-token-1" } }]);
    expect(t.push.state()).toBe("registered");
    await t.push.ensureRegistered();
    expect(t.requests).toHaveLength(1);
  });

  it("waits for a login and registers again after a token rotation", async () => {
    const t = setup({ account: null });
    await t.push.start();
    expect(t.push.state()).toBe("off");
    expect(t.requests).toHaveLength(0);
    t.setAccount(ACCOUNT);
    await flush();
    expect(t.requests).toHaveLength(1);
    t.plugin.tokenCb?.("fcm-token-2");
    await flush();
    expect(t.requests.map((r) => (r.body as { token: string }).token)).toEqual(["fcm-token-1", "fcm-token-2"]);
    // same token again → nothing
    t.plugin.tokenCb?.("fcm-token-2");
    await flush();
    expect(t.requests).toHaveLength(2);
    // logout, login on another device id → registers for the new device
    t.setAccount(null);
    await flush();
    expect(t.push.state()).toBe("off");
    t.setAccount({ ...ACCOUNT, deviceId: "dev-2" });
    await flush();
    expect(t.requests).toHaveLength(3);
  });

  it("offline: retried after the next successful sync", async () => {
    const t = setup();
    t.answers.push("network", 503);
    await t.push.start();
    expect(t.push.state()).toBe("pending");
    t.synced("2026-11-06T10:00:00.000Z");
    await flush();
    expect(t.push.state()).toBe("pending");
    t.synced("2026-11-06T10:01:00.000Z");
    await flush();
    expect(t.push.state()).toBe("registered");
    expect(t.requests).toHaveLength(3);
    // further syncs do not register again
    t.synced("2026-11-06T10:02:00.000Z");
    await flush();
    expect(t.requests).toHaveLength(3);
  });

  it("app without Firebase or server without FCM: no endless retries", async () => {
    const t = setup();
    t.plugin.token = new PushPluginError("NOT_CONFIGURED", "x");
    await t.push.start();
    expect(t.push.state()).toBe("notConfigured");
    t.synced("2026-11-06T10:00:00.000Z");
    await flush();
    expect(t.plugin.tokenCalls).toBe(1);
    expect(t.requests).toHaveLength(0);

    const s = setup({ status: 404 });
    await s.push.start();
    expect(s.push.state()).toBe("serverUnsupported");
    s.synced("2026-11-06T10:00:00.000Z");
    await flush();
    expect(s.requests).toHaveLength(1);
  });

  it("a token that is not available yet is fetched again later", async () => {
    const t = setup();
    t.plugin.token = new PushPluginError("UNAVAILABLE", "x");
    await t.push.start();
    expect(t.push.state()).toBe("pending");
    t.plugin.token = "fcm-token-1";
    t.synced("2026-11-06T10:00:00.000Z");
    await flush();
    expect(t.push.state()).toBe("registered");
  });
});

describe("wake-up", () => {
  it("foreground message: shows the reminder, syncs, then re-plans", async () => {
    const t = setup();
    await t.push.start();
    t.events.length = 0;
    t.plugin.messageCb?.({ type: "reminder", noteId: "n1", at: "2026-11-06T10:01:00.000Z", title: "Erinnerung: Einkauf", body: "Milch" });
    await flush();
    expect(t.events).toEqual(["show", "sync", "replan:sync"]);
    expect(t.shown[0].noteId).toBe("n1");
    // a test push is not shown as a reminder
    t.events.length = 0;
    t.plugin.messageCb?.({ type: "test", noteId: null, at: null, title: "t", body: "b" });
    await flush();
    expect(t.events).toEqual(["sync", "replan:sync"]);
  });

  it("tap on the system notification (cold start and running app) opens the note and syncs", async () => {
    const t = setup();
    t.plugin.launch = { type: "reminder", noteId: "n1", at: "2026-11-06T10:01:00.000Z" };
    await t.push.start();
    expect(t.opened).toEqual(["n1"]);
    expect(t.events).toEqual(["sync", "replan:sync"]);
    t.plugin.openedCb?.({ type: "reminder", noteId: "n2", at: null });
    await flush();
    expect(t.opened).toEqual(["n1", "n2"]);
    expect(t.notifier.replan).toHaveBeenCalledTimes(2);
  });

  it("an offline sync still re-plans", async () => {
    const t = setup();
    await t.push.start();
    t.sync.syncNow.mockRejectedValueOnce(new Error("offline"));
    t.plugin.messageCb?.({ type: "reminder", noteId: "n1", at: null, title: null, body: null });
    await flush();
    expect(t.notifier.replan).toHaveBeenCalledWith("sync");
  });

  it("no launch data: nothing is opened", async () => {
    const t = setup();
    await t.push.start();
    expect(t.opened).toEqual([]);
    expect(t.sync.syncNow).not.toHaveBeenCalled();
  });
});

describe("payload parsing and errors", () => {
  it("parses plugin payloads defensively", () => {
    expect(parsePushData({ type: "reminder", noteId: "n", at: "x", url: "/notes/n" })).toEqual({ type: "reminder", noteId: "n", at: "x" });
    expect(parsePushData({ noteId: 5 })).toEqual({ type: null, noteId: null, at: null });
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData("x")).toBeNull();
    expect(parsePushMessage({ type: "test", title: "T", body: "" })).toEqual({ type: "test", noteId: null, at: null, title: "T", body: null });
  });

  it("maps Kotlin rejections", () => {
    expect(toPushError({ code: "NOT_CONFIGURED", message: "m" }).code).toBe("NOT_CONFIGURED");
    expect(toPushError("NOT_CONFIGURED: Firebase").code).toBe("NOT_CONFIGURED");
    expect(toPushError({ code: "UNAVAILABLE" }).code).toBe("UNAVAILABLE");
    expect(toPushError(new Error("Command get_token not found")).code).toBe("UNAVAILABLE");
  });
});
