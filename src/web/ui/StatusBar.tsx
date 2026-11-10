import { formatWallTime, instantToWall } from "../../lib/zoned";
import { parseInstant } from "../../lib/schedule";
import type { WebSyncStatus } from "../contract";
import { usePendingCount, useSyncStatus } from "./hooks";
import { Link } from "./router";
import { useServices } from "./services";
import styles from "./ui.module.css";

const waiting = (n: number) => (n === 1 ? "1 Änderung wartet" : `${n} Änderungen warten`);

/** v4 error codes at the start of WebSyncStatus.message with their own text (PLAN_V4 §10). */
const ERROR_TEXTS: [string, string][] = [
  ["quota_exceeded", "Der Speicher deines Kontos ist voll. Lösche oder kürze Notizen, damit wieder synchronisiert wird."],
  ["account_disabled", "Das Konto ist gesperrt."],
  ["content_format_unsupported", "Dein Konto nutzt ein neueres Datenformat. Bitte aktualisiere Display Buddy."],
  ["device_limit", "Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden."],
];

/** German status line for a sync status (PLAN_V3_SYNC §8 texts). */
export function statusText(s: WebSyncStatus, pending: number, deviceZone: string): string {
  const n = Math.max(pending, s.pending);
  switch (s.state) {
    case "signedOut":
      return "Nicht angemeldet";
    case "syncing":
      return "Synchronisiere …";
    case "offline":
      return n > 0 ? `Offline – ${waiting(n)}` : "Offline";
    case "unauthorized":
      return n > 0 ? `Abgemeldet – bitte neu anmelden (${waiting(n)})` : "Abgemeldet – bitte neu anmelden";
    case "error": {
      const special = ERROR_TEXTS.find(([code]) => s.message?.startsWith(code));
      if (special) return special[1];
      return n > 0 ? `Sync-Fehler – ${waiting(n)}` : "Sync-Fehler – neuer Versuch folgt";
    }
    case "idle": {
      if (n > 0) return waiting(n);
      const last = s.lastSyncAt ? parseInstant(s.lastSyncAt) : null;
      return last === null
        ? "Synchronisiert"
        : `Synchronisiert um ${formatWallTime(instantToWall(last, deviceZone))}`;
    }
  }
}

export function clockWarningText(offsetMs: number): string {
  const min = Math.round(Math.abs(offsetMs) / 60_000);
  return `Die Uhr dieses Geräts geht ${min} Min. ${offsetMs > 0 ? "nach" : "vor"}. Zeitstempel werden korrigiert.`;
}

export function StatusBar() {
  const { sync, deviceZone } = useServices();
  const status = useSyncStatus();
  const pending = usePendingCount();
  return (
    <footer className={styles.status} aria-label="Synchronisationsstatus">
      <span className={styles.statusText} role="status" aria-live="polite">
        <span className={styles.dot} data-state={status.state} aria-hidden="true" />
        {statusText(status, pending, deviceZone())}
        {status.clockWarning && (
          <>
            {" · "}
            <strong>{clockWarningText(status.clockOffsetMs)}</strong>
          </>
        )}
      </span>
      {status.state === "unauthorized" ? (
        <Link to="/login" className={styles.linkButton}>
          Anmelden
        </Link>
      ) : (
        status.state !== "signedOut" && (
          <button
            type="button"
            className={styles.linkButton}
            aria-label="Jetzt synchronisieren"
            disabled={status.state === "syncing"}
            onClick={() => void sync.syncNow().catch(() => undefined)}
          >
            Jetzt synchronisieren
          </button>
        )
      )}
    </footer>
  );
}
