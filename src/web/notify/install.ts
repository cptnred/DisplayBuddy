/**
 * Install button / guide (PLAN_V3_SYNC §9.1) and persistent storage (§9.2).
 *
 * Sources: MDN „Making PWAs installable“, „Trigger installation from your PWA“
 * (beforeinstallprompt: preventDefault, keep the event, call prompt() from a click,
 * read userChoice; `appinstalled`), browser-compat-data: beforeinstallprompt only in
 * Chromium (Chrome Android 61), not Safari/Firefox → guide card there.
 * MDN StorageManager.persist (Chrome Android 55, Safari iOS 15.2).
 */
import { isIos, isStandalone, type PlatformInfo } from "./platform";
import type { InstallController, InstallMode, StorageController } from "./types";

/** The non-standard BeforeInstallPromptEvent (Chromium). */
export interface BeforeInstallPromptEventLike extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallDeps {
  platform: () => PlatformInfo;
  /** window (event target for beforeinstallprompt / appinstalled). */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

export function createInstallController(deps: InstallDeps): InstallController {
  let deferred: BeforeInstallPromptEventLike | null = null;
  let installed = isStandalone(deps.platform());
  const listeners = new Set<(m: InstallMode) => void>();

  const mode = (): InstallMode => {
    if (installed || isStandalone(deps.platform())) return "installed";
    if (deferred) return "prompt";
    const p = deps.platform();
    if (isIos(p)) return "ios";
    // Firefox and others: guide via the browser menu
    return "manual";
  };
  const notify = () => {
    const m = mode();
    for (const l of [...listeners]) l(m);
  };

  deps.target.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEventLike;
    notify();
  });
  deps.target.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });

  return {
    mode,
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async prompt() {
      const e = deferred;
      if (!e) return false;
      // An event can be prompted only once.
      deferred = null;
      await e.prompt();
      const choice = await e.userChoice;
      if (choice.outcome === "accepted") installed = true;
      notify();
      return choice.outcome === "accepted";
    },
  };
}

export function createStorageController(storage: StorageManager | undefined): StorageController | null {
  if (!storage) return null;
  return {
    persist: async () => (typeof storage.persist === "function" ? storage.persist() : false),
    persisted: async () => (typeof storage.persisted === "function" ? storage.persisted() : false),
    estimate: async () => {
      if (typeof storage.estimate !== "function") return null;
      const e = await storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    },
  };
}
