/**
 * Platform pieces of the native shell besides the notifier (PLAN_V3_SYNC §10.2):
 * shell configuration, token provider over the shell's secure storage, device
 * preferences, id generation. Kept here (not in mobile/) so that Vitest covers them;
 * the entry point mobile/src/main.tsx only wires them together.
 *
 * The Tauri `invoke` is injected (tests pass a fake). Commands: `shell_config`,
 * `token_get`, `token_set`, `server_get`, `server_set` (mobile/src-tauri/src/lib.rs).
 */
import { PAIRING_TTL_MS, PLAIN_HTTP_HOSTS } from "../../lib/pairing";
import type { Account, ServerChoice, ServerSelector, SyncEngine, TokenProvider, WebSyncStatus } from "../contract";
import { PENDING_CODE_KEY, originHost, sameOrigin } from "../pairing/parse";
import type { NativePrefs } from "./native";

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface ShellConfig {
  /** Effective server origin (server.json before the build default), null if invalid. */
  serverUrl: string | null;
  platform: "android" | "ios" | "desktop";
}

/**
 * A normalised origin as `server_url::normalize` (Rust) returns it: `https://host[:port]`,
 * `http://` only for localhost/127.0.0.1/[::1]/10.0.2.2; no path, query, fragment or user
 * info (PLAN_V4 §7.2). The background sync gets nothing else (D-107 „Folgen für v4“).
 */
export function isServerOrigin(origin: string): boolean {
  const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(origin);
  return !!m && (m[1] === "https" || PLAIN_HTTP_HOSTS.includes(m[2]));
}

export async function loadShellConfig(invoke: Invoke): Promise<ShellConfig> {
  const raw = await invoke<Partial<ShellConfig>>("shell_config");
  const platform = raw.platform === "android" || raw.platform === "ios" ? raw.platform : "desktop";
  const url = typeof raw.serverUrl === "string" && isServerOrigin(raw.serverUrl) ? raw.serverUrl : null;
  return { serverUrl: url, platform };
}

/** Tauri rejects commands with the Rust error string; the UI matches `signed_in`/`invalid_url` in Error.message. */
function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === "string" ? e : String(e));
}

export interface ServerSelectorDeps {
  tokens: Pick<TokenProvider, "getToken">;
  /** stop_background_sync: the service must never keep an old origin (PLAN_V4 §7.2). */
  stopBackground(): Promise<void>;
  /** After a successful server_set: the scope changed, the app reloads (D-97). */
  reload(): void;
}

/** server_get / server_set of the shell (PLAN_V4 §6.5). */
export function createServerSelector(invoke: Invoke, deps: ServerSelectorDeps): ServerSelector {
  return {
    async current() {
      try {
        return await invoke<ServerChoice>("server_get");
      } catch (e) {
        throw asError(e);
      }
    },
    async set(origin) {
      // the token belongs to one server; Rust checks this again
      if (await deps.tokens.getToken()) throw new Error("signed_in");
      await deps.stopBackground().catch(() => undefined);
      try {
        await invoke("server_set", { origin });
      } catch (e) {
        throw asError(e);
      }
      deps.reload();
    },
  };
}

/** When the UI stored a pending code (PENDING_CODE_KEY) before server_set: the time of the switch. */
export const PENDING_CODE_AT_KEY = "buddy-pending-pairing-at";

/** Called right before the reload after server_set: stamps a pending code. */
export function stampPendingCode(storage: Pick<Storage, "getItem" | "setItem"> | null, nowMs: number): void {
  try {
    if (storage?.getItem(PENDING_CODE_KEY)) storage.setItem(PENDING_CODE_AT_KEY, String(nowMs));
  } catch {
    // storage blocked: the UI finds no code and the user types it again
  }
}

/**
 * At start, before the UI reads the pending code: a code survives the reload only if it is
 * younger than its 3-minute lifetime (PLAN_V4 §6.2). Older, unstamped or future-stamped codes
 * are removed, so a later app start never redeems a forgotten code.
 */
