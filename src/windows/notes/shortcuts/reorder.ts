/**
 * Pure helpers for reordering shortcut tiles (pointer drag + "Nach links/rechts").
 * No React, no DOM.
 */

/**
 * Final index of the dragged tile.
 *
 * @param midpoints horizontal midpoints of all tiles (list order, measured when the drag started)
 * @param from      index of the dragged tile
 * @param x         current horizontal centre of the dragged tile (same coordinate space)
 * @returns index in `0..n-1` the tile ends up at (after removing it from `from` and re-inserting it)
 */
export function computeDropIndex(midpoints: readonly number[], from: number, x: number): number {
  const n = midpoints.length;
  if (n === 0) return 0;
  if (from < 0 || from >= n || !Number.isFinite(x)) return Math.min(Math.max(from, 0), n - 1);
  let index = 0;
  for (let i = 0; i < n; i++) {
    if (i !== from && midpoints[i] < x) index++;
  }
  return index;
}

/** Returns a copy of `items` with the element at `from` moved to `to` (`to` clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = items.slice();
  if (copy.length === 0 || from < 0 || from >= copy.length) return copy;
  const target = Math.min(Math.max(to, 0), copy.length - 1);
  if (target === from) return copy;
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item);
  return copy;
}

/**
 * Shift (in tile steps: -1, 0, 1) of a non-dragged tile `i` while the tile from `from`
 * hovers over position `to` – makes room for the dragged tile.
 */
export function shiftDuringDrag(i: number, from: number, to: number): -1 | 0 | 1 {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -1;
  if (to < from && i >= to && i < from) return 1;
  return 0;
}
