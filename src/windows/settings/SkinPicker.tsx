import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { BuddyConfig, SkinData, SkinInfo } from "../../types";
import { BuddyAvatar } from "../buddy/BuddyAvatar";
import styles from "./SkinPicker.module.css";

const TILE_PREVIEW_PX = 56;

export interface SkinPickerProps {
  config: BuddyConfig;
  builtins: { id: string; name: string }[];
  custom: SkinInfo[];
  loadSkin: (id: string) => Promise<SkinData>;
  onSelect: (skin: string) => void;
  /** Opens the native import dialog; resolves true when a skin was imported. */
  onImport: () => Promise<boolean>;
  /** Deletes after confirmation; resolves true on success. */
  onDelete: (skin: SkinInfo) => Promise<boolean>;
}

/** Figure chooser: radio grid of live mini previews, import button, delete with in-app confirm. */
export function SkinPicker({ config, builtins, custom, loadSkin, onSelect, onImport, onDelete }: SkinPickerProps) {
  const uid = useId();
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<SkinInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const importBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const deleteOrigin = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirm) cancelBtn.current?.focus();
  }, [confirm]);

  const closeConfirm = () => {
    setConfirm(null);
    const back = deleteOrigin.current?.isConnected ? deleteOrigin.current : importBtn.current;
    back?.focus();
  };

  const runImport = async () => {
    setImporting(true);
    try {
      await onImport();
    } finally {
      setImporting(false);
    }
  };

  const runDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await onDelete(confirm);
    } finally {
      setDeleting(false);
      closeConfirm();
    }
  };

  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm();
    }
  };

  // Tiles are static previews (no idle animation) in the current colours/eyes/mouth.
  const tileConfig = (skin: string): BuddyConfig => ({
    ...config,
    skin,
    size: TILE_PREVIEW_PX,
    opacity: 1,
    animate: false,
  });

  const tile = (id: string, name: string, info?: SkinInfo) => (
    <div key={id} className={styles.tile} data-testid={`skin-tile-${id}`}>
      <label className={styles.choice}>
        <input
          type="radio"
          name={`${uid}-skin`}
          value={id}
          checked={config.skin === id}
          onChange={() => onSelect(id)}
        />
        <span className={styles.card}>
          <span className={styles.thumb}>
            <BuddyAvatar config={tileConfig(id)} loadSkin={loadSkin} />
          </span>
          <span className={styles.name} title={name}>
            {name}
          </span>
        </span>
      </label>
      {info && (
        <button
          type="button"
          className={styles.delete}
          aria-label={`Figur „${name}“ löschen`}
          title="Löschen"
          onClick={(e) => {
            deleteOrigin.current = e.currentTarget;
            setConfirm(info);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );

  return (
    <fieldset className={styles.picker}>
      <legend>Figur</legend>
      <div className={styles.grid} role="radiogroup" aria-label="Figur">
        {builtins.map((s) => tile(s.id, s.name))}
        {custom.map((s) => tile(s.id, s.name, s))}
      </div>

      {confirm && (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-labelledby={`${uid}-confirm-title`}
          aria-describedby={`${uid}-confirm-text`}
          onKeyDown={onConfirmKey}
        >
          <p id={`${uid}-confirm-title`} className={styles.confirmTitle}>
            Figur „{confirm.name}“ löschen?
          </p>
          <p id={`${uid}-confirm-text`} className={styles.confirmText}>
            Die importierte Datei wird entfernt. Ist sie gerade ausgewählt, erscheint wieder der Smiley.
          </p>
          <div className={styles.confirmActions}>
            <button ref={cancelBtn} type="button" className={styles.button} onClick={closeConfirm} disabled={deleting}>
              Abbrechen
            </button>
            <button type="button" className={styles.danger} onClick={() => void runDelete()} disabled={deleting}>
              Löschen
            </button>
          </div>
        </div>
      )}

      <div className={styles.importRow}>
        <button
          ref={importBtn}
          type="button"
          className={styles.button}
          onClick={() => void runImport()}
          disabled={importing}
          aria-busy={importing}
        >
          Eigenes Bild oder Lottie importieren …
        </button>
        <span className={styles.hint}>PNG, SVG, GIF, WebP oder Lottie-JSON, max. 5 MB</span>
      </div>
    </fieldset>
  );
}
