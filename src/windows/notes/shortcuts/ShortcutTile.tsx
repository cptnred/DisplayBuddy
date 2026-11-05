import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Shortcut } from "../../../types";
import { ShortcutIcon } from "./icons";
import styles from "./ShortcutBar.module.css";

export interface ShortcutTileProps {
  shortcut: Shortcut;
  tabbable: boolean;
  renaming: boolean;
  dragging: boolean;
  /** translateX in px while a drag is in progress (dragged tile or a neighbour making room). */
  shiftX: number | null;
  onActivate: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: () => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
  onMore: (button: HTMLElement) => void;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className={styles.renameInput}
      aria-label="Neuer Name"
      data-local-escape=""
      value={value}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function ShortcutTile(props: ShortcutTileProps) {
  const { shortcut, renaming, dragging, shiftX } = props;
  const style: CSSProperties | undefined = shiftX === null ? undefined : { transform: `translateX(${shiftX}px)` };
  const title = shortcut.name === shortcut.target ? shortcut.name : `${shortcut.name}\n${shortcut.target}`;

  return (
    <div
      className={`${styles.tileWrap} ${dragging ? styles.dragging : ""}`}
      style={style}
      data-tile-wrap=""
    >
      {renaming ? (
        <div className={styles.tile} title={title}>
          <ShortcutIcon shortcut={shortcut} />
          <RenameInput initial={shortcut.name} onCommit={props.onRenameCommit} onCancel={props.onRenameCancel} />
        </div>
      ) : (
        <>
          <button
            type="button"
            className={styles.tile}
            title={title}
            data-shortcut-id={shortcut.id}
            tabIndex={props.tabbable ? 0 : -1}
            aria-keyshortcuts="Enter F2 Delete Shift+F10"
            onClick={props.onActivate}
            onKeyDown={props.onKeyDown}
            onFocus={props.onFocus}
            onContextMenu={props.onContextMenu}
            onPointerDown={props.onPointerDown}
            onPointerMove={props.onPointerMove}
            onPointerUp={props.onPointerUp}
            onPointerCancel={props.onPointerCancel}
          >
            <ShortcutIcon shortcut={shortcut} />
            <span className={styles.name}>{shortcut.name}</span>
          </button>
          <button
            type="button"
            className={styles.more}
            tabIndex={-1}
            aria-label={`Optionen für ${shortcut.name}`}
            aria-haspopup="menu"
            onClick={(e) => props.onMore(e.currentTarget)}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
