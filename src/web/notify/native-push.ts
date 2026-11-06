/**
 * Native push of the Android shell (PLAN_V3_SYNC §10.5, §7.4; D-55: Android/FCM only,
 * iOS relies on local planning).
 *
 * - Registers the FCM token with `PUT /devices/current/push` whenever an account is
 *   signed in: once per app start, after a login, when FCM rotates the token, and again
 *   after the next successful sync if the server could not be reached.
 * - A push only wakes the app. In the foreground (`message` event) it shows the reminder
 *   at once (the system does not display FCM notifications of a foreground app), then
 *   syncs and re-plans (`notifier.replan("sync")`). A tap on the system notification
 *   (`opened` / launch data) opens the note, syncs and re-plans.
 * - The server only pushes occurrences the device has not planned yet (deviceState
 *   `scheduledSeq`, D-48), so a push never duplicates a local notification.
 *
 * No platform globals: plugin, HTTP adapter, store, sync engine and notifier are injected
 * (tests use fakes). The token never reaches logs or the DOM.
 */
import type { DataStore, HttpAdapter, SyncEngine } from "../contract";
import type { NativeNotifier } from "./native";

/** Data fields of an FCM message (server/src/push/native_fcm.rs, `fcm_message`). */
export interface PushData {
  type: string | null;
  noteId: string | null;
  at: string | null;
}

export interface PushMessage extends PushData {
  title: string | null;
  body: string | null;
}

export type PushErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE";

export class PushPluginError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushPluginError";
  }
}

/** The `buddy-push` plugin (mobile/plugins/buddy-push), adapter in native-push-plugin.ts. */
export interface PushPlugin {
  /** FCM registration token; rejects with {@link PushPluginError}. */
  getToken(): Promise<string>;
  /** Data of the notification the app was started from (once), else null. */
  takeLaunchData(): Promise<PushData | null>;
  onToken(cb: (token: string) => void): Promise<() => void>;
  onMessage(cb: (m: PushMessage) => void): Promise<() => void>;
  onOpened(cb: (d: PushData) => void): Promise<() => void>;
}

/**
 * - `off`: signed out (nothing to register);
 * - `notConfigured`: the app was built without Firebase (google-services.json);
 * - `serverUnsupported`: the server has no FCM credentials (404);
 * - `pending`: not reached yet (offline / server error), retried after the next sync;
 * - `registered`: the server knows the current token.
 */
export type NativePushState = "off" | "notConfigured" | "serverUnsupported" | "pending" | "registered";

export interface NativePushDeps {
  plugin: PushPlugin;
  http: Pick<HttpAdapter, "request">;
  store: Pick<DataStore, "getAccount" | "subscribe">;
  sync: Pick<SyncEngine, "syncNow" | "onStatus" | "status">;
  notifier: Pick<NativeNotifier, "replan">;
  /** Shows a reminder push at once (foreground); the entry uses the notification plugin. */
  showNow?(m: PushMessage): Promise<void>;
  onOpenNote?(noteId: string): void;
  /** Diagnostics (never tokens or note content). */
  log?(message: string): void;
}

export interface NativePush {
  start(): Promise<void>;
  stop(): void;
  state(): NativePushState;
  /** Registers now if needed (coalesced). */
  ensureRegistered(): Promise<NativePushState>;
}

export const PUSH_PATH = "/devices/current/push";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Defensive parsing of plugin payloads (data of a message / tap). */
export function parsePushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return { type: str(o.type), noteId: str(o.noteId), at: str(o.at) };
}

export function parsePushMessage(raw: unknown): PushMessage | null {
  const d = parsePushData(raw);
  if (!d) return null;
  const o = raw as Record<string, unknown>;
  return { ...d, title: str(o.title), body: str(o.body) };
}

export function createNativePush(deps: NativePushDeps): NativePush {
  const { plugin, http, store, sync, notifier } = deps;
  const log = deps.log ?? (() => undefined);
  let state: NativePushState = "off";
  let token: string | null = null;
  /** `${deviceId}|${token}` the server confirmed in this process. */
  let registeredKey: string | null = null;
  let running: Promise<NativePushState> | null = null;
  let again = false;
  let started = false;
  const cleanups: (() => void)[] = [];

  async function registerOnce(): Promise<NativePushState> {
    let account;
    try {
      account = await store.getAccount();
    } catch {
      account = null;
    }
    if (!account) {
      registeredKey = null;
      return (state = "off");
    }
    if (state === "notConfigured") return state;
    if (!token) {
      try {
        token = await plugin.getToken();
      } catch (e) {
        if (e instanceof PushPluginError && e.code === "NOT_CONFIGURED") {
          log("push: app built without Firebase");
          return (state = "notConfigured");
        }
        log("push: no FCM token yet");
        return (state = "pending");
      }
    }
    const key = `${account.deviceId}|${token}`;
    if (key === registeredKey) return (state = "registered");
    let status: number;
    try {
      status = (await http.request("PUT", PUSH_PATH, { platform: "fcm", token })).status;
    } catch {
      log("push: server not reachable, retry after the next sync");
      return (state = "pending");
    }
    if (status >= 200 && status < 300) {
      registeredKey = key;
      log("push: token registered");
      return (state = "registered");
    }
    if (status === 404) {
      log("push: server has no FCM configuration");
      return (state = "serverUnsupported");
    }
    log(`push: registration failed (${status})`);
    return (state = "pending");
  }

  function ensureRegistered(): Promise<NativePushState> {
    if (running) {
      again = true;
      return running;
    }
    const run = (async () => {
      let result: NativePushState;
      do {
        again = false;
        result = await registerOnce();
      } while (again);
      return result;
    })().finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  async function wake(reason: string): Promise<void> {
    log(`push: wake (${reason})`);
    try {
      await sync.syncNow();
    } catch {
      // offline: the local plan stays; the next trigger syncs
    }
    await notifier.replan("sync");
  }

  function opened(d: PushData | null): Promise<void> {
    if (!d) return Promise.resolve();
    if (d.noteId) deps.onOpenNote?.(d.noteId);
    return wake("opened");
  }

  async function message(m: PushMessage): Promise<void> {
    if (m.type === "reminder" && deps.showNow) {
      try {
        await deps.showNow(m);
      } catch {
        log("push: showing the reminder failed");
      }
    }
    await wake("message");
  }

  return {
    async start() {
      if (started) return;
      started = true;
      const add = async (p: Promise<() => void>) => {
        try {
          cleanups.push(await p);
        } catch {
          log("push: listener not available");
        }
      };
      await add(
        plugin.onToken((t) => {
          if (!t || t === token) return;
          token = t;
          void ensureRegistered();
        }),
      );
      await add(plugin.onMessage((m) => void message(m)));
      await add(plugin.onOpened((d) => void opened(d)));
      cleanups.push(
        store.subscribe((c) => {
          if (c.kind === "account" || c.kind === "all") void ensureRegistered();
        }),
      );
      let last = sync.status().lastSyncAt;
      cleanups.push(
        sync.onStatus((s) => {
          if (s.state !== "idle" || !s.lastSyncAt || s.lastSyncAt === last) return;
          last = s.lastSyncAt;
          if (state === "pending" || state === "off") void ensureRegistered();
        }),
      );
      let launch: PushData | null = null;
      try {
        launch = await plugin.takeLaunchData();
      } catch {
        launch = null;
      }
      await ensureRegistered();
      await opened(launch);
    },
    stop() {
      for (const c of cleanups.splice(0)) c();
      started = false;
    },
    state: () => state,
    ensureRegistered,
  };
}
