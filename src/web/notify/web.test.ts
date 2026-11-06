import { describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../types";
import { createFakeHttp } from "../ui/testing/fakeSync";
import type { PlatformInfo } from "./platform";
import { base64UrlToBytes, isIos, isStandalone, suggestDeviceName } from "./platform";
import {
  createWebNotifier,
  PUSH_PATHS,
  WANTED_KEY,
  type NotificationLike,
  type PushRegistrationLike,
  type SubscriptionLike,
  type WebNotifierDeps,
} from "./web";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const ANDROID: PlatformInfo = {
  userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36",
  displayStandalone: false,
};
const IPHONE_TAB: PlatformInfo = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
  displayStandalone: false,
  iosStandalone: false,
};

function makeSub(key: Uint8Array, endpoint = "https://push.example/abc"): SubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    endpoint,
    options: { applicationServerKey: key.buffer as ArrayBuffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setup(opts: { platform?: PlatformInfo; permission?: NotificationPermission; answer?: NotificationPermission; sub?: SubscriptionLike | null } = {}) {
  const http = createFakeHttp();
  http.route("GET", PUSH_PATHS.vapidKey, () => ({ status: 200, body: { key: KEY } }));
  http.route("PUT", PUSH_PATHS.subscription, () => ({ status: 204 }));
  http.route("DELETE", PUSH_PATHS.subscription, () => ({ status: 204 }));
  http.route("POST", PUSH_PATHS.test, () => ({ status: 204 }));
  const state = { permission: opts.permission ?? ("default" as NotificationPermission), sub: opts.sub ?? null };
  const calls: string[] = [];
  const notification: NotificationLike = {
    get permission() {
      return state.permission;
    },
    requestPermission: vi.fn(() => {
      calls.push("requestPermission");
      state.permission = opts.answer ?? "granted";
      return Promise.resolve(state.permission);
    }),
  };
  const registration: PushRegistrationLike = {
    showNotification: vi.fn(),
    getNotifications: vi.fn(async () => []),
    pushManager: {
      getSubscription: vi.fn(async () => state.sub),
      subscribe: vi.fn(async (o) => {
        calls.push(`subscribe:${o.userVisibleOnly}`);
        state.sub = makeSub(o.applicationServerKey);
        return state.sub;
      }),
    },
  };
  const store = new Map<string, string>();
  const deps: WebNotifierDeps = {
    http,
    platform: () => opts.platform ?? ANDROID,
    registration: async () => registration,
    notification,
    hasPushManager: true,
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => (v === null ? store.delete(k) : store.set(k, v)) },
    setAppBadge: vi.fn(async () => undefined),
    clearAppBadge: vi.fn(async () => undefined),
    origin: "https://buddy.test",
  };
  return { notifier: createWebNotifier(deps), http, state, calls, registration, deps, store };
}

