/**
 * Adapter over the shell's own `buddy-push` plugin (mobile/plugins/buddy-push, Android
 * only). The only file in the web code that talks to it; {@link createNativePush} sees
 * the {@link PushPlugin} interface and is tested with a fake.
 *
 * IPC: `plugin:buddy-push|get_token` / `take_launch_data` are forwarded to the Kotlin
 * methods `getToken` / `takeLaunchData`; events via `addPluginListener` (token, message,
 * opened). A Kotlin `invoke.reject(message, code)` arrives as an object with `code`.
 */
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import {
  parsePushData,
  parsePushMessage,
  type PushData,
  type PushErrorCode,
  type PushMessage,
  type PushPlugin,
  PushPluginError,
} from "./native-push";

const PLUGIN = "buddy-push";

/** Maps a rejected invoke to {@link PushPluginError}. */
export function toPushError(e: unknown): PushPluginError {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : null;
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e ?? null);
  const known: PushErrorCode = code === "NOT_CONFIGURED" || /NOT_CONFIGURED/.test(text) ? "NOT_CONFIGURED" : "UNAVAILABLE";
  return new PushPluginError(known, known === "NOT_CONFIGURED" ? "Firebase not configured" : "FCM token unavailable");
}

export function createTauriPushPlugin(): PushPlugin {
  return {
    async getToken() {
      let res: { token?: unknown };
      try {
        res = await invoke<{ token?: unknown }>(`plugin:${PLUGIN}|get_token`);
      } catch (e) {
        throw toPushError(e);
      }
      if (typeof res?.token !== "string" || !res.token) throw new PushPluginError("UNAVAILABLE", "empty FCM token");
      return res.token;
    },
    async takeLaunchData() {
      const res = await invoke<{ data?: unknown }>(`plugin:${PLUGIN}|take_launch_data`);
      return parsePushData(res?.data ?? null);
    },
    async onToken(cb) {
      const l = await addPluginListener<{ token?: unknown }>(PLUGIN, "token", (p) => {
        if (typeof p?.token === "string" && p.token) cb(p.token);
      });
      return () => void l.unregister();
    },
    async onMessage(cb: (m: PushMessage) => void) {
      const l = await addPluginListener<unknown>(PLUGIN, "message", (p) => {
        const m = parsePushMessage(p);
        if (m) cb(m);
      });
      return () => void l.unregister();
    },
    async onOpened(cb: (d: PushData) => void) {
      const l = await addPluginListener<unknown>(PLUGIN, "opened", (p) => {
        const d = parsePushData(p);
        if (d) cb(d);
      });
      return () => void l.unregister();
    },
  };
}
