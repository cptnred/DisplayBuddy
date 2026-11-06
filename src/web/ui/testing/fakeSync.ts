/**
 * In-memory fakes of the sync engine and the HTTP adapter (src/web/contract.ts §9.3).
 * No network: the fake engine flips states and logs calls; the fake HTTP adapter
 * answers from a route table.
 */
import { WARN_OFFSET_MS } from "../../../lib/clock";
import type {
  HttpAdapter,
  HttpResponse,
  SyncEngine,
  SyncEngineOptions,
  SyncNotice,
  WebSyncStatus,
} from "../../contract";
import type { FakeDataStore } from "./fakeStore";

export interface FakeSyncEngine extends SyncEngine {
  readonly calls: string[];
  /** Test helper: pushes a status to listeners. */
  setStatus(patch: Partial<WebSyncStatus>): void;
  /** Test helper: delivers a notice. */
  notice(n: SyncNotice): void;
  /** Credentials accepted by `login` (default: any non-empty password ≥ 12 chars). */
  accept: (username: string, password: string) => boolean;
}

export const INITIAL_STATUS: WebSyncStatus = {
  state: "signedOut",
  pending: 0,
  lastSyncAt: null,
  clockOffsetMs: 0,
  clockWarning: false,
  message: null,
};

export function createFakeSync(options: SyncEngineOptions): FakeSyncEngine {
  const store = options.store as FakeDataStore;
  let status: WebSyncStatus = { ...INITIAL_STATUS };
  const statusListeners = new Set<(s: WebSyncStatus) => void>();
  const noticeListeners = new Set<(n: SyncNotice) => void>();
  const calls: string[] = [];

  const set = (patch: Partial<WebSyncStatus>) => {
    status = { ...status, ...patch };
    status.clockWarning = Math.abs(status.clockOffsetMs) > WARN_OFFSET_MS;
    for (const l of [...statusListeners]) l({ ...status });
  };

  void store.getAccount().then((a) => {
    if (a && status.state === "signedOut") set({ state: "idle" });
  });

  const engine: FakeSyncEngine = {
    calls,
    accept: (_u, p) => p.length >= 12,
    status: () => ({ ...status }),
    onStatus(l) {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    onNotice(l) {
      noticeListeners.add(l);
      return () => noticeListeners.delete(l);
    },
    async login(username, password, deviceName) {
      calls.push(`login:${username}:${deviceName}`);
      if (!engine.accept(username, password)) {
        set({ state: "unauthorized", message: "invalid credentials" });
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      }
      store.setAccount?.({
        username,
        deviceId: "fake-device",
        serverUrl: globalThis.location?.origin ?? "https://buddy.test",
        timeZone: null,
      });
      set({ state: "idle", message: null, lastSyncAt: store.clock.correctedNowIso() });
    },
    async logout() {
      calls.push("logout");
      set({ state: "signedOut" });
    },
    async syncNow() {
      calls.push("syncNow");
      if (status.state === "signedOut" || status.state === "unauthorized") return;
      set({ state: "syncing" });
      store.clearOutbox?.();
      set({ state: "idle", pending: 0, lastSyncAt: store.clock.correctedNowIso() });
    },
    requestSync(reason) {
      calls.push(`request:${reason}`);
    },
    start() {
      calls.push("start");
    },
    stop() {
      calls.push("stop");
    },
    setStatus: set,
    notice(n) {
      for (const l of [...noticeListeners]) l(n);
    },
  };
  return engine;
}

type Handler = (body: unknown) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

export interface FakeHttp extends HttpAdapter {
  readonly requests: Array<{ method: string; path: string; body?: unknown }>;
  route(method: string, path: string, handler: Handler): void;
}

/** HTTP adapter answering from a route table; unknown routes → 404. */
export function createFakeHttp(kind: "web" | "mobile" = "web"): FakeHttp {
  const routes = new Map<string, Handler>();
  const requests: FakeHttp["requests"] = [];
  return {
    kind,
    requests,
    route(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
      requests.push({ method, path, body });
      const h = routes.get(`${method} ${path}`);
      const sentAt = Date.now();
      const res = h ? await h(body) : { status: 404, body: { error: "not_found", message: "no route" } };
      const out: HttpResponse<T> = {
        status: res.status,
        body: (res.body ?? null) as T | null,
        sentAt,
        receivedAt: sentAt,
      };
      return out;
    },
  };
}
