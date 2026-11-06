import { describe, expect, it } from "vitest";
import { dayLabel, dueText, formatReminderAt, reminderTimeText } from "./format";
import { instantToWall } from "../../lib/zoned";

const ms = (iso: string) => Date.parse(iso);

describe("reminderTimeText", () => {
  it("shows device time with the original zone time (PLAN §5.5 example)", () => {
    // 09:00 Berlin (CET) = 08:00Z = 03:00 New York
    const at = ms("2026-11-11T08:00:00.000Z");
    const now = ms("2026-11-11T06:00:00.000Z");
    const t = reminderTimeText(at, "Europe/Berlin", "America/New_York", now);
    expect(t.local).toBe("Heute, 03:00");
    expect(t.original).toBe("09:00 Berlin");
    expect(t.full).toBe("Heute, 03:00 (09:00 Berlin)");
  });

  it("has no original part when the zones show the same wall time", () => {
    const at = ms("2026-11-11T08:00:00.000Z");
    const t = reminderTimeText(at, "Europe/Berlin", "Europe/Paris", at);
    expect(t.original).toBeNull();
    expect(t.full).toBe("Heute, 09:00");
  });

  it("adds the weekday when the original date differs", () => {
    // 09:00 Tokyo on Thu 12.11. = 00:00Z = Wed 11.11. 19:00 New York
    const at = ms("2026-11-12T00:00:00.000Z");
    const now = ms("2026-11-11T12:00:00.000Z");
    const t = reminderTimeText(at, "Asia/Tokyo", "America/New_York", now);
    expect(t.full).toBe("Heute, 19:00 (Do. 09:00 Tokyo)");
  });

  it("uses the device zone for Morgen/Gestern and dates", () => {
    const today = instantToWall(ms("2026-11-11T12:00:00Z"), "UTC");
    expect(dayLabel(instantToWall(ms("2026-11-12T01:00:00Z"), "UTC"), today)).toBe("Morgen");
    expect(dayLabel(instantToWall(ms("2026-11-10T23:00:00Z"), "UTC"), today)).toBe("Gestern");
    expect(dayLabel(instantToWall(ms("2026-11-20T10:00:00Z"), "UTC"), today)).toBe("Fr., 20.11.");
    expect(dayLabel(instantToWall(ms("2027-01-02T10:00:00Z"), "UTC"), today)).toBe("02.01.2027");
  });

  it("is independent of the process zone (TZ)", () => {
    const at = ms("2026-03-20T08:00:00.000Z"); // between US and EU DST switch: 09:00 Berlin = 04:00 NY
    const t = reminderTimeText(at, "Europe/Berlin", "America/New_York", at);
    expect(t.full).toBe("Heute, 04:00 (09:00 Berlin)");
  });
});

describe("dueText / formatReminderAt", () => {
  it("says „fällig seit“ when the push arrives late", () => {
    const at = ms("2026-11-11T08:00:00.000Z");
    expect(dueText(at, "Europe/Berlin", "Europe/Berlin", at + 60_000)).toBe("fällig heute, 09:00");
    expect(dueText(at, "Europe/Berlin", "Europe/Berlin", at + 3 * 3_600_000)).toBe("fällig seit heute, 09:00");
  });

  it("falls back to the device zone for reminders without zone and to raw text when unreadable", () => {
    const now = ms("2026-11-11T06:00:00.000Z");
    expect(formatReminderAt({ at: "2026-11-11T08:00:00.000Z", timeZone: null }, "Europe/Berlin", now)).toBe(
      "Heute, 09:00",
    );
    expect(formatReminderAt({ at: "kaputt", timeZone: null }, "UTC", now)).toBe("kaputt");
  });
});
