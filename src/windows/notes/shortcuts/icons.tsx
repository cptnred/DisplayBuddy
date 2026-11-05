import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import type { Shortcut, ShortcutKind } from "../../../types";
import { hostOf } from "./url";
import styles from "./ShortcutBar.module.css";

/** Shell icons by shortcut id (module-level: survives remounts and tab switches). */
const iconCache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** Test helper. */
export function resetIconCache() {
  iconCache.clear();
  pending.clear();
}

function fetchIcon(id: string): Promise<string | null> {
  let p = pending.get(id);
  if (!p) {
    p = api
      .shortcutIcon(id)
      .then((url) => (typeof url === "string" && url.startsWith("data:image/") ? url : null))
      .catch(() => null)
      .then((url) => {
        iconCache.set(id, url);
        pending.delete(id);
        return url;
      });
    pending.set(id, p);
  }
  return p;
}

/** Lazily loads the shell icon of an item; `null` while loading or when unavailable. */
export function useShellIcon(id: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => iconCache.get(id) ?? null);
  useEffect(() => {
    if (!enabled) return;
    if (iconCache.has(id)) {
      setUrl(iconCache.get(id) ?? null);
      return;
    }
    let alive = true;
    void fetchIcon(id).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [id, enabled]);
  return enabled ? url : null;
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" data-fallback-icon="folder">
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h5l2.4 2.4h9.6A2.5 2.5 0 0 1 25 10.9V20a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 3 20Z" fill="#f5c451" />
      <path d="M3 11.5h22V20a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 3 20Z" fill="#ffd977" />
    </svg>
  );
}

function ProgramIcon() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" data-fallback-icon="program">
      <rect x="3.5" y="5" width="21" height="18" rx="3" fill="#dbe4f3" stroke="#9aaccb" />
      <path d="M3.5 8a3 3 0 0 1 3-3h15a3 3 0 0 1 3 3v2h-21Z" fill="#5b7fc7" />
      <circle cx="6.8" cy="7.5" r="0.9" fill="#fff" />
      <circle cx="9.4" cy="7.5" r="0.9" fill="#fff" />
      <path d="m9 14.5 2.8 2.3L9 19.1M14 19h5" stroke="#3d5a99" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" data-fallback-icon="file">
      <path d="M7.5 3.5h9l5 5v14.5a1.5 1.5 0 0 1-1.5 1.5H7.5A1.5 1.5 0 0 1 6 23V5a1.5 1.5 0 0 1 1.5-1.5Z" fill="#fff" stroke="#a7b0bc" />
      <path d="M16.5 3.5v5h5" fill="#e8ecf1" stroke="#a7b0bc" strokeLinejoin="round" />
      <path d="M9.5 13h9M9.5 16.5h9M9.5 20h6" stroke="#c3cad3" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Soft pastel derived from the host so bookmarks are distinguishable. */
function hueOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function BookmarkIcon({ target }: { target: string }) {
  const host = hostOf(target);
  const letter = (host.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  const hue = hueOf(host);
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" data-fallback-icon="url">
      <circle cx="14" cy="14" r="11" fill={`hsl(${hue} 70% 90%)`} stroke={`hsl(${hue} 35% 62%)`} />
      <g stroke={`hsl(${hue} 30% 70%)`} strokeWidth="0.9" fill="none" opacity="0.8">
        <ellipse cx="14" cy="14" rx="5" ry="11" />
        <path d="M3.5 10.5h21M3.5 17.5h21" />
      </g>
      <text
        x="14"
        y="14"
        dy="0.36em"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill={`hsl(${hue} 45% 28%)`}
        fontFamily="Segoe UI, system-ui, sans-serif"
      >
        {letter}
      </text>
    </svg>
  );
}

function FallbackIcon({ kind, target }: { kind: ShortcutKind; target: string }) {
  switch (kind) {
    case "folder":
      return <FolderIcon />;
    case "program":
      return <ProgramIcon />;
    case "url":
      return <BookmarkIcon target={target} />;
    default:
      return <FileIcon />;
  }
}

export function ShortcutIcon({ shortcut }: { shortcut: Shortcut }) {
  const isUrl = shortcut.kind === "url";
  const shell = useShellIcon(shortcut.id, !isUrl);
  return (
    <span className={styles.icon} aria-hidden="true">
      {shell ? (
        <img src={shell} alt="" width={28} height={28} draggable={false} />
      ) : (
        <FallbackIcon kind={shortcut.kind} target={shortcut.target} />
      )}
    </span>
  );
}
