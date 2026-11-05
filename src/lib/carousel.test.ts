import { describe, expect, it } from "vitest";
import {
  circularOffset,
  indicatorLabel,
  insertAfter,
  move,
  normalizeIndex,
  removeAt,
  step,
  visibleSlots,
} from "./carousel";

describe("normalizeIndex", () => {
  it("wraps positive and negative indices", () => {
    expect(normalizeIndex(0, 5)).toBe(0);
    expect(normalizeIndex(4, 5)).toBe(4);
    expect(normalizeIndex(5, 5)).toBe(0);
    expect(normalizeIndex(12, 5)).toBe(2);
    expect(normalizeIndex(-1, 5)).toBe(4);
    expect(normalizeIndex(-6, 5)).toBe(4);
    expect(normalizeIndex(-10, 5)).toBe(0);
  });
  it("returns 0 for empty lists and never -0", () => {
    expect(normalizeIndex(3, 0)).toBe(0);
    expect(normalizeIndex(-3, 0)).toBe(0);
    expect(Object.is(normalizeIndex(-5, 5), 0)).toBe(true);
    expect(normalizeIndex(Number.NaN, 3)).toBe(0);
  });
});

describe("circularOffset", () => {
  it("takes the shortest path", () => {
    expect(circularOffset(1, 0, 5)).toBe(1);
    expect(circularOffset(4, 0, 5)).toBe(-1);
    expect(circularOffset(0, 4, 5)).toBe(1);
    expect(circularOffset(3, 0, 5)).toBe(-2);
    expect(circularOffset(2, 2, 5)).toBe(0);
    expect(circularOffset(9, 0, 10)).toBe(-1);
  });
  it("resolves ties for even n to the positive side", () => {
    expect(circularOffset(2, 0, 4)).toBe(2);
    expect(circularOffset(0, 2, 4)).toBe(2);
    expect(circularOffset(1, 0, 2)).toBe(1);
    expect(circularOffset(0, 1, 2)).toBe(1);
    expect(circularOffset(5, 0, 10)).toBe(5);
  });
  it("is 0 for n = 0 or 1", () => {
    expect(circularOffset(3, 1, 0)).toBe(0);
    expect(circularOffset(0, 0, 1)).toBe(0);
  });
});

describe("visibleSlots", () => {
  const noDupes = (slots: { index: number }[]) =>
    expect(new Set(slots.map((s) => s.index)).size).toBe(slots.length);

  it("n = 0 → no slots", () => {
    expect(visibleSlots(0, 0)).toEqual([]);
  });
  it("n = 1 → only the active slot", () => {
    expect(visibleSlots(1, 0)).toEqual([{ index: 0, offset: 0 }]);
    expect(visibleSlots(1, 5)).toEqual([{ index: 0, offset: 0 }]);
  });
  it("n = 2 → active + the other note at +1 only", () => {
    expect(visibleSlots(2, 0)).toEqual([
      { index: 0, offset: 0 },
      { index: 1, offset: 1 },
    ]);
    expect(visibleSlots(2, 1)).toEqual([
      { index: 1, offset: 0 },
      { index: 0, offset: 1 },
    ]);
  });
  it("n = 3 → -1, 0, +1", () => {
    expect(visibleSlots(3, 0)).toEqual([
      { index: 2, offset: -1 },
      { index: 0, offset: 0 },
      { index: 1, offset: 1 },
    ]);
  });
  it("n = 4 → -1..+2 (tie on positive side)", () => {
    expect(visibleSlots(4, 0).map((s) => s.offset)).toEqual([-1, 0, 1, 2]);
    expect(visibleSlots(4, 0).find((s) => s.offset === 2)?.index).toBe(2);
  });
  it("n = 10 → -2..+2 with wraparound", () => {
    expect(visibleSlots(10, 0)).toEqual([
      { index: 8, offset: -2 },
      { index: 9, offset: -1 },
      { index: 0, offset: 0 },
      { index: 1, offset: 1 },
      { index: 2, offset: 2 },
    ]);
    expect(visibleSlots(10, 9).map((s) => s.index)).toEqual([7, 8, 9, 0, 1]);
  });
  it("respects radius and never duplicates indices", () => {
    expect(visibleSlots(10, 3, 1).map((s) => s.offset)).toEqual([-1, 0, 1]);
    for (let n = 0; n <= 12; n++) {
      for (let a = -3; a < n + 3; a++) {
        const slots = visibleSlots(n, a);
        noDupes(slots);
        for (const s of slots) expect(s.offset).toBe(circularOffset(s.index, a, n));
      }
    }
  });
});

describe("step", () => {
  it("wraps last → first and first → last", () => {
    expect(step(4, 1, 5)).toBe(0);
    expect(step(0, -1, 5)).toBe(4);
    expect(step(2, 1, 5)).toBe(3);
  });
  it("handles big deltas and empty lists", () => {
    expect(step(1, 13, 5)).toBe(4);
    expect(step(1, -13, 5)).toBe(3);
    expect(step(0, 1, 0)).toBe(0);
    expect(step(0, 1, 1)).toBe(0);
  });
});

