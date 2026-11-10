import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { PAIRING_TTL_MS, formatCode } from "../../lib/pairing";
import type { PairingInfo, PairingStatus } from "../../types";
import { accountErrorText, errorCode, formatCountdown } from "./accountTexts";
import styles from "./AccountSection.module.css";

/** The settings window asks the server every 2 s (PLAN_V4 §6.2). */
export const POLL_MS = 2_000;
/** Below this the countdown is announced once more (aria-live only at start and < 30 s). */
const ANNOUNCE_BELOW_MS = 30_000;

type View =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "pending"; info: PairingInfo; startedAt: number }
  | { kind: "redeemed"; device: NonNullable<PairingStatus["device"]> | null }
  | { kind: "expired" };

export interface PairingPanelProps {
  /** Increment to start a code from outside („Jetzt Handy verbinden“). */
  startSignal?: number;
}

/** „Handy verbinden“: QR only after the click, countdown, code as text, success/expiry. */
export function PairingPanel({ startSignal = 0 }: PairingPanelProps) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [announce, setAnnounce] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const pendingId = useRef<string | null>(null);
  const announcedLate = useRef(false);

  const cancelPending = useCallback(() => {
    const id = pendingId.current;
    pendingId.current = null;
    if (id) void api.pairingCancel(id).catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    cancelPending();
    setError(null);
    setNotice(null);
    setView({ kind: "starting" });
    try {
      const info = await api.pairingStart();
      pendingId.current = info.pairingId;
      announcedLate.current = false;
      const t = Date.now();
      setNow(t);
      setView({ kind: "pending", info, startedAt: t });
      setAnnounce(`Gültig noch ${formatCountdown(PAIRING_TTL_MS)}`);
    } catch (e) {
      setView({ kind: "idle" });
      setError(accountErrorText(e));
    }
  }, [cancelPending]);

  // cancel an open code when the section/window goes away
  useEffect(() => cancelPending, [cancelPending]);

  useEffect(() => {
    if (startSignal > 0) void start();
  }, [startSignal, start]);

  const pending = view.kind === "pending" ? view : null;

  // countdown (1 s) and polling (2 s) while a code is open
  useEffect(() => {
    if (!pending) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    let busy = false;
    const poll = setInterval(() => {
      if (busy) return;
      busy = true;
      api
        .pairingStatus(pending.info.pairingId)
        .then((s) => {
          if (pendingId.current !== s.pairingId) return;
          if (s.state === "redeemed") {
            pendingId.current = null;
            setView({ kind: "redeemed", device: s.device });
          } else if (s.state === "expired" || s.state === "cancelled") {
            pendingId.current = null;
            setView({ kind: "expired" });
          }
        })
        .catch((e) => {
          if (errorCode(e) === "pairing_invalid") {
            pendingId.current = null;
            setView({ kind: "expired" });
          } // network hiccups: keep polling
        })
        .finally(() => {
          busy = false;
        });
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pending]);

  const remaining = pending ? PAIRING_TTL_MS - (now - pending.startedAt) : 0;

  useEffect(() => {
    if (!pending) return;
    if (remaining <= 0) {
      cancelPending();
      setView({ kind: "expired" });
    } else if (remaining < ANNOUNCE_BELOW_MS && !announcedLate.current) {
      announcedLate.current = true;
      setAnnounce(`Gültig noch ${formatCountdown(remaining)}`);
    }
  }, [pending, remaining, cancelPending]);

  const abort = () => {
    cancelPending();
    setView({ kind: "idle" });
  };

  const notMe = async (device: { id: string; name: string }) => {
    setError(null);
    try {
      await api.accountRevokeDevice(device.id);
      setView({ kind: "idle" });
      setNotice(`‚${device.name}‘ wurde abgemeldet.`);
    } catch (e) {
      setError(accountErrorText(e));
    }
  };

  return (
    <div className={styles.block} aria-labelledby="pairing-heading" role="group">
      <h3 id="pairing-heading">Handy verbinden</h3>
      <p className={styles.srOnly} aria-live="polite">
        {announce}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {notice && <p role="status">{notice}</p>}

      {(view.kind === "idle" || view.kind === "starting") && (
        <button type="button" className={styles.primary} disabled={view.kind === "starting"} onClick={() => void start()}>
          Handy verbinden
        </button>
      )}

      {pending && (
        <div className={styles.pairing}>
          <p>Scanne den Code mit der Kamera deines Handys (Web-App) oder in der Display-Buddy-App mit ‚QR-Code scannen‘.</p>
          <img
            className={styles.qr}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pending.info.qrSvg)}`}
            alt={`QR-Code zum Anmelden, Code ${formatCode(pending.info.code)}`}
          />
          <p>
            Oder gib diesen Code ein: <strong className={styles.code}>{formatCode(pending.info.code)}</strong>
          </p>
          <p className={styles.muted}>Gültig noch {formatCountdown(remaining)}</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.secondary} onClick={abort}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {view.kind === "redeemed" && (
        <div className={styles.pairing}>
          <p role="status">✓ ‚{view.device?.name ?? "Ein Gerät"}‘ ist jetzt angemeldet.</p>
          <div className={styles.buttons}>
            {view.device && (
              <button type="button" className={styles.secondary} onClick={() => void notMe(view.device!)}>
                Das war ich nicht – abmelden
              </button>
            )}
            <button type="button" className={styles.secondary} onClick={() => setView({ kind: "idle" })}>
              Fertig
            </button>
          </div>
        </div>
      )}


      {view.kind === "expired" && (
        <div className={styles.pairing}>
          <p role="status">Der Code ist abgelaufen.</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.primary} onClick={() => void start()}>
              Neuen Code
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
