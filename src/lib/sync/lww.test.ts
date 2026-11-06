import vectors from "../../../crates/buddy-core/tests/fixtures/lww_vectors.json";
import type { ReminderState } from "../../types";
import { clampFuture, noteWinner, orderWinner, reminderWinner } from "./lww";
import type { NoteRecord, OrderRecord, ReminderRecord } from "./types";

const ID = "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f";
interface Side {
  updatedAt: string;
  updatedBy: string;
  deleted?: boolean;
  state?: string;
}
const note = (s: Side): NoteRecord => ({ id: ID, updatedAt: s.updatedAt, updatedBy: s.updatedBy, deleted: !!s.deleted, note: null });
const reminder = (s: Side): ReminderRecord => ({
  noteId: ID,
  updatedAt: s.updatedAt,
  updatedBy: s.updatedBy,
  deleted: !!s.deleted,
  reminder: s.deleted
    ? null
    : {
        noteId: ID,
        at: "2026-11-07T08:00:00.000Z",
        repeat: "none",
        state: (s.state ?? "scheduled") as ReminderState,
        firedAt: null,
        updatedAt: s.updatedAt,
        timeZone: "Europe/Berlin",
      },
});
const order = (s: Side): OrderRecord => ({ updatedAt: s.updatedAt, updatedBy: s.updatedBy, ids: [] });

describe("lww_vectors.json", () => {
  it.each(vectors.notes.map((c) => [c.name, c] as const))("note: %s", (_n, c) => {
    expect(noteWinner(note(c.local), note(c.remote))).toBe(c.winner);
  });
  it.each(vectors.reminders.map((c) => [c.name, c] as const))("reminder: %s", (_n, c) => {
    expect(reminderWinner(reminder(c.local), reminder(c.remote))).toBe(c.winner);
  });
  it.each(vectors.order.map((c) => [c.name, c] as const))("order: %s", (_n, c) => {
    expect(orderWinner(order(c.local), order(c.remote))).toBe(c.winner);
  });
  it.each(vectors.clamp.map((c) => [c.name, c] as const))("clamp: %s", (_n, c) => {
    expect(clampFuture(c.ts, Date.parse(c.serverNow))).toBe(c.expected);
  });
});
