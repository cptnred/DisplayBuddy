/** /new, /setup, /settings */
import { useEffect, useRef, useState } from "react";
import { emptyDoc } from "../../../windows/notes/docText";
import { NOTE_SCHEMA_VERSION, type Note } from "../../../types";
import { useAccount, usePendingCount, useSyncStatus } from "../hooks";
import { InstallCard, NotificationSettings } from "../Panels";
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

export function SettingsPage() {
  const { sync, store, notifier, deviceZone } = useServices();
  const { navigate } = useRouter();
  const [account] = useAccount();
  const status = useSyncStatus();
  const pending = usePendingCount();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      // unsubscribe while the session cookie is still valid
      await notifier?.disable().catch(() => undefined);
      await sync.logout().catch(() => undefined);
      sync.stop();
      await store.signOut();
      navigate("/login", { replace: true });
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
            Angemeldet als <strong>{account.username}</strong> auf {account.serverUrl}
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
    </main>
  );
}
