// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Note, Reminder } from "../../types";
import {
  diffPlan,
  fnv1a32,
  MAX_PLANNED,
  notificationBody,
  notificationId,
  noteTitle,
  planReminders,
  reminderForNotification,
  resolvedActive,
  scheduleDate,
  TEST_NOTIFICATION_ID,
} from "./native-plan";

const NOW = Date.parse("2026-11-06T10:00:00.000Z");

function note(id: string, title = "", text = ""): Note {
  return {
    id,
    title,
    color: "yellow",
    content: text
      ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
      : { type: "doc", content: [] },
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    schemaVersion: 1,
  };
}

function rem(noteId: string, at: string, patch: Partial<Reminder> = {}): Reminder {
  return {
    noteId,
    at,
    repeat: "none",
    state: "scheduled",
    firedAt: null,
    updatedAt: "2026-11-05T10:00:00.000Z",
    timeZone: "Europe/Berlin",
    ...patch,
  };
}

describe("notificationId", () => {
  it("is FNV-1a 32 (reference vectors)", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("is a stable signed 32-bit integer of (noteId, instant)", () => {
    const id = notificationId("n1", "2026-11-06T11:00:00.000Z");
    expect(id).not.toBeNull();
    expect(Number.isInteger(id)).toBe(true);
    expect(id!).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(id!).toBeLessThan(2 ** 31);
    expect(notificationId("n1", "2026-11-06T11:00:00.000Z")).toBe(id);
    // same instant written with an offset → same id
    expect(notificationId("n1", "2026-11-06T12:00:00+01:00")).toBe(id);
  });

  it("changes when the occurrence moves or the note differs", () => {
    const a = notificationId("n1", "2026-11-06T11:00:00.000Z");
    expect(notificationId("n1", "2026-11-06T11:10:00.000Z")).not.toBe(a);
    expect(notificationId("n2", "2026-11-06T11:00:00.000Z")).not.toBe(a);
  });

  it("returns null for unreadable times", () => {
    expect(notificationId("n1", "morgen")).toBeNull();
  });

  it("never collides with the test notification id", () => {
    for (let i = 0; i < 2000; i++) {
      expect(notificationId(`n${i}`, "2026-11-06T11:00:00.000Z")).not.toBe(TEST_NOTIFICATION_ID);
    }
  });
});

describe("planReminders", () => {
  it("plans only scheduled reminders in the future, sorted by time", () => {
    const plan = planReminders({
      reminders: [
        rem("late", "2026-11-06T12:00:00.000Z"),
        rem("early", "2026-11-06T10:30:00.000Z"),
        rem("past", "2026-11-06T09:59:59.000Z"),
        rem("now", "2026-11-06T10:00:00.000Z"),
        rem("due", "2026-11-06T11:00:00.000Z", { state: "due" }),
        rem("done", "2026-11-06T11:00:00.000Z", { state: "done" }),
        rem("broken", "kaputt"),
      ],
      notes: [note("late", "Spät"), note("early", "Früh")],
      now: NOW,
      deviceZone: "Europe/Berlin",
    });
    expect(plan.notifications.map((n) => n.noteId)).toEqual(["early", "late"]);
    expect(plan.notifications[0]).toMatchObject({
      id: notificationId("early", "2026-11-06T10:30:00.000Z"),
      at: "2026-11-06T10:30:00.000Z",
      atMs: Date.parse("2026-11-06T10:30:00.000Z"),
      title: "Früh",
      body: "Erinnerung um 11:30",
    });
    expect(plan.truncated).toBe(0);
  });

  it(`keeps at most ${MAX_PLANNED} (iOS limit 64), the nearest ones`, () => {
    const reminders = Array.from({ length: 75 }, (_, i) =>
      rem(`n${String(i).padStart(2, "0")}`, new Date(NOW + (75 - i) * 60_000).toISOString()),
    );
    const plan = planReminders({ reminders, notes: [], now: NOW, deviceZone: "UTC" });
    expect(plan.notifications).toHaveLength(MAX_PLANNED);
    expect(plan.truncated).toBe(15);
    // nearest first: n74 (1 min) … n15 (60 min)
    expect(plan.notifications[0].noteId).toBe("n74");
    expect(plan.notifications[MAX_PLANNED - 1].noteId).toBe("n15");
  });

  it("uses the absolute instant whatever the device zone (only the text changes)", () => {
    const reminders = [rem("n1", "2026-11-07T08:00:00.000Z")]; // 09:00 Berlin
    const berlin = planReminders({ reminders, notes: [note("n1", "Arzt")], now: NOW, deviceZone: "Europe/Berlin" });
    const ny = planReminders({ reminders, notes: [note("n1", "Arzt")], now: NOW, deviceZone: "America/New_York" });
    expect(ny.notifications[0].id).toBe(berlin.notifications[0].id);
    expect(ny.notifications[0].atMs).toBe(berlin.notifications[0].atMs);
    expect(berlin.notifications[0].body).toBe("Erinnerung um 09:00");
    expect(ny.notifications[0].body).toBe("Erinnerung um 03:00 (09:00 Berlin)");
  });

  it("titles: note title, else start of the text, else generic", () => {
    expect(noteTitle(note("a", "  Einkauf "))).toBe("Einkauf");
    expect(noteTitle(note("a", "", "Milch und Brot"))).toBe("Milch und Brot");
    expect(noteTitle(note("a"))).toBe("Erinnerung");
    expect(noteTitle(undefined)).toBe("Erinnerung");
    expect(noteTitle(note("a", "x".repeat(100)))).toHaveLength(60);
  });

  it("body: text snippet when the title is separate", () => {
    const at = Date.parse("2026-11-07T08:00:00.000Z");
    expect(notificationBody(note("a", "Arzt", "Karte mitnehmen"), at, "Europe/Berlin", "Europe/Berlin")).toBe(
      "Karte mitnehmen\nErinnerung um 09:00",
    );
    expect(notificationBody(note("a", "", "Karte mitnehmen"), at, "Asia/Tokyo", "Europe/Berlin")).toBe(
      "Erinnerung um 09:00 (17:00 Tokyo)",
    );
  });
});

describe("diffPlan", () => {
  const plan = (rs: Reminder[], deviceZone = "Europe/Berlin") =>
    planReminders({ reminders: rs, notes: [note("a", "A"), note("b", "B")], now: NOW, deviceZone }).notifications;

  it("first plan: schedules everything", () => {
    const wanted = plan([rem("a", "2026-11-06T11:00:00.000Z"), rem("b", "2026-11-06T12:00:00.000Z")]);
    expect(diffPlan(wanted, [])).toEqual({ cancel: [], schedule: wanted });
  });

  it("unchanged plan: nothing to do", () => {
    const wanted = plan([rem("a", "2026-11-06T11:00:00.000Z")]);
    const pending = wanted.map((w) => ({ id: w.id, title: w.title, body: w.body }));
    expect(diffPlan(wanted, pending)).toEqual({ cancel: [], schedule: [] });
  });

  it("moved (snooze/edit elsewhere): cancels the old id, schedules the new one", () => {
    const before = plan([rem("a", "2026-11-06T11:00:00.000Z")]);
    const after = plan([rem("a", "2026-11-06T11:10:00.000Z")]);
    const d = diffPlan(after, before.map((w) => ({ id: w.id, title: w.title, body: w.body })));
    expect(d.cancel).toEqual([before[0].id]);
    expect(d.schedule.map((s) => s.id)).toEqual([after[0].id]);
  });

  it("acknowledged/removed: cancels, keeps the test notification", () => {
    const before = plan([rem("a", "2026-11-06T11:00:00.000Z")]);
    const pending = [...before.map((w) => ({ id: w.id })), { id: TEST_NOTIFICATION_ID }];
    expect(diffPlan([], pending)).toEqual({ cancel: [before[0].id], schedule: [] });
  });

  it("text changed (device zone changed on a trip): replaces with the same id", () => {
    const berlin = plan([rem("a", "2026-11-07T08:00:00.000Z")]);
    const ny = plan([rem("a", "2026-11-07T08:00:00.000Z")], "America/New_York");
    const d = diffPlan(ny, berlin.map((w) => ({ id: w.id, title: w.title, body: w.body })));
    expect(d.cancel).toEqual([berlin[0].id]);
    expect(d.schedule).toEqual(ny);
    expect(ny[0].id).toBe(berlin[0].id);
  });

  it("platforms without text in pending(): compares ids only", () => {
    const wanted = plan([rem("a", "2026-11-06T11:00:00.000Z")]);
    expect(diffPlan(wanted, [{ id: wanted[0].id, title: null, body: null }])).toEqual({ cancel: [], schedule: [] });
  });
});

describe("resolvedActive / reminderForNotification", () => {
  it("removes delivered notifications of done, moved or deleted occurrences only", () => {
    const due = rem("a", "2026-11-06T09:00:00.000Z", { state: "due" });
    const doneR = rem("b", "2026-11-06T09:00:00.000Z", { state: "done" });
    const idDue = notificationId("a", due.at)!;
    const idDone = notificationId("b", doneR.at)!;
    const idMoved = notificationId("a", "2026-11-06T08:00:00.000Z")!;
    const idGone = notificationId("zzz", "2026-11-06T08:00:00.000Z")!;
    expect(resolvedActive([idDue, idDone, idMoved, idGone, TEST_NOTIFICATION_ID], [due, doneR])).toEqual([
      idDone,
      idMoved,
      idGone,
    ]);
  });

  it("finds the reminder of a notification id (iOS reports only the id)", () => {
    const r = rem("a", "2026-11-06T11:00:00.000Z");
    expect(reminderForNotification(notificationId("a", r.at)!, [rem("b", r.at), r])).toBe(r);
    expect(reminderForNotification(notificationId("a", "2026-11-06T12:00:00.000Z")!, [r])).toBeNull();
  });
});

describe("scheduleDate", () => {
  it("rounds up to the whole second (never early, no fraction for the native parsers)", () => {
    expect(scheduleDate(Date.parse("2026-11-06T10:00:00.000Z")).toISOString()).toBe("2026-11-06T10:00:00.000Z");
    expect(scheduleDate(Date.parse("2026-11-06T10:00:00.001Z")).toISOString()).toBe("2026-11-06T10:00:01.000Z");
  });
});
