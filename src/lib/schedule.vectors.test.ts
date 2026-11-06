/**
 * TypeScript passes the SAME vectors as buddy-core (PLAN_V3_SYNC §5.5, scenario 20).
 * Also run with TZ=America/New_York and TZ=Asia/Tokyo (npm run test:tz): the device
 * zone must not change any result.
 */
import vectors from "../../crates/buddy-core/tests/fixtures/schedule_vectors.json";
import type { Reminder, ReminderRepeat, ReminderState } from "../types";
import { ackReminder, formatUtc, nextOccurrence, parseInstant, snoozeReminder } from "./schedule";
import { formatWall, instantToWall, parseWall, wallToInstant } from "./zoned";

const ID = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";
const ms = (s: string) => {
  const v = parseInstant(s);
  if (v === null) throw new Error(`bad instant ${s}`);
  return v;
};

describe("schedule_vectors.json", () => {
  it("has a meaningful number of cases", () => {
    expect(vectors.wallToInstant.length).toBeGreaterThanOrEqual(20);
    expect(vectors.next.length).toBeGreaterThanOrEqual(100);
    expect(vectors.ack.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors.wallToInstant.map((c) => [c.name, c] as const))("wall → instant: %s", (_n, c) => {
    const wall = parseWall(c.wall);
    expect(wall).not.toBeNull();
    const t = wallToInstant(wall!, c.zone);
    expect(t === null ? null : formatUtc(t)).toBe(c.expected);
  });

  it.each(vectors.instantToWall.map((c) => [c.name, c] as const))("instant → wall: %s", (_n, c) => {
    expect(formatWall(instantToWall(ms(c.instant), c.zone))).toBe(c.wall);
  });

  it.each(vectors.next.map((c) => [c.name, c] as const))("next: %s", (_n, c) => {
    const n = nextOccurrence(ms(c.at), c.repeat as ReminderRepeat, ms(c.now), c.zone);
    expect(n === null ? null : formatUtc(n)).toBe(c.expected);
  });

  it.each(vectors.ack.map((c) => [c.name, c] as const))("ack: %s", (_n, c) => {
    const r: Reminder = {
      noteId: ID,
      at: c.at,
      repeat: c.repeat as ReminderRepeat,
      state: "due",
      firedAt: null,
      updatedAt: null,
      timeZone: c.zone,
    };
    // the default zone must not matter when the reminder has its own
    const out = ackReminder(r, ms(c.now), "Pacific/Kiritimati");
    expect(out.at).toBe(c.expectedAt);
    expect(out.state).toBe(c.expectedState as ReminderState);
    expect(out.updatedAt).toBe(formatUtc(ms(c.now)));
  });

  it.each(vectors.snooze.map((c) => [c.name, c] as const))("snooze: %s", (_n, c) => {
    const r: Reminder = {
      noteId: ID,
      at: c.at,
      repeat: "daily",
      state: "due",
      firedAt: null,
      updatedAt: null,
      timeZone: "Asia/Kolkata",
    };
    expect(snoozeReminder(r, c.minutes, ms(c.now)).at).toBe(c.expectedAt);
  });
});
