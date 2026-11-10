/**
 * Login page (PLAN_V4 §6.2, §10): „QR-Code scannen“ (only with an available scanner), „Code
 * eingeben“ and „Mit Passwort anmelden“. No registration here (accounts are created on the PC).
 * Server line + dialog and the foreign-origin confirmation exist only with a ServerSelector
 * (native app); the PWA always talks to its own origin (D-98) and refuses foreign codes.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ServerChoice } from "../../contract";
import { originHost, parsePairingInput, rememberPendingCode, sameOrigin, takePendingCode } from "../../pairing/parse";
import { useAccount, usePendingCount, useSyncStatus } from "../hooks";
import { LegalLinks } from "../Panels";
import { useRouter } from "../router";
import { useServices } from "../services";
import styles from "../ui.module.css";

export const CODE_INVALID_TEXT =
  "Der Code ist ungültig, abgelaufen oder wurde schon benutzt. Lass dir am PC einen neuen anzeigen.";
export const NOT_A_CODE_TEXT = "Das ist kein Display-Buddy-Anmeldecode.";
export const CAMERA_DENIED_TEXT = "Kein Zugriff auf die Kamera. Erlaube ihn in den Einstellungen oder gib den Code ein.";
const CAMERA_FAILED_TEXT = "Die Kamera konnte nicht gestartet werden. Bitte gib den Code ein.";

/** German text for a login failure (SyncError.code / HTTP status of src/web/sync). */
export function errorText(e: unknown): string {
  const { code, status } = (e ?? {}) as { code?: string; status?: number };
  if (code === "pairing_invalid") return CODE_INVALID_TEXT;
  if (code === "device_limit") return "Zu viele Geräte. Bitte zuerst ein altes Gerät abmelden.";
  if (code === "account_disabled") return "Das Konto ist gesperrt.";
  if (code === "unauthorized" || status === 401 || status === 403) return "Benutzername oder Passwort ist falsch.";
  if (code === "too_many_requests" || status === 429) return "Zu viele Versuche. Bitte später erneut versuchen.";
  if (code === "account_mismatch") {
    return "Auf diesem Gerät ist ein anderes Konto angemeldet. Bitte zuerst in den Einstellungen abmelden.";
  }
  if (code === "http" || code === "invalid_response" || code === "bad_request") {
    return "Der Server hat unerwartet geantwortet.";
  }
  return "Der Server ist nicht erreichbar. Bitte Verbindung prüfen.";
}

function serverSetErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("signed_in")) return "Der Server kann nur geändert werden, solange niemand angemeldet ist.";
  if (msg.includes("invalid_url")) return "Diese Adresse ist ungültig. Bitte https://… eingeben.";
  return "Der Server konnte nicht geändert werden.";
}

type Mode = "choose" | "code" | "password";

/** A scanned code of another server (native app only). */
interface ForeignCode {
  code: string;
  origin: string;
}

function ForeignServerDialog({
  foreign,
  own,
  busy,
  onCancel,
  onConfirm,
}: {
  foreign: ForeignCode;
  own: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // „Abbrechen“ is the default action (PLAN_V4 §10)
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className={styles.dialog}
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <h2 id={titleId}>Anderer Server</h2>
      <p>
        Dieser Code gehört zum Server <strong>{originHost(foreign.origin)}</strong>. Das ist nicht dein eingestellter
        Server ({originHost(own)}). Fahre nur fort, wenn du diesen Server selbst betreibst oder ihm vertraust.
      </p>
      <div className={styles.row}>
        <button
          ref={cancelRef}
          type="button"
          className={`${styles.button} ${styles.primary}`}
          aria-label="Abbrechen, Server nicht wechseln"
          onClick={onCancel}
        >
          Abbrechen
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label="Server verwenden und anmelden"
          disabled={busy}
          onClick={onConfirm}
        >
          Server verwenden und anmelden
        </button>
      </div>
    </div>
  );
}

