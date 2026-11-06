/**
 * Test helpers for the sync engine (no real network): an in-memory server speaking
 * API v1 (§6, D-63) with the shared LWW rules, manual timers and a Web Locks fake.
 * Only imported by tests (and usable by C2/N1 tests).
 */
import { clampFuture, cmpStamp, noteWinner, orderWinner, reminderWinner } from "../../lib/sync/lww";
import type {
  NoteRecord,
  OrderRecord,
  PushRequest,
  PushResult,
  ReminderRecord,
} from "../../lib/sync/types";
import type { HttpAdapter, HttpResponse } from "../contract";
import { NetworkError } from "./http";

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Stored<T> {
  rec: T;
  seq: number;
}

export interface LoggedRequest {
  device: string;
  method: Method;
  path: string;
  body: unknown;
}

export interface FakeDevice {
  adapter: HttpAdapter & { serverUrl: string };
  /** Simulates no network (fetch rejects). */
  offline: boolean;
  /** Device clock (Unix ms) used for sentAt/receivedAt. */
  now: () => number;
  /** Queue of forced responses for the next requests. */
  failNext(status: number, error?: string): void;
  authorized: boolean;
}

export class FakeServer {
  serverNow: () => number;
  password = "correct horse battery";
  username = "martin";
  timeZone = "Europe/Berlin";
  seq = 0;
  minCursor = 0;
  notes = new Map<string, Stored<NoteRecord>>();
  reminders = new Map<string, Stored<ReminderRecord>>();
  order: Stored<OrderRecord> | null = null;
  revisions: { noteId: string; reason: "replaced" | "rejected"; rec: NoteRecord }[] = [];
  log: LoggedRequest[] = [];
  deviceStates = new Map<string, unknown>();
  /** Delay before answering /sync/push (ms of real time) – for concurrency tests. */
  pushDelayMs = 0;
  inFlightPushes = 0;
  maxInFlightPushes = 0;
  private devCounter = 0;

  constructor(serverNow: () => number) {
    this.serverNow = serverNow;
  }

  private iso(): string {
    return new Date(this.serverNow()).toISOString();
  }

  /** A client device; `kind` web = cookie session, mobile = bearer token (authorized flag). */
  device(kind: "web" | "mobile", now: () => number, name = `${kind}-${++this.devCounter}`): FakeDevice {
    const forced: { status: number; error?: string }[] = [];
    const dev: FakeDevice = {
      offline: false,
      now,
      authorized: false,
      failNext: (status, error) => forced.push({ status, error }),
      adapter: {
        kind,
        serverUrl: "https://buddy.test",
        request: async <T>(method: Method, path: string, body?: unknown): Promise<HttpResponse<T>> => {
          const sentAt = now();
          if (dev.offline) throw new NetworkError("offline");
          this.log.push({ device: name, method, path, body });
          const f = forced.shift();
          let res: { status: number; body: unknown };
          if (f) res = { status: f.status, body: { error: f.error ?? "error", message: "forced", serverTime: this.iso() } };
          else res = await this.handle(dev, kind, method, path, body);
          if (res.status === 401) dev.authorized = false;
          return { status: res.status, body: res.body as T, sentAt, receivedAt: now() };
        },
      },
    };
    return dev;
  }

  private async handle(
    dev: FakeDevice,
    kind: "web" | "mobile",
    method: Method,
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const [route, query] = path.split("?");
    const st = this.iso();
    const err = (status: number, error: string) => ({ status, body: { error, message: error, serverTime: st } });
    if (method === "POST" && (route === "/session" || route === "/devices")) {
      const b = body as { username: string; password: string; deviceId?: string | null; kind?: string };
      if (b.username !== this.username || b.password !== this.password) return err(401, "unauthorized");
      if (route === "/session" && kind !== "web") return err(400, "bad_request");
      dev.authorized = true;
      const deviceId = (route === "/session" && b.deviceId) || `srv-${++this.devCounter}`;
      return route === "/session"
        ? { status: 200, body: { deviceId, serverTime: st } }
        : { status: 200, body: { deviceId, token: "tok-secret", serverTime: st } };
    }
    if (!dev.authorized) return err(401, "unauthorized");
    if (method === "DELETE" && (route === "/session" || route === "/devices/current")) {
      dev.authorized = false;
      return { status: 204, body: null };
    }
    if (method === "GET" && route === "/me") {
      return { status: 200, body: { username: this.username, timeZone: this.timeZone, deviceId: "x", serverTime: st } };
    }
    if (method === "GET" && route === "/sync/changes") {
      const params = new URLSearchParams(query);
      const since = Number(params.get("since") ?? 0);
      const limit = Number(params.get("limit") ?? 500);
      if (since > 0 && since < this.minCursor) return err(410, "full_resync_required");
      type Item = { seq: number; kind: "n" | "r"; rec: NoteRecord | ReminderRecord };
      const items: Item[] = [
        ...[...this.notes.values()].map((s) => ({ seq: s.seq, kind: "n" as const, rec: s.rec })),
        ...[...this.reminders.values()].map((s) => ({ seq: s.seq, kind: "r" as const, rec: s.rec })),
      ]
        .filter((i) => i.seq > since)
        .sort((a, b) => a.seq - b.seq);
      const page = items.slice(0, limit);
      const hasMore = items.length > limit;
      const cursor = hasMore ? page[page.length - 1].seq : this.seq;
      const order = this.order && this.order.seq > since && this.order.seq <= cursor ? this.order.rec : null;
      return {
        status: 200,
        body: {
          cursor,
          hasMore,
          notes: page.filter((i) => i.kind === "n").map((i) => i.rec),
          reminders: page.filter((i) => i.kind === "r").map((i) => i.rec),
          order,
          serverTime: st,
        },
      };
    }
    if (method === "POST" && route === "/sync/push") {
      this.inFlightPushes++;
      this.maxInFlightPushes = Math.max(this.maxInFlightPushes, this.inFlightPushes);
      try {
        if (this.pushDelayMs > 0) await new Promise((r) => setTimeout(r, this.pushDelayMs));
        return { status: 200, body: this.push(body as PushRequest) };
      } finally {
        this.inFlightPushes--;
      }
    }
    return err(404, "not_found");
  }

