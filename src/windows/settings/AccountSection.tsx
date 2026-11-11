import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type LegalLinkKind } from "../../lib/api";
import type { ServerInfo, SyncStatus } from "../../types";
import { AccountManage } from "./AccountManage";
import { PairingPanel } from "./PairingPanel";
import { RecoveryCodeDialog } from "./RecoveryCodeDialog";
import {
  DEFAULT_DEVICE_NAME,
  accountErrorText,
  clockWarningText,
  errorCode,
  pendingText,
  serverHost,
  staleText,
  statusText,
  syncProblemText,
} from "./accountTexts";
import styles from "./AccountSection.module.css";

/** Id of the section (open_settings("account") scrolls here). */
export const ACCOUNT_SECTION_ID = "account";

type Mode = "register" | "login" | "recover";
type InfoState = { kind: "loading" } | { kind: "ok"; info: ServerInfo } | { kind: "error"; code: string; text: string };

/** Settings section „Konto & Handy“ (PLAN_V4 §7.1); replaces „Synchronisation“ of v3. */
export function AccountSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [customServer, setCustomServer] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [info, setInfo] = useState<InfoState>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [deviceName, setDeviceName] = useState(DEFAULT_DEVICE_NAME);
  const [inviteCode, setInviteCode] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Code for the mandatory dialog; `suggest` = afterwards offer „Jetzt Handy verbinden“. */
  const [recovery, setRecovery] = useState<{ code: string; suggest: boolean } | null>(null);
  const [suggestPairing, setSuggestPairing] = useState(false);
  const [pairSignal, setPairSignal] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    let alive = true;
    const apply = (s: SyncStatus) => {
      if (!alive) return;
      setStatus(s);
      if (s.serverUrl) {
        // v3 installations keep their own server (D-96)
        setCustomServer(true);
        setServerUrl((v) => v || s.serverUrl);
      }
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

  /** "" = standard server. */
  const effectiveUrl = customServer ? serverUrl.trim() : "";

  const loadInfo = useCallback(async (url: string) => {
    setInfo({ kind: "loading" });
    try {
      setInfo({ kind: "ok", info: await api.accountServerInfo(url) });
    } catch (e) {
      setInfo({ kind: "error", code: errorCode(e), text: accountErrorText(e) });
    }
  }, []);

  const connected = !!status?.enabled;
  const needsForm = !!status && (!connected || status.state === "unauthorized");

  // server info for the form: standard server at once, own server after editing (on blur)
  useEffect(() => {
    if (!needsForm || (customServer && !serverUrl.trim())) return;
    void loadInfo(customServer ? serverUrl.trim() : "");
  }, [needsForm, customServer, loadInfo]); // own address: reloaded on blur, not per keystroke

  const fail = (e: unknown, context: "login" | "register" | "recover") => setError(accountErrorText(e, context));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode !== "login" && password !== repeat) {
      setError("Die Passwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        setStatus(await api.syncConnect(effectiveUrl, username.trim(), password, deviceName.trim()));
      } else {
        const r =
          mode === "register"
            ? await api.accountRegister(effectiveUrl, username.trim(), password, deviceName.trim(), inviteCode.trim() || null)
            : await api.accountRecover(effectiveUrl, username.trim(), recoveryInput, password, deviceName.trim());
        setStatus(r.status);
        setRecovery({ code: r.recoveryCode, suggest: true });
      }
      setPassword("");
      setRepeat("");
      setRecoveryInput("");
      setInviteCode("");
    } catch (err) {
      fail(err, mode);
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
    setConfirmDisconnect(false);
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

  const openLink = (kind: LegalLinkKind) =>
    void api.accountOpenLink(kind).catch(() => setError("Der Link konnte nicht geöffnet werden."));

  const warning = status ? clockWarningText(status) : null;
  const stale = status ? staleText(status) : null;
  const problem = status ? syncProblemText(status) : null;
  const serverInfo = info.kind === "ok" ? info.info : null;
  const closed = mode === "register" && serverInfo?.registration === "closed";
  const tooOld = info.kind === "error" && info.code === "server_too_old" && mode !== "login";

  return (
    <section className={styles.group} id={ACCOUNT_SECTION_ID} aria-labelledby="account-heading" tabIndex={-1}>
      <h2 id="account-heading">Konto &amp; Handy</h2>
      {!connected && (
        <p className={styles.muted}>
          Mit einem Konto siehst du deine Notizen und Erinnerungen auch auf dem Handy. Display Buddy funktioniert auch
          ohne Konto.
        </p>
      )}
      <p className={styles.syncStatus} role="status" data-sync-state={status?.state ?? "unknown"}>
        {status ? statusText(status) : "…"}
        {connected && <span className={styles.muted}> · {serverHost(status?.serverUrl ?? "")}</span>}
      </p>
      {warning && (
        <p className={styles.warning} role="alert">
          {warning}
        </p>
      )}
      {problem && (
        <p className={styles.warning} role="alert">
          {problem}
        </p>
      )}
      {stale && <p className={styles.muted}>{stale}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {needsForm && (
        <>
          <div className={styles.serverRow}>
            {customServer ? (
              <>
                <label className={styles.text}>
                  <span>Server-Adresse</span>
                  <input
                    type="url"
                    aria-label="Server-Adresse"
                    placeholder="https://buddy.example.org"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    onBlur={() => serverUrl.trim() && void loadInfo(serverUrl.trim())}
                    autoComplete="url"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    setCustomServer(false);
                    setServerUrl("");
                  }}
                >
                  Standard-Server verwenden
                </button>
              </>
            ) : (
              <>
                <span>Server: {serverHost("")}</span>
                <button type="button" className={styles.link} onClick={() => setCustomServer(true)}>
                  Eigenen Server verwenden …
                </button>
              </>
            )}
          </div>

          <div className={styles.segmented} role="group" aria-label="Konto anlegen oder anmelden">
            <button type="button" aria-pressed={mode === "register"} onClick={() => setMode("register")}>
              Konto anlegen
            </button>
            <button type="button" aria-pressed={mode !== "register"} onClick={() => setMode("login")}>
              Anmelden
            </button>
          </div>

          {tooOld && <p className={styles.warning}>{info.text}</p>}
          {info.kind === "error" && !tooOld && mode !== "login" && <p className={styles.warning}>{info.text}</p>}
          {closed && <p className={styles.warning}>Auf diesem Server kann man sich nicht selbst registrieren.</p>}

          {!tooOld && !closed && (
            <form className={styles.form} onSubmit={(e) => void submit(e)} aria-busy={busy}>
              {mode === "recover" && <p className={styles.formTitle}>Passwort vergessen</p>}
              <Field label="Benutzername" value={username} onChange={setUsername} autoComplete="username"
                hint={mode === "register" ? "3–32 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich." : undefined} />
              {mode === "recover" && (
                <Field label="Wiederherstellungscode" value={recoveryInput} onChange={setRecoveryInput} autoComplete="off"
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
              )}
              <Field
                label={mode === "recover" ? "Neues Passwort" : "Passwort"}
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                hint={mode === "login" ? undefined : "Mindestens 12 Zeichen. Ein langer Satz ist ein gutes Passwort."}
              />
              {mode !== "login" && (
                <Field label="Passwort wiederholen" type="password" value={repeat} onChange={setRepeat} autoComplete="new-password" />
              )}
              <Field label="Gerätename" value={deviceName} onChange={setDeviceName} autoComplete="off" maxLength={64} />
              {mode === "register" && serverInfo?.registration === "invite" && (
                <Field label="Einladungscode" value={inviteCode} onChange={setInviteCode} autoComplete="off" />
              )}
              {mode === "register" && (
                <p className={styles.muted}>Mit dem Anlegen gelten die Datenschutzhinweise des Servers.</p>
              )}
              <div className={styles.buttons}>
                <button type="submit" className={styles.primary} disabled={busy}>
                  {mode === "register" ? "Konto anlegen" : mode === "login" ? "Anmelden" : "Neues Passwort setzen"}
                </button>
                {mode === "login" && (
                  <button type="button" className={styles.link} onClick={() => setMode("recover")}>
                    Passwort vergessen?
                  </button>
                )}
                {mode === "recover" && (
                  <button type="button" className={styles.link} onClick={() => setMode("login")}>
                    Zurück zum Anmelden
                  </button>
                )}
              </div>
              {busy && mode === "register" && <p role="status">Konto wird angelegt …</p>}
            </form>
          )}

          {serverInfo && (serverInfo.legal.privacyUrl || serverInfo.legal.imprintUrl || serverInfo.legal.termsUrl) && (
            <div className={styles.buttons}>
              {serverInfo.legal.privacyUrl && (
                <button type="button" className={styles.link} onClick={() => openLink("privacy")}>
                  Datenschutz
                </button>
              )}
              {serverInfo.legal.imprintUrl && (
                <button type="button" className={styles.link} onClick={() => openLink("imprint")}>
                  Impressum
                </button>
              )}
              {serverInfo.legal.termsUrl && (
                <button type="button" className={styles.link} onClick={() => openLink("terms")}>
                  Nutzungsbedingungen
                </button>
              )}
            </div>
          )}
        </>
      )}

      {connected && !needsForm && (
        <>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || status?.state === "syncing"}
              onClick={() => void syncNow()}
            >
              Jetzt synchronisieren
            </button>
          </div>
          {suggestPairing && (
            <div className={styles.hint}>
              <p>Jetzt dein Handy verbinden?</p>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  setSuggestPairing(false);
                  setPairSignal((n) => n + 1);
                }}
              >
                Jetzt Handy verbinden
              </button>
            </div>
          )}
          <PairingPanel startSignal={pairSignal} />
          <AccountManage onRecoveryCode={(code) => setRecovery({ code, suggest: false })} onDeleted={setStatus} />
        </>
      )}

      {connected && (
        <div className={styles.buttons}>
          {confirmDisconnect ? (
            <>
              <span className={styles.muted} role="alert">
                {pendingText(status?.pending ?? 0)} noch nicht übertragen. Trotzdem trennen?
              </span>
              <button type="button" className={styles.secondary} onClick={() => void disconnect()}>
                Trotzdem trennen
              </button>
              <button type="button" className={styles.secondary} onClick={() => setConfirmDisconnect(false)}>
                Abbrechen
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => ((status?.pending ?? 0) > 0 ? setConfirmDisconnect(true) : void disconnect())}
            >
              Trennen (nur dieser PC)
            </button>
          )}
        </div>
      )}

      {recovery && (
        <RecoveryCodeDialog
          code={recovery.code}
          onDone={() => {
            setRecovery(null);
            if (recovery.suggest) setSuggestPairing(true);
          }}
        />
      )}
    </section>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  type?: "text" | "password";
  hint?: ReactNode;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label className={styles.text}>
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        onChange={(e) => props.onChange(e.target.value)}
        required
        autoComplete={props.autoComplete}
        spellCheck={false}
      />
      {props.hint && <small className={styles.muted}>{props.hint}</small>}
    </label>
  );
}