export function expirePendingCode(storage: Pick<Storage, "getItem" | "removeItem"> | null, nowMs: number): void {
  try {
    if (!storage) return;
    const at = Number(storage.getItem(PENDING_CODE_AT_KEY));
    storage.removeItem(PENDING_CODE_AT_KEY);
    const age = nowMs - at;
    if (!Number.isFinite(at) || at <= 0 || age < 0 || age >= PAIRING_TTL_MS) storage.removeItem(PENDING_CODE_KEY);
  } catch {
    // storage blocked: nothing to redeem
  }
}

/**
 * PLAN_V4 §9.2: the stored account belongs to another server than the effective origin (e.g. a
 * build with another BUDDY_PUBLIC_URL). With a token present the app must not sync – the token
 * would go to the wrong server. Returns the hint, or null if all is well.
 */
export function originMismatch(account: Account | null, token: string | null, origin: string): string | null {
  if (!account || !token || !account.serverUrl || sameOrigin(account.serverUrl, origin)) return null;
  return `Diese App-Version ist für einen anderen Server eingerichtet (${originHost(origin)}). Dein Konto liegt auf ${originHost(account.serverUrl)}. Melde dich ab und neu an.`;
}

/**
 * Sync engine stand-in while the origin does not match (§9.2): never sends a request (the token
 * belongs to the other server), keeps the outbox, logout() only forgets the token locally.
 * Message prefix `server_mismatch` (the hint itself is shown by the entry point).
 */
export function createMismatchSync(tokens: Pick<TokenProvider, "setToken">): SyncEngine {
  let status: WebSyncStatus = {
    state: "error",
    pending: 0,
    lastSyncAt: null,
    clockOffsetMs: 0,
    clockWarning: false,
    message: "server_mismatch: the account belongs to another server",
  };
  const listeners = new Set<(s: WebSyncStatus) => void>();
  const refuse = () => Promise.reject(new Error(status.message ?? "server_mismatch"));
  return {
    status: () => ({ ...status }),
    onStatus(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    onNotice: () => () => undefined,
    login: refuse,
    loginWithCode: refuse,
    deleteAccount: refuse,
    serverInfo: async () => null,
    async logout() {
      await tokens.setToken(null);
      status = { ...status, state: "signedOut", message: null };
      for (const l of [...listeners]) l({ ...status });
    },
    syncNow: async () => undefined,
    requestSync: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

/**
 * Token in the keychain (iOS) / Keystore-encrypted storage (Android). Cached in memory
 * after the first read so each sync request does not cross the IPC bridge; the value
 * never goes to logs or the DOM.
 */
export function createShellTokens(invoke: Invoke): TokenProvider {
  let cached: string | null | undefined;
  let reading: Promise<string | null> | null = null;
  return {
    async getToken() {
      if (cached !== undefined) return cached;
      reading ??= invoke<string | null>("token_get")
        .then((t) => (typeof t === "string" && t ? t : null))
        .catch(() => null)
        .finally(() => {
          reading = null;
        });
      const t = await reading;
      cached = t;
      return t;
    },
    async setToken(token) {
      cached = undefined;
      await invoke("token_set", { token });
      cached = token;
    },
  };
}

/** Device preference „Benachrichtigungen ein/aus“ in localStorage (per device, not synced). */
export function createLocalPrefs(storage: Pick<Storage, "getItem" | "setItem"> | null, key = "buddy.native.notifications"): NativePrefs {
  let memory: boolean | null = null;
  return {
    enabled() {
      try {
        const v = storage?.getItem(key);
        if (v === "on") return true;
        if (v === "off") return false;
        return memory;
      } catch {
        return memory;
      }
    },
    setEnabled(on) {
      memory = on;
      try {
        storage?.setItem(key, on ? "on" : "off");
      } catch {
        // memory only (storage blocked)
      }
    },
  };
}

/**
 * UUID v4 for new notes. `crypto.randomUUID` needs a secure context; the shell's
 * WebView origins (https://tauri.localhost, tauri://localhost) normally are, but
 * getRandomValues works everywhere, so it is the fallback.
 */
export function newUuid(c: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Suggested device name for the login form. */
export function shellDeviceName(platform: ShellConfig["platform"]): string {
  if (platform === "android") return "Android (App)";
  if (platform === "ios") return "iPhone/iPad (App)";
  return "Display Buddy App";
}