  private push(req: PushRequest) {
    const results: PushResult[] = [];
    const now = this.serverNow();
    for (const incoming of req.notes) {
      if (!/^[0-9a-z-]+$/i.test(incoming.id)) {
        results.push({ kind: "note", id: incoming.id, status: "invalid", message: "invalid note id" });
        continue;
      }
      const clamped = clampFuture(incoming.updatedAt, now) ?? incoming.updatedAt;
      const rec = { ...incoming, updatedAt: clamped };
      const cur = this.notes.get(rec.id);
      if (cur && cmpStamp(rec.updatedAt, rec.updatedBy, cur.rec.updatedAt, cur.rec.updatedBy) === 0) {
        results.push({ kind: "note", id: rec.id, status: "applied" });
      } else if (cur && noteWinner(cur.rec, rec) === "local") {
        this.revisions.push({ noteId: rec.id, reason: "rejected", rec });
        results.push({ kind: "note", id: rec.id, status: "stale", note: cur.rec });
      } else {
        if (cur) this.revisions.push({ noteId: rec.id, reason: "replaced", rec: cur.rec });
        this.notes.set(rec.id, { rec, seq: ++this.seq });
        results.push({
          kind: "note",
          id: rec.id,
          status: "applied",
          ...(clamped !== incoming.updatedAt ? { clampedUpdatedAt: clamped } : {}),
        });
      }
    }
    for (const incoming of req.reminders) {
      const clamped = clampFuture(incoming.updatedAt, now) ?? incoming.updatedAt;
      const rec = { ...incoming, updatedAt: clamped };
      const cur = this.reminders.get(rec.noteId);
      if (cur && reminderWinner(cur.rec, rec) === "local") {
        const echo = cmpStamp(rec.updatedAt, rec.updatedBy, cur.rec.updatedAt, cur.rec.updatedBy) === 0;
        results.push(
          echo
            ? { kind: "reminder", id: rec.noteId, status: "applied" }
            : { kind: "reminder", id: rec.noteId, status: "stale", reminder: cur.rec },
        );
      } else {
        this.reminders.set(rec.noteId, { rec, seq: ++this.seq });
        results.push({ kind: "reminder", id: rec.noteId, status: "applied" });
      }
    }
    if (req.order) {
      const rec = { ...req.order, updatedAt: clampFuture(req.order.updatedAt, now) ?? req.order.updatedAt };
      if (this.order && orderWinner(this.order.rec, rec) === "local") {
        results.push({ kind: "order", id: "order", status: "stale", order: this.order.rec });
      } else {
        this.order = { rec, seq: ++this.seq };
        results.push({ kind: "order", id: "order", status: "applied" });
      }
    }
    if (req.deviceState) this.deviceStates.set("last", req.deviceState);
    return { results, cursor: this.seq, serverTime: this.iso() };
  }

  /** Server-side scheduler firing a reminder (state due, updatedAt unchanged, D-30). */
  fireReminder(noteId: string): void {
    const cur = this.reminders.get(noteId);
    if (!cur?.rec.reminder) return;
    const rec = { ...cur.rec, reminder: { ...cur.rec.reminder, state: "due" as const, firedAt: this.iso() } };
    this.reminders.set(noteId, { rec, seq: ++this.seq });
  }

  /** Simulates tombstone purge: drops tombstones and raises min_cursor. */
  purgeTombstones(): void {
    for (const [id, s] of this.notes) if (s.rec.deleted) this.notes.delete(id);
    for (const [id, s] of this.reminders) if (s.rec.deleted) this.reminders.delete(id);
    this.minCursor = this.seq + 1;
    this.seq++;
  }
}

/** Manual timers for SyncEngineOptions.setTimeout/clearTimeout. */
export class ManualTimers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  readonly setTimeout = ((fn: () => void, ms?: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + (ms ?? 0), fn });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clearTimeout = ((id: number) => {
    this.tasks.delete(id);
  }) as unknown as typeof clearTimeout;

  /** Delays of pending timers relative to now (sorted). */
  pending(): number[] {
    return [...this.tasks.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Advances time and runs due timers in order (each callback synchronously). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.tasks) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = target;
  }
}

/** Minimal exclusive Web Locks fake (navigator.locks.request(name, cb)). */
export class FakeLocks {
  private tails = new Map<string, Promise<unknown>>();
  held = 0;
  maxHeld = 0;

  request<T>(name: string, cb: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(async () => {
      this.held++;
      this.maxHeld = Math.max(this.maxHeld, this.held);
      try {
        return await cb();
      } finally {
        this.held--;
      }
    });
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}
