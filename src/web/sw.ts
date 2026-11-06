/// <reference lib="webworker" />
/**
 * Service worker of the PWA (PLAN_V3_SYNC §9.1, §9.4), built by vite-plugin-pwa with
 * `strategies: 'injectManifest'` (vite-pwa docs „Advanced (injectManifest)“,
 * „Prompt for update“). The push/click logic lives in ./notify/swHandlers.ts (tested
 * as a unit); this file only wires it to `self`.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clock } from "../lib/clock";
import { deviceZone } from "../lib/zoned";
import type { DataStore } from "./contract";
import { openDataStore } from "./data";
import { handleNotificationClick, handlePush, type SwDeps } from "./notify/swHandlers";
import { BACKGROUND_SYNC_TAG, createSyncEngine, createWebHttp } from "./sync";

declare let self: ServiceWorkerGlobalScope;

// App shell: precache the build, drop caches of older builds.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// SPA navigation fallback to the precached index.html – never for the API.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }));

// registerType 'prompt': the page asks us to activate the waiting worker.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

let storePromise: Promise<DataStore> | null = null;
function openStore(): Promise<DataStore> {
  if (!storePromise) {
    storePromise = openDataStore().catch((e: unknown) => {
      storePromise = null;
      throw e;
    });
  }
  return storePromise;
}

const workerNavigator = self.navigator as WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void> };

const deps: SwDeps = {
  registration: self.registration as unknown as SwDeps["registration"],
  clients: self.clients as unknown as SwDeps["clients"],
  openStore,
  sync: (store) => createSyncEngine({ store, http: createWebHttp() }).syncNow(),
  deviceZone,
  maxActions: () => {
    const n = (globalThis as { Notification?: { maxActions?: number } }).Notification;
    return typeof n?.maxActions === "number" ? n.maxActions : 0;
  },
  now: () => clock.correctedNow(),
  origin: self.location.origin,
  setBadge: typeof workerNavigator.setAppBadge === "function" ? (n) => workerNavigator.setAppBadge!(n) : undefined,
};

self.addEventListener("push", (event) => {
  let data: unknown = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null; // non-JSON payload → generic notification (never invisible)
  }
  event.waitUntil(handlePush(data, deps));
});

// Chromium/Firefox only (browser-compat-data: not on Safari iOS).
self.addEventListener("notificationclick", (event) => {
  event.waitUntil(handleNotificationClick(event.notification, event.action, deps));
});

// Background Sync (Chromium only, optional): the engine registers BACKGROUND_SYNC_TAG
// when it is offline with pending changes; push the outbox once the network is back.
interface SyncEventLike extends ExtendableEvent {
  readonly tag: string;
}
self.addEventListener("sync" as keyof ServiceWorkerGlobalScopeEventMap, (event) => {
  const e = event as unknown as SyncEventLike;
  if (e.tag !== BACKGROUND_SYNC_TAG) return;
  e.waitUntil(openStore().then((store) => deps.sync(store)));
});
