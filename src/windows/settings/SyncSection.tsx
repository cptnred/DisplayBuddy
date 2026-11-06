import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { needsClockWarning } from "../../lib/clock";
import type { SyncStatus } from "../../types";
import styles from "./SettingsApp.module.css";

export const DEFAULT_DEVICE_NAME = "Windows-PC";

/** German text for an error of `sync_connect` (the string starts with a code). */
export function connectErrorText(error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const code = raw.split(":")[0].trim();
  switch (code) {
    case "invalid_url":
      return "Ungültige Server-Adresse. Erlaubt ist https://… (http:// nur für localhost).";
    case "invalid_input":
      return "Bitte Benutzername, Passwort und Gerätenamen (höchstens 64 Zeichen) angeben.";
    case "unauthorized":
      return "Benutzername oder Passwort ist falsch.";
    case "offline":
      return "Server nicht erreichbar. Bitte Adresse und Internetverbindung prüfen.";
    case "keyring":
      return "Die Anmeldung konnte nicht im Windows-Anmeldeinformationsspeicher abgelegt werden.";
    case "server":
      return raw.includes("429")
        ? "Zu viele Anmeldeversuche. Bitte später erneut versuchen."
        : "Der Server hat die Anmeldung abgelehnt.";
    default:
      return "Verbinden fehlgeschlagen.";
  }
}

function pendingText(n: number): string {
  return n === 1 ? "1 Änderung wartet" : `${n} Änderungen warten`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(d);
}

/** German status line for a sync status. */
export function statusText(s: SyncStatus): string {
  if (!s.enabled) return "Nicht verbunden";
  switch (s.state) {
    case "syncing":
      return "Synchronisiere …";
    case "offline":
      return `Offline – ${pendingText(s.pending)}`;
    case "error":
      return s.pending > 0 ? `Fehler bei der Synchronisation – ${pendingText(s.pending)}` : "Fehler bei der Synchronisation";
    case "unauthorized":
      return "Abgemeldet – bitte neu verbinden";
    case "off":
      return "Nicht verbunden";
    case "idle":
    default:
      if (s.pending > 0) return `Verbunden – ${pendingText(s.pending)}`;
      return s.lastSyncAt ? `Synchronisiert – zuletzt ${formatTime(s.lastSyncAt)}` : "Verbunden";
  }
}

/** Hint for local changes replaced by newer versions (`message` = "stale:<n>"). */
export function staleText(s: SyncStatus): string | null {
  const m = /^stale:(\d+)$/.exec(s.message ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return n === 1
    ? "1 Änderung wurde durch eine neuere Fassung von einem anderen Gerät ersetzt."
    : `${n} Änderungen wurden durch neuere Fassungen von anderen Geräten ersetzt.`;
}

/** Clock warning for |offset| > 2 min (positive offset = this PC is behind). */
export function clockWarningText(s: SyncStatus): string | null {
  if (!s.enabled || !needsClockWarning(s.clockOffsetMs)) return null;
  const minutes = Math.round(Math.abs(s.clockOffsetMs) / 60_000);
  const dir = s.clockOffsetMs > 0 ? "nach" : "vor";
  return `Die Uhr dieses PCs geht etwa ${minutes} Min. ${dir}. Zeitstempel werden korrigiert – bitte die Windows-Uhrzeit prüfen.`;
}

/** Settings section „Synchronisation“ (PLAN_V3_SYNC §8). */
export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(DEFAULT_DEVICE_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();

  useEffect(() => {
    let alive = true;
    const apply = (s: SyncStatus) => {
      if (!alive) return;
      setStatus(s);
      if (s.serverUrl) setServerUrl((v) => v || s.serverUrl);
      if (s.deviceName) setDeviceName((v) => (v === DEFAULT_DEVICE_NAME || !v ? s.deviceName : v));
    };
    api
      .syncStatus()
      .then(apply)
      .catch(() => alive && setError("Der Sync-Status konnte nicht geladen werden."));
    const unlisten = api.onSyncStatus(apply);
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  }, []);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.syncConnect(serverUrl.trim(), username.trim(), password, deviceName.trim());
      setStatus(s);
      setPassword("");
    } catch (err) {
      setError(connectErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    try {
      setStatus(await api.syncNow());
    } catch {
      setError("Synchronisation konnte nicht gestartet werden.");
    }
  };

  const disconnect = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.syncDisconnect());
    } catch {
      setError("Trennen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  const connected = !!status?.enabled;
  const showForm = !connected || status?.state === "unauthorized";
  const warning = status ? clockWarningText(status) : null;
  const stale = status ? staleText(status) : null;

  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <h2 id={headingId}>Synchronisation</h2>
      <p className={styles.syncStatus} role="status" data-sync-state={status?.state ?? "unknown"}>
        {status ? statusText(status) : "…"}
        {connected && status?.serverUrl && <span className={styles.muted}> · {status.serverUrl}</span>}
      </p>
      {warning && (
        <p className={styles.warning} role="alert">
          {warning}
        </p>
      )}
      {stale && <p className={styles.muted}>{stale}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <form className={styles.syncForm} onSubmit={(e) => void connect(e)}>
          <label className={styles.text}>
            <span>Server-Adresse</span>
            <input
              type="url"
              aria-label="Server-Adresse"
              placeholder="https://buddy.example.org"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              required
              autoComplete="url"
              spellCheck={false}
            />
          </label>
          <label className={styles.text}>
            <span>Benutzer</span>
            <input
              type="text"
              aria-label="Benutzer"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              spellCheck={false}
            />
          </label>
          <label className={styles.text}>
            <span>Passwort</span>
            <input
              type="password"
              aria-label="Passwort"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <label className={styles.text}>
            <span>Gerätename</span>
            <input
              type="text"
              aria-label="Gerätename"
              value={deviceName}
              maxLength={64}
              onChange={(e) => setDeviceName(e.target.value)}
              required
            />
          </label>
          <div className={styles.buttons}>
            <button type="submit" className={styles.primary} disabled={busy}>
              {connected ? "Neu verbinden" : "Verbinden"}
            </button>
          </div>
        </form>
      )}

      {connected && (
        <div className={styles.buttons}>
          {!showForm && (
            <button type="button" className={styles.primary} disabled={busy || status?.state === "syncing"} onClick={() => void syncNow()}>
              Jetzt synchronisieren
            </button>
          )}
          {confirming ? (
            <>
              <span className={styles.muted} role="alert">
                {pendingText(status?.pending ?? 0)} noch nicht übertragen. Trotzdem trennen?
              </span>
              <button type="button" className={styles.secondary} onClick={() => void disconnect()}>
                Trotzdem trennen
              </button>
              <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>
                Abbrechen
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => ((status?.pending ?? 0) > 0 ? setConfirming(true) : void disconnect())}
            >
              Trennen
            </button>
          )}
        </div>
      )}
    </section>
  );
}
