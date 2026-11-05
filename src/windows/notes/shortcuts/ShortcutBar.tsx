import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { api, type SettingsPatch } from "../../../lib/api";
import type { Shortcut, ShortcutList, ShortcutsData } from "../../../types";
import { BookmarkForm, errorText } from "./BookmarkForm";
import { anchorFromElement, anchorFromPoint, Menu, type MenuAnchor, type MenuItem } from "./Menu";
import { computeDropIndex, moveItem, shiftDuringDrag } from "./reorder";
import { ShortcutTile } from "./ShortcutTile";
import styles from "./ShortcutBar.module.css";

const TABS: { id: ShortcutList; label: string }[] = [
  { id: "items", label: "Programme & Ordner" },
  { id: "bookmarks", label: "Lesezeichen" },
];

const EMPTY_TEXT: Record<ShortcutList, string> = {
  items: "Dateien, Programme oder Ordner hierher ziehen oder mit + hinzufügen",
  bookmarks: "Noch keine Lesezeichen – mit + hinzufügen",
};

export const DROP_HINT = "Hier ablegen, um Verknüpfungen hinzuzufügen";
export const MESSAGE_MS = 4000;
const DRAG_THRESHOLD = 5;

/** Maps backend errors of `open_shortcut` to a short German message. */
export function openErrorText(err: unknown): string {
  const msg = errorText(err);
  if (/not found|nicht gefunden/i.test(msg)) return "Ziel nicht gefunden";
  return `Öffnen fehlgeschlagen: ${msg}`;
}

function unlistenLater(sub: Promise<() => void> | (() => void)) {
  return () => {
    Promise.resolve(sub)
      .then((un) => un?.())
      .catch(() => {});
  };
}

interface PointerState {
  id: string;
  from: number;
  startX: number;
  pointerId: number;
  /** Tile midpoints at drag start (viewport x). */
  mids: number[];
  /** Distance between two neighbouring tiles. */
  step: number;
  dragging: boolean;
}

interface DragView {
  id: string;
  from: number;
  to: number;
  dx: number;
  step: number;
}

