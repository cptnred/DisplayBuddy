/**
 * Everything the UI needs from the platform, passed in by the entry point
 * (PWA: src/web/main.tsx; native shell: mobile entry of phase N1). The UI never imports
 * the data/sync implementation or touches service-worker/push globals.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { DataStore, QrScanner, ServerSelector, SyncEngine } from "../contract";
import type { InstallController, Notifier, StorageController } from "../notify/types";

/** Service-worker update state (PWA: useRegisterSW; native: none). */
export interface UpdateState {
  needRefresh: boolean;
  /** Activates the waiting worker and reloads. */
  update(): Promise<void>;
  dismiss(): void;
}

export interface Services {
  store: DataStore;
  sync: SyncEngine;
  notifier: Notifier | null;
  install: InstallController | null;
  storage: StorageController | null;
  /** Device IANA zone (injectable for tests). */
  deviceZone(): string;
  /** New note ids (crypto.randomUUID in the browser). */
  newId(): string;
  /** Suggested device name for the login form. */
  defaultDeviceName(): string;
  /**
   * v4: QR scanner for the login page (PWA: createWebScanner; native: barcode-scanner plugin).
   * Missing or isAvailable() false → no „QR-Code scannen“ button.
   */
  scanner?: QrScanner | null;
  /**
   * v4, native app only: server choice. Present → login page shows „Server: … · ändern“ and a
   * scanned code of another origin asks before switching; absent (PWA) → such codes are refused.
   */
  server?: ServerSelector | null;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ value, children }: { value: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("ServicesProvider missing");
  return s;
}
