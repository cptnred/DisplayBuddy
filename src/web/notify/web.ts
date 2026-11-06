/**
 * PWA notifier: Web Push subscription + app badge (PLAN_V3_SYNC §9.4).
 *
 * Sources: MDN Push API / PushManager.subscribe / Notification.requestPermission,
 * Apple „Sending web push notifications in web apps and browsers“ (permission only
 * after a user gesture, home-screen apps only on iOS ≥ 16.4, no pushsubscriptionchange
 * on iOS → reconcile at every start), mdn/browser-compat-data (setAppBadge: Safari iOS
 * 16.4, not Chrome Android → feature check; getNotifications: Chrome Android 40, iOS 16.4).
 *
 * Every browser global is injected (`WebNotifierDeps`), so tests run with mocks and
 * the UI never touches them.
 */
import type { PushSubscriptionJson, VapidPublicKey } from "../../lib/sync/types";
import type { Reminder } from "../../types";
import type { HttpAdapter } from "../contract";
import { base64UrlToBytes, currentPlatform, isIos, isStandalone, sameBytes, type PlatformInfo } from "./platform";
import { closeResolved, type SwRegistration } from "./swHandlers";
import type { Notifier, NotifierStatus } from "./types";

/**
 * Paths of the web push endpoints of §6, relative to API_BASE (the HttpAdapter of
 * src/web/sync/http.ts prepends `/api/v1` and adds cookie + X-Buddy-Request).
 */
export const PUSH_PATHS = {
  vapidKey: "/push/vapid-public-key",
  subscription: "/push/subscription",
  test: "/push/test",
} as const;

/** localStorage key: the user turned notifications on in this browser (per-device convenience). */
export const WANTED_KEY = "buddy.push.wanted";

export interface SubscriptionLike {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  expirationTime?: number | null;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<SubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>;
}

export interface PushRegistrationLike extends SwRegistration {
  pushManager?: PushManagerLike;
}

