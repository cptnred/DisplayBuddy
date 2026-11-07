/**
 * Background sync of the Android shell without Firebase (D-107). A native alarm-driven sync
 * (mobile/plugins/buddy-push, `BackgroundScheduler`) needs the server address and the device
 * token once; from then on it fetches new and changed reminders by itself and plans them as
 * local alarms, even if the app is closed or in the background.
 *
 * - signed in → hand over address and token (every app start, after a login);
 * - signed out → the sync forgets the account and stops;
 * - once, after the notification permission was granted: the system dialog „Akku-Optimierung
 *   ignorieren“, because Doze blocks the network of every other app.
 *
 * No platform globals: plugin, store, token provider and storage are injected. The token
 * never reaches logs or the DOM.
 */
import type { DataStore, TokenProvider } from "../contract";
import type { NativeNotifier } from "./native";

export interface BackgroundState {
  configured: boolean;
  batteryUnrestricted: boolean;
}

/** The `buddy-push` plugin, adapter in native-push-plugin.ts. */
export interface BackgroundPlugin {
  start(config: { baseUrl: string; token: string }): Promise<void>;
  stop(): Promise<void>;
  state(): Promise<BackgroundState>;
  requestBatteryExemption(): Promise<void>;
}

export interface BackgroundSyncDeps {
  plugin: BackgroundPlugin;
  tokens: Pick<TokenProvider, "getToken">;
  store: Pick<DataStore, "getAccount" | "subscribe">;
  notifier: Pick<NativeNotifier, "status">;
  baseUrl: string;
  /** Device storage for „already asked for the battery exemption“. */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  log?(message: string): void;
}

export interface BackgroundSync {
  start(): Promise<void>;
  stop(): void;
  /** Re-checks account and permissions now (coalesced); call on resume. */
  ensure(): Promise<void>;
}

export const BATTERY_ASKED_KEY = "buddy.native.batteryAsked";

export function createBackgroundSync(deps: BackgroundSyncDeps): BackgroundSync {
  const { plugin, tokens, store, notifier } = deps;
  const log = deps.log ?? (() => undefined);
  let running: Promise<void> | null = null;
  let again = false;
  let handedOver: string | null = null;
  const cleanups: (() => void)[] = [];

  function asked(): boolean {
    try {
      return deps.storage?.getItem(BATTERY_ASKED_KEY) === "1";
    } catch {
      return true;
    }
  }

  function markAsked(): void {
    try {
      deps.storage?.setItem(BATTERY_ASKED_KEY, "1");
    } catch {
      // asked again next time (storage blocked)
    }
  }

  async function once(): Promise<void> {
    let account;
    try {
      account = await store.getAccount();
    } catch {
      account = null;
    }
    if (!account) {
      if (handedOver !== null) {
        handedOver = null;
        await plugin.stop().catch(() => undefined);
        log("background sync: stopped (signed out)");
      }
      return;
    }
    const token = await tokens.getToken();
    if (!token) return;
    const key = `${account.deviceId}|${deps.baseUrl}`;
    // the native side forgets the account on 401/403 or if its Keystore entry is unreadable
    if (handedOver === key && (await plugin.state().catch(() => null))?.configured === false) handedOver = null;
    if (handedOver !== key) {
      try {
        await plugin.start({ baseUrl: deps.baseUrl, token });
        handedOver = key;
        log("background sync: started");
      } catch {
        log("background sync: could not be started");
        return;
      }
    }
    // never together with the notification permission dialog: only once it is granted
    if (!asked() && (await notifier.status().catch(() => null))?.state === "enabled") {
      const state = await plugin.state().catch(() => null);
      if (state && !state.batteryUnrestricted) {
        markAsked();
        await plugin.requestBatteryExemption().catch(() => undefined);
        log("background sync: asked for the battery exemption");
      }
    }
  }

  function ensure(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    const run = (async () => {
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  return {
    async start() {
      if (cleanups.length === 0) {
        cleanups.push(
          store.subscribe((c) => {
            if (c.kind === "account" || c.kind === "all") void ensure();
          }),
        );
      }
      await ensure();
    },
    stop() {
      for (const c of cleanups.splice(0)) c();
    },
    ensure,
  };
}
