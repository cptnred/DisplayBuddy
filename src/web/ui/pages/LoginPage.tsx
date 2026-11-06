import { useState, type FormEvent } from "react";
import { useAccount, usePendingCount, useSyncStatus } from "../hooks";
import { useRouter } from "../router";
import { useServices } from "../services";
import styles from "../ui.module.css";

/** German text for a login failure (SyncError.code / HTTP status of src/web/sync). */
export function errorText(e: unknown): string {
  const { code, status } = (e ?? {}) as { code?: string; status?: number };
  if (code === "unauthorized" || status === 401 || status === 403) return "Benutzername oder Passwort ist falsch.";
  if (code === "too_many_requests" || status === 429) return "Zu viele Versuche. Bitte später erneut versuchen.";
  if (code === "account_mismatch") {
    return "Auf diesem Gerät ist ein anderes Konto angemeldet. Bitte zuerst in den Einstellungen abmelden.";
  }
  if (code === "http" || code === "invalid_response") return "Der Server hat unerwartet geantwortet.";
  return "Der Server ist nicht erreichbar. Bitte Verbindung prüfen.";
}

export function LoginPage() {
  const { sync, storage, defaultDeviceName } = useServices();
  const { navigate } = useRouter();
  const status = useSyncStatus();
  const pending = usePendingCount();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [account] = useAccount();
  // signed in before and the session expired / the device was revoked
  const reconnect = account !== null && status.state === "unauthorized";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Bitte Benutzername und Passwort eingeben.");
      return;
    }
    setBusy(true);
    try {
      await sync.login(username.trim(), password, deviceName.trim() || defaultDeviceName());
      setPassword("");
      // PLAN §9.2: ask for persistent storage after the login
      void storage?.persist().catch(() => false);
      void sync.syncNow().catch(() => undefined);
      navigate(reconnect ? "/" : "/setup", { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.main}>
      <form className={styles.card} onSubmit={(e) => void submit(e)} aria-label="Anmelden" noValidate>
        <h2>{reconnect ? "Bitte neu anmelden" : "Anmelden"}</h2>
        {reconnect && pending > 0 && (
          <p className={styles.muted} role="status">
            {pending === 1
              ? "1 Änderung wird nach dem Anmelden übertragen."
              : `${pending} Änderungen werden nach dem Anmelden übertragen.`}
          </p>
        )}
        <label className={styles.field}>
          Benutzername
          <input
            className={styles.input}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-label="Benutzername"
          />
        </label>
        <label className={styles.field}>
          Passwort
          <input
            className={styles.input}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Passwort"
          />
        </label>
        <label className={styles.field}>
          Gerätename
          <input
            className={styles.input}
            name="deviceName"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            aria-label="Gerätename"
          />
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy} aria-label="Anmelden">
          {busy ? "Anmelden …" : "Anmelden"}
        </button>
      </form>
    </main>
  );
}
