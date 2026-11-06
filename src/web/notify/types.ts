/**
 * Platform interface for notifications (PLAN_V3_SYNC §9.4, §10.3).
 *
 * The UI (src/web/ui) only talks to a `Notifier`. The PWA implementation lives in
 * `./web.ts` (Web Push + service worker); the native shell (phase N1) provides its own
 * in `./native*` (local scheduling). The UI never touches navigator.serviceWorker,
 * Notification or PushManager itself.
 */
import type { Reminder } from "../../types";

export type NotifierState =
  /** Platform cannot show push notifications at all (old browser, no service worker). */
  | "unsupported"
  /** iOS/iPadOS Safari tab: push only after „Zum Home-Bildschirm“ (iOS ≥ 16.4). */
  | "needsInstall"
  /** Supported, not enabled yet: the UI shows „Benachrichtigungen aktivieren“. */
  | "available"
  /** Permission denied in the browser/OS settings. */
  | "denied"
  /** Enabled: subscription active and registered with the server (or local planning on). */
  | "enabled"
  /** Enabling or the server registration failed (message has details). */
  | "error";

export interface NotifierStatus {
  state: NotifierState;
  /** Technical detail for "error" (the UI shows a German text). */
  message?: string | null;
}

export interface Notifier {
  /** "pwa" = Web Push via service worker; "native" = local notifications of the shell. */
  readonly kind: "pwa" | "native";
  /** Current state (cheap; no permission prompt). */
  status(): Promise<NotifierStatus>;
  /**
   * Turns notifications on. MUST be called directly from a click handler: the
   * permission request happens synchronously before the first await (user gesture,
   * Apple requirement).
   */
  enable(): Promise<NotifierStatus>;
  /** Turns them off (unsubscribe + server registration removed). */
  disable(): Promise<NotifierStatus>;
  /** Sends a test notification to this device (PWA: POST /push/test). */
  test(): Promise<void>;
  /**
   * Called at every app start: re-checks the subscription with the server and
   * re-subscribes if needed (iOS has no pushsubscriptionchange).
   */
  reconcile(): Promise<NotifierStatus>;
  /**
   * Called whenever the reminder list changes: app badge = number of due reminders
   * (where supported) and closes notifications of reminders that are resolved
   * (done, moved, or removed while the note still exists – `noteIds` = local notes).
   */
  syncDue(reminders: readonly Reminder[], noteIds: readonly string[]): Promise<void>;
}

/** Install support of the platform (PWA only; the native shell passes null). */
export type InstallMode =
  /** Already running as installed app (display-mode: standalone). */
  | "installed"
  /** Chromium: own install button via beforeinstallprompt. */
  | "prompt"
  /** iOS/iPadOS: guide card „Teilen → Zum Home-Bildschirm“. */
  | "ios"
  /** Firefox and other browsers without prompt: guide card via browser menu. */
  | "manual";

export interface InstallController {
  mode(): InstallMode;
  /** Changes of the mode (beforeinstallprompt arrived, app installed). */
  onChange(listener: (mode: InstallMode) => void): () => void;
  /** Shows the browser's install prompt (only in mode "prompt"); true if accepted. */
  prompt(): Promise<boolean>;
}

/** Persistent storage (navigator.storage), optional per platform. */
export interface StorageController {
  persist(): Promise<boolean>;
  persisted(): Promise<boolean>;
  /** Bytes used / quota, null if unknown. */
  estimate(): Promise<{ usage: number; quota: number } | null>;
}