export function ShortcutBar() {
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (t: ShortcutList) => `${baseId}-tab-${t}`;

  const [data, setData] = useState<ShortcutsData | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<ShortcutList>("items");
  const [collapsed, setCollapsed] = useState(false);
  const [osDrag, setOsDrag] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState<MenuAnchor | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [tileMenu, setTileMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);

  const addButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<ShortcutList, HTMLButtonElement | null>>>({});
  const pendingFocus = useRef<string | null>(null);
  const pointer = useRef<PointerState | null>(null);
  const suppressClick = useRef(false);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Settings the user already changed before `loadSettings` resolved. */
  const touched = useRef({ tab: false, collapsed: false });
  /** Bumped on every applied data update; stale responses are dropped. */
  const dataVersion = useRef(0);
  const mutationSeq = useRef(0);
  const latest = useRef({ tab, collapsed });
  latest.current = { tab, collapsed };

  const list: Shortcut[] = data?.[tab] ?? [];
  const expanded = !collapsed || osDrag;

  // ---- feedback -------------------------------------------------------------
  const showMessage = useCallback((text: string) => {
    clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, []);
  useEffect(() => () => clearTimeout(messageTimer.current), []);

  const persist = useCallback((patch: SettingsPatch) => {
    api.saveSettings(patch).catch((err: unknown) => console.error("[shortcuts] saving settings failed", err));
  }, []);

  // ---- data ----------------------------------------------------------------
  const applyData = useCallback((d: ShortcutsData) => {
    dataVersion.current++;
    setData(d);
  }, []);

  /** Runs a mutating command; only the latest one's result is applied (events always are). */
  const mutate = useCallback(
    (run: () => Promise<ShortcutsData>, failText: string) => {
      const seq = ++mutationSeq.current;
      return run().then(
        (d) => {
          if (seq === mutationSeq.current) applyData(d);
        },
        (err: unknown) => {
          showMessage(`${failText}: ${errorText(err)}`);
          // resync after a failed optimistic update
          if (seq === mutationSeq.current) {
            api.listShortcuts().then(applyData, () => {});
          }
        },
      );
    },
    [applyData, showMessage],
  );

  useEffect(() => {
    let alive = true;
    const version = dataVersion.current;
    api
      .listShortcuts()
      .then((d) => {
        if (alive && dataVersion.current === version) applyData(d);
      })
      .catch((err: unknown) => {
        if (alive) showMessage(`Verknüpfungen konnten nicht geladen werden: ${errorText(err)}`);
      });
    api
      .loadSettings()
      .then((s) => {
        if (!alive) return;
        if (!touched.current.tab && (s.shortcutBarTab === "items" || s.shortcutBarTab === "bookmarks")) {
          setTab(s.shortcutBarTab);
        }
        if (!touched.current.collapsed && typeof s.shortcutBarCollapsed === "boolean") {
          setCollapsed(s.shortcutBarCollapsed);
        }
      })
      .catch((err: unknown) => console.error("[shortcuts] loading settings failed", err))
      .finally(() => {
        if (alive) setReady(true);
      });

    const unChanged = unlistenLater(
      api.onShortcutsChanged((d) => {
        if (alive) applyData(d);
      }),
    );
    const unDrag = unlistenLater(
      api.onShortcutDrag((state) => {
        if (!alive) return;
        if (state === "enter") {
          setOsDrag(true);
          return;
        }
        setOsDrag(false);
        if (state !== "drop") return;
        const patch: SettingsPatch = {};
        if (latest.current.tab !== "items") {
          touched.current.tab = true;
          setTab("items");
          patch.shortcutBarTab = "items";
        }
        if (latest.current.collapsed) {
          touched.current.collapsed = true;
          setCollapsed(false);
          patch.shortcutBarCollapsed = false;
        }
        setFormOpen(false);
        if (Object.keys(patch).length > 0) persist(patch);
      }),
    );
    return () => {
      alive = false;
      unChanged();
      unDrag();
    };
  }, [applyData, persist, showMessage]);

  // ---- focus helpers ----------------------------------------------------------
  const tileButtons = useCallback(
    () => [...(rowEl?.querySelectorAll<HTMLButtonElement>("button[data-shortcut-id]") ?? [])],
    [rowEl],
  );

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const btn = tileButtons().find((b) => b.dataset.shortcutId === id);
    if (btn) {
      pendingFocus.current = null;
      btn.focus();
    }
  });

  const focusTile = (id: string | null) => {
    if (!id) return;
    setFocusId(id);
    pendingFocus.current = id;
  };

  // ---- header actions -------------------------------------------------------------
  const closeTransient = () => {
    setAddMenu(null);
    setTileMenu(null);
    setRenamingId(null);
  };

  const selectTab = (t: ShortcutList, expand: boolean) => {
    const patch: SettingsPatch = {};
    if (t !== tab) {
      touched.current.tab = true;
      setTab(t);
      setFormOpen(false);
      closeTransient();
      patch.shortcutBarTab = t;
    }
    if (expand && collapsed) {
      touched.current.collapsed = true;
      setCollapsed(false);
      patch.shortcutBarCollapsed = false;
    }
    if (Object.keys(patch).length > 0) persist(patch);
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const t = TABS[next].id;
    selectTab(t, false);
    tabRefs.current[t]?.focus();
  };

  const setCollapsedPersist = (value: boolean) => {
    touched.current.collapsed = true;
    setCollapsed(value);
    if (value) {
      setFormOpen(false);
      closeTransient();
    }
    persist({ shortcutBarCollapsed: value });
  };

  const onAdd = () => {
    if (collapsed) setCollapsedPersist(false);
    if (tab === "bookmarks") {
      setFormOpen((open) => !open);
      return;
    }
    const btn = addButtonRef.current;
    setAddMenu((cur) => (cur || !btn ? null : anchorFromElement(btn)));
  };

  const pick = (folder: boolean) => {
    void api.pickShortcuts(folder).then(
      (d) => applyData(d),
      (err: unknown) => showMessage(`Hinzufügen fehlgeschlagen: ${errorText(err)}`),
    );
  };

  const addBookmark = async (name: string, url: string) => {
    const d = await api.addBookmark(name, url);
    applyData(d);
    setFormOpen(false);
    const added = d.bookmarks.find((b) => !list.some((x) => x.id === b.id));
    if (added) {
      setFocusId(added.id);
      requestAnimationFrame(() => rowEl?.querySelector(`[data-shortcut-id="${added.id}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" }));
    }
  };

  // ---- tile actions ---------------------------------------------------------------
  const openShortcut = (s: Shortcut) => {
    api.openShortcut(s.id).catch((err: unknown) => showMessage(openErrorText(err)));
  };

  const updateList = (fn: (items: Shortcut[]) => Shortcut[]) => {
    setData((d) => (d ? { ...d, [tab]: fn(d[tab]) } : d));
  };

  const moveTo = (id: string, to: number) => {
    const from = list.findIndex((s) => s.id === id);
    if (from < 0 || to === from || to < 0 || to >= list.length) return;
    const next = moveItem(list, from, to);
    updateList(() => next);
    focusTile(id);
    const listName = tab;
    void mutate(() => api.reorderShortcuts(listName, next.map((s) => s.id)), "Verschieben fehlgeschlagen");
  };

  const remove = (id: string) => {
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return;
    const neighbour = list[i + 1] ?? list[i - 1] ?? null;
    updateList((items) => items.filter((s) => s.id !== id));
    if (neighbour) focusTile(neighbour.id);
    else setFocusId(null);
    void mutate(() => api.removeShortcut(id), "Entfernen fehlgeschlagen");
  };

  const commitRename = (s: Shortcut, value: string) => {
    setRenamingId(null);
    focusTile(s.id);
    const name = value.trim();
    if (!name || name === s.name) return;
    updateList((items) => items.map((x) => (x.id === s.id ? { ...x, name } : x)));
    void mutate(() => api.updateShortcut(s.id, name), "Umbenennen fehlgeschlagen");
  };

  const startRename = (id: string) => {
    setTileMenu(null);
    setRenamingId(id);
  };

  const openTileMenu = (id: string, anchor: MenuAnchor) => {
    setAddMenu(null);
    setFocusId(id);
    setTileMenu({ id, anchor });
  };

  const onTileKeyDown = (s: Shortcut, index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const go = (i: number) => {
      const target = list[Math.min(Math.max(i, 0), list.length - 1)];
      if (target) focusTile(target.id);
    };
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      openTileMenu(s.id, anchorFromElement(e.currentTarget));
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        openShortcut(s);
        return;
      case "Delete":
        e.preventDefault();
        remove(s.id);
        return;
      case "F2":
        e.preventDefault();
        startRename(s.id);
        return;
      case "ArrowRight":
        e.preventDefault();
        go(index + 1);
        return;
      case "ArrowLeft":
        e.preventDefault();
        go(index - 1);
        return;
      case "Home":
        e.preventDefault();
        go(0);
        return;
      case "End":
        e.preventDefault();
        go(list.length - 1);
        return;
    }
  };

  const onTileContextMenu = (s: Shortcut) => (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // keyboard-triggered contextmenu events carry no pointer position
    const anchor = e.clientX === 0 && e.clientY === 0 ? anchorFromElement(e.currentTarget) : anchorFromPoint(e.clientX, e.clientY);
    openTileMenu(s.id, anchor);
  };

  // ---- pointer reorder (no HTML5 DnD: the window uses Tauri's native file drop) ----------
  const onPointerDown = (s: Shortcut, index: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || renamingId) return;
    const rects = tileButtons().map((b) => b.getBoundingClientRect());
    const mids = rects.map((r) => r.left + r.width / 2);
    const step = rects.length > 1 ? rects[1].left - rects[0].left : (rects[0]?.width ?? 0);
    pointer.current = { id: s.id, from: index, startX: e.clientX, pointerId: e.pointerId, mids, step, dragging: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = pointer.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = e.clientX - p.startX;
    if (!p.dragging) {
      if (Math.abs(dx) <= DRAG_THRESHOLD) return;
      p.dragging = true;
      setTileMenu(null);
      setAddMenu(null);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* not supported (tests) */
      }
    }
    const centre = (p.mids[p.from] ?? p.startX) + dx;
    setDrag({ id: p.id, from: p.from, to: computeDropIndex(p.mids, p.from, centre), dx, step: p.step });
  };

  const endPointer = (e: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const p = pointer.current;
    if (!p || p.pointerId !== e.pointerId) return;
    pointer.current = null;
    if (!p.dragging) return;
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    setDrag(null);
    if (!commit) return;
    const centre = (p.mids[p.from] ?? p.startX) + (e.clientX - p.startX);
    moveTo(p.id, computeDropIndex(p.mids, p.from, centre));
  };

  // mouse wheel scrolls the tile row horizontally (non-passive listener for preventDefault)
  useEffect(() => {
    if (!rowEl) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (rowEl.scrollWidth <= rowEl.clientWidth) return;
      e.preventDefault();
      rowEl.scrollLeft += e.deltaY;
    };
    rowEl.addEventListener("wheel", onWheel, { passive: false });
    return () => rowEl.removeEventListener("wheel", onWheel);
  }, [rowEl]);

  // ---- render ---------------------------------------------------------------------
  const tabbableId = list.some((s) => s.id === focusId) ? focusId : (list[0]?.id ?? null);
  const menuShortcut = tileMenu ? list.find((s) => s.id === tileMenu.id) : undefined;
  const menuIndex = menuShortcut ? list.indexOf(menuShortcut) : -1;

  const tileMenuItems: MenuItem[] = menuShortcut
    ? [
        { label: "Öffnen", onSelect: () => openShortcut(menuShortcut) },
        { label: "Umbenennen", onSelect: () => startRename(menuShortcut.id) },
        { label: "Nach links", onSelect: () => moveTo(menuShortcut.id, menuIndex - 1), disabled: menuIndex <= 0, separated: true },
        { label: "Nach rechts", onSelect: () => moveTo(menuShortcut.id, menuIndex + 1), disabled: menuIndex >= list.length - 1 },
        { label: "Entfernen", onSelect: () => remove(menuShortcut.id), danger: true, separated: true },
      ]
    : [];

  const addMenuItems: MenuItem[] = [
    { label: "Dateien oder Programme …", onSelect: () => pick(false) },
    { label: "Ordner …", onSelect: () => pick(true) },
  ];

  const tileShift = (s: Shortcut, i: number): number | null => {
    if (!drag) return null;
    if (s.id === drag.id) return drag.dx;
    return shiftDuringDrag(i, drag.from, drag.to) * drag.step;
  };

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <section
      className={`${styles.bar} ${osDrag ? styles.dragOver : ""}`}
      aria-label="Verknüpfungen"
      data-shortcut-bar=""
      data-collapsed={expanded ? undefined : ""}
    >
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Verknüpfungsarten">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              className={styles.tab}
              aria-selected={t.id === tab}
              aria-controls={panelId}
              tabIndex={t.id === tab ? 0 : -1}
              title={t.label}
              onClick={() => selectTab(t.id, true)}
              onKeyDown={onTabKeyDown}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          ref={addButtonRef}
          type="button"
          className={`${styles.iconButton} ${addMenu ? styles.addOpen : ""}`}
          aria-label="Hinzufügen"
          title={tab === "items" ? "Dateien, Programme oder Ordner hinzufügen" : "Lesezeichen hinzufügen"}
          aria-haspopup={tab === "items" ? "menu" : undefined}
          aria-expanded={tab === "items" ? addMenu !== null : formOpen}
          onClick={onAdd}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={collapsed ? "Verknüpfungsleiste ausklappen" : "Verknüpfungsleiste einklappen"}
          title={collapsed ? "Ausklappen" : "Einklappen"}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={() => setCollapsedPersist(!collapsed)}
        >
          <svg
            className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(activeTab.id)}
        className={`${styles.panel} ${formOpen ? styles.panelAuto : ""}`}
        hidden={!expanded}
      >
        {expanded &&
          (formOpen && tab === "bookmarks" ? (
            <BookmarkForm onSubmit={addBookmark} onCancel={() => setFormOpen(false)} />
          ) : (
            <div ref={setRowEl} className={styles.row} role="toolbar" aria-label={activeTab.label} aria-orientation="horizontal">
              {data && ready && list.length === 0 && <p className={styles.empty}>{EMPTY_TEXT[tab]}</p>}
              {list.map((s, i) => (
                <ShortcutTile
                  key={s.id}
                  shortcut={s}
                  tabbable={s.id === tabbableId}
                  renaming={s.id === renamingId}
                  dragging={drag?.id === s.id}
                  shiftX={tileShift(s, i)}
                  onActivate={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    setFocusId(s.id);
                    openShortcut(s);
                  }}
                  onKeyDown={onTileKeyDown(s, i)}
                  onFocus={() => setFocusId(s.id)}
                  onContextMenu={onTileContextMenu(s)}
                  onMore={(btn) => openTileMenu(s.id, anchorFromElement(btn))}
                  onPointerDown={onPointerDown(s, i)}
                  onPointerMove={onPointerMove}
                  onPointerUp={(e) => endPointer(e, true)}
                  onPointerCancel={(e) => endPointer(e, false)}
                  onRenameCommit={(v) => commitRename(s, v)}
                  onRenameCancel={() => {
                    setRenamingId(null);
                    focusTile(s.id);
                  }}
                />
              ))}
            </div>
          ))}
        {osDrag && (
          <div className={styles.dropHint} role="status">
            {DROP_HINT}
          </div>
        )}
      </div>

      {message && (
        <div className={styles.toast} role="status" aria-live="polite">
          <span className={styles.toastText}>{message}</span>
        </div>
      )}

      {addMenu && tab === "items" && (
        <Menu
          label="Hinzufügen"
          items={addMenuItems}
          anchor={addMenu}
          align="end"
          ignore={addButtonRef.current}
          onClose={(restore) => {
            setAddMenu(null);
            if (restore) addButtonRef.current?.focus();
          }}
        />
      )}

      {tileMenu && menuShortcut && (
        <Menu
          label={`Aktionen für ${menuShortcut.name}`}
          items={tileMenuItems}
          anchor={tileMenu.anchor}
          onClose={(restore) => {
            setTileMenu(null);
            if (restore) focusTile(menuShortcut.id);
          }}
        />
      )}
    </section>
  );
}
