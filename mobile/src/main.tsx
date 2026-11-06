/**
 * Entry point of the native shell (Tauri 2 Mobile, PLAN_V3_SYNC §10). Same UI, data layer
 * and sync engine as the PWA (src/web/main.tsx), but:
 * - no service worker, no PWA plugin, no install prompt;
 * - HTTP through @tauri-apps/plugin-http with `Authorization: Bearer` (scope limited to
 *   BUDDY_PUBLIC_URL/api/v1/* by the Rust side), token in the keychain/keystore;
 * - local planning of every reminder (src/web/notify/native.ts), re-planned at start,
 *   after each sync, after local changes and on resume;
 * - Android only: native push over FCM (src/web/notify/native-push.ts, plugin
 *   mobile/plugins/buddy-push) wakes the app for reminders it has not planned yet.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { deviceZone } from "../../src/lib/zoned";
import "../../src/styles/base.css";
import { openDataStore, syncAccess } from "../../src/web/data";
import { createStorageController } from "../../src/web/notify/install";
import { createNativeNotifier, followSync } from "../../src/web/notify/native";
import { notificationId } from "../../src/web/notify/native-plan";
import { createTauriNotificationPlugin } from "../../src/web/notify/native-plugin";
import { createNativePush } from "../../src/web/notify/native-push";
import { createTauriPushPlugin } from "../../src/web/notify/native-push-plugin";
import {
  createLocalPrefs,
  createShellTokens,
  loadShellConfig,
  newUuid,
  shellDeviceName,
  type Invoke,
} from "../../src/web/notify/native-shell";
import { createNativeHttp, createSyncEngine } from "../../src/web/sync";
import { App, browserHistory, type Services } from "../../src/web/ui";

/** Must match RESUMED_EVENT in mobile/src-tauri/src/lib.rs. */
const RESUMED_EVENT = "buddy://resumed";

function Message({ text }: { text: string }) {
  return (
    <main style={{ padding: 16 }} role="alert">
      <p>{text}</p>
    </main>
  );
}

function Root({ services, onNavigator }: { services: Services; onNavigator(nav: (p: string) => void): void }) {
  const history = useRef(browserHistory()).current;
  return <App services={services} history={history} update={null} onNavigatorReady={onNavigator} />;
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

async function boot() {
  const root = createRoot(document.getElementById("root") as HTMLElement);
  const call = invoke as Invoke;
  const config = await loadShellConfig(call).catch(() => null);
  if (!config) {
    root.render(<Message text="Display Buddy konnte nicht starten (Verbindung zur App-Hülle fehlt)." />);
    return;
  }
  if (!config.serverUrl) {
    root.render(
      <Message text="Diese App wurde ohne Server-Adresse gebaut. Bitte beim Bauen BUDDY_PUBLIC_URL setzen (siehe mobile/README.md)." />,
    );
    return;
  }
  let store;
  try {
    store = await openDataStore();
  } catch {
    root.render(<Message text="Display Buddy kann auf diesem Gerät keine Daten speichern (IndexedDB nicht verfügbar)." />);
    return;
  }

  const http = createNativeHttp({
    baseUrl: config.serverUrl,
    tokens: createShellTokens(call),
    fetch: tauriFetch as typeof fetch,
  });
  let navigate: ((path: string) => void) | null = null;
  let pendingOpen: string | null = null;
  // created below; the notifier asks it to report a new deviceState (§10.3)
  let sync: ReturnType<typeof createSyncEngine> | null = null;
  const notificationPlugin = createTauriNotificationPlugin();
  const openNote = (id: string) => {
    const path = `/notes/${encodeURIComponent(id)}`;
    if (navigate) navigate(path);
    else pendingOpen = path;
  };
  const notifier = createNativeNotifier({
    store,
    getCursor: () => syncAccess(store).getCursor(),
    plugin: notificationPlugin,
    deviceZone,
    prefs: createLocalPrefs(localStore()),
    onDeviceState: () => sync?.requestSync("change"),
    onOpenNote: openNote,
    log: (m) => console.info(`[buddy-native] ${m}`),
  });
  sync = createSyncEngine({ store, http, deviceState: () => notifier.deviceState() });
  followSync(notifier, sync);

  // resume: Rust event (Android onResume / iOS willEnterForeground) + visibilitychange
  const onResume = () => {
    void notifier.replan("resume");
    sync?.requestSync("visible");
  };
  void listen(RESUMED_EVENT, onResume).catch(() => undefined);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void notifier.replan("resume");
  });
  void notifier.start();

  // Native push (PLAN §10.5, D-55): Android only; iOS relies on the local planning.
  if (config.platform === "android") {
    const push = createNativePush({
      plugin: createTauriPushPlugin(),
      http,
      store,
      sync,
      notifier,
      // FCM does not display notifications of a foreground app: show the reminder now,
      // with the same id and buttons as the local plan would have used.
      showNow: async (m) => {
        const id = m.noteId && m.at ? notificationId(m.noteId, m.at) : null;
        if (id === null || !m.noteId || !m.at) return;
        await notificationPlugin.schedule({
          id,
          title: m.title ?? "Erinnerung",
          body: m.body ?? "",
          atMs: null,
          actions: true,
          extra: { noteId: m.noteId, at: m.at },
        });
      },
      onOpenNote: openNote,
      log: (m) => console.info(`[buddy-native] ${m}`),
    });
    void push.start();
  }

  const services: Services = {
    store,
    sync,
    notifier,
    install: null,
    storage: createStorageController(navigator.storage),
    deviceZone,
    newId: () => newUuid(),
    defaultDeviceName: () => shellDeviceName(config.platform),
  };
  root.render(
    <StrictMode>
      <Root
        services={services}
        onNavigator={(nav) => {
          navigate = nav;
          if (pendingOpen) {
            nav(pendingOpen);
            pendingOpen = null;
          }
        }}
      />
    </StrictMode>,
  );
}

void boot();
