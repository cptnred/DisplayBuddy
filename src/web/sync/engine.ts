/**
 * Sync engine for PWA and native shell (PLAN_V3_SYNC §9.3, protocol §6 / D-63).
 *
 * Run: push the outbox (≤ 200 records per kind and request) → apply results
 * (applied / stale → take server version + notice / invalid) → pull from the cursor
 * until `hasMore = false` → LWW merge (src/lib/sync/lww.ts, inside the data layer).
 * Every response with `serverTime` feeds the clock offset (src/lib/clock.ts).
 *
 * - 401 → state "unauthorized", outbox kept, no automatic retries until login.
 * - 410 full_resync_required → pull everything from 0, LWW merge, live local documents the
 *   server did not send go back into the outbox (restored backup), outbox pushed afterwards.
 * - Network error → "offline"; other failures → "error"; retry with backoff
 *   5 s → 30 s → 2 min → 5 min. `navigator.onLine` is only a hint.
 * - Runs are serialized per tab and across tabs with Web Locks
 *   (`navigator.locks.request("buddy-sync")`, MDN Web Locks API) where available.
 * - Background Sync (`registration.sync`, Chromium only per browser-compat-data) is an
 *   optional extra: registered when offline with pending changes; the service worker
 *   handles the `sync` event with tag {@link BACKGROUND_SYNC_TAG}.
 *
 * No DOM required: `window`/`document` listeners are installed only if present.
 */
import { needsClockWarning, offsetSample } from "../../lib/clock";
import { parseInstant } from "../../lib/schedule";
import {
  type DeviceLoginResponse,
  type DeviceState,
  ERROR_CODES,
  type Me,
  PUSH_BATCH_MAX,
  type PushRequest,
  type PushResponse,
  type SessionResponse,
  type SyncChanges,
} from "../../lib/sync/types";
import type {
  CreateSyncEngine,
  DataChange,
  DataStore,
  HttpAdapter,
  HttpResponse,
  SyncEngine,
  SyncEngineOptions,
  SyncNotice,
  WebSyncState,
  WebSyncStatus,
} from "../contract";
import { requestPersistentStorage } from "../data/persist";
import { type SyncAccess, syncAccess } from "../data/store";
import type { OutboxEntry } from "../data/db";
import { NetworkError } from "./http";

export const LOCK_NAME = "buddy-sync";
export const BACKGROUND_SYNC_TAG = "buddy-sync";
export const CHANGE_DEBOUNCE_MS = 2_000;
export const VISIBLE_INTERVAL_MS = 60_000;
export const BACKOFF_MS = [5_000, 30_000, 120_000, 300_000] as const;
export const PULL_LIMIT = 200;
const MAX_PAGES = 10_000;

export type SyncErrorCode =
  | "network"
  | "unauthorized"
  | "too_many_requests"
  | "full_resync_required"
  | "account_mismatch"
  | "http"
  | "invalid_response";

/** Error with a machine-readable code (the UI maps codes to German texts). */
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