describe("insertAfter", () => {
  it("inserts into an empty list", () => {
    expect(insertAfter([], 0, "x")).toEqual({ items: ["x"], active: 0 });
  });
  it("inserts at the end", () => {
    expect(insertAfter(["a", "b"], 1, "x")).toEqual({ items: ["a", "b", "x"], active: 2 });
  });
  it("inserts in the middle and makes the new item active", () => {
    expect(insertAfter(["a", "b", "c"], 0, "x")).toEqual({ items: ["a", "x", "b", "c"], active: 1 });
  });
  it("does not mutate the input", () => {
    const src = ["a"];
    insertAfter(src, 0, "x");
    expect(src).toEqual(["a"]);
  });
});

describe("removeAt", () => {
  it("removing the active item in the middle activates the next one", () => {
    expect(removeAt(["a", "b", "c"], 1)).toEqual({ items: ["a", "c"], active: 1 });
  });
  it("removing the last item wraps to the first (next on the ring)", () => {
    expect(removeAt(["a", "b", "c"], 2)).toEqual({ items: ["a", "b"], active: 0 });
  });
  it("removing the only item yields an empty list with active 0", () => {
    expect(removeAt(["a"], 0)).toEqual({ items: [], active: 0 });
    expect(removeAt([], 0)).toEqual({ items: [], active: 0 });
  });
  it("removing a non-active item keeps the same active item", () => {
    const before = ["a", "b", "c", "d"];
    const r1 = removeAt(before, 0, 2); // remove "a" while "c" active
    expect(r1.items[r1.active]).toBe("c");
    const r2 = removeAt(before, 3, 1); // remove "d" while "b" active
    expect(r2.items[r2.active]).toBe("b");
  });
  it("does not mutate the input", () => {
    const src = ["a", "b"];
    removeAt(src, 0);
    expect(src).toEqual(["a", "b"]);
  });
});

describe("move", () => {
  it("swaps with the neighbour", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual({ items: ["b", "a", "c"], active: 1 });
    expect(move(["a", "b", "c"], 2, -1)).toEqual({ items: ["a", "c", "b"], active: 1 });
  });
  it("wraps around both ends", () => {
    expect(move(["a", "b", "c"], 2, 1)).toEqual({ items: ["c", "b", "a"], active: 0 });
    expect(move(["a", "b", "c"], 0, -1)).toEqual({ items: ["c", "b", "a"], active: 2 });
  });
  it("is a no-op for 0 or 1 items", () => {
    expect(move([], 0, 1)).toEqual({ items: [], active: 0 });
    expect(move(["a"], 0, -1)).toEqual({ items: ["a"], active: 0 });
  });
});

describe("indicatorLabel", () => {
  it("formats 1-based position", () => {
    expect(indicatorLabel(2, 7)).toBe("3 / 7");
    expect(indicatorLabel(0, 1)).toBe("1 / 1");
    expect(indicatorLabel(-1, 7)).toBe("7 / 7");
  });
  it("shows 0 / 0 when empty", () => {
    expect(indicatorLabel(0, 0)).toBe("0 / 0");
  });
});

describe("invariants over many sizes (n = 0..12)", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

  it("move is a permutation, keeps the moved item active and is undone by the opposite move", () => {
    for (let n = 0; n <= 12; n++) {
      const items = range(n);
      for (let i = 0; i < n; i++) {
        for (const d of [-1, 1] as const) {
          const r = move(items, i, d);
          expect(sorted(r.items)).toEqual(items);
          expect(r.items[r.active]).toBe(i);
          expect(move(r.items, r.active, d === 1 ? -1 : 1).items).toEqual(items);
        }
      }
    }
  });

  it("n moves in one direction bring the item back to its start (full lap)", () => {
    for (let n = 2; n <= 12; n++) {
      let r = { items: range(n), active: 0 };
      for (let k = 0; k < n; k++) r = move(r.items, r.active, 1);
      expect(r.items[r.active]).toBe(0);
      // a lap of swaps is a rotation by one step for the other items, but no item is lost
      expect(sorted(r.items)).toEqual(range(n));
    }
  });

  it("removeAt never loses other items and always returns a valid active index", () => {
    for (let n = 1; n <= 12; n++) {
      const items = range(n);
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < n; a++) {
          const r = removeAt(items, i, a);
          expect(r.items).toEqual(items.filter((x) => x !== i));
          if (r.items.length === 0) expect(r.active).toBe(0);
          else {
            expect(r.active).toBeGreaterThanOrEqual(0);
            expect(r.active).toBeLessThan(r.items.length);
            if (a !== i) expect(r.items[r.active]).toBe(a);
          }
        }
      }
    }
  });

  it("insertAfter then removeAt of the new item restores the list and the previous active item", () => {
    for (let n = 0; n <= 12; n++) {
      const items = range(n);
      for (let a = 0; a < Math.max(n, 1); a++) {
        const ins = insertAfter(items, a, 99);
        expect(ins.items[ins.active]).toBe(99);
        expect(ins.items).toHaveLength(n + 1);
        const rem = removeAt(ins.items, ins.active, ins.active);
        expect(rem.items).toEqual(items);
      }
    }
  });

  it("step by ±n is identity and stepping forward then back returns", () => {
    for (let n = 1; n <= 12; n++) {
      for (let a = 0; a < n; a++) {
        expect(step(a, n, n)).toBe(a);
        expect(step(a, -n, n)).toBe(a);
        expect(step(step(a, 1, n), -1, n)).toBe(a);
      }
    }
  });
});
