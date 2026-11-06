// @vitest-environment node
/**
 * Build test of the PWA (PLAN_V3_SYNC §9.1, Abnahme 13): builds vite.web.config.ts into a
 * temp dir and checks the installability basics (MDN „Making PWAs installable“,
 * vite-pwa „PWA Minimal Requirements“).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../..");
let out = "";

/** Width/height from a PNG IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "buddy-web-"));
  await build({
    root,
    configFile: join(root, "vite.web.config.ts"),
    logLevel: "silent",
    build: { outDir: out, emptyOutDir: true },
  });
}, 120_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("dist-web", () => {
  it("index.html has the required head entries and no inline script", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/<html lang="de">/);
    expect(html).toMatch(/<meta name="viewport"/);
    expect(html).toMatch(/<title>Display Buddy<\/title>/);
    expect(html).toMatch(/<meta name="description"/);
    expect(html).toMatch(/<meta name="theme-color" content="#1F6F78"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180.png" sizes="180x180"/);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest.webmanifest"/);
    // CSP script-src 'self': every script must be external
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("has a valid manifest with 192/512 and maskable icons", () => {
    const m = JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8"));
    expect(m).toMatchObject({
      name: "Display Buddy",
      short_name: "Buddy",
      lang: "de",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#1F6F78",
    });
    expect(m.description).toBeTruthy();
    const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose ?? "any"}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const icon of m.icons) {
      const [w, h] = pngSize(join(out, icon.src));
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    expect(pngSize(join(out, "icons/apple-touch-icon-180.png"))).toEqual([180, 180]);
    expect(pngSize(join(out, "icons/badge-96.png"))).toEqual([96, 96]);
  });

  it("emits sw.js with the injected precache manifest and push handlers", () => {
    const sw = readFileSync(join(out, "sw.js"), "utf8");
    expect(sw).not.toContain("self.__WB_MANIFEST");
    expect(sw).toMatch(/"url":"index.html"/);
    expect(sw).toMatch(/"url":"icons\/icon-192.png"/);
    expect(sw).toContain("notificationclick");
    expect(sw).toContain("SKIP_WAITING");
  });
});
