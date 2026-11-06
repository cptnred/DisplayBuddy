/**
 * Platform pieces of the native shell besides the notifier (PLAN_V3_SYNC §10.2):
 * shell configuration, token provider over the shell's secure storage, device
 * preferences, id generation. Kept here (not in mobile/) so that Vitest covers them;
 * the entry point mobile/src/main.tsx only wires them together.
 *
 * The Tauri `invoke` is injected (tests pass a fake). Commands: `shell_config`,
 * `token_get`, `token_set` (mobile/src-tauri/src/lib.rs).
 */
import type { TokenProvider } from "../contract";
import type { NativePrefs } from "./native";

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface ShellConfig {
  /** Server origin baked in at build time (BUDDY_PUBLIC_URL), null if missing. */
  serverUrl: string | null;
  platform: "android" | "ios" | "desktop";
}

export async function loadShellConfig(invoke: Invoke): Promise<ShellConfig> {
  const raw = await invoke<Partial<ShellConfig>>("shell_config");
  const platform = raw.platform === "android" || raw.platform === "ios" ? raw.platform : "desktop";
  const url = typeof raw.serverUrl === "string" && /^https?:\/\/[^/?#\s]+$/.test(raw.serverUrl) ? raw.serverUrl : null;
  return { serverUrl: url, platform };
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
