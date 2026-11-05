import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../lib/api";
import { DEFAULT_BUDDY, type BuddyConfig } from "../../types";
import { createDragClickTracker } from "./dragClick";
import { clampSpeed, HOP_MS, Smiley } from "./Smiley";
import styles from "./BuddyApp.module.css";

export const BUDDY_LABEL = "Display Buddy – Notizen öffnen oder schließen";
const BUDDY_TITLE = "Klicken: Notizen · Ziehen: verschieben · Rechtsklick: Menü";
/** A contextmenu event right after a keyboard-opened menu is the same gesture. */
const KEY_MENU_DEDUPE_MS = 500;

function logError(what: string) {
  return (err: unknown) => console.error(`[buddy] ${what} failed:`, err);
}

export function BuddyApp() {
  const [config, setConfig] = useState<BuddyConfig | null>(null);
  const [hovered, setHovered] = useState(false);
  const [hopping, setHopping] = useState(false);

  const tracker = useRef(createDragClickTracker({ threshold: 4 })).current;
  const hopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastKeyMenu = useRef(0);
  const speedRef = useRef(1);
  speedRef.current = clampSpeed(config?.animationSpeed ?? 1);

  // ---- settings ------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    let gotEvent = false;
    let unlisten: (() => void) | undefined;

    api
      .onSettingsChanged((s) => {
        if (!alive) return;
        gotEvent = true;
        setConfig(s.buddy);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(logError("onSettingsChanged"));

    api
      .loadSettings()
      .then((s) => {
        // A settings-changed event that arrived meanwhile is newer than this load.
        if (alive && !gotEvent) setConfig(s.buddy);
      })
      .catch((err) => {
        logError("loadSettings")(err);
        if (alive && !gotEvent) setConfig(DEFAULT_BUDDY);
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // ---- gesture state resets -------------------------------------------------
  useEffect(() => {
    const reset = () => tracker.cancel();
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("blur", reset);
      clearTimeout(hopTimer.current);
    };
  }, [tracker]);

  // ---- actions ---------------------------------------------------------------
  const hop = useCallback(() => {
    clearTimeout(hopTimer.current);
    setHopping(true);
    hopTimer.current = setTimeout(() => setHopping(false), HOP_MS / speedRef.current);
  }, []);

  const activate = useCallback(() => {
    hop();
    api.toggleNotes().catch(logError("toggleNotes"));
  }, [hop]);

  const openMenu = useCallback(() => {
    tracker.cancel();
    api.showBuddyMenu().catch(logError("showBuddyMenu"));
  }, [tracker]);

  // ---- pointer -----------------------------------------------------------------
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    tracker.down(e.screenX, e.screenY);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best effort */
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!tracker.active) return;
    if (tracker.move(e.screenX, e.screenY) === "drag") {
      // The OS takes over from here; pointerup may never arrive.
      tracker.cancel();
      getCurrentWindow().startDragging().catch(logError("startDragging"));
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (tracker.up() === "click") activate();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (Date.now() - lastKeyMenu.current < KEY_MENU_DEDUPE_MS) return;
    openMenu();
  };

  // ---- keyboard ----------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!e.repeat) activate();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      lastKeyMenu.current = Date.now();
      openMenu();
    }
  };

  return (
    <div className={styles.root}>
      <div
        className={styles.buddy}
        role="button"
        tabIndex={0}
        aria-label={BUDDY_LABEL}
        title={BUDDY_TITLE}
        style={config ? { width: config.size, height: config.size } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => tracker.cancel()}
        onLostPointerCapture={() => tracker.cancel()}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onDragStart={(e) => e.preventDefault()}
      >
        {config && <Smiley config={config} hovered={hovered} hopping={hopping} />}
      </div>
    </div>
  );
}
