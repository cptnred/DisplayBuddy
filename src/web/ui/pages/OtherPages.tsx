/** /new, /setup, /settings */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { emptyDoc } from "../../../windows/notes/docText";
import { NOTE_SCHEMA_VERSION, type Note } from "../../../types";
import { useAccount, usePendingCount, useSyncStatus } from "../hooks";
import { originHost } from "../../pairing/parse";
import { InstallCard, LegalLinks, NotificationSettings } from "../Panels";
import { Link, useRouter } from "../router";
import { useServices } from "../services";
import { clockWarningText, statusText } from "../StatusBar";
import styles from "../ui.module.css";

/** Creates an empty note and opens it (replace, so „Zurück“ skips /new). */
export function NewPage() {
  const { store, newId } = useServices();
  const { navigate } = useRouter();
  const started = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const now = store.clock.correctedNowIso();
    const note: Note = {
      id: newId(),
      title: "",
      color: "yellow",
      content: emptyDoc(),
      createdAt: now,
      updatedAt: now,
      schemaVersion: NOTE_SCHEMA_VERSION,
    };
    store.saveNote(note).then(
      (n) => navigate(`/notes/${n.id}`, { replace: true }),
      () => setError(true),
    );
  }, [store, newId, navigate]);
  return (
    <main className={styles.main}>
      {error ? (
        <p className={styles.error} role="alert">
          Die Notiz konnte nicht angelegt werden.
        </p>
      ) : (
        <p className={styles.muted}>Neue Notiz …</p>
      )}
    </main>
  );
}

