/// <reference types="vite-plugin-pwa/react" />
/**
 * Entry point of the PWA (web.html → dist-web/index.html). Wires the platform
 * pieces – data layer, sync engine, Web Push notifier, install prompt, service
 * worker update – into the shared UI. The native shell (phase N1) has its own entry
 * with other adapters and no service worker.
 */
import { StrictMode, useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useRegisterSW } from "virtual:pwa-register/react";
import { deviceZone } from "../lib/zoned";
import "../styles/base.css";
import { openDataStore, requestPersistentStorage } from "./data";
import { createInstallController, createStorageController } from "./notify/install";
import { currentPlatform, suggestDeviceName } from "./notify/platform";
import type { OpenMessage } from "./notify/swHandlers";
import type { StorageController } from "./notify/types";
import { createBrowserNotifier } from "./notify/web";
import { createSyncEngine, createWebHttp } from "./sync";
import { App, browserHistory, type Services, type UpdateState } from "./ui";

/** Re-checks for a new service worker every hour (vite-pwa „Periodic SW Updates“). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

function Root({ services }: { services: Services }) {
  const history = useMemo(() => browserHistory(), []);
  const navigateRef = useRef<((path: string) => void) | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update().catch(() => undefined), UPDATE_CHECK_MS);
    },
    onRegisterError() {
      // offline start without a worker is fine; the app still runs from IndexedDB
    },
  });
  const update = useMemo<UpdateState>(
    () => ({
      needRefresh,
      update: () => updateServiceWorker(true),
      dismiss: () => setNeedRefresh(false),
    }),
    [needRefresh, updateServiceWorker, setNeedRefresh],
  );

  // notificationclick in the worker → route an open window to the note
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as Partial<OpenMessage> | null;
      if (msg?.type === "buddy-open" && typeof msg.url === "string" && msg.url.startsWith("/")) {
        navigateRef.current?.(msg.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return (
    <App
      services={services}
      history={history}
      update={update}
      onNavigatorReady={(nav) => {
        navigateRef.current = nav;
      }}
    />
  );
}

/** persist() through the data layer's helper (checks persisted() first, never throws). */
function withPersist(c: StorageController | null): StorageController | null {
  return c ? { ...c, persist: requestPersistentStorage } : null;
}

async function boot() {
  const root = createRoot(document.getElementById("root") as HTMLElement);
  let store;
  try {
    store = await openDataStore();
  } catch {
    root.render(
      <p style={{ padding: 16 }}>
        Display Buddy kann hier keine Daten speichern. Bitte den privaten Modus verlassen oder einen anderen Browser
        verwenden.
      </p>,
    );
    return;
  }
  const http = createWebHttp();
  const sync = createSyncEngine({ store, http });
  const services: Services = {
    store,
    sync,
    notifier: createBrowserNotifier(http),
    install: createInstallController({ platform: currentPlatform, target: window }),
    storage: withPersist(createStorageController(navigator.storage)),
    deviceZone,
    newId: () => crypto.randomUUID(),
    defaultDeviceName: () => suggestDeviceName(currentPlatform()),
  };
  root.render(
    <StrictMode>
      <Root services={services} />
    </StrictMode>,
  );
}

void boot();
