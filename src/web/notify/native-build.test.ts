// @vitest-environment node
/**
 * Build test of the native shell's UI (vite.mobile.config.ts, PLAN_V3_SYNC §10.1): no
 * service worker, no web manifest, no inline script (CSP of mobile/src-tauri/tauri.conf.json),
 * only the plugin commands the shell's capability grants.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../../..");
let out = "";
let js = "";

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "buddy-mobile-"));
  await build({
    configFile: join(root, "vite.mobile.config.ts"),
    logLevel: "silent",
    build: { outDir: out, emptyOutDir: true },
  });
  js = readdirSync(join(out, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(out, "assets", f), "utf8"))
    .join("\n");
}, 120_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("mobile/dist", () => {
  it("has index.html without inline scripts and without manifest/service worker", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/<html lang="de">/);
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).not.toMatch(/<script>(?!<)/);
    expect(html).not.toMatch(/manifest/);
    expect(existsSync(join(out, "sw.js"))).toBe(false);
    expect(existsSync(join(out, "manifest.webmanifest"))).toBe(false);
    expect(js).not.toMatch(/workbox|registerSW/);
  });

  it("uses only plugin commands granted by the capability (notification:default, http scope, barcode-scanner:default)", () => {
    const used = new Set(js.match(/plugin:[a-z-]+\|[a-z_]+/g) ?? []);
    const allowed =
      /^plugin:(event\|(listen|unlisten)|notification\|[a-z_]+|http\|fetch(_cancel|_send|_read_body|_cancel_body)?|barcode-scanner\|(scan|cancel|check_permissions|request_permissions|open_app_settings|vibrate))$/;
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(c).toMatch(allowed);
    const caps = JSON.parse(readFileSync(join(root, "mobile/src-tauri/capabilities/main.json"), "utf8")) as {
      permissions: string[];
    };
    expect(caps.permissions).toContain("notification:default");
    // http is granted at runtime with the BUDDY_PUBLIC_URL scope only (src-tauri/src/lib.rs)
    expect(caps.permissions.some((p) => p.startsWith("http:"))).toBe(false);
    // the scanner plugin exists only on Android/iOS (PLAN_V4 §7.2)
    expect(used).toContain("plugin:barcode-scanner|scan");
    const scanner = JSON.parse(readFileSync(join(root, "mobile/src-tauri/capabilities/scanner.json"), "utf8")) as {
      permissions: string[];
      platforms: string[];
    };
    expect(scanner.permissions).toEqual(["barcode-scanner:default"]);
    expect([...scanner.platforms].sort()).toEqual(["android", "iOS"]);
  });
});
