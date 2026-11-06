import type { Reminder } from "../types";
import {
  ackReminder,
  earliestScheduled,
  fire,
  formatUtc,
  isDue,
  parseInstant,
  reminderZone,
  setReminder,
  setReminderWall,
  snoozeReminder,
} from "./schedule";
import { parseWall } from "./zoned";

const ID = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";
const t = (s: string) => parseInstant(s)!;
const base = (patch: Partial<Reminder> = {}): Reminder => ({
  noteId: ID,
  at: "2026-11-05T08:00:00.000Z",
  repeat: "daily",
  state: "scheduled",
  firedAt: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
  timeZone: "Europe/Berlin",
  ...patch,
});

describe("schedule.ts", () => {
  it("parses only RFC 3339 instants", () => {
    expect(parseInstant("2026-11-05T09:00:00+01:00")).toBe(Date.UTC(2026, 10, 5, 8));
    expect(parseInstant("2026-11-05T08:00:00.250Z")).toBe(Date.UTC(2026, 10, 5, 8, 0, 0, 250));
    expect(parseInstant("2026-11-05")).toBeNull();
    expect(parseInstant("Nov 5 2026")).toBeNull();
    expect(parseInstant("tomorrow")).toBeNull();
  });

  it("due is a pure instant comparison", () => {
    const r = base({ at: "2026-11-05T09:00:00+01:00" });
    expect(isDue(r, t("2026-11-05T07:59:59.999Z"))).toBe(false);
    expect(isDue(r, t("2026-11-05T08:00:00Z"))).toBe(true);
    expect(isDue({ ...r, state: "due" }, t("2026-11-05T09:00:00Z"))).toBe(false);
  });

  it("fire keeps updatedAt", () => {
    const r = fire(base(), t("2026-11-05T08:00:03Z"));
    expect(r.state).toBe("due");
    expect(r.firedAt).toBe("2026-11-05T08:00:03.000Z");
    expect(r.updatedAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("setReminder stamps updatedAt and zone, keeps firedAt", () => {
    const now = t("2026-11-04T12:00:00.123Z");
    const r = setReminder(base({ firedAt: "x", state: "due" }), ID, t("2026-11-06T10:15:30.250+01:00"), "none", "America/New_York", now);
    expect(r).toEqual({
      noteId: ID,
      at: "2026-11-06T09:15:30.250Z",
      repeat: "none",
      state: "scheduled",
      firedAt: "x",
      updatedAt: "2026-11-04T12:00:00.123Z",
      timeZone: "America/New_York",
    });
  });

  it("setReminderWall uses the reminder zone, not the device zone", () => {
    const wall = parseWall("2026-11-05T09:00")!;
    const now = t("2026-11-04T12:00:00Z");
    expect(setReminderWall(null, ID, wall, "daily", "Europe/Berlin", now).at).toBe("2026-11-05T08:00:00.000Z");
    expect(setReminderWall(null, ID, wall, "daily", "America/New_York", now).at).toBe("2026-11-05T14:00:00.000Z");
    expect(setReminderWall(null, ID, wall, "daily", "Asia/Kolkata", now).at).toBe("2026-11-05T03:30:00.000Z");
  });

  it("ack: Berlin 09:00 acknowledged in New York → next day 09:00 Berlin (scenario 24)", () => {
    const r = base({ at: "2026-11-05T08:00:00.000Z", state: "due" });
    const out = ackReminder(r, t("2026-11-05T13:00:00Z"), "America/New_York");
    expect(out.at).toBe("2026-11-06T08:00:00.000Z");
    expect(out.timeZone).toBe("Europe/Berlin");
  });

  it("ack without zone falls back and records the zone", () => {
    const out = ackReminder(base({ timeZone: null, at: "2026-11-06T14:00:00Z" }), t("2026-11-06T14:01:00Z"), "America/New_York");
    expect(out.at).toBe("2026-11-07T14:00:00.000Z");
    expect(out.timeZone).toBe("America/New_York");
    expect(reminderZone({ timeZone: "Mars/Olympus" }, "UTC")).toBe("UTC");
  });

  it("one-off ack is done", () => {
    const out = ackReminder(base({ repeat: "none", state: "due" }), t("2026-11-05T08:05:00Z"), "UTC");
    expect(out.state).toBe("done");
    expect(out.at).toBe("2026-11-05T08:00:00.000Z");
    expect(out.updatedAt).toBe("2026-11-05T08:05:00.000Z");
  });

  it("snooze validates minutes", () => {
    const now = t("2026-11-05T08:05:00Z");
    expect(() => snoozeReminder(base(), 0, now)).toThrow();
    expect(() => snoozeReminder(base(), 1441, now)).toThrow();
    expect(() => snoozeReminder(base(), 1.5, now)).toThrow();
    const r = snoozeReminder(base({ state: "due" }), 10, now);
    expect(r.at).toBe("2026-11-05T08:15:00.000Z");
    expect(r.state).toBe("scheduled");
    expect(r.updatedAt).toBe(formatUtc(now));
  });

  it("earliestScheduled", () => {
    expect(earliestScheduled([])).toBeNull();
    expect(
      earliestScheduled([
        base({ at: "2026-11-05T09:00:00+01:00" }),
        base({ at: "2026-11-05T07:00:00Z", state: "due" }),
        base({ at: "2026-11-05T07:30:00Z" }),
      ]),
    ).toBe(t("2026-11-05T07:30:00Z"));
  });
});