function isNetworkFailure(e: unknown): boolean {
  return e instanceof NetworkError || e instanceof TypeError;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function sameDeviceState(a: DeviceState | null, b: DeviceState | null): boolean {
  return !!a && !!b && a.scheduledSeq === b.scheduledSeq && a.localNotifications === b.localNotifications;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

interface Batch {
  entries: OutboxEntry[];
  request: PushRequest;
}

/** Splits the outbox: note batches first (reminders refer to notes), order in the last batch. */
export function buildBatches(entries: OutboxEntry[], deviceState: DeviceState | null): Batch[] {
  const notes = entries.filter((e) => e.kind === "note");
  const reminders = entries.filter((e) => e.kind === "reminder");
  const order = entries.find((e) => e.kind === "order");
  const groups: OutboxEntry[][] = [...chunk(notes, PUSH_BATCH_MAX), ...chunk(reminders, PUSH_BATCH_MAX)];
  if (groups.length === 0) groups.push([]);
  if (order) groups[groups.length - 1] = [...groups[groups.length - 1], order];
  return groups.map((g) => {
    const request: PushRequest = {
      notes: g.flatMap((e) => (e.kind === "note" ? [e.record] : [])),
      reminders: g.flatMap((e) => (e.kind === "reminder" ? [e.record] : [])),
      order: g.find((e) => e.kind === "order")?.record ?? null,
    };
    if (deviceState) request.deviceState = deviceState;
    return { entries: g, request };
  });
}

class Engine implements SyncEngine {
  private readonly store: DataStore;
  private readonly access: SyncAccess;
  private readonly http: HttpAdapter;
  private readonly deviceState: () => DeviceState | null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  private current: WebSyncStatus;
  private readonly statusListeners = new Set<(s: WebSyncStatus) => void>();
  private readonly noticeListeners = new Set<(n: SyncNotice) => void>();

  private started = false;
  /** logout() done; stays signed out until login() even if the account is still stored. */
  private loggedOut = false;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private rerun: Parameters<SyncEngine["requestSync"]>[0] | null = null;
  private timer: unknown = null;
  private intervalTimer: unknown = null;
  private backoffStep = 0;
  private inBackoff = false;
  private lastDeviceState: DeviceState | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.access = syncAccess(options.store);
    this.http = options.http;
    this.deviceState = options.deviceState ?? (() => null);
    const st = options.setTimeout ?? globalThis.setTimeout;
    const ct = options.clearTimeout ?? globalThis.clearTimeout;
    this.setTimer = (fn, ms) => st(fn, ms);
    this.clearTimer = (id) => ct(id as ReturnType<typeof setTimeout>);
    this.current = {
      state: "idle",
      pending: 0,
      lastSyncAt: null,
      clockOffsetMs: this.store.clock.offsetMs(),
      clockWarning: needsClockWarning(this.store.clock.offsetMs()),
      message: null,
    };
    this.store.subscribe((c) => this.onDataChange(c));
    void this.refresh();
  }

  // ---- status -----------------------------------------------------------------------

  status(): WebSyncStatus {
    return { ...this.current };
  }

  onStatus(listener: (s: WebSyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onNotice(listener: (n: SyncNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  private setStatus(patch: Partial<WebSyncStatus>): void {
    const offset = this.store.clock.offsetMs();
    const next: WebSyncStatus = {
      ...this.current,
      ...patch,
      clockOffsetMs: offset,
      clockWarning: needsClockWarning(offset),
    };
    const changed = (Object.keys(next) as (keyof WebSyncStatus)[]).some((k) => next[k] !== this.current[k]);
    this.current = next;
    if (!changed) return;
    for (const l of [...this.statusListeners]) {
      try {
        l({ ...next });
      } catch (e) {
        console.error("sync status listener failed", e);
      }
    }
  }

  private notice(n: SyncNotice): void {
    for (const l of [...this.noticeListeners]) {
      try {
        l(n);
      } catch (e) {
        console.error("sync notice listener failed", e);
      }
    }
  }

  /** Re-reads pending count, account and lastSyncAt from the store. */
  private async refresh(): Promise<void> {
    try {
      const [pending, account, lastSyncAt] = await Promise.all([
        this.store.pendingCount(),
        this.store.getAccount(),
        this.access.getLastSyncAt(),
      ]);
      const patch: Partial<WebSyncStatus> = { pending, lastSyncAt };
      if (!account || this.loggedOut) patch.state = "signedOut";
      else if (this.current.state === "signedOut") patch.state = "idle";
      this.setStatus(patch);
    } catch {
      // store closed
    }
  }

  private onDataChange(change: DataChange): void {
    void this.refresh().then(() => {
      if (change.source === "local" && change.kind !== "account" && this.current.pending > 0) {
        this.requestSync("change");
      }
    });
  }

  // ---- triggers ---------------------------------------------------------------------

  private blocked(): boolean {
    return this.current.state === "signedOut" || this.current.state === "unauthorized";
  }

  private arm(delayMs: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  requestSync(reason: "change" | "online" | "visible" | "timer" | "start" | "push"): void {
    if (this.blocked()) return;
    if (this.running) {
      // remember one follow-up; a "change" never downgrades a stronger pending reason
      this.rerun = reason === "change" && this.rerun ? this.rerun : reason;
      return;
    }
    switch (reason) {
      case "change":
        if (!this.inBackoff) this.arm(CHANGE_DEBOUNCE_MS);
        break;
      case "timer":
        if (!this.inBackoff && this.timer === null) this.arm(0);
        break;
      case "online":
        this.backoffStep = 0;
        this.inBackoff = false;
        this.arm(0);
        break;
      default:
        this.arm(0);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const g = globalThis as {
      addEventListener?: (t: string, l: () => void) => void;
      removeEventListener?: (t: string, l: () => void) => void;
      document?: { visibilityState?: string; addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void };
    };
    const onOnline = () => this.requestSync("online");
    const onOffline = () => {
      // only a hint (MDN navigator.onLine): show it, the next request decides
      if (!this.running && !this.blocked()) this.setStatus({ state: "offline", message: "navigator offline" });
    };
    const onVisibility = () => {
      if (this.visible()) this.requestSync("visible");
    };
    g.addEventListener?.("online", onOnline);
    g.addEventListener?.("offline", onOffline);
    g.document?.addEventListener?.("visibilitychange", onVisibility);
    this.cleanups.push(() => {
      g.removeEventListener?.("online", onOnline);
      g.removeEventListener?.("offline", onOffline);
      g.document?.removeEventListener?.("visibilitychange", onVisibility);
    });
    this.armInterval();
    // the initial refresh may still be running: decide after it
    void this.refresh().then(() => this.requestSync("start"));
  }

  stop(): void {
    this.started = false;
    for (const c of this.cleanups.splice(0)) c();
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.intervalTimer !== null) this.clearTimer(this.intervalTimer);
    this.timer = null;
    this.intervalTimer = null;
  }

  private visible(): boolean {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    return !doc || doc.visibilityState !== "hidden";
  }

  private armInterval(): void {
    this.intervalTimer = this.setTimer(() => {
      this.intervalTimer = null;
      if (!this.started) return;
      if (this.visible()) this.requestSync("timer");
      this.armInterval();
    }, VISIBLE_INTERVAL_MS);
  }

  // ---- running ----------------------------------------------------------------------

  syncNow(): Promise<void> {
    if (this.running) {
      // a sync is in flight: run once more afterwards and resolve then
      this.queued ??= this.running.then(() => {
        this.queued = null;
        return this.syncNow();
      });
      return this.queued;
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const run = this.run().finally(() => {
      this.running = null;
      const again = this.rerun;
      this.rerun = null;
      if (again && !this.queued) this.requestSync(again);
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<void> {
    const account = await this.store.getAccount().catch(() => null);
    if (!account || this.loggedOut) {
      this.setStatus({ state: "signedOut" });
      return;
    }
    this.setStatus({ state: "syncing", message: null });
    try {
      const locks = lockManager();
      if (locks) await locks.request(LOCK_NAME, () => this.cycle());
      else await this.cycle();
      const now = this.store.clock.correctedNowIso();
      await this.access.setLastSyncAt(now);
      this.backoffStep = 0;
      this.inBackoff = false;
      // final state only after pending/lastSyncAt are fresh (observers may act on it)
      await this.refresh();
      this.setStatus({ state: "idle", lastSyncAt: now, message: null });
    } catch (e) {
      await this.refresh();
      this.fail(e);
    }
  }

  private async cycle(): Promise<void> {
    try {
      await this.push();
      await this.pull(false);
    } catch (e) {
      if (!(e instanceof SyncError && e.code === "full_resync_required")) throw e;
      await this.pull(true);
      this.notice({ kind: "fullResync" });
      await this.push();
    }
  }

  private fail(e: unknown): void {
    let state: WebSyncState = "error";
    let retry = true;
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof SyncError) {
      if (e.code === "unauthorized") {
        state = "unauthorized";
        retry = false;
      } else if (e.code === "network") {
        state = "offline";
      }
    } else if (isNetworkFailure(e)) {
      state = "offline";
      message = "network error";
    } else {
      console.error("sync failed", e);
    }
    this.setStatus({ state, message });
    if (retry && this.started) {
      const delay = BACKOFF_MS[Math.min(this.backoffStep, BACKOFF_MS.length - 1)];
      this.backoffStep++;
      this.inBackoff = true;
      this.arm(delay);
      if (state === "offline") void this.registerBackgroundSync();
    }
  }

  private async registerBackgroundSync(): Promise<void> {
    try {
      if (this.current.pending === 0) return;
      const sw = (globalThis.navigator as { serviceWorker?: ServiceWorkerContainer } | undefined)?.serviceWorker;
      const reg = await sw?.getRegistration?.();
      const sync = (reg as { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
      await sync?.register(BACKGROUND_SYNC_TAG);
    } catch {
      // optional (Chromium only); triggers and backoff cover the rest
    }
  }

  /** One request; measures the clock offset and maps error statuses. */
  private async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<HttpResponse<T>> {
    let res: HttpResponse<T>;
    try {
      res = await this.http.request<T>(method, path, body);
    } catch (e) {
      if (isNetworkFailure(e)) throw new SyncError("network", `network error: ${method} ${path.split("?")[0]}`);
      throw e;
    }
    await this.measure(res);
    const s = res.status;
    if (s >= 200 && s < 300) return res;
    const err = (res.body as { error?: unknown } | null)?.error;
    const code = typeof err === "string" ? err : "";
    if (s === 401) throw new SyncError("unauthorized", "unauthorized", s);
    if (s === 410 || code === ERROR_CODES.fullResyncRequired) {
      throw new SyncError("full_resync_required", "full resync required", s);
    }
    if (s === 429) throw new SyncError("too_many_requests", "too many requests", s);
    throw new SyncError("http", `HTTP ${s}${code ? ` ${code}` : ""}: ${method} ${path.split("?")[0]}`, s);
  }

  private async measure(res: HttpResponse<unknown>): Promise<void> {
    const serverTime = (res.body as { serverTime?: unknown } | null)?.serverTime;
    if (typeof serverTime !== "string") return;
    const server = parseInstant(serverTime);
    if (server === null) return;
    const sample = offsetSample(server, res.sentAt, res.receivedAt);
    if (sample === null) return;
    await this.access.addClockSample(sample);
    this.setStatus({});
  }

  private async push(): Promise<void> {
    const entries = await this.access.outbox();
    const ds = this.deviceState();
    const reportState = !!ds && !sameDeviceState(ds, this.lastDeviceState);
    if (entries.length === 0 && !reportState) return;
    for (const batch of buildBatches(entries, ds)) {
      const res = await this.call<PushResponse>("POST", "/sync/push", batch.request);
      const results = res.body?.results;
      if (!Array.isArray(results)) throw new SyncError("invalid_response", "push response without results");
      const outcome = await this.access.applyPushResults(batch.entries, results);
      for (const n of outcome.notices) this.notice(n);
      for (const inv of outcome.invalid) console.warn(`sync: server rejected ${inv.kind} record (${inv.message ?? "invalid"})`);
    }
    if (ds) this.lastDeviceState = ds;
  }

  private async pull(full: boolean): Promise<void> {
    let cursor = full ? 0 : await this.access.getCursor();
    const seenNotes = new Set<string>();
    const seenReminders = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call<SyncChanges>("GET", `/sync/changes?since=${cursor}&limit=${PULL_LIMIT}`);
      const body = res.body;
      if (!body || !Array.isArray(body.notes) || !Array.isArray(body.reminders) || typeof body.cursor !== "number") {
        throw new SyncError("invalid_response", "malformed changes response");
      }
      const outcome = await this.access.mergeChanges(body);
      for (const n of outcome.notices) this.notice(n);
      if (full) {
        for (const n of body.notes) seenNotes.add(n.id);
        for (const r of body.reminders) seenReminders.add(r.noteId);
      }
      cursor = body.cursor;
      if (!body.hasMore) break;
    }
    if (full) await this.access.requeueUnseen(seenNotes, seenReminders);
  }

  // ---- account ----------------------------------------------------------------------

  async login(username: string, password: string, deviceName: string): Promise<void> {
    const previous = await this.store.getAccount();
    if (previous && previous.username !== username) {
      throw new SyncError("account_mismatch", "another account is signed in on this device");
    }
    let deviceId: string;
    if (this.http.kind === "web") {
      const res = await this.call<SessionResponse>("POST", "/session", {
        username,
        password,
        deviceName,
        deviceId: previous?.deviceId ?? null,
      });
      deviceId = res.body?.deviceId ?? "";
    } else {
      const res = await this.call<DeviceLoginResponse>("POST", "/devices", {
        username,
        password,
        deviceName,
        kind: "mobile",
      });
      deviceId = res.body?.deviceId ?? "";
    }
    if (!deviceId) throw new SyncError("invalid_response", "login response without deviceId");
    const me = (await this.call<Me>("GET", "/me")).body;
    const serverUrl =
      (this.http as { serverUrl?: string }).serverUrl ??
      (globalThis as { location?: { origin?: string } }).location?.origin ??
      "";
    await this.access.setAccount({
      username: me?.username || username,
      deviceId,
      serverUrl,
      timeZone: me?.timeZone ?? null,
    });
    void requestPersistentStorage().then((p) => this.access.setPersisted(p).catch(() => undefined));
    this.backoffStep = 0;
    this.inBackoff = false;
    this.lastDeviceState = null;
    this.loggedOut = false;
    this.setStatus({ state: "idle", message: null });
    await this.syncNow();
  }

  async logout(): Promise<void> {
    this.stopTimersForLogout();
    try {
      await this.call("DELETE", this.http.kind === "web" ? "/session" : "/devices/current");
    } catch (e) {
      // offline or already invalid: the local sign-out goes ahead anyway
      this.setStatus({ message: e instanceof Error ? e.message : String(e) });
    }
    this.loggedOut = true;
    this.setStatus({ state: "signedOut" });
  }

  private stopTimersForLogout(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.inBackoff = false;
    this.backoffStep = 0;
  }
}

export const createSyncEngine: CreateSyncEngine = (options) => new Engine(options);
