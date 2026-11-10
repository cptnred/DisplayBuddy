import { describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "../contract";
import { createNativeHttp, createWebHttp, NetworkError } from "./http";

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryTokens(initial: string | null = null): TokenProvider & { value: string | null } {
  const t = {
    value: initial,
    getToken: async () => t.value,
    setToken: async (v: string | null) => {
      t.value = v;
    },
  };
  return t;
}

describe("createWebHttp (PWA)", () => {
  it("same-origin request with cookie credentials, CSRF header and JSON body", async () => {
    const fetch = vi.fn(async () => json(200, { results: [], cursor: 1, serverTime: "2026-11-06T10:00:00.000Z" }));
    let t = 1000;
    const http = createWebHttp("", { fetch, now: () => (t += 10) });
    const res = await http.request("POST", "/sync/push", { notes: [] });
    expect(http.kind).toBe("web");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/sync/push");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({
      "X-Buddy-Request": "1",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(init.body).toBe('{"notes":[]}');
    expect(res).toEqual({ status: 200, body: { results: [], cursor: 1, serverTime: "2026-11-06T10:00:00.000Z" }, sentAt: 1010, receivedAt: 1020 });
  });

  it("uses a base URL, returns error statuses and 204 without throwing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: "unauthorized", message: "x" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("kein json", { status: 502 }));
    const http = createWebHttp("https://buddy.example.org/", { fetch });
    expect(http.serverUrl).toBe("https://buddy.example.org");
    const a = await http.request("GET", "/me");
    expect(fetch.mock.calls[0][0]).toBe("https://buddy.example.org/api/v1/me");
    expect((fetch.mock.calls[0][1] as RequestInit).body).toBeUndefined();
    expect(a).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await http.request("DELETE", "/session")).toMatchObject({ status: 204, body: null });
    expect(await http.request("GET", "/me")).toMatchObject({ status: 502, body: null });
  });

  it("turns a rejected fetch into NetworkError", async () => {
    const http = createWebHttp("", { fetch: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });
    await expect(http.request("GET", "/me")).rejects.toBeInstanceOf(NetworkError);
  });

  it("falls back to the global fetch", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    try {
      await createWebHttp().request("GET", "/health");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createNativeHttp (shell)", () => {
  it("sends the bearer token, no cookies, no CSRF header", async () => {
    const fetch = vi.fn(async () => json(200, { username: "m" }));
    const http = createNativeHttp({ baseUrl: "https://buddy.example.org", tokens: memoryTokens("tok"), fetch });
    expect(http.kind).toBe("mobile");
    await http.request("GET", "/me");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://buddy.example.org/api/v1/me");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(init.headers).not.toHaveProperty("X-Buddy-Request");
  });

  it("stores the token from POST /devices and does not hand it out", async () => {
    const tokens = memoryTokens();
    const fetch = vi.fn(async () => json(201, { deviceId: "d1", token: "secret", serverTime: "2026-11-06T10:00:00.000Z" }));
    const http = createNativeHttp({ baseUrl: "https://b", tokens, fetch });
    const res = await http.request("POST", "/devices", { username: "m", password: "p", deviceName: "Handy", kind: "mobile" });
    expect(tokens.value).toBe("secret");
    expect(res.body).toEqual({ deviceId: "d1", serverTime: "2026-11-06T10:00:00.000Z" });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("Authorization");
  });

  it("v4: stores the token from POST /devices/pairing and strips it from the body", async () => {
    const tokens = memoryTokens();
    const answer = { deviceId: "d2", token: "paired-secret", username: "anna", serverTime: "2026-11-06T10:00:00.000Z" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(400, { error: "pairing_invalid", message: "x" }))
      .mockResolvedValueOnce(json(200, answer));
    const http = createNativeHttp({ baseUrl: "https://b", tokens, fetch });
    const body = { code: "ABCDEFGHJKMN", deviceName: "Pixel", kind: "mobile" };
    await http.request("POST", "/devices/pairing", body);
    expect(tokens.value).toBeNull();
    const res = await http.request("POST", "/devices/pairing", body);
    expect(tokens.value).toBe("paired-secret");
    expect(res.body).toEqual({ deviceId: "d2", username: "anna", serverTime: "2026-11-06T10:00:00.000Z" });
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[0]).toBe("https://b/api/v1/devices/pairing");
  });

  it("keeps the token on a failed login and clears it on logout, even offline", async () => {
    const tokens = memoryTokens("old");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: "unauthorized", message: "x" }))
      .mockRejectedValueOnce(new TypeError("offline"));
    const http = createNativeHttp({ baseUrl: "https://b", tokens, fetch });
    await http.request("POST", "/devices", {});
    expect(tokens.value).toBe("old");
    await expect(http.request("DELETE", "/devices/current")).rejects.toBeInstanceOf(NetworkError);
    expect(tokens.value).toBeNull();
  });
});
