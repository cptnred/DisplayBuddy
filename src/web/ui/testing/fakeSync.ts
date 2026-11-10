/**
 * In-memory fakes of the sync engine and the HTTP adapter (src/web/contract.ts §9.3).
 * No network: the fake engine flips states and logs calls; the fake HTTP adapter
 * answers from a route table.
 */
import { WARN_OFFSET_MS } from "../../../lib/clock";
import { normalizeCode } from "../../../lib/pairing";
import type { ServerInfo } from "../../../lib/sync/types";
import type {
  HttpAdapter,
  HttpResponse,
  SyncEngine,
  SyncEngineOptions,
  SyncNotice,
  WebSyncStatus,
} from "../../contract";
import { SyncError } from "../../sync/engine";
import type { FakeDataStore } from "./fakeStore";

/** The pairing code the fake engine accepts by default. */
export const FAKE_PAIRING_CODE = "ABCDEFGHJKMN";

export interface FakeSyncEngine extends SyncEngine {
  readonly calls: string[];
  /** Test helper: pushes a status to listeners. */
  setStatus(patch: Partial<WebSyncStatus>): void;
  /** Test helper: delivers a notice. */
  notice(n: SyncNotice): void;
  /** Credentials accepted by `login` (default: any non-empty password ≥ 12 chars). */
  accept: (username: string, password: string) => boolean;
  /** Pairing codes (normalised) accepted by `loginWithCode` → account name. */
  codes: Map<string, string>;
  /** GET /info answer (null = v3 server). */
  info: ServerInfo | null;
  /** Thrown by the next login / loginWithCode / deleteAccount instead of the normal result. */
  nextError: unknown;
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

  const takeError = () => {
    const e = engine.nextError;
    engine.nextError = null;
    if (e) throw e;
  };

  const engine: FakeSyncEngine = {
    calls,
    accept: (_u, p) => p.length >= 12,
    codes: new Map([[FAKE_PAIRING_CODE, "anna"]]),
    info: null,
    nextError: null,
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
      takeError();
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
    async loginWithCode(code, deviceName) {
      calls.push(`loginWithCode:${code}:${deviceName}`);
      takeError();
      const normalized = normalizeCode(code);
      const username = normalized ? engine.codes.get(normalized) : undefined;
      if (!normalized || !username) throw new SyncError("pairing_invalid", "pairing_invalid: fake", 400);
      engine.codes.delete(normalized);
      const previous = await store.getAccount();
      if (previous && previous.username !== username) {
        throw new SyncError("account_mismatch", "another account is signed in on this device");
      }
      store.setAccount?.({
        username,
        deviceId: "fake-device",
        serverUrl: globalThis.location?.origin ?? "https://buddy.test",
        timeZone: null,
      });
      set({ state: "idle", message: null, lastSyncAt: store.clock.correctedNowIso() });
    },
    async serverInfo() {
      calls.push("serverInfo");
      return engine.info;
    },
    async deleteAccount(password, confirmUsername) {
      calls.push(`deleteAccount:${confirmUsername}`);
      takeError();
      const account = await store.getAccount();
      if (!engine.accept(account?.username ?? "", password)) throw new SyncError("unauthorized", "unauthorized", 401);
      if (confirmUsername !== account?.username) throw new SyncError("bad_request", "bad_request: fake", 400);
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
