import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../lib/api";
import { DEFAULT_BUDDY, type BuddyConfig, type Reminder } from "../../types";
import { BuddyAvatar } from "./BuddyAvatar";
import { createDragClickTracker } from "./dragClick";
import { clampSpeed, HOP_MS } from "./motion";
import styles from "./BuddyApp.module.css";

export const BUDDY_LABEL = "Display Buddy – Notizen öffnen oder schließen";
export const BUDDY_ALERT_LABEL = "Display Buddy – Erinnerung fällig, klicken zum Öffnen";
const BUDDY_TITLE = "Klicken: Notizen · Ziehen: verschieben · Rechtsklick: Menü";
const BUDDY_ALERT_TITLE = "Klicken: fällige Notiz öffnen · Ziehen: verschieben · Rechtsklick: Menü";
/** A contextmenu event right after a keyboard-opened menu is the same gesture. */
const KEY_MENU_DEDUPE_MS = 500;

const timeOf = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** Due reminders, oldest first (by fire time, then by scheduled time). */
export function dueReminders(reminders: Reminder[]): Reminder[] {
  return reminders
    .filter((r) => r.state === "due")
    .sort((a, b) => timeOf(a.firedAt ?? a.at) - timeOf(b.firedAt ?? b.at) || timeOf(a.at) - timeOf(b.at));
}

function BellBadge({ count, size }: { count: number; size: number }) {
  const style = { fontSize: Math.min(20, Math.max(10, size * 0.13)) } as CSSProperties;
  return (
    <span className={styles.badge} style={style} aria-hidden="true" data-testid="reminder-badge">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 2a1.5 1.5 0 0 0-1.5 1.5v.6A6 6 0 0 0 6 10v4.2l-1.6 2.4A.9.9 0 0 0 5.2 18h13.6a.9.9 0 0 0 .8-1.4L18 14.2V10a6 6 0 0 0-4.5-5.9v-.6A1.5 1.5 0 0 0 12 2Zm-2.5 17a2.5 2.5 0 0 0 5 0Z" />
      </svg>
      <span>{count > 9 ? "9+" : count}</span>
    </span>
  );
}

function logError(what: string) {
  return (err: unknown) => console.error(`[buddy] ${what} failed:`, err);
}

export function BuddyApp() {
  const [config, setConfig] = useState<BuddyConfig | null>(null);
  const [hovered, setHovered] = useState(false);
  const [hopping, setHopping] = useState(false);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const due = useMemo(() => dueReminders(reminders), [reminders]);
  const dueRef = useRef(due);
  dueRef.current = due;

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

  // ---- reminders ------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    let gotEvent = false;
    let unlisten: (() => void) | undefined;

    api
      .onRemindersChanged((list) => {
        if (!alive) return;
        gotEvent = true;
        setReminders(list);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(logError("onRemindersChanged"));

    api
      .listReminders()
      .then((list) => {
        if (alive && !gotEvent) setReminders(list);
      })
      .catch(logError("listReminders"));

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
    const oldest = dueRef.current[0];
    if (oldest) api.openNote(oldest.noteId).catch(logError("openNote"));
    else api.toggleNotes().catch(logError("toggleNotes"));
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
        aria-label={due.length > 0 ? BUDDY_ALERT_LABEL : BUDDY_LABEL}
        title={due.length > 0 ? BUDDY_ALERT_TITLE : BUDDY_TITLE}
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
        {config && (
          <BuddyAvatar
            config={config}
            hovered={hovered}
            hopping={hopping}
            alert={due.length > 0}
            alertCount={due.length}
          />
        )}
        {config && due.length > 0 && <BellBadge count={due.length} size={config.size} />}
      </div>
    </div>
  );
}
