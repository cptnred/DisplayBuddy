/**
 * /pair#c=<code> (PLAN_V4 §6.2 way A): opened by the phone's camera app. The fragment is read
 * once and removed at once with history.replaceState (MDN: changes the URL without a request
 * or reload), so it is neither in the history nor shared further. The code is NEVER redeemed
 * automatically (link previews, prefetch): only „Hier anmelden“ sends POST /session/pairing.
 */
import { useEffect, useState } from "react";
import { formatCode, normalizeCode } from "../../../lib/pairing";
import { originHost } from "../../pairing/parse";
import { useAccount, useSyncStatus } from "../hooks";
import { Link, useRouter } from "../router";
import { useServices } from "../services";
import styles from "../ui.module.css";
import { errorText, NOT_A_CODE_TEXT } from "./LoginPage";

/** "#c=ABCD-EFGH-JKMN" → normalised code; anything else (other parameters too) → null. */
export function codeFromFragment(hash: string): string | null {
  const m = /^#c=([^&#]*)$/.exec(hash);
  return m ? normalizeCode(m[1]) : null;
}

export function PairPage() {
  const { sync, storage, defaultDeviceName } = useServices();
  const { navigate, hash } = useRouter();
  const [code] = useState(() => codeFromFragment(hash()));
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, accountLoaded] = useAccount();
  const status = useSyncStatus();

  useEffect(() => {
    if (hash()) navigate("/pair", { replace: true });
  }, [hash, navigate]);

  const signIn = async () => {
    if (!code) return;
    setError(null);
    setBusy(true);
    try {
      await sync.loginWithCode(code, deviceName.trim() || defaultDeviceName());
      void storage?.persist().catch(() => false);
      navigate("/setup", { replace: true });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (!accountLoaded) return null;
  if (account && status.state !== "unauthorized") {
    return (
      <main className={styles.main}>
        <section className={styles.card} aria-label="Schon angemeldet">
          <p role="status">Du bist schon als ‚{account.username}‘ angemeldet.</p>
          <div className={styles.row}>
            <Link to="/" className={styles.linkButton}>
              Zur Übersicht
            </Link>
          </div>
        </section>
      </main>
    );
  }
  if (!code) {
    return (
      <main className={styles.main}>
        <section className={styles.card} aria-label="Anmeldecode">
          <p className={styles.error} role="alert">
            {NOT_A_CODE_TEXT}
          </p>
          <div className={styles.row}>
            <Link to="/login" className={styles.linkButton}>
              Zur Anmeldung
            </Link>
          </div>
        </section>
      </main>
    );
  }
  return (
    <main className={styles.main}>
      <form
        className={styles.card}
        aria-label="Dieses Gerät anmelden"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <h2>Dieses Gerät anmelden</h2>
        <p className={styles.muted}>Server: {originHost(globalThis.location?.origin ?? "")}</p>
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
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={busy}
          aria-label="Hier anmelden"
        >
          {busy ? "Anmelden …" : "Hier anmelden"}
        </button>
        <p className={styles.muted}>
          Nutzt du die Display-Buddy-App oder die installierte Web-App? Dann tippe dort auf ‚Code eingeben‘:{" "}
          <strong>{formatCode(code)}</strong>
        </p>
      </form>
    </main>
  );
}
