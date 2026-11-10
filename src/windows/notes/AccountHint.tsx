import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Settings } from "../../types";
import styles from "./AccountHint.module.css";

/**
 * One-time hint above the shortcut bar (PLAN_V4 §7.1): only while not connected and not
 * dismissed. „Später“ hides it until the next start (the notes window lives as long as the
 * app), „Nicht mehr zeigen“ sets `accountHintDismissed`.
 */
export function AccountHint() {
  const [settings, setSettings] = useState<Pick<Settings, "syncEnabled" | "accountHintDismissed"> | null>(null);
  const [later, setLater] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .loadSettings()
      .then((s) => alive && s && setSettings(s))
      .catch(() => undefined);
    const unlisten = api.onSettingsChanged((s) => alive && setSettings(s));
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  }, []);

  if (!settings || settings.syncEnabled || settings.accountHintDismissed || later) return null;

  const dismiss = () => {
    setSettings({ ...settings, accountHintDismissed: true });
    void api.saveSettings({ accountHintDismissed: true }).catch(() => undefined);
  };

  return (
    <aside className={styles.card} aria-labelledby="account-hint-title">
      <p id="account-hint-title" className={styles.title}>
        Notizen auch aufs Handy?
      </p>
      <p className={styles.text}>Lege ein kostenloses Konto an und verbinde dein Handy per QR-Code.</p>
      <div className={styles.buttons}>
        <button type="button" className={styles.primary} onClick={() => void api.openSettings("account").catch(() => undefined)}>
          Konto anlegen
        </button>
        <button type="button" className={styles.secondary} onClick={() => setLater(true)}>
          Später
        </button>
        <button type="button" className={styles.secondary} onClick={dismiss}>
          Nicht mehr zeigen
        </button>
      </div>
    </aside>
  );
}
