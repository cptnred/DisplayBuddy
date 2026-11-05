/**
 * Keyed debouncer for autosave (docs/PLAN.md §8 "Autosave").
 *
 * Guarantees per key:
 * - latest value wins: scheduling again replaces the pending value and restarts the timer;
 * - runs are serialised: never two concurrent `run`s for the same key; a value that becomes
 *   due while a run is in flight is written after that run finishes;
 * - values are written in the order they were scheduled, so an older snapshot is never
 *   written after a newer one;
 * - `flush` starts pending values immediately and resolves once everything that was pending
 *   or in flight for the key(s) has finished (it never rejects).
 *
 * `run` errors are reported via `onError` (default: console.error) and do not break the chain.
 */
export interface KeyedDebouncer<T> {
  schedule(key: string, value: T): void;
  flush(key?: string): Promise<void>;
  cancel(key: string): void;
  /** Keys with a scheduled value that has not been handed to `run` yet. */
  pending(): string[];
}

export interface KeyedDebouncerOptions<T> {
  onError?: (key: string, error: unknown, value: T) => void;
}

interface Entry<T> {
  timer: ReturnType<typeof setTimeout> | null;
  hasValue: boolean;
  value: T | undefined;
  /** Tail of the serialised run chain; always resolves. */
  chain: Promise<void>;
  running: number;
}

export function createKeyedDebouncer<T>(
  delayMs: number,
  run: (key: string, value: T) => Promise<void>,
  options: KeyedDebouncerOptions<T> = {},
): KeyedDebouncer<T> {
  const entries = new Map<string, Entry<T>>();
  const onError =
    options.onError ??
    ((key: string, error: unknown) => console.error(`[debounce] run failed for "${key}"`, error));

  const entry = (key: string): Entry<T> => {
    let e = entries.get(key);
    if (!e) {
      e = { timer: null, hasValue: false, value: undefined, chain: Promise.resolve(), running: 0 };
      entries.set(key, e);
    }
    return e;
  };

  const clearTimer = (e: Entry<T>) => {
    if (e.timer !== null) {
      clearTimeout(e.timer);
      e.timer = null;
    }
  };

  const cleanup = (key: string, e: Entry<T>) => {
    if (!e.hasValue && e.timer === null && e.running === 0 && entries.get(key) === e) {
      entries.delete(key);
    }
  };

  /** Hands the pending value (if any) to the run chain; returns the chain tail. */
  const fire = (key: string): Promise<void> => {
    const e = entries.get(key);
    if (!e) return Promise.resolve();
    clearTimer(e);
    if (e.hasValue) {
      const value = e.value as T;
      e.hasValue = false;
      e.value = undefined;
      e.running++;
      e.chain = e.chain
        .then(() => run(key, value))
        .catch((err: unknown) => onError(key, err, value))
        .finally(() => {
          e.running--;
          cleanup(key, e);
        });
    }
    return e.chain;
  };

  return {
    schedule(key, value) {
      const e = entry(key);
      e.value = value;
      e.hasValue = true;
      clearTimer(e);
      e.timer = setTimeout(() => {
        e.timer = null;
        void fire(key);
      }, delayMs);
    },
    async flush(key) {
      const keys = key === undefined ? [...entries.keys()] : [key];
      await Promise.all(keys.map((k) => fire(k)));
    },
    cancel(key) {
      const e = entries.get(key);
      if (!e) return;
      clearTimer(e);
      e.hasValue = false;
      e.value = undefined;
      cleanup(key, e);
    },
    pending() {
      return [...entries.entries()].filter(([, e]) => e.hasValue).map(([k]) => k);
    },
  };
}
