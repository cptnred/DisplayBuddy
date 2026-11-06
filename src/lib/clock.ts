/**
 * Corrected device clock (PLAN_V3_SYNC §5.3.3, D-41). Mirror of
 * `crates/buddy-core/src/clock.rs`; both pass `clock_vectors.json`.
 *
 * offset = serverTime − (sentAt + RTT/2), only for RTT < 5 s; the offset in use is the
 * median of the last 5 samples (even count: mean of the middle two, truncated toward 0).
 * Without any measurement the offset is 0 (= behaviour of 0.2.0).
 */

export const MAX_RTT_MS = 5_000;
export const SAMPLES = 5;
export const WARN_OFFSET_MS = 2 * 60 * 1000;

/** One offset sample in ms (server ahead = positive) or null if RTT ≥ 5 s or negative. */
export function offsetSample(serverTimeMs: number, sentMs: number, receivedMs: number): number | null {
  const rtt = receivedMs - sentMs;
  if (!(rtt >= 0 && rtt < MAX_RTT_MS)) return null;
  return serverTimeMs - (sentMs + Math.trunc(rtt / 2));
}

/** Keeps the last {@link SAMPLES} offsets (oldest first) and returns their median. */
export function pushOffset(samples: readonly number[], offset: number): number[] {
  return [...samples, offset].slice(-SAMPLES);
}

export function medianOffset(samples: readonly number[]): number {
  const v = samples.slice(-SAMPLES).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const n = v.length;
  return n % 2 === 1 ? v[(n - 1) / 2] : Math.trunc((v[n / 2 - 1] + v[n / 2]) / 2);
}

export function needsClockWarning(offsetMs: number): boolean {
  return Math.abs(offsetMs) > WARN_OFFSET_MS;
}

export interface Clock {
  /** Device time + offset, Unix ms. The only "now" for stamps and reminder math. */
  correctedNow(): number;
  /** {@link correctedNow} as `YYYY-MM-DDTHH:MM:SS.sssZ`. */
  correctedNowIso(): string;
  offsetMs(): number;
  setOffsetMs(offsetMs: number): void;
}

/** A clock over an injectable device time source (tests pass a fake). */
export function createClock(deviceNow: () => number = () => Date.now(), initialOffsetMs = 0): Clock {
  let offset = initialOffsetMs;
  return {
    correctedNow: () => deviceNow() + offset,
    correctedNowIso: () => new Date(deviceNow() + offset).toISOString(),
    offsetMs: () => offset,
    setOffsetMs: (ms) => {
      offset = Number.isFinite(ms) ? Math.trunc(ms) : 0;
    },
  };
}

/** Process-wide clock (desktop windows, web app). Sync code updates its offset. */
export const clock: Clock = createClock();
