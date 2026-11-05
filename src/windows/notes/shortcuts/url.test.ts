import { describe, expect, it } from "vitest";
import { hostOf, normalizeBookmarkUrl } from "./url";

describe("normalizeBookmarkUrl", () => {
  it("prefixes https:// when no scheme is given", () => {
    expect(normalizeBookmarkUrl("  example.com/path ")).toEqual({ ok: true, url: "https://example.com/path" });
    expect(normalizeBookmarkUrl("localhost:3000")).toEqual({ ok: true, url: "https://localhost:3000" });
  });
  it("keeps http and https", () => {
    expect(normalizeBookmarkUrl("http://a.de")).toEqual({ ok: true, url: "http://a.de" });
    expect(normalizeBookmarkUrl("HTTPS://A.de")).toEqual({ ok: true, url: "HTTPS://A.de" });
  });
  it("rejects empty input, other schemes and garbage", () => {
    expect(normalizeBookmarkUrl("   ").ok).toBe(false);
    expect(normalizeBookmarkUrl("ftp://x.de")).toEqual({ ok: false, error: "Nur http- und https-Adressen sind erlaubt." });
    expect(normalizeBookmarkUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeBookmarkUrl("mailto:a@b.de").ok).toBe(false);
    expect(normalizeBookmarkUrl("exa mple.com").ok).toBe(false);
    expect(normalizeBookmarkUrl("https://").ok).toBe(false);
  });
});

describe("hostOf", () => {
  it("strips www and tolerates garbage", () => {
    expect(hostOf("https://www.Example.com/x")).toBe("example.com");
    expect(hostOf("nonsense")).toBe("");
  });
});
