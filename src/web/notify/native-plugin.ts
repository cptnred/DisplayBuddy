/**
 * Thin adapter over `@tauri-apps/plugin-notification` 2.8.0 for the native shell
 * (PLAN_V3_SYNC §10.2/§10.3). The planner (`native.ts`) only sees {@link NotificationPlugin},
 * so it is tested with a fake; this file is the only place in the web code that talks to
 * the plugin.
 *
 * Scheduling goes through the plugin's `notify` command directly (the same command its
 * `sendNotification()` uses via the `window.Notification` shim) because `sendNotification`
 * returns nothing and swallows errors such as a past date (iOS `pastScheduledTime`) –
 * the planner must know whether a notification was really planned.
 * Source: plugins-workspace/plugins/notification guest-js/index.ts, src/init-iife.js.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  active,
  cancel,
  createChannel,
  Importance,
  onAction,
  onNotificationReceived,
  pending,
  registerActionTypes,
  removeActive,
  requestPermission,
  Schedule,
  Visibility,
} from "@tauri-apps/plugin-notification";
import {
  ACTION_ACK,
  ACTION_SNOOZE,
  ACTION_TYPE_ID,
  CHANNEL_ID,
  type PendingInfo,
  scheduleDate,
} from "./native-plan";

export type NativePermission = "granted" | "denied" | "prompt";

export interface LocalNotification {
  id: number;
  title: string;
  body: string;
  /** Absolute instant (Unix ms); null = show now. */
  atMs: number | null;
  /** With „Erledigt“/„10 Min. später“ buttons. */
  actions: boolean;
  extra?: Record<string, string>;
}

export interface ActionEvent {
  /** "ack", "snooze10", "tap", "dismiss" … */
  actionId: string;
  /** Notification id if the platform reports it. */
  id: number | null;
  extra: Record<string, unknown> | null;
}

export interface NotificationPlugin {
  permission(): Promise<NativePermission>;
  /** Shows the system prompt (iOS requestAuthorization, Android 13+ POST_NOTIFICATIONS). */
  requestPermission(): Promise<NativePermission>;
  /** Channel + action types; idempotent. */
  setup(): Promise<void>;
  schedule(n: LocalNotification): Promise<void>;
  pending(): Promise<PendingInfo[]>;
  cancel(ids: number[]): Promise<void>;
  active(): Promise<number[]>;
  removeActive(ids: number[]): Promise<void>;
  onAction(cb: (e: ActionEvent) => void): Promise<() => void>;
  /** A notification was delivered while the app is in the foreground (id). */
  onReceived(cb: (id: number) => void): Promise<() => void>;
}

export function toPermission(p: string | boolean | null | undefined): NativePermission {
  if (p === true || p === "granted") return "granted";
  if (p === false || p === "denied") return "denied";
  return "prompt";
}

/** The real plugin (only usable inside the Tauri shell). */
export function createTauriNotificationPlugin(): NotificationPlugin {
  return {
    async permission() {
      const raw = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      return toPermission(raw);
    },
    async requestPermission() {
      // window.Notification shim of the plugin → plugin:notification|request_permission
      return toPermission(await requestPermission());
    },
    async setup() {
      // Android only (channels); iOS answers with an error, which is fine
      await createChannel({
        id: CHANNEL_ID,
        name: "Erinnerungen",
        description: "Erinnerungen an Notizen von Display Buddy",
        importance: Importance.High,
        visibility: Visibility.Private,
        vibration: true,
        lights: true,
      }).catch(() => undefined);
      await registerActionTypes([
        {
          id: ACTION_TYPE_ID,
          actions: [
            // foreground: iOS starts the app for the action, so the data layer runs
            { id: ACTION_ACK, title: "Erledigt", foreground: true },
            { id: ACTION_SNOOZE, title: "10 Min. später", foreground: true },
          ],
        },
      ]);
    },
    async schedule(n) {
      await invoke("plugin:notification|notify", {
        options: {
          id: n.id,
          channelId: CHANNEL_ID,
          title: n.title,
          body: n.body,
          // absolute instant, not repeating, allowWhileIdle (Android Doze) – PLAN §10.3
          schedule: n.atMs === null ? undefined : Schedule.at(scheduleDate(n.atMs), false, true),
          actionTypeId: n.actions ? ACTION_TYPE_ID : undefined,
          extra: n.extra,
          autoCancel: true,
        },
      });
    },
    async pending() {
      const list = await pending();
      return list.map((p) => ({ id: p.id, title: p.title ?? null, body: p.body ?? null }));
    },
    async cancel(ids) {
      if (ids.length) await cancel(ids);
    },
    async active() {
      return (await active()).map((a) => a.id);
    },
    async removeActive(ids) {
      if (ids.length) await removeActive(ids.map((id) => ({ id })));
    },
    async onAction(cb) {
      const listener = await onAction((e) => {
        const n = e.notification;
        cb({
          actionId: e.actionId,
          id: typeof n?.id === "number" ? n.id : null,
          extra: n && typeof n.extra === "object" ? (n.extra as Record<string, unknown>) : null,
        });
      });
      return () => void listener.unregister();
    },
    async onReceived(cb) {
      const listener = await onNotificationReceived((n) => {
        if (typeof n.id === "number") cb(n.id);
      });
      return () => void listener.unregister();
    },
  };
}
