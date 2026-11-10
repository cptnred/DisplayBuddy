/**
 * Platform HTTP adapters (PLAN_V3_SYNC §9.3).
 *
 * - PWA: same-origin `fetch`, session cookie (`credentials: "same-origin"`), CSRF header
 *   `X-Buddy-Request: 1` (§7.5), `cache: "no-store"`.
 * - Native shell: injected `fetch` (from `@tauri-apps/plugin-http`, supplied by the shell)
 *   with `Authorization: Bearer <token>` from a {@link TokenProvider}; no cookies.
 *   The adapter stores the token returned by `POST /devices` and `POST /devices/pairing`
 *   (v4) itself and clears it on `DELETE /devices/current`, so the token never travels
 *   through the engine or the UI.
 *
 * A failed `fetch` (rejected promise, MDN: network error) becomes {@link NetworkError};
 * HTTP error statuses are returned, not thrown.
 */
import { API_BASE, CSRF_HEADER } from "../../lib/sync/types";
import type { HttpAdapter, HttpResponse, TokenProvider } from "../contract";

export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/** Adapter plus the server origin for {@link import("../contract").Account.serverUrl}. */
export interface OriginHttpAdapter extends HttpAdapter {
  readonly serverUrl: string;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function send<T>(
  f: typeof fetch,
  now: () => number,
  url: string,
  init: RequestInit,
): Promise<HttpResponse<T>> {
  const sentAt = now();
  let res: Response;
  let text: string;
  try {
    res = await f(url, init);
    text = res.status === 204 ? "" : await res.text();
  } catch (e) {
    throw new NetworkError(`request failed: ${init.method} ${new URL(url, "http://x").pathname}`, { cause: e });
  }
  const receivedAt = now();
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, sentAt, receivedAt };
}

function jsonInit(method: Method, body: unknown, headers: Record<string, string>): RequestInit {
  const h: Record<string, string> = { Accept: "application/json", ...headers };
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return init;
}

export interface WebHttpOptions {
  fetch?: typeof fetch;
  /** Device time for offset measurement (default Date.now). */
  now?: () => number;
}

/** PWA adapter: `baseUrl` "" = same origin (default). */
export function createWebHttp(baseUrl = "", options: WebHttpOptions = {}): OriginHttpAdapter {
  const base = trimSlash(baseUrl);
  const now = options.now ?? (() => Date.now());
  const origin = base || (globalThis as { location?: { origin?: string } }).location?.origin || "";
  return {
    kind: "web",
    serverUrl: origin,
    request<T>(method: Method, path: string, body?: unknown) {
      const f = options.fetch ?? globalThis.fetch.bind(globalThis);
      const init = jsonInit(method, body, { [CSRF_HEADER]: "1" });
      init.credentials = "same-origin";
      init.cache = "no-store";
      return send<T>(f, now, `${base}${API_BASE}${path}`, init);
    },
  };
}

export interface NativeHttpOptions {
  baseUrl: string;
  tokens: TokenProvider;
  /** `fetch` from @tauri-apps/plugin-http in the shell; default globalThis.fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Native shell adapter (Bearer token). */
export function createNativeHttp(options: NativeHttpOptions): OriginHttpAdapter {
  const base = trimSlash(options.baseUrl);
  const now = options.now ?? (() => Date.now());
  return {
    kind: "mobile",
    serverUrl: base,
    async request<T>(method: Method, path: string, body?: unknown) {
      const f = options.fetch ?? globalThis.fetch.bind(globalThis);
      const token = await options.tokens.getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const init = jsonInit(method, body, headers);
      init.credentials = "omit";
      const isLogout = method === "DELETE" && path === "/devices/current";
      let res: HttpResponse<T>;
      try {
        res = await send<T>(f, now, `${base}${API_BASE}${path}`, init);
      } finally {
        if (isLogout) await options.tokens.setToken(null);
      }
      const issuesToken = path === "/devices" || path === "/devices/pairing";
      if (method === "POST" && issuesToken && res.status >= 200 && res.status < 300) {
        const b = res.body as { token?: unknown } | null;
        if (b && typeof b.token === "string") {
          await options.tokens.setToken(b.token);
          const { token: _drop, ...rest } = b as Record<string, unknown>;
          void _drop;
          res = { ...res, body: rest as T };
        }
      }
      return res;
    },
  };
}
