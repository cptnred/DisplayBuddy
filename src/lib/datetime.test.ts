// Node re-reads TZ at runtime; vitest isolates test files, so this only affects this file.
process.env.TZ = "Europe/Berlin";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatReminder,
  fromRfc3339,
  nextFullHour,
  offsetOf,
  parseLocal,
  toDateInput,
  toRfc3339Local,
  toTimeInput,
} from "./datetime";

/** True when the TZ override took effect (otherwise the Berlin-specific cases are skipped). */
const berlin = new Date(2026, 10, 5, 12).getTimezoneOffset() === -60 && new Date(2026, 6, 5, 12).getTimezoneOffset() === -120;

afterEach(() => {
  vi.useRealTimers();
});

describe("TZ-independent", () => {
  it("toRfc3339Local round-trips through Date and fromRfc3339", () => {
    const s = toRfc3339Local("2026-11-05", "14:30");
    expect(s).toMatch(/^2026-11-05T14:30:00[+-]\d{2}:\d{2}$/);
    const d = new Date(s);
    expect(d.getTime()).toBe(new Date(2026, 10, 5, 14, 30).getTime());
    expect(s.slice(-6)).toBe(offsetOf(new Date(2026, 10, 5, 14, 30)));
    expect(fromRfc3339(s)).toEqual({ date: "2026-11-05", time: "14:30" });
  });

  it("fromRfc3339 converts foreign offsets into local time", () => {
    const d = new Date("2026-11-05T13:30:00Z");
    expect(fromRfc3339("2026-11-05T13:30:00Z")).toEqual({ date: toDateInput(d), time: toTimeInput(d) });
    expect(fromRfc3339("nonsense")).toBeNull();
  });

  it("rejects invalid input", () => {
    expect(() => toRfc3339Local("2026-02-31", "10:00")).toThrow(RangeError);
    expect(() => toRfc3339Local("2026-11-05", "24:00")).toThrow(RangeError);
    expect(() => toRfc3339Local("", "10:00")).toThrow(RangeError);
    expect(parseLocal("2026-11-05", "")).toBeNull();
  });

  it("formatReminder: today / tomorrow / yesterday / weekday / other year", () => {
    const now = new Date(2026, 10, 5, 8, 0); // Thu 05.11.2026
    const at = (y: number, mo: number, d: number, h: number, mi: number) => toRfc3339Local(
      `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
    );
    expect(formatReminder(at(2026, 11, 5, 14, 30), now)).toBe("Heute, 14:30");
    expect(formatReminder(at(2026, 11, 5, 0, 0), now)).toBe("Heute, 00:00");
    expect(formatReminder(at(2026, 11, 6, 9, 0), now)).toBe("Morgen, 09:00");
    expect(formatReminder(at(2026, 11, 4, 18, 0), now)).toBe("Gestern, 18:00");
    expect(formatReminder(at(2026, 11, 7, 14, 30), now)).toBe("Sa., 07.11., 14:30");
    expect(formatReminder(at(2026, 11, 13, 14, 30), now)).toBe("Fr., 13.11., 14:30");
    expect(formatReminder(at(2027, 11, 7, 14, 30), now)).toBe("07.11.2027, 14:30");
    expect(formatReminder(at(2027, 1, 1, 0, 5), new Date(2026, 11, 31, 12))).toBe("Morgen, 00:05");
    expect(formatReminder("kaputt", now)).toBe("kaputt");
  });

  it("formatReminder defaults to the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 5, 10, 0));
    expect(formatReminder(toRfc3339Local("2026-11-05", "14:30"))).toBe("Heute, 14:30");
  });

  it("nextFullHour", () => {
    expect(nextFullHour(new Date(2026, 10, 5, 14, 5, 12))).toEqual(new Date(2026, 10, 5, 15, 0, 0));
    expect(nextFullHour(new Date(2026, 10, 5, 14, 0, 0))).toEqual(new Date(2026, 10, 5, 15, 0, 0));
    expect(nextFullHour(new Date(2026, 10, 5, 23, 30))).toEqual(new Date(2026, 10, 6, 0, 0, 0));
    expect(nextFullHour(new Date(2026, 11, 31, 23, 59))).toEqual(new Date(2027, 0, 1, 0, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 5, 9, 41));
    expect(nextFullHour()).toEqual(new Date(2026, 10, 5, 10, 0, 0));
  });
});

describe.runIf(berlin)("Europe/Berlin (DST)", () => {
  it("uses the offset valid at that moment", () => {
    expect(toRfc3339Local("2026-11-05", "14:30")).toBe("2026-11-05T14:30:00+01:00");
    expect(toRfc3339Local("2026-07-05", "14:30")).toBe("2026-07-05T14:30:00+02:00");
  });

  it("handles the DST switch days", () => {
    // 2026-03-29: 02:00 → 03:00 (gap), 2026-10-25: 03:00 → 02:00
    expect(toRfc3339Local("2026-03-29", "01:30")).toBe("2026-03-29T01:30:00+01:00");
    expect(toRfc3339Local("2026-03-29", "02:30")).toBe("2026-03-29T03:30:00+02:00");
    expect(toRfc3339Local("2026-03-29", "04:00")).toBe("2026-03-29T04:00:00+02:00");
    expect(toRfc3339Local("2026-10-25", "04:00")).toBe("2026-10-25T04:00:00+01:00");
  });

  it("fromRfc3339 / formatReminder convert UTC into Berlin time", () => {
    expect(fromRfc3339("2026-11-05T13:30:00Z")).toEqual({ date: "2026-11-05", time: "14:30" });
    expect(fromRfc3339("2026-11-05T23:30:00Z")).toEqual({ date: "2026-11-06", time: "00:30" });
    expect(formatReminder("2026-11-05T23:30:00Z", new Date("2026-11-05T12:00:00Z"))).toBe("Morgen, 00:30");
  });

  it("nextFullHour across the spring-forward gap", () => {
    const at = nextFullHour(new Date(2026, 2, 29, 1, 15));
    expect(at.toISOString()).toBe("2026-03-29T01:00:00.000Z"); // 03:00 CEST
  });
});
