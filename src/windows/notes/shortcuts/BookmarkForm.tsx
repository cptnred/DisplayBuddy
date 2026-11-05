import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { normalizeBookmarkUrl } from "./url";
import styles from "./ShortcutBar.module.css";

export interface BookmarkFormProps {
  /** Resolves when stored; rejects with the backend error. */
  onSubmit: (name: string, url: string) => Promise<void>;
  onCancel: () => void;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/** Inline form „Lesezeichen hinzufügen“: Name (optional) + URL. Enter submits, Esc cancels. */
export function BookmarkForm({ onSubmit, onCancel }: BookmarkFormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const alive = useRef(true);

  useEffect(() => {
    nameRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const check = normalizeBookmarkUrl(url);
    if (!check.ok) {
      setError(check.error);
      urlRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), check.url);
    } catch (err) {
      if (!alive.current) return;
      setError(`Lesezeichen konnte nicht gespeichert werden: ${errorText(err)}`);
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <form
      className={styles.form}
      aria-label="Lesezeichen hinzufügen"
      data-local-escape=""
      noValidate
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
    >
      <input
        ref={nameRef}
        className={styles.input}
        type="text"
        aria-label="Name (optional)"
        placeholder="Name (optional)"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        ref={urlRef}
        className={styles.input}
        type="url"
        inputMode="url"
        aria-label="Adresse"
        placeholder="https://…"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          if (error) setError(null);
        }}
      />
      <div className={styles.formButtons}>
        <button type="submit" className={styles.primary} disabled={busy}>
          Hinzufügen
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
      {error && (
        <p id={errorId} className={styles.formError} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
