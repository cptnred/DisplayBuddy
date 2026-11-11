/**
 * Entry point of the native shell (Tauri 2 Mobile, PLAN_V3_SYNC §10). Same UI, data layer
 * and sync engine as the PWA (src/web/main.tsx), but:
 * - no service worker, no PWA plugin, no install prompt;
 * - HTTP through @tauri-apps/plugin-http with `Authorization: Bearer` (scope limited to
 *   <effective origin>/api/v1/* by the Rust side), token in the keychain/keystore;
 * - v4 (PLAN_V4 §6.2, §6.5, §9.2): QR scanner (barcode-scanner plugin), server choice
 *   (server_get/server_set, reload afterwards), pending code of a confirmed foreign server
 *   kept across that reload for 3 minutes, no sync if the stored account belongs to another
 *   server than the effective origin;
 * - local planning of every reminder (src/web/notify/native.ts), re-planned at start,
 *   after each sync, after local changes and on resume;
 * - Android only: native push over FCM (src/web/notify/native-push.ts, plugin
 *   mobile/plugins/buddy-push) wakes the app for reminders it has not planned yet.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Format, cancel as cancelScan, requestPermissions as requestCamera, scan } from "@tauri-apps/plugin-barcode-scanner";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { deviceZone } from "../../src/lib/zoned";
import "../../src/styles/base.css";
import { openDataStore, syncAccess } from "../../src/web/data";
import { createStorageController } from "../../src/web/notify/install";
import { createNativeNotifier, followSync } from "../../src/web/notify/native";
import { createBackgroundSync } from "../../src/web/notify/native-background";
import { notificationId } from "../../src/web/notify/native-plan";
import { createTauriNotificationPlugin } from "../../src/web/notify/native-plugin";
import { createNativePush } from "../../src/web/notify/native-push";
import { createTauriBackgroundPlugin, createTauriPushPlugin } from "../../src/web/notify/native-push-plugin";
import { createNativeScanner } from "../../src/web/notify/native-scanner";
import {
  createLocalPrefs,
  createMismatchSync,
  createServerSelector,
  createShellTokens,
  expirePendingCode,
  loadShellConfig,
  newUuid,
  originMismatch,
  shellDeviceName,
  stampPendingCode,
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

function Root({
  services,
  onNavigator,
  hint,
}: {
  services: Services;
  onNavigator(nav: (p: string) => void): void;
  hint: string | null;
}) {
  const history = useRef(browserHistory()).current;
  return (
    <>
      {hint && (
        <p role="alert" style={{ margin: 0, padding: "12px 16px", background: "#fff3cd", color: "#3d2e00" }}>
          {hint}
        </p>
      )}
      <App services={services} history={history} update={null} onNavigatorReady={onNavigator} />
    </>
  );
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
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
    // shell_config always carries the build default or a validated server.json
    root.render(<Message text="Die Server-Adresse dieser App ist ungültig (siehe mobile/README.md)." />);
    return;
  }
  const serverUrl = config.serverUrl;
  // a code confirmed for another server survives the reload after server_set, but only briefly
  expirePendingCode(sessionStore(), Date.now());
  let store;
  try {
    store = await openDataStore();
  } catch {
    root.render(<Message text="Display Buddy kann auf diesem Gerät keine Daten speichern (IndexedDB nicht verfügbar)." />);
    return;
  }

  const tokens = createShellTokens(call);
  // PLAN_V4 §9.2: account of another server + token → no request may carry that token here
  const mismatch = originMismatch(
    await store.getAccount().catch(() => null),
    await tokens.getToken(),
    serverUrl,
  );
  const backgroundPlugin = config.platform === "android" ? createTauriBackgroundPlugin() : null;
  const http = createNativeHttp({
    baseUrl: serverUrl,
    tokens,
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
  sync = mismatch
    ? createMismatchSync(tokens)
    : createSyncEngine({ store, http, deviceState: () => notifier.deviceState() });
  const engine = sync;
  followSync(notifier, engine);
  if (mismatch) {
    console.info("[buddy-native] stored account belongs to another server: sync off until sign-out");
    void backgroundPlugin?.stop().catch(() => undefined);
    // after „Abmelden“ the local data is gone: start fresh against the effective origin
    store.subscribe((c) => {
      if (c.kind === "account" || c.kind === "all") {
        void store.getAccount().then(
          (a) => a === null && location.reload(),
          () => undefined,
        );
      }
    });
  }

  // resume: Rust event (Android onResume / iOS willEnterForeground) + visibilitychange
  const onResume = () => {
    void notifier.replan("resume");
    void background?.ensure();
    sync?.requestSync("visible");
  };
  void listen(RESUMED_EVENT, onResume).catch(() => undefined);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void notifier.replan("resume");
  });
  void notifier.start();

  // Background sync without Firebase (D-107): Android only; the Kotlin service plans new and
  // changed reminders by itself while the app is closed.
  const background =
    backgroundPlugin && !mismatch
      ? createBackgroundSync({
          plugin: backgroundPlugin,
          tokens,
          store,
          notifier,
          sync: engine,
          baseUrl: serverUrl,
          storage: localStore(),
          log: (m) => console.info(`[buddy-native] ${m}`),
        })
      : null;
  void background?.start();
  // Native push (PLAN §10.5, D-55): Android only; iOS relies on the local planning.
  if (config.platform === "android" && !mismatch) {
    const push = createNativePush({
      plugin: createTauriPushPlugin(),
      http,
      store,
      sync: engine,
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
    sync: engine,
    notifier,
    install: null,
    storage: createStorageController(navigator.storage),
    deviceZone,
    newId: () => newUuid(),
    defaultDeviceName: () => shellDeviceName(config.platform),
    scanner: createNativeScanner({
      plugin: { requestPermissions: requestCamera, scan, cancel: cancelScan },
      available: config.platform !== "desktop",
      qrFormat: Format.QRCode,
    }),
    server: createServerSelector(call, {
      tokens,
      stopBackground: async () => {
        await backgroundPlugin?.stop();
      },
      reload: () => {
        stampPendingCode(sessionStore(), Date.now());
        location.reload();
      },
    }),
  };
  root.render(
    <StrictMode>
      <Root
        services={services}
        hint={mismatch}
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
