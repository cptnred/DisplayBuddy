import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { AccountInfo, DeviceInfo, SyncStatus } from "../../types";
import {
  DEVICE_KIND_TEXT,
  accountErrorText,
  errorCode,
  formatBytes,
  lastSeenText,
} from "./accountTexts";
import styles from "./AccountSection.module.css";

const KIND_ICON: Record<DeviceInfo["kind"], string> = { desktop: "🖥", mobile: "📱", web: "🌐" };

export interface AccountManageProps {
  /** A new recovery code to show in the mandatory dialog. */
  onRecoveryCode: (code: string) => void;
  /** Sync status after deleting the account (off). */
  onDeleted: (status: SyncStatus) => void;
}

/** Devices and account of a connected PC (PLAN_V4 §7.1). */
export function AccountManage({ onRecoveryCode, onDeleted }: AccountManageProps) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, d] = await Promise.all([api.accountInfo(), api.accountDevices()]);
      setAccount(a);
      setDevices(d);
      setError(null);
    } catch (e) {
      setError(accountErrorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <Devices devices={devices} onChange={setDevices} />
      {account && (
        <Account
          account={account}
          onRecoveryCode={(code) => {
            onRecoveryCode(code);
            void reload();
          }}
          onNotice={setNotice}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}

function Devices({ devices, onChange }: { devices: DeviceInfo[]; onChange: (d: DeviceInfo[]) => void }) {
  const [askPassword, setAskPassword] = useState<DeviceInfo | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const revoke = async (device: DeviceInfo, pw: string | null) => {
    setError(null);
    try {
      onChange(await api.accountRevokeDevice(device.id, pw));
      setAskPassword(null);
      setPassword("");
    } catch (e) {
      if (errorCode(e) === "password_required") setAskPassword(device);
      else setError(accountErrorText(e, pw ? "password" : "general"));
    }
  };

  return (
    <div className={styles.block} role="group" aria-labelledby="devices-heading">
      <h3 id="devices-heading">Geräte</h3>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <ul className={styles.devices}>
        {devices.map((d) => (
          <li key={d.id}>
            <span aria-hidden="true">{KIND_ICON[d.kind]}</span>
            <span className={styles.deviceName}>
              {d.name} <span className={styles.muted}>· {DEVICE_KIND_TEXT[d.kind]}</span>
              <br />
              <span className={styles.muted}>{lastSeenText(d.lastSeenAt, now)}</span>
            </span>
            {d.current ? (
              <span className={styles.muted}>Dieses Gerät</span>
            ) : (
              <button
                type="button"
                className={styles.secondary}
                aria-label={`${d.name} abmelden`}
                onClick={() => void revoke(d, null)}
              >
                Abmelden
              </button>
            )}
          </li>
        ))}
      </ul>
      {askPassword && (
        <form
          className={styles.form}
          data-local-escape
          onSubmit={(e) => {
            e.preventDefault();
            void revoke(askPassword, password);
          }}
        >
          <p>Dieses Gerät wurde vor deinem angemeldet. Zum Abmelden bitte dein Passwort eingeben.</p>
          <PasswordField label="Passwort" value={password} onChange={setPassword} autoComplete="current-password" />
          <div className={styles.buttons}>
            <button type="submit" className={styles.primary}>
              Mit Passwort abmelden
            </button>
            <button type="button" className={styles.secondary} onClick={() => setAskPassword(null)}>
              Abbrechen
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  return (
    <label className={styles.text}>
      <span>{props.label}</span>
      <input
        type="password"
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required
        autoComplete={props.autoComplete}
      />
    </label>
  );
}

type Panel = null | "password" | "code" | "delete";

function Account({
  account,
  onRecoveryCode,
  onNotice,
  onDeleted,
}: {
  account: AccountInfo;
  onRecoveryCode: (code: string) => void;
  onNotice: (t: string | null) => void;
  onDeleted: (s: SyncStatus) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [unknownCurrent, setUnknownCurrent] = useState(false);
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [confirmName, setConfirmName] = useState("");

  const open = (p: Panel) => {
    setPanel((v) => (v === p ? null : p));
    setError(null);
    setCurrent("");
    setNext("");
    setRepeat("");
    setConfirmName("");
    setUnknownCurrent(false);
  };

  const run = async (fn: () => Promise<void>, context: "password" | "general" = "password") => {
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(accountErrorText(e, context));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError("Die Passwörter stimmen nicht überein.");
      return;
    }
    void run(async () => {
      await api.accountChangePassword(unknownCurrent ? null : current, next);
      setPanel(null);
      onNotice("Das Passwort wurde geändert. Andere Geräte sind abgemeldet.");
    });
  };

  const newCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const code = await api.accountNewRecoveryCode(current);
      setPanel(null);
      onRecoveryCode(code);
    });
  };

  const exportData = () =>
    void run(async () => {
      const path = await api.accountExport();
      if (path) onNotice(`Gespeichert: ${path}`);
    }, "general");

  const deleteAccount = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onDeleted(await api.accountDelete(current, confirmName)));
  };

  const { usage, quota } = account;
  const share = quota.bytes ? Math.min(1, usage.bytes / quota.bytes) : 0;

  return (
    <div className={styles.block} role="group" aria-labelledby="konto-heading">
      <h3 id="konto-heading">Konto</h3>
      <p>Angemeldet als {account.username}</p>
      <p>
        Speicher: {formatBytes(usage.bytes)}
        {quota.bytes ? ` von ${formatBytes(quota.bytes)}` : ""}
      </p>
      {quota.bytes ? (
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Speicher"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <span style={{ transform: `scaleX(${share})` }} />
        </div>
      ) : null}

      {account.recoveryCodeCreatedAt === null && (
        <div className={styles.hint}>
          <p>Für dieses Konto gibt es noch keinen Wiederherstellungscode.</p>
          <button type="button" className={styles.secondary} onClick={() => open("code")}>
            Code erzeugen
          </button>
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.buttons}>
        <button type="button" className={styles.secondary} aria-expanded={panel === "password"} onClick={() => open("password")}>
          Passwort ändern
        </button>
        <button type="button" className={styles.secondary} aria-expanded={panel === "code"} onClick={() => open("code")}>
          Neuer Wiederherstellungscode
        </button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={exportData}>
          Daten exportieren
        </button>
        <button type="button" className={styles.secondary} aria-expanded={panel === "delete"} onClick={() => open("delete")}>
          Konto löschen …
        </button>
      </div>

      {panel === "password" && (
        <form className={styles.form} data-local-escape onSubmit={changePassword}>
          <label className={styles.check}>
            <input type="checkbox" checked={unknownCurrent} onChange={(e) => setUnknownCurrent(e.target.checked)} />
            <span>Ich kenne mein aktuelles Passwort nicht</span>
          </label>
          {!unknownCurrent && (
            <PasswordField label="Aktuelles Passwort" value={current} onChange={setCurrent} autoComplete="current-password" />
          )}
          <PasswordField label="Neues Passwort" value={next} onChange={setNext} autoComplete="new-password" />
          <PasswordField label="Neues Passwort wiederholen" value={repeat} onChange={setRepeat} autoComplete="new-password" />
          <p className={styles.muted}>Mindestens 12 Zeichen. Ein langer Satz ist ein gutes Passwort. Andere Geräte werden abgemeldet.</p>
          <div className={styles.buttons}>
            <button type="submit" className={styles.primary} disabled={busy}>
              Passwort ändern
            </button>
          </div>
        </form>
      )}

      {panel === "code" && (
        <form className={styles.form} data-local-escape onSubmit={newCode}>
          <p>Der bisherige Code wird damit ungültig.</p>
          <PasswordField label="Passwort" value={current} onChange={setCurrent} autoComplete="current-password" />
          <div className={styles.buttons}>
            <button type="submit" className={styles.primary} disabled={busy}>
              Code erzeugen
            </button>
          </div>
        </form>
      )}

      {panel === "delete" && (
        <form className={styles.form} data-local-escape onSubmit={deleteAccount}>
          <p>
            <strong>Konto endgültig löschen?</strong>
          </p>
          <p>
            Alle Notizen, Erinnerungen und Geräte dieses Kontos werden sofort vom Server gelöscht. Auf diesem PC bleiben
            deine Notizen erhalten. Aus den Sicherungen des Servers verschwinden die Daten spätestens nach 14 Tagen.
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={exportData}>
              Vorher Daten exportieren
            </button>
          </div>
          <PasswordField label="Passwort" value={current} onChange={setCurrent} autoComplete="current-password" />
          <label className={styles.text}>
            <span>Benutzername zur Bestätigung</span>
            <input
              type="text"
              aria-label="Benutzername zur Bestätigung"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className={styles.buttons}>
            <button
              type="submit"
              className={styles.danger}
              disabled={busy || confirmName.trim().toLowerCase() !== account.username.toLowerCase()}
            >
              Endgültig löschen
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
