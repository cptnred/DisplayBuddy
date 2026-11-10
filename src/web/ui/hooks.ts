/** Data hooks over the DataStore / SyncEngine (local-first: the UI reads only locally). */
import { useEffect, useRef, useState } from "react";
import { earliestScheduled, isDue } from "../../lib/schedule";
import type { ServerInfo } from "../../lib/sync/types";
import type { Note, Reminder } from "../../types";
import type { Account, DataChange, WebSyncStatus } from "../contract";
import { useServices } from "./services";

/** Re-reads `load` initially and on every matching store change. */
function useStoreValue<T>(load: () => Promise<T>, kinds: DataChange["kind"][], initial: T): [T, boolean] {
  const { store } = useServices();
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const kindKey = kinds.join(",");
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const refresh = () => {
      const mine = ++seq;
      loadRef.current().then(
        (v) => {
          if (alive && mine === seq) {
            setValue(v);
            setLoaded(true);
          }
        },
        () => {
          if (alive) setLoaded(true);
        },
      );
    };
    refresh();
    const wanted = new Set(kindKey.split(","));
    const off = store.subscribe((c) => {
      if (c.kind === "all" || wanted.has(c.kind)) refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, [store, kindKey]);
  return [value, loaded];
}

export function useNotes(): [Note[], boolean] {
  const { store } = useServices();
  return useStoreValue(() => store.listNotes(), ["notes", "order"], []);
}

export function useReminders(): Reminder[] {
  const { store } = useServices();
  return useStoreValue(() => store.listReminders(), ["reminders", "notes"], [] as Reminder[])[0];
}

export function useAccount(): [Account | null, boolean] {
  const { store } = useServices();
  return useStoreValue(() => store.getAccount(), ["account"], null);
}

/**
 * Records waiting in the outbox. Re-read on data changes AND on every sync status change:
 * a successful push empties the outbox without any data change event, so a counter that
 * listened only to the store kept showing „1 Änderung wartet“ after the sync.
 */
export function usePendingCount(): number {
  const { store, sync } = useServices();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const refresh = () => {
      const mine = ++seq;
      store.pendingCount().then(
        (n) => {
          if (alive && mine === seq) setCount(n);
        },
        () => {},
      );
    };
    refresh();
    const offStore = store.subscribe((c) => {
      if (c.kind !== "account") refresh();
    });
    const offSync = sync.onStatus(() => refresh());
    return () => {
      alive = false;
      offStore();
      offSync();
    };
  }, [store, sync]);
  return count;
}

export function useSyncStatus(): WebSyncStatus {
  const { sync } = useServices();
  const [s, setS] = useState(() => sync.status());
  useEffect(() => {
    setS(sync.status());
    return sync.onStatus(setS);
  }, [sync]);
  return s;
}

/** Corrected "now" (store clock), refreshed every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const { store } = useServices();
  const [now, setNow] = useState(() => store.clock.correctedNow());
  useEffect(() => {
    const t = setInterval(() => setNow(store.clock.correctedNow()), intervalMs);
    return () => clearInterval(t);
  }, [store, intervalMs]);
  return now;
}

/** Longest single wait of the due timer (re-checks the clock regularly). */
const MAX_WAIT_MS = 60_000;

/**
 * UI due timer: marks scheduled reminders due once `at ≤ now` (store.markDue, which
 * neither stamps nor enters the outbox, D-30). Complements the push in the worker.
 */
export function useDueTimer(reminders: Reminder[]): void {
  const { store } = useServices();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const check = () => {
      const now = store.clock.correctedNow();
      for (const r of reminders) if (isDue(r, now)) void store.markDue(r.noteId, r.at).catch(() => null);
      const next = earliestScheduled(reminders.filter((r) => !isDue(r, now)));
      if (next !== null && alive) {
        timer = setTimeout(check, Math.min(Math.max(next - now, 250), MAX_WAIT_MS));
      }
    };
    check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [store, reminders]);
}

/** v4: GET /info of the own server (legal links); null while loading, offline or on a v3 server. */
export function useServerInfo(): ServerInfo | null {
  const { sync } = useServices();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    let alive = true;
    sync.serverInfo().then(
      (i) => alive && setInfo(i),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [sync]);
  return info;
}
