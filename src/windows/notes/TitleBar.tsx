import type { MouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import styles from "./TitleBar.module.css";

export interface TitleBarProps {
  pinned: boolean;
  canDelete: boolean;
  onNew: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onClose: () => void;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" className={styles.icon}>
      {children}
    </svg>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Single drag mechanism (Tauri's built-in data-tauri-drag-region script is deliberately not
 * used, so a press never starts two native drags). Starts a native window drag when the empty title-bar area is pressed with the primary button. */
function onDragMouseDown(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target.hasAttribute("data-drag-region")) return;
  try {
    void getCurrentWindow()
      .startDragging()
      .catch(() => {});
  } catch {
    // not running inside Tauri (tests / browser preview)
  }
}

export function TitleBar({ pinned, canDelete, onNew, onDelete, onTogglePin, onClose }: TitleBarProps) {
  return (
    <header className={styles.bar} data-drag-region onMouseDown={onDragMouseDown}>
      <button type="button" className={styles.newButton} aria-label="Neue Notiz" title="Neue Notiz (Strg+N)" onClick={onNew}>
        <Icon>
          <path d="M8 3.5v9M3.5 8h9" {...stroke} strokeWidth={1.8} />
        </Icon>
        <span>Neue Notiz</span>
      </button>
      <span className={styles.drag} data-drag-region />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Löschen"
        title="Notiz löschen"
        onClick={onDelete}
        disabled={!canDelete}
      >
        <Icon>
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1c.05.8.7 1.4 1.5 1.4h2.8c.8 0 1.45-.6 1.5-1.4l.6-8.1M6.8 7v4.5M9.2 7v4.5" {...stroke} />
        </Icon>
      </button>
      <button
        type="button"
        className={`${styles.iconButton} ${pinned ? styles.pressed : ""}`}
        aria-label="Anheften"
        aria-pressed={pinned}
        title={pinned ? "Anheften lösen" : "Fenster anheften (bleibt bei Fokusverlust offen)"}
        onClick={onTogglePin}
      >
        <Icon>
          <path
            d="M9.8 2.5 13.5 6.2l-1.4.5-2.3 2.3.3 2.6-1 1-2.4-2.4L3.5 13.5M6.7 10.2 4.3 7.8l1-1 2.6.3 2.3-2.3.6-1.3"
            {...stroke}
            fill={pinned ? "currentColor" : "none"}
            fillOpacity={pinned ? 0.25 : 0}
          />
        </Icon>
      </button>
      <button type="button" className={`${styles.iconButton} ${styles.close}`} aria-label="Schließen" title="Schließen (Esc)" onClick={onClose}>
        <Icon>
          <path d="M4 4l8 8M12 4l-8 8" {...stroke} strokeWidth={1.7} />
        </Icon>
      </button>
    </header>
  );
}