function ServerDialog({ choice, onClose }: { choice: ServerChoice; onClose(): void }) {
  const { server } = useServices();
  const titleId = useId();
  const [value, setValue] = useState(choice.isDefault ? "" : choice.origin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async (origin: string | null) => {
    setError(null);
    setBusy(true);
    try {
      await server?.set(origin); // reloads the app on success (D-97)
    } catch (e) {
      setError(serverSetErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.dialog}
      role="dialog"
      aria-labelledby={titleId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) setError("Bitte die Adresse eingeben.");
        else void apply(value.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <h2 id={titleId}>Eigenen Server verwenden</h2>
      <label className={styles.field}>
        Adresse deines Servers (https://…)
        <input
          className={styles.input}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Adresse deines Servers"
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          aria-label="Server-Adresse übernehmen"
          disabled={busy}
        >
          Übernehmen
        </button>
        {!choice.isDefault && (
          <button
            type="button"
            className={styles.button}
            aria-label="Standard-Server verwenden"
            disabled={busy}
            onClick={() => void apply(null)}
          >
            Standard-Server verwenden
          </button>
        )}
        <button type="button" className={styles.button} aria-label="Server-Dialog schließen" onClick={onClose}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export function LoginPage() {
  const { sync, storage, defaultDeviceName, scanner, server } = useServices();
  const { navigate } = useRouter();
  const status = useSyncStatus();
  const pending = usePendingCount();
  const [mode, setMode] = useState<Mode>("choose");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<ServerChoice | null>(null);
  const [serverDialog, setServerDialog] = useState(false);
  const [foreign, setForeign] = useState<ForeignCode | null>(null);
  const [account] = useAccount();
  // signed in before and the session expired / the device was revoked
  const reconnect = account !== null && status.state === "unauthorized";
  const canScan = !!scanner && scanner.isAvailable();

  useEffect(() => {
    let alive = true;
    server?.current().then(
      (c) => alive && setChoice(c),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [server]);

  const done = () => {
    setPassword("");
    // PLAN §9.2: ask for persistent storage after the login
    void storage?.persist().catch(() => false);
    void sync.syncNow().catch(() => undefined);
    navigate(reconnect ? "/" : "/setup", { replace: true });
  };

  const redeem = async (code: string) => {
    setBusy(true);
    try {
      await sync.loginWithCode(code, deviceName.trim() || defaultDeviceName());
      done();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // native app: a code confirmed for another server survives the reload after server_set
  const pendingTaken = useRef(false);
  useEffect(() => {
    if (!server || pendingTaken.current) return;
    pendingTaken.current = true;
    const code = takePendingCode();
    if (code) void redeem(code);
    // runs once per page load; redeem only reads state set before it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  /** Scanned or typed text → redeem, ask (foreign server, native) or refuse (PWA). */
  const handleInput = async (text: string) => {
    setError(null);
    const parsed = parsePairingInput(text);
    if (parsed.kind === "invalid") {
      setError(NOT_A_CODE_TEXT);
      return;
    }
    if (parsed.origin) {
      const own = server
        ? ((choice ?? (await server.current().catch(() => null)))?.origin ?? null)
        : (globalThis.location?.origin ?? null);
      if (!own || !sameOrigin(parsed.origin, own)) {
        if (server && own) setForeign({ code: parsed.code, origin: parsed.origin });
        else setError(`Dieser Code gehört zu einem anderen Server (${originHost(parsed.origin)}). Öffne ihn dort.`);
        return;
      }
    }
    await redeem(parsed.code);
  };

  const scan = async () => {
    if (!scanner) return;
    setError(null);
    try {
      const text = await scanner.scan();
      if (text !== null) await handleInput(text);
    } catch (e) {
      setError(e instanceof Error && e.message === "camera_denied" ? CAMERA_DENIED_TEXT : CAMERA_FAILED_TEXT);
    }
  };

  const confirmForeign = async () => {
    if (!foreign || !server) return;
    setBusy(true);
    rememberPendingCode(foreign.code);
    try {
      await server.set(foreign.origin); // reloads; the code is redeemed after the restart
    } catch (e) {
      takePendingCode();
      setForeign(null);
      setError(serverSetErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Bitte Benutzername und Passwort eingeben.");
      return;
    }
    setBusy(true);
    try {
      await sync.login(username.trim(), password, deviceName.trim() || defaultDeviceName());
      done();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!codeInput.trim()) {
      setError("Bitte den Anmeldecode eingeben.");
      return;
    }
    void handleInput(codeInput);
  };

  const switchMode = (next: Mode) => {
    setError(null);
    setMode(next);
  };

  const deviceField = (
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
  );
  const errorLine = error && (
    <p className={styles.error} role="alert">
      {error}
    </p>
  );

  return (
    <main className={styles.main}>
      <section className={styles.card} aria-label="Anmelden">
        <h2>{reconnect ? "Bitte neu anmelden" : "Anmelden"}</h2>
        {reconnect && pending > 0 && (
          <p className={styles.muted} role="status">
            {pending === 1
              ? "1 Änderung wird nach dem Anmelden übertragen."
              : `${pending} Änderungen werden nach dem Anmelden übertragen.`}
          </p>
        )}
        <p className={styles.muted}>Öffne am PC Display Buddy → Einstellungen → Konto & Handy → ‚Handy verbinden‘.</p>
        <div className={styles.row}>
          {canScan && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              aria-label="QR-Code scannen"
              disabled={busy}
              onClick={() => void scan()}
            >
              QR-Code scannen
            </button>
          )}
          <button
            type="button"
            className={styles.button}
            aria-label="Code eingeben"
            aria-pressed={mode === "code"}
            onClick={() => switchMode("code")}
          >
            Code eingeben
          </button>
          <button
            type="button"
            className={styles.button}
            aria-label="Mit Passwort anmelden"
            aria-pressed={mode === "password"}
            onClick={() => switchMode("password")}
          >
            Mit Passwort anmelden
          </button>
        </div>
        {canScan && <p className={styles.muted}>Kamera-Zugriff wird nur zum Scannen benötigt.</p>}
        {mode === "choose" && errorLine}
        {foreign && (
          <ForeignServerDialog
            foreign={foreign}
            own={choice?.origin ?? ""}
            busy={busy}
            onCancel={() => setForeign(null)}
            onConfirm={() => void confirmForeign()}
          />
        )}
      </section>

      {mode === "code" && (
        <form className={styles.card} onSubmit={submitCode} aria-label="Mit Code anmelden" noValidate>
          <label className={styles.field}>
            Anmeldecode
            <input
              className={styles.input}
              name="pairingCode"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
              autoFocus
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              aria-label="Anmeldecode"
            />
          </label>
          {deviceField}
          {errorLine}
          <button
            type="submit"
            className={`${styles.button} ${styles.primary}`}
            disabled={busy}
            aria-label="Mit Code anmelden"
          >
            {busy ? "Anmelden …" : "Anmelden"}
          </button>
        </form>
      )}

      {mode === "password" && (
        <form
          className={styles.card}
          onSubmit={(e) => void submitPassword(e)}
          aria-label="Mit Passwort anmelden"
          noValidate
        >
          <label className={styles.field}>
            Benutzername
            <input
              className={styles.input}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
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
          {deviceField}
          {errorLine}
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy} aria-label="Anmelden">
            {busy ? "Anmelden …" : "Anmelden"}
          </button>
        </form>
      )}

      <section className={styles.card} aria-label="Konto und Server">
        <p className={styles.muted}>Noch kein Konto? Lege es am PC in Display Buddy an.</p>
        {server && choice && (
          <p className={styles.muted}>
            Server: {originHost(choice.origin)} ·{" "}
            <button
              type="button"
              className={styles.linkButton}
              aria-label="Server ändern"
              onClick={() => setServerDialog(true)}
            >
              ändern
            </button>
          </p>
        )}
        {serverDialog && choice && <ServerDialog choice={choice} onClose={() => setServerDialog(false)} />}
        <LegalLinks />
      </section>
    </main>
  );
}
