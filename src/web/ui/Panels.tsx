/** Install card, update banner, notification settings, sync notices. */
import { useEffect, useState } from "react";
import type { SyncNotice } from "../contract";
import type { InstallMode, NotifierStatus } from "../notify/types";
import { useSaveTracker } from "./saves";
import { useServices, type UpdateState } from "./services";
import styles from "./ui.module.css";

export function useInstallMode(): InstallMode | null {
  const { install } = useServices();
  const [mode, setMode] = useState<InstallMode | null>(() => install?.mode() ?? null);
  useEffect(() => {
    if (!install) return;
    setMode(install.mode());
    return install.onChange(setMode);
  }, [install]);
  return mode;
}

/**
 * „App installieren“ (Chromium, beforeinstallprompt) or a guide card for iOS/Firefox
 * (MDN „Installing“: no prompt there). Hidden when already installed.
 */
export function InstallCard({ compact = false }: { compact?: boolean }) {
  const { install } = useServices();
  const mode = useInstallMode();
  if (!install || !mode || mode === "installed") return null;
  return (
    <section className={styles.card} aria-label="App installieren">
      <h2>App installieren</h2>
      {mode === "prompt" && (
        <>
          {!compact && (
            <p className={styles.muted}>
              Installiert startet Display Buddy wie eine App, funktioniert offline und kann Erinnerungen anzeigen.
            </p>
          )}
          <div className={styles.row}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              aria-label="App installieren"
              onClick={() => void install.prompt()}
            >
              Installieren
            </button>
          </div>
        </>
      )}
      {mode === "ios" && (
        <>
          <p className={styles.muted}>
            Auf iPhone und iPad gibt es Benachrichtigungen nur für die installierte App (ab iOS 16.4). Im Safari-Tab
            können Daten nach 7 Tagen ohne Nutzung gelöscht werden.
          </p>
          <ol className={styles.steps}>
            <li>In Safari unten auf „Teilen“ tippen.</li>
            <li>„Zum Home-Bildschirm“ wählen und „Hinzufügen“ tippen.</li>
            <li>Display Buddy vom Home-Bildschirm aus öffnen.</li>
          </ol>
        </>
      )}
      {mode === "manual" && (
        <>
          <p className={styles.muted}>
            Dein Browser bietet keinen Installieren-Knopf an. Du kannst Display Buddy über das Browser-Menü
            installieren.
          </p>
          <ol className={styles.steps}>
            <li>Das Browser-Menü öffnen (⋮ bzw. ☰).</li>
            <li>„Installieren“, „App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen.</li>
          </ol>
        </>
      )}
    </section>
  );
}

/** „Neue Version verfügbar“ – only once every save has finished (PLAN_V3_SYNC §9.1). */
export function UpdateBanner({ update }: { update: UpdateState | null }) {
  const saves = useSaveTracker();
  const [working, setWorking] = useState(false);
  if (!update?.needRefresh || saves.busy) return null;
  return (
    <section className={styles.banner} aria-label="Update verfügbar" role="region">
      <span>Eine neue Version von Display Buddy ist verfügbar.</span>
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          aria-label="Jetzt aktualisieren"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void (async () => {
              await saves.flushAll();
              await update.update();
            })().finally(() => setWorking(false));
          }}
        >
          Aktualisieren
        </button>
        <button type="button" className={styles.button} aria-label="Später aktualisieren" onClick={update.dismiss}>
          Später
        </button>
      </div>
    </section>
  );
}

const NOTIFY_TEXT: Record<NotifierStatus["state"], string> = {
  unsupported: "Dieser Browser kann keine Benachrichtigungen anzeigen.",
  needsInstall:
    "Auf iPhone und iPad gibt es Benachrichtigungen nur in der installierten App. Zuerst zum Home-Bildschirm hinzufügen.",
  available: "Benachrichtigungen sind aus.",
  denied: "Benachrichtigungen sind in den Browser- bzw. Systemeinstellungen blockiert.",
  enabled: "Benachrichtigungen sind aktiv.",
  error: "Benachrichtigungen konnten nicht eingerichtet werden.",
};

/** „Benachrichtigungen aktivieren“ + Testbenachrichtigung (PLAN_V3_SYNC §9.4). */
export function NotificationSettings() {
  const { notifier } = useServices();
  const [status, setStatus] = useState<NotifierStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      notifier
        ?.status()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus({ state: "error" }));
    };
    refresh();
    // native shell: the permission is requested by the app itself after the login
    const unsubscribe = notifier?.subscribe?.(refresh);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [notifier]);

  if (!notifier) return null;
  const state = status?.state;

  const run = (p: Promise<NotifierStatus>) => {
    setBusy(true);
    setMessage(null);
    p.then(setStatus)
      .catch(() => setStatus({ state: "error" }))
      .finally(() => setBusy(false));
  };

  return (
    <section className={styles.card} aria-label="Benachrichtigungen">
      <h2>Benachrichtigungen</h2>
      <p className={styles.muted} role="status">
        {state ? NOTIFY_TEXT[state] : "Wird geprüft …"}
      </p>
      {notifier.kind === "pwa" && state !== "needsInstall" && state !== "unsupported" && (
        <p className={styles.muted}>
          Ohne Internet kommt eine Erinnerung nachträglich, sobald das Gerät wieder online ist.
        </p>
      )}
      <div className={styles.row}>
        {state === "needsInstall" && (
          <button type="button" className={styles.button} disabled aria-label="Zuerst zum Home-Bildschirm hinzufügen">
            Zuerst zum Home-Bildschirm hinzufügen
          </button>
        )}
        {(state === "available" || state === "error") && (
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={busy}
            aria-label="Benachrichtigungen aktivieren"
            // enable() runs synchronously in this handler (user gesture, Apple requirement)
            onClick={() => run(notifier.enable())}
          >
            Benachrichtigungen aktivieren
          </button>
        )}
        {state === "enabled" && (
          <>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              aria-label="Testbenachrichtigung senden"
              onClick={() => {
                setBusy(true);
                setMessage(null);
                notifier
                  .test()
                  .then(() => setMessage("Testbenachrichtigung gesendet."))
                  .catch(() => setMessage("Testbenachrichtigung fehlgeschlagen."))
                  .finally(() => setBusy(false));
              }}
            >
              Testbenachrichtigung
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              aria-label="Benachrichtigungen ausschalten"
              onClick={() => run(notifier.disable())}
            >
              Ausschalten
            </button>
          </>
        )}
      </div>
      {message && (
        <p className={styles.muted} role="status">
          {message}
        </p>
      )}
    </section>
  );
}

export function noticeText(n: SyncNotice): string {
  switch (n.kind) {
    case "stale":
      return "Auf einem anderen Gerät gab es eine neuere Fassung. Sie wurde übernommen.";
    case "remoteDeleted":
      return "Diese Notiz wurde auf einem anderen Gerät gelöscht.";
    case "fullResync":
      return "Die Daten wurden vollständig mit dem Server abgeglichen.";
  }
}

/** Shows sync notices as a dismissible toast. */
export function NoticeToast({ notice, onClose }: { notice: string | null; onClose(): void }) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [notice, onClose]);
  if (!notice) return null;
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span>{notice}</span>
      <button type="button" className={styles.iconButton} style={{ color: "#fff" }} aria-label="Hinweis schließen" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