/** First-run setup after the login: install, notifications, done. */
export function SetupPage() {
  return (
    <main className={styles.main}>
      <section className={styles.card} aria-label="Einrichtung">
        <h2>Fast fertig</h2>
        <p className={styles.muted}>
          Deine Notizen werden auf diesem Gerät gespeichert und mit dem Server abgeglichen, sobald eine Verbindung
          besteht.
        </p>
      </section>
      <InstallCard />
      <NotificationSettings />
      <div className={styles.row}>
        <Link to="/" className={`${styles.button} ${styles.primary}`} aria-label="Einrichtung abschließen">
          Fertig
        </Link>
      </div>
    </main>
  );
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function StorageSection() {
  const { storage } = useServices();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void storage?.persisted().then((p) => alive && setPersisted(p)).catch(() => undefined);
    void storage?.estimate().then((e) => alive && setUsage(e)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [storage]);
  if (!storage) return null;
  return (
    <section className={styles.card} aria-label="Speicher">
      <h2>Speicher</h2>
      <p className={styles.muted}>
        {persisted === null
          ? "Wird geprüft …"
          : persisted
            ? "Die Daten sind dauerhaft gespeichert."
            : "Der Browser darf die Daten bei Platzmangel löschen. Nicht übertragene Änderungen gingen dabei verloren."}
      </p>
      {usage && <p className={styles.muted}>Belegt: {formatBytes(usage.usage)}</p>}
      {persisted === false && (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            aria-label="Dauerhaft speichern anfragen"
            onClick={() => void storage.persist().then(setPersisted)}
          >
            Dauerhaft speichern
          </button>
        </div>
      )}
    </section>
  );
}

/** German text for a failed account deletion (SyncError codes of src/web/sync). */
export function deleteErrorText(e: unknown): string {
  const { code, status } = (e ?? {}) as { code?: string; status?: number };
  // the server answers a wrong confirmation password with 403 forbidden (not 401)
  if (status === 403 && code === "http") return "Das Passwort ist falsch.";
  if (code === "bad_request") return "Der Benutzername stimmt nicht.";
  if (code === "too_many_requests") return "Zu viele Versuche. Bitte später erneut versuchen.";
  if (code === "network") return "Der Server ist nicht erreichbar. Bitte Verbindung prüfen.";
  return "Das Konto konnte nicht gelöscht werden.";
}

/** „Konto löschen …“ (PLAN_V4 §6.6): password + username, then like signing out. */
function DeleteAccountSection({ username, onDeleted }: { username: string; onDeleted(): Promise<void> }) {
  const { sync } = useServices();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Bitte das Passwort eingeben.");
      return;
    }
    if (confirmName.trim().toLowerCase() !== username.toLowerCase()) {
      setError("Der Benutzername stimmt nicht.");
      return;
    }
    setBusy(true);
    try {
      await sync.deleteAccount(password, confirmName.trim());
      setPassword("");
      await onDeleted();
    } catch (err) {
      setError(deleteErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Konto löschen">
      <h2>Konto löschen</h2>
      {!open ? (
        <div className={styles.row}>
          <button type="button" className={`${styles.button} ${styles.danger}`} aria-label="Konto löschen …" onClick={() => setOpen(true)}>
            Konto löschen …
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} aria-label="Konto endgültig löschen" noValidate className={styles.field}>
          <strong>Konto endgültig löschen?</strong>
          <p className={styles.muted}>
            Alle Notizen, Erinnerungen und Geräte dieses Kontos werden sofort vom Server gelöscht. Aus den Sicherungen
            des Servers verschwinden die Daten spätestens nach 14 Tagen. Auf diesem Gerät werden die Daten ebenfalls
            gelöscht.
          </p>
          <label className={styles.field}>
            Passwort
            <input
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Passwort"
            />
          </label>
          <label className={styles.field}>
            Benutzername zur Bestätigung
            <input
              className={styles.input}
              autoCapitalize="none"
              autoComplete="off"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              aria-label="Benutzername zur Bestätigung"
            />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.row}>
            <button type="submit" className={`${styles.button} ${styles.danger}`} disabled={busy} aria-label="Endgültig löschen">
              Endgültig löschen
            </button>
            <button
              type="button"
              className={styles.button}
              aria-label="Nicht löschen"
              onClick={() => {
                setOpen(false);
                setError(null);
                setPassword("");
              }}
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { sync, store, notifier, deviceZone } = useServices();
  const { navigate } = useRouter();
  const [account] = useAccount();
  const status = useSyncStatus();
  const pending = usePendingCount();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Local part of signing out (also after deleting the account). */
  const clearLocal = async () => {
    sync.stop();
    await store.signOut();
    navigate("/login", { replace: true });
  };

  const signOut = async () => {
    setBusy(true);
    try {
      // unsubscribe while the session cookie is still valid
      await notifier?.disable().catch(() => undefined);
      await sync.logout().catch(() => undefined);
      await clearLocal();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.main}>
      <section className={styles.card} aria-label="Synchronisation">
        <h2>Synchronisation</h2>
        {account && (
          <p className={styles.muted}>
            Angemeldet als <strong>{account.username}</strong> auf {originHost(account.serverUrl)}
          </p>
        )}
        <p role="status">{statusText(status, pending, deviceZone())}</p>
        {status.clockWarning && <p className={styles.error}>{clockWarningText(status.clockOffsetMs)}</p>}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            aria-label="Jetzt synchronisieren"
            disabled={status.state === "syncing"}
            onClick={() => void sync.syncNow().catch(() => undefined)}
          >
            Jetzt synchronisieren
          </button>
        </div>
      </section>
      <NotificationSettings />
      <StorageSection />
      <InstallCard compact />
      <section className={styles.card} aria-label="Abmelden">
        <h2>Abmelden</h2>
        <p className={styles.muted}>Beim Abmelden werden die Daten auf diesem Gerät gelöscht.</p>
        {!confirm ? (
          <div className={styles.row}>
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              aria-label="Abmelden"
              onClick={() => (pending > 0 ? setConfirm(true) : void signOut())}
              disabled={busy}
            >
              Abmelden
            </button>
          </div>
        ) : (
          <>
            <p className={styles.error} role="alert">
              {pending === 1
                ? "1 Änderung wurde noch nicht übertragen und geht beim Abmelden verloren."
                : `${pending} Änderungen wurden noch nicht übertragen und gehen beim Abmelden verloren.`}
            </p>
            <div className={styles.row}>
              <button
                type="button"
                className={`${styles.button} ${styles.danger}`}
                aria-label="Trotzdem abmelden"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Trotzdem abmelden
              </button>
              <button type="button" className={styles.button} aria-label="Nicht abmelden" onClick={() => setConfirm(false)}>
                Abbrechen
              </button>
            </div>
          </>
        )}
      </section>
      {account && (
        <DeleteAccountSection
          username={account.username}
          onDeleted={async () => {
            // the server already removed the push subscription; drop the local one too
            await notifier?.disable().catch(() => undefined);
            await clearLocal();
          }}
        />
      )}
      <LegalLinks />
    </main>
  );
}
