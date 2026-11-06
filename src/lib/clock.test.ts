import vectors from "../../crates/buddy-core/tests/fixtures/clock_vectors.json";
import { createClock, medianOffset, needsClockWarning, offsetSample, pushOffset } from "./clock";

describe("clock_vectors.json", () => {
  it.each(vectors.samples.map((c) => [c.name, c] as const))("sample: %s", (_n, c) => {
    expect(offsetSample(c.serverTimeMs, c.sentMs, c.receivedMs)).toBe(c.expected);
  });

  it.each(vectors.median.map((c) => [c.name, c] as const))("median: %s", (_n, c) => {
    let kept: number[] = [];
    for (const p of c.pushes) kept = pushOffset(kept, p);
    expect(kept).toEqual(c.expectedKept);
    expect(medianOffset(kept)).toBe(c.expectedOffsetMs);
    expect(needsClockWarning(medianOffset(kept))).toBe(c.warning);
  });
});

describe("createClock", () => {
  it("adds the offset to an injected device time", () => {
    let now = Date.UTC(2026, 10, 6, 10);
    const c = createClock(() => now);
    expect(c.correctedNowIso()).toBe("2026-11-06T10:00:00.000Z");
    c.setOffsetMs(-600_000);
    expect(c.correctedNowIso()).toBe("2026-11-06T09:50:00.000Z");
    now += 1000;
    expect(c.correctedNow()).toBe(Date.UTC(2026, 10, 6, 9, 50, 1));
    c.setOffsetMs(Number.NaN);
    expect(c.offsetMs()).toBe(0);
  });
});