export interface NotificationLike {
  readonly permission: NotificationPermission;
  requestPermission(cb?: (p: NotificationPermission) => void): Promise<NotificationPermission> | void;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface WebNotifierDeps {
  http: HttpAdapter;
  platform: () => PlatformInfo;
  /** Resolves to the active service worker registration (navigator.serviceWorker.ready); null without SW. */
  registration: () => Promise<PushRegistrationLike | null>;
  /** `Notification` constructor (static API) or null if missing. */
  notification: NotificationLike | null;
  /** True if `PushManager` exists in this context. */
  hasPushManager: boolean;
  storage: KeyValue;
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  origin: string;
}

function subscriptionJson(sub: SubscriptionLike): PushSubscriptionJson {
  const j = sub.toJSON();
  return {
    endpoint: j.endpoint ?? sub.endpoint,
    keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" },
  };
}

/** Calls requestPermission for both the promise and the old callback form (Safari). */
function requestPermission(n: NotificationLike): Promise<NotificationPermission> {
  return new Promise((resolve, reject) => {
    try {
      const r = n.requestPermission(resolve);
      if (r && typeof (r as Promise<NotificationPermission>).then === "function") {
        (r as Promise<NotificationPermission>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

const ok = (status: number) => status >= 200 && status < 300;

export function createWebNotifier(deps: WebNotifierDeps): Notifier {
  let keyPromise: Promise<Uint8Array<ArrayBuffer>> | null = null;
  let lastError: string | null = null;

  const wanted = () => deps.storage.get(WANTED_KEY) === "1";
  const setWanted = (v: boolean) => deps.storage.set(WANTED_KEY, v ? "1" : null);

  /** Prefetched so that subscribe() can follow requestPermission() without extra round trips. */
  const vapidKey = () => {
    if (!keyPromise) {
      keyPromise = deps.http.request<VapidPublicKey>("GET", PUSH_PATHS.vapidKey).then((res) => {
        if (!ok(res.status) || !res.body?.key) throw new Error(`vapid key: HTTP ${res.status}`);
        return base64UrlToBytes(res.body.key);
      });
      keyPromise.catch(() => {
        keyPromise = null;
      });
    }
    return keyPromise;
  };

  const baseState = (): NotifierStatus | null => {
    const p = deps.platform();
    if (isIos(p) && !isStandalone(p)) return { state: "needsInstall" };
    if (!deps.notification || !deps.hasPushManager) return { state: "unsupported" };
    if (deps.notification.permission === "denied") return { state: "denied" };
    return null;
  };

  const register = async (sub: SubscriptionLike) => {
    const res = await deps.http.request<null>("PUT", PUSH_PATHS.subscription, subscriptionJson(sub));
    if (!ok(res.status)) throw new Error(`subscription: HTTP ${res.status}`);
  };

  /** Existing subscription with the current server key, or a new one. */
  const ensureSubscription = async (reg: PushRegistrationLike, key: Uint8Array<ArrayBuffer>) => {
    const pm = reg.pushManager;
    if (!pm) throw new Error("no PushManager on the registration");
    let sub = await pm.getSubscription();
    const keyKnown = sub?.options?.applicationServerKey;
    if (sub && keyKnown && !sameBytes(keyKnown, key)) {
      // server key rotated → the old subscription can no longer receive our pushes
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return sub;
  };

  const notifier: Notifier = {
    kind: "pwa",

    async status() {
      const base = baseState();
      if (base) return base;
      if (lastError) return { state: "error", message: lastError };
      if (deps.notification?.permission === "granted" && wanted()) {
        const reg = await deps.registration();
        const sub = await reg?.pushManager?.getSubscription();
        if (sub) return { state: "enabled" };
      }
      // warm up the key for a quick enable() inside the next click
      vapidKey().catch(() => undefined);
      return { state: "available" };
    },

    enable() {
      const base = baseState();
      if (base && base.state !== "denied") return Promise.resolve(base);
      const n = deps.notification as NotificationLike;
      // Synchronously inside the click handler (user gesture): permission first.
      const permission = n.permission === "granted" ? Promise.resolve<NotificationPermission>("granted") : requestPermission(n);
      const key = vapidKey();
      key.catch(() => undefined);
      return (async (): Promise<NotifierStatus> => {
        try {
          const p = await permission;
          if (p === "denied") return { state: "denied" };
          if (p !== "granted") return { state: "available" };
          const reg = await deps.registration();
          if (!reg) return { state: "unsupported" };
          const sub = await ensureSubscription(reg, await key);
          await register(sub);
          setWanted(true);
          lastError = null;
          return { state: "enabled" };
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          return { state: "error", message: lastError };
        }
      })();
    },

    async disable() {
      setWanted(false);
      lastError = null;
      try {
        const reg = await deps.registration();
        const sub = await reg?.pushManager?.getSubscription();
        if (sub) {
          await deps.http.request<null>("DELETE", PUSH_PATHS.subscription, { endpoint: sub.endpoint });
          await sub.unsubscribe();
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        return { state: "error", message: lastError };
      }
      return baseState() ?? { state: "available" };
    },

    async test() {
      const res = await deps.http.request<null>("POST", PUSH_PATHS.test);
      if (!ok(res.status)) throw new Error(`test: HTTP ${res.status}`);
    },

    async reconcile() {
      const base = baseState();
      if (base) return base;
      if (!wanted() || deps.notification?.permission !== "granted") return { state: "available" };
      try {
        const reg = await deps.registration();
        if (!reg) return { state: "unsupported" };
        const sub = await ensureSubscription(reg, await vapidKey());
        await register(sub);
        lastError = null;
        return { state: "enabled" };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        return { state: "error", message: lastError };
      }
    },

    async syncDue(reminders: readonly Reminder[], noteIds: readonly string[]) {
      const due = reminders.filter((r) => r.state === "due").length;
      try {
        if (due > 0) await deps.setAppBadge?.(due);
        else if (deps.clearAppBadge) await deps.clearAppBadge();
        else await deps.setAppBadge?.(0);
      } catch {
        /* badge is optional (not installed, not permitted) */
      }
      try {
        const reg = await deps.registration();
        if (reg) await closeResolved(reg, reminders, new Set(noteIds), deps.origin);
      } catch {
        /* optional */
      }
    },
  };
  return notifier;
}

/** Wires the notifier to the running browser (page context; used by main.tsx). */
export function createBrowserNotifier(http: HttpAdapter): Notifier {
  const nav = globalThis.navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  const hasSw = !!nav && "serviceWorker" in nav;
  return createWebNotifier({
    http,
    platform: currentPlatform,
    registration: async () =>
      hasSw ? ((await nav.serviceWorker.ready) as unknown as PushRegistrationLike) : null,
    notification: typeof Notification === "undefined" ? null : (Notification as unknown as NotificationLike),
    hasPushManager: typeof (globalThis as { PushManager?: unknown }).PushManager !== "undefined",
    storage: {
      get: (k) => {
        try {
          return globalThis.localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          if (v === null) globalThis.localStorage.removeItem(k);
          else globalThis.localStorage.setItem(k, v);
        } catch {
          /* private mode */
        }
      },
    },
    setAppBadge: nav?.setAppBadge ? (n) => nav.setAppBadge!(n) : undefined,
    clearAppBadge: nav?.clearAppBadge ? () => nav.clearAppBadge!() : undefined,
    origin: globalThis.location.origin,
  });
}
