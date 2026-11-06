// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createNativeHttp } from "../sync";
import { createLocalPrefs, createShellTokens, loadShellConfig, newUuid, shellDeviceName, type Invoke } from "./native-shell";

function fakeInvoke(initial: string | null = null) {
  let token = initial;
  const calls: [string, unknown][] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "token_get") return token;
    if (cmd === "token_set") {
      token = (args?.token as string | null) ?? null;
      return null;
    }
    if (cmd === "shell_config") return { serverUrl: "https://buddy.example.org", platform: "android" };
    throw new Error(`unknown ${cmd}`);
  }) as unknown as Invoke;
  return { invoke, calls, stored: () => token };
}

describe("shell config", () => {
  it("passes valid values, rejects garbage", async () => {
    expect(await loadShellConfig(fakeInvoke().invoke)).toEqual({
      serverUrl: "https://buddy.example.org",
      platform: "android",
    });
    const bad = (async () => ({ serverUrl: "https://x/y", platform: "web" })) as unknown as Invoke;
    expect(await loadShellConfig(bad)).toEqual({ serverUrl: null, platform: "desktop" });
  });
});

describe("token provider", () => {
  it("reads once, caches, stores and clears", async () => {
    const f = fakeInvoke("t1");
    const tokens = createShellTokens(f.invoke);
    expect(await Promise.all([tokens.getToken(), tokens.getToken()])).toEqual(["t1", "t1"]);
    expect(await tokens.getToken()).toBe("t1");
    expect(f.calls.filter(([c]) => c === "token_get")).toHaveLength(1);
    await tokens.setToken("t2");
    expect(f.stored()).toBe("t2");
    expect(await tokens.getToken()).toBe("t2");
    await tokens.setToken(null);
    expect(f.stored()).toBeNull();
    expect(await tokens.getToken()).toBeNull();
  });

  it("an unreadable store counts as signed out", async () => {
    const invoke = (async () => {
      throw new Error("no storage access");
    }) as unknown as Invoke;
    expect(await createShellTokens(invoke).getToken()).toBeNull();
  });

  it("with the native HTTP adapter: POST /devices stores the token, requests carry Bearer, logout clears", async () => {
    const f = fakeInvoke();
    const tokens = createShellTokens(f.invoke);
    const seen: { url: string; auth: string | null }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push({ url, auth: h.Authorization ?? null });
      if (url.endsWith("/devices")) {
        return new Response(JSON.stringify({ deviceId: "d1", token: "secret-1", serverTime: "x" }), { status: 200 });
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const http = createNativeHttp({ baseUrl: "https://buddy.example.org", tokens, fetch });
    const login = await http.request<Record<string, unknown>>("POST", "/devices", { kind: "mobile" });
    expect(login.body).toEqual({ deviceId: "d1", serverTime: "x" }); // token never reaches the engine/UI
    expect(f.stored()).toBe("secret-1");
    await http.request("GET", "/me");
    expect(seen[1]).toEqual({ url: "https://buddy.example.org/api/v1/me", auth: "Bearer secret-1" });
    await http.request("DELETE", "/devices/current");
    expect(f.stored()).toBeNull();
  });
});

describe("prefs, ids, names", () => {
  it("remembers the notification preference, survives a blocked storage", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const p = createLocalPrefs(storage);
    expect(p.enabled()).toBeNull();
    p.setEnabled(false);
    expect(createLocalPrefs(storage).enabled()).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const q = createLocalPrefs(blocked);
    q.setEnabled(true);
    expect(q.enabled()).toBe(true);
  });

  it("makes UUID v4 without randomUUID", () => {
    let n = 0;
    const id = newUuid({ getRandomValues: <T extends ArrayBufferView | null>(a: T) => {
      const b = a as unknown as Uint8Array;
      for (let i = 0; i < b.length; i++) b[i] = (n++ * 37) & 0xff;
      return a;
    } } as Pick<Crypto, "getRandomValues">);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newUuid({ getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: () => "x" })).toBe("x");
  });

  it("suggests German device names", () => {
    expect(shellDeviceName("android")).toBe("Android (App)");
    expect(shellDeviceName("ios")).toBe("iPhone/iPad (App)");
  });
});
