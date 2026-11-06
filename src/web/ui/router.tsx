/**
 * Minimal path router over the History API (no dependency). Works in the PWA and in
 * the native shell's webview; tests pass a memory history.
 *
 * Routes: /login, /, /notes/<id>, /new, /setup, /settings (PLAN_V3_SYNC §9.5).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

export type Route =
  | { name: "login" }
  | { name: "list" }
  | { name: "note"; id: string }
  | { name: "new" }
  | { name: "setup" }
  | { name: "settings" }
  | { name: "notFound"; path: string };

export function parseRoute(path: string): Route {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/index.html") return { name: "list" };
  if (p === "/login") return { name: "login" };
  if (p === "/new") return { name: "new" };
  if (p === "/setup") return { name: "setup" };
  if (p === "/settings") return { name: "settings" };
  const m = /^\/notes\/([0-9A-Za-z-]{1,64})$/.exec(p);
  if (m) return { name: "note", id: m[1] };
  return { name: "notFound", path: p };
}

export interface HistoryLike {
  path(): string;
  push(path: string): void;
  replace(path: string): void;
  listen(listener: () => void): () => void;
}

export function browserHistory(): HistoryLike {
  return {
    path: () => globalThis.location.pathname + globalThis.location.search,
    push: (p) => globalThis.history.pushState(null, "", p),
    replace: (p) => globalThis.history.replaceState(null, "", p),
    listen: (l) => {
      globalThis.addEventListener("popstate", l);
      return () => globalThis.removeEventListener("popstate", l);
    },
  };
}

export function memoryHistory(initial = "/"): HistoryLike & { entries: string[] } {
  const entries = [initial];
  const listeners = new Set<() => void>();
  return {
    entries,
    path: () => entries[entries.length - 1],
    push: (p) => {
      entries.push(p);
    },
    replace: (p) => {
      entries[entries.length - 1] = p;
    },
    listen: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

interface RouterValue {
  route: Route;
  path: string;
  navigate(path: string, options?: { replace?: boolean }): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ history, children }: { history: HistoryLike; children: ReactNode }) {
  const [path, setPath] = useState(() => history.path());
  useEffect(() => history.listen(() => setPath(history.path())), [history]);
  const navigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      if (options?.replace) history.replace(to);
      else if (to !== history.path()) history.push(to);
      setPath(history.path());
    },
    [history],
  );
  const value = useMemo(() => ({ route: parseRoute(path), path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const r = useContext(RouterContext);
  if (!r) throw new Error("RouterProvider missing");
  return r;
}

/** An in-app link (keeps SPA navigation; keyboard and screen readers see a real link). */
export function Link({
  to,
  children,
  className,
  style,
  "aria-label": ariaLabel,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      style={style}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
