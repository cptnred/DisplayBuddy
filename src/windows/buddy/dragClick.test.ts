import { describe, expect, it } from "vitest";
import { createDragClickTracker } from "./dragClick";

describe("createDragClickTracker", () => {
  it("reports a click for down + up without movement", () => {
    const t = createDragClickTracker();
    t.down(10, 10);
    expect(t.up()).toBe("click");
  });

  it("returns none for up() without a preceding down()", () => {
    const t = createDragClickTracker();
    expect(t.up()).toBe("none");
  });

  it("returns none for a second up() after a click", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.up()).toBe("click");
    expect(t.up()).toBe("none");
  });

  it("treats movement up to the threshold (inclusive) as a click", () => {
    const t = createDragClickTracker();
    t.down(100, 100);
    expect(t.move(103, 100)).toBeNull();
    expect(t.move(100, 96)).toBeNull(); // exactly 4 px
    expect(t.up()).toBe("click");
  });

  it("uses Euclidean distance, not per-axis distance", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    // 3 px on each axis = 4.24 px > 4
    expect(t.move(3, 3)).toBe("drag");
  });

  it("does not trigger while staying inside the threshold circle", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(2.8, 2.8)).toBeNull(); // 3.96 px
    expect(t.up()).toBe("click");
  });

  it("returns drag exactly once and then up() returns none", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(5, 0)).toBe("drag");
    expect(t.move(20, 0)).toBeNull();
    expect(t.move(0, 0)).toBeNull(); // moving back does not revert to a click
    expect(t.up()).toBe("none");
  });

  it("works with negative coordinates (monitors left of / above the primary)", () => {
    const t = createDragClickTracker();
    t.down(-1920, -10);
    expect(t.move(-1925, -10)).toBe("drag");
  });

  it("ignores moves without a press", () => {
    const t = createDragClickTracker();
    expect(t.move(500, 500)).toBeNull();
    expect(t.up()).toBe("none");
  });

  it("respects a custom threshold", () => {
    const t = createDragClickTracker({ threshold: 10 });
    t.down(0, 0);
    expect(t.move(8, 0)).toBeNull();
    expect(t.move(11, 0)).toBe("drag");
  });

  it("measures relative to the down position, not the last move", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(2, 0)).toBeNull();
    expect(t.move(4, 0)).toBeNull();
    expect(t.move(4.5, 0)).toBe("drag");
  });

  it("cancel() discards the current press", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.active).toBe(true);
    t.cancel();
    expect(t.active).toBe(false);
    expect(t.move(50, 50)).toBeNull();
    expect(t.up()).toBe("none");
  });

  it("cancel() after a drag allows a fresh click", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(10, 0)).toBe("drag");
    t.cancel();
    t.down(10, 0);
    expect(t.up()).toBe("click");
  });

  it("a new down() restarts tracking even if up() never arrived", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(10, 0)).toBe("drag");
    // OS took over the drag, pointerup never came
    t.down(300, 300);
    expect(t.move(302, 301)).toBeNull();
    expect(t.up()).toBe("click");
  });

  it("each press can produce its own drag", () => {
    const t = createDragClickTracker();
    t.down(0, 0);
    expect(t.move(9, 0)).toBe("drag");
    expect(t.up()).toBe("none");
    t.down(0, 0);
    expect(t.move(0, 9)).toBe("drag");
  });
});
