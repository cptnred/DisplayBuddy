/**
 * Pure, framework-free logic for the endless notes carousel (docs/PLAN.md §8).
 *
 * Conventions:
 * - Indices are always normalised into `0..n-1`; an empty list uses index 0.
 * - Offsets are the shortest signed circular distance from the active item.
 *   For even `n` the tie (distance exactly n/2) resolves to the POSITIVE side.
 */

/** ((i % n) + n) % n; n <= 0 → 0. */
export function normalizeIndex(i: number, n: number): number {
  if (n <= 0 || !Number.isFinite(i)) return 0;
  const t = Math.trunc(i);
  return ((t % n) + n) % n;
}

/** Shortest signed distance from `active` to `index` on a ring of `n` items (ties → positive). */
export function circularOffset(index: number, active: number, n: number): number {
  if (n <= 0) return 0;
  const d = normalizeIndex(index - active, n);
  return d > n / 2 ? d - n : d;
}

export interface Slot {
  index: number;
  offset: number;
}

/**
 * Slots to render around the active item, sorted by offset (ascending).
 * Never contains an index twice. Offsets beyond ±1 are hidden "staging" slots
 * so cards can enter/leave seamlessly.
 *
 * n=0 → []; n=1 → [0]; n=2 → active + other at +1; n=3 → -1,0,+1;
 * n=4 → -1,0,+1,+2; n≥5 (radius 2) → -2..+2.
 */
export function visibleSlots(n: number, active: number, radius = 2): Slot[] {
  if (n <= 0) return [];
  const a = normalizeIndex(active, n);
  const r = Math.max(0, Math.trunc(radius));
  const used = new Set<number>([a]);
  const slots: Slot[] = [{ index: a, offset: 0 }];
  for (let d = 1; d <= r; d++) {
    // positive first so ties (even n) land on the positive side, matching circularOffset
    for (const o of [d, -d]) {
      const index = normalizeIndex(a + o, n);
      if (used.has(index)) continue;
      used.add(index);
      slots.push({ index, offset: o });
    }
  }
  return slots.sort((x, y) => x.offset - y.offset);
}

/** Moves the active index by `delta` with wraparound. */
export function step(active: number, delta: number, n: number): number {
  return normalizeIndex(active + delta, n);
}

/** Inserts `item` directly after the active one; the new item becomes active. */
export function insertAfter<T>(items: T[], active: number, item: T): { items: T[]; active: number } {
  if (items.length === 0) return { items: [item], active: 0 };
  const pos = normalizeIndex(active, items.length) + 1;
  const next = items.slice();
  next.splice(pos, 0, item);
  return { items: next, active: pos };
}

/**
 * Removes the item at `index`.
 *
 * `active` (defaults to `index`, i.e. "removing the active item"):
 * - removed item was active → the following item becomes active; removing the
 *   last item wraps to 0 (the "next" one on the ring);
 * - removed item was not active → the same item stays active (index shifts if needed);
 * - list becomes empty → active 0.
 */
export function removeAt<T>(
  items: T[],
  index: number,
  active: number = index,
): { items: T[]; active: number } {
  const n = items.length;
  if (n === 0) return { items: [], active: 0 };
  const i = normalizeIndex(index, n);
  const a = normalizeIndex(active, n);
  const next = items.slice();
  next.splice(i, 1);
  const m = next.length;
  if (m === 0) return { items: next, active: 0 };
  if (a === i) return { items: next, active: i >= m ? 0 : i };
  return { items: next, active: a > i ? a - 1 : a };
}

/**
 * Moves the item at `index` one position on the ring by swapping it with its
 * neighbour (wraps: last +1 swaps with first, first -1 swaps with last).
 * The returned `active` is the item's new index.
 */
export function move<T>(items: T[], index: number, delta: -1 | 1): { items: T[]; active: number } {
  const n = items.length;
  if (n === 0) return { items: [], active: 0 };
  const i = normalizeIndex(index, n);
  if (n === 1) return { items: items.slice(), active: i };
  const j = normalizeIndex(i + delta, n);
  const next = items.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return { items: next, active: j };
}

/** "3 / 7" (1-based); empty list → "0 / 0". */
export function indicatorLabel(active: number, n: number): string {
  if (n <= 0) return "0 / 0";
  return `${normalizeIndex(active, n) + 1} / ${n}`;
}
