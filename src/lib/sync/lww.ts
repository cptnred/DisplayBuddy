/**
 * Last-writer-wins per document (PLAN_V3_SYNC §5.4, D-29). Mirror of
 * `crates/buddy-core/src/lww.rs`; both pass `lww_vectors.json`.
 *
 * 1. `updatedAt` as an instant (unparseable = oldest); 2. reminders only: state rank
 * scheduled < due < done; 3. `updatedBy` (code-unit order, larger wins); 4. full tie → local.
 */
import type { ReminderState } from "../../types";
import { parseInstant } from "../schedule";
import type { NoteRecord, OrderRecord, ReminderRecord } from "./types";

export const MAX_FUTURE_MS = 2 * 60 * 1000;

export type Winner = "local" | "remote";

function instant(s: string): number {
  return parseInstant(s) ?? Number.NEGATIVE_INFINITY;
}

function cmp(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** >0 if remote is newer. String comparison by UTF-16 code units equals Rust's byte order for ASCII ids. */
export function cmpStamp(remoteAt: string, remoteBy: string, localAt: string, localBy: string): number {
  return cmp(instant(remoteAt), instant(localAt)) || cmp(remoteBy, localBy);
}

const decide = (c: number): Winner => (c > 0 ? "remote" : "local");

export function noteWinner(local: NoteRecord, remote: NoteRecord): Winner {
  return decide(cmpStamp(remote.updatedAt, remote.updatedBy, local.updatedAt, local.updatedBy));
}

export function orderWinner(local: OrderRecord, remote: OrderRecord): Winner {
  return decide(cmpStamp(remote.updatedAt, remote.updatedBy, local.updatedAt, local.updatedBy));
}

const RANK: Record<ReminderState, number> = { scheduled: 0, due: 1, done: 2 };

function stateRank(r: ReminderRecord): number {
  return r.reminder ? RANK[r.reminder.state] : 0;
}

export function reminderWinner(local: ReminderRecord, remote: ReminderRecord): Winner {
  return decide(
    cmp(instant(remote.updatedAt), instant(local.updatedAt)) ||
      cmp(stateRank(remote), stateRank(local)) ||
      cmp(remote.updatedBy, local.updatedBy),
  );
}

/** Server rule: > 2 min in the future → server time; otherwise verbatim. Null if not RFC 3339. */
export function clampFuture(ts: string, serverNowMs: number): string | null {
  const t = parseInstant(ts);
  if (t === null) return null;
  return t > serverNowMs + MAX_FUTURE_MS ? new Date(serverNowMs).toISOString() : ts;
}
