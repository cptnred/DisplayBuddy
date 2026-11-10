import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatRecoveryCode } from "../../lib/pairing";
import styles from "./AccountSection.module.css";

export interface RecoveryCodeDialogProps {
  /** Normalised 24 characters. */
  code: string;
  onDone: () => void;
}

/**
 * Mandatory step after registering, recovering or a new code (PLAN_V4 §6.1): the code is
 * shown only now. Focus stays inside; Esc does NOT close (data-local-escape); „Weiter“ only
 * after the box is ticked.
 */
export function RecoveryCodeDialog({ code, onDone }: RecoveryCodeDialogProps) {
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const formatted = formatRecoveryCode(code);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    copyRef.current?.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault(); // deliberately no way out without confirming
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [
      ...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"),
    ];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !dialogRef.current.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !dialogRef.current.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop} data-local-escape>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.dialogTitle}>
          Dein Wiederherstellungscode
        </h2>
        <p id={textId}>
          Mit diesem Code kannst du ein neues Passwort setzen, falls du deins vergisst. Er wird nur jetzt angezeigt.
          Bewahre ihn sicher auf, z. B. im Passwort-Manager oder ausgedruckt.
        </p>
        <p className={styles.bigCode} aria-label={`Wiederherstellungscode ${formatted}`}>
          {formatted}
        </p>
        <div className={styles.buttons}>
          <button ref={copyRef} type="button" className={styles.secondary} onClick={() => void copy()}>
            Kopieren
          </button>
          <span className={styles.muted} role="status">
            {copied === "ok" ? "Kopiert." : copied === "failed" ? "Kopieren nicht möglich – bitte abschreiben." : ""}
          </span>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
          <span>Ich habe den Code sicher aufbewahrt.</span>
        </label>
        <div className={styles.buttons}>
          <button type="button" className={styles.primary} disabled={!stored} onClick={onDone}>
            Weiter
          </button>
        </div>
      </div>
    </div>
  );
}
