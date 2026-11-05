import { describe, expect, it } from "vitest";
import { computeDropIndex, moveItem, shiftDuringDrag } from "./reorder";

// tiles 60 px apart → midpoints 30, 90, 150, 210
const mids = [30, 90, 150, 210];

describe("computeDropIndex", () => {
  it("stays in place for small moves", () => {
    expect(computeDropIndex(mids, 1, 90)).toBe(1);
    expect(computeDropIndex(mids, 1, 140)).toBe(1);
    expect(computeDropIndex(mids, 1, 40)).toBe(1);
  });
  it("moves right once the centre passes the next midpoint", () => {
    expect(computeDropIndex(mids, 1, 151)).toBe(2);
    expect(computeDropIndex(mids, 0, 500)).toBe(3);
  });
  it("moves left once the centre passes the previous midpoint", () => {
    expect(computeDropIndex(mids, 2, 89)).toBe(1);
    expect(computeDropIndex(mids, 3, -100)).toBe(0);
  });
  it("handles edge cases", () => {
    expect(computeDropIndex([], 0, 10)).toBe(0);
    expect(computeDropIndex([5], 0, 999)).toBe(0);
    expect(computeDropIndex(mids, 7, 10)).toBe(3);
    expect(computeDropIndex(mids, 2, Number.NaN)).toBe(2);
  });
});

describe("moveItem", () => {
  it("moves forward and backward without mutating the input", () => {
    const src = ["a", "b", "c", "d"];
    expect(moveItem(src, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(src, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(src).toEqual(["a", "b", "c", "d"]);
  });
  it("clamps and ignores invalid input", () => {
    expect(moveItem(["a", "b"], 0, 9)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 1, -3)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(moveItem([], 0, 0)).toEqual([]);
  });
  it("agrees with computeDropIndex", () => {
    const to = computeDropIndex(mids, 0, 160);
    expect(moveItem(["a", "b", "c", "d"], 0, to)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("shiftDuringDrag", () => {
  it("shifts the tiles between from and to", () => {
    expect([0, 1, 2, 3].map((i) => shiftDuringDrag(i, 0, 2))).toEqual([0, -1, -1, 0]);
    expect([0, 1, 2, 3].map((i) => shiftDuringDrag(i, 3, 1))).toEqual([0, 1, 1, 0]);
    expect([0, 1, 2].map((i) => shiftDuringDrag(i, 1, 1))).toEqual([0, 0, 0]);
  });
});
