/**
 * Tracks unsaved edits (debounced autosave + in-flight writes), so the update banner
 * appears only after every save has finished (PLAN_V3_SYNC §9.1) and an update or
 * navigation can flush first.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface SaveTracker {
  /** True while any registered editor has pending or running saves. */
  busy: boolean;
  /** Reports the busy state of one source (e.g. the open note). */
  report(source: string, busy: boolean): void;
  /** Registers a flush function; returns the unregister function. */
  registerFlush(source: string, flush: () => Promise<void>): () => void;
  /** Flushes every source (resolves when all saves are done). */
  flushAll(): Promise<void>;
}

const SaveContext = createContext<SaveTracker | null>(null);

export function SaveTrackerProvider({ children }: { children: ReactNode }) {
  const [busySources, setBusySources] = useState<ReadonlySet<string>>(new Set());
  const flushers = useRef(new Map<string, () => Promise<void>>());

  const report = useCallback((source: string, busy: boolean) => {
    setBusySources((prev) => {
      if (prev.has(source) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  const registerFlush = useCallback((source: string, flush: () => Promise<void>) => {
    flushers.current.set(source, flush);
    return () => {
      if (flushers.current.get(source) === flush) flushers.current.delete(source);
    };
  }, []);
  const flushAll = useCallback(async () => {
    await Promise.all([...flushers.current.values()].map((f) => f().catch(() => undefined)));
  }, []);

  const value = useMemo(
    () => ({ busy: busySources.size > 0, report, registerFlush, flushAll }),
    [busySources, report, registerFlush, flushAll],
  );
  return <SaveContext.Provider value={value}>{children}</SaveContext.Provider>;
}

export function useSaveTracker(): SaveTracker {
  const s = useContext(SaveContext);
  if (!s) throw new Error("SaveTrackerProvider missing");
  return s;
}
