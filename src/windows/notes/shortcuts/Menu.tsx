import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import styles from "./ShortcutBar.module.css";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a separator above this item. */
  separated?: boolean;
}

/** Viewport rect the menu is attached to (a tile, a button or the pointer position). */
export interface MenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function anchorFromElement(el: Element): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

export function anchorFromPoint(x: number, y: number): MenuAnchor {
  return { left: x, right: x, top: y, bottom: y };
}

const MARGIN = 6;
const GAP = 4;

/**
 * Places a menu of size w×h next to `anchor` inside a vw×vh viewport.
 * Prefers opening upward (the bar sits at the bottom of the window); flips below when there
 * is no room above. Horizontally aligned to the anchor's start (or end) edge and clamped.
 */
export function placeMenu(
  anchor: MenuAnchor,
  w: number,
  h: number,
  vw: number,
  vh: number,
  align: "start" | "end",
): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, vw - w - MARGIN);
  const left = Math.min(Math.max(align === "end" ? anchor.right - w : anchor.left, MARGIN), maxLeft);
  let top = anchor.top - h - GAP;
  if (top < MARGIN) top = Math.max(MARGIN, Math.min(anchor.bottom + GAP, vh - h - MARGIN));
  return { left, top };
}

export interface MenuProps {
  label: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  align?: "start" | "end";
  /** Pointer-downs inside this element do not close the menu (its toggle button). */
  ignore?: HTMLElement | null;
  /** `restoreFocus` = true when closed by keyboard (Esc/Tab) or by choosing an item. */
  onClose: (restoreFocus: boolean) => void;
}

/** Small popup menu rendered inside the window (position: fixed). Esc stays local. */
export function Menu({ label, items, anchor, align = "start", ignore, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const latest = useRef({ onClose, ignore });
  latest.current = { onClose, ignore };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeMenu(anchor, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, align));
  }, [anchor, align]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || latest.current.ignore?.contains(t)) return;
      latest.current.onClose(false);
    };
    const onResize = () => latest.current.onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        return;
      case "ArrowDown":
        next = buttons[(i + 1) % buttons.length];
        break;
      case "ArrowUp":
        next = buttons[(i - 1 + buttons.length) % buttons.length];
        break;
      case "Home":
        next = buttons[0];
        break;
      case "End":
        next = buttons[buttons.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-local-escape=""
      className={styles.menu}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.label} role="none">
          {item.separated && <div className={styles.separator} role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${item.danger ? styles.danger : ""}`}
            disabled={item.disabled}
            onClick={() => {
              onClose(true);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