describe("platform", () => {
  it("detects iOS (incl. iPadOS desktop UA) and standalone mode", () => {
    expect(isIos(IPHONE_TAB)).toBe(true);
    expect(isIos({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605", platform: "MacIntel", maxTouchPoints: 5, displayStandalone: false })).toBe(true);
    expect(isIos(ANDROID)).toBe(false);
    expect(isStandalone({ ...IPHONE_TAB, iosStandalone: true })).toBe(true);
    expect(suggestDeviceName(IPHONE_TAB)).toBe("iPhone (Safari)");
    expect(suggestDeviceName(ANDROID)).toBe("Android (Chrome)");
  });

  it("decodes the base64url VAPID key to a 65-byte P-256 point", () => {
    const b = base64UrlToBytes(KEY);
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
  });
});

describe("web notifier", () => {
  it("asks for permission synchronously inside the click, then subscribes and registers", async () => {
    const { notifier, calls, http, store } = setup();
    await notifier.status(); // warms up the key
    const p = notifier.enable();
    // the permission prompt happened before the first await (user gesture)
    expect(calls).toEqual(["requestPermission"]);
    expect(await p).toEqual({ state: "enabled" });
    expect(calls).toEqual(["requestPermission", "subscribe:true"]);
    expect(http.requests.find((r) => r.method === "PUT")).toEqual({
      method: "PUT",
      path: "/api/v1/push/subscription",
      body: { endpoint: "https://push.example/abc", keys: { p256dh: "p256", auth: "auth" } },
    });
    expect(store.get(WANTED_KEY)).toBe("1");
    expect(await notifier.status()).toEqual({ state: "enabled" });
  });

  it("reports denied permission", async () => {
    const { notifier } = setup({ answer: "denied" });
    expect(await notifier.enable()).toEqual({ state: "denied" });
    expect(await notifier.status()).toEqual({ state: "denied" });
  });

  it("tells iOS Safari tabs to add the app to the home screen first", async () => {
    const { notifier, calls } = setup({ platform: IPHONE_TAB });
    expect(await notifier.status()).toEqual({ state: "needsInstall" });
    expect(await notifier.enable()).toEqual({ state: "needsInstall" });
    expect(calls).toEqual([]);
  });

  it("is unsupported without Notification/PushManager", async () => {
    const { deps } = setup();
    const n = createWebNotifier({ ...deps, notification: null });
    expect(await n.status()).toEqual({ state: "unsupported" });
  });

  it("reconciles at start: re-subscribes a lost subscription (iOS has no pushsubscriptionchange)", async () => {
    const { notifier, state, calls, http, store } = setup({ permission: "granted" });
    store.set(WANTED_KEY, "1");
    state.sub = null;
    expect(await notifier.reconcile()).toEqual({ state: "enabled" });
    expect(calls).toEqual(["subscribe:true"]);
    expect(http.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("reconcile re-registers an existing subscription and replaces one with a rotated key", async () => {
    const old = makeSub(new Uint8Array(65).fill(7), "https://push.example/old");
    const { notifier, store, calls, http } = setup({ permission: "granted", sub: old });
    store.set(WANTED_KEY, "1");
    expect(await notifier.reconcile()).toEqual({ state: "enabled" });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(calls).toEqual(["subscribe:true"]);
    expect(http.requests.at(-1)?.body).toMatchObject({ endpoint: "https://push.example/abc" });
  });

  it("reconcile does nothing when the user never enabled notifications", async () => {
    const { notifier, http } = setup({ permission: "granted" });
    expect(await notifier.reconcile()).toEqual({ state: "available" });
    expect(http.requests).toEqual([]);
  });

  it("disable unsubscribes and deletes the server registration", async () => {
    const sub = makeSub(base64UrlToBytes(KEY));
    const { notifier, http, store } = setup({ permission: "granted", sub });
    store.set(WANTED_KEY, "1");
    expect(await notifier.disable()).toEqual({ state: "available" });
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(http.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/api/v1/push/subscription",
      body: { endpoint: "https://push.example/abc" },
    });
    expect(store.has(WANTED_KEY)).toBe(false);
  });

  it("sends a test notification and reports server errors", async () => {
    const { notifier, http } = setup({ permission: "granted" });
    await notifier.test();
    expect(http.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/push/test" });
    http.route("POST", PUSH_PATHS.test, () => ({ status: 500 }));
    await expect(notifier.test()).rejects.toThrow();
  });

  it("returns an error state when the server rejects the subscription", async () => {
    const { notifier, http } = setup();
    http.route("PUT", PUSH_PATHS.subscription, () => ({ status: 401 }));
    expect((await notifier.enable()).state).toBe("error");
  });

  it("syncDue sets the badge to the number of due reminders and clears it", async () => {
    const { notifier, deps } = setup({ permission: "granted" });
    const r = (noteId: string, state: Reminder["state"]): Reminder => ({
      noteId,
      at: "2026-11-11T08:00:00.000Z",
      repeat: "none",
      state,
      firedAt: null,
      updatedAt: null,
      timeZone: "UTC",
    });
    await notifier.syncDue([r("a", "due"), r("b", "due"), r("c", "scheduled")], ["a", "b", "c"]);
    expect(deps.setAppBadge).toHaveBeenCalledWith(2);
    await notifier.syncDue([r("c", "scheduled")], ["c"]);
    expect(deps.clearAppBadge).toHaveBeenCalled();
  });
});
