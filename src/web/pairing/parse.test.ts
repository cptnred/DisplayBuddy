import { afterEach, describe, expect, it } from "vitest";
import { originHost, parsePairingInput, rememberPendingCode, sameOrigin, takePendingCode } from "./parse";

afterEach(() => sessionStorage.clear());

describe("pairing input", () => {
  it("accepts QR URLs (with origin) and typed codes (without)", () => {
    expect(parsePairingInput("https://Buddy.Example.org/pair#c=abcd-efgh-jkmn")).toEqual({
      kind: "code",
      code: "ABCDEFGHJKMN",
      origin: "https://buddy.example.org",
    });
    expect(parsePairingInput(" abcd efgh jkmn ")).toEqual({ kind: "code", code: "ABCDEFGHJKMN", origin: null });
  });

  it("rejects everything else", () => {
    for (const bad of ["", "hallo", "http://buddy.example.org/pair#c=ABCDEFGHJKMN", "https://x.org/pair?c=ABCDEFGHJKMN", "ABCD-EFGH"]) {
      expect(parsePairingInput(bad)).toEqual({ kind: "invalid" });
    }
  });

  it("compares origins without case and default ports", () => {
    expect(sameOrigin("https://buddy.test:443", "https://BUDDY.test")).toBe(true);
    expect(sameOrigin("http://localhost:80", "http://localhost")).toBe(true);
    expect(sameOrigin("https://buddy.test:8443", "https://buddy.test")).toBe(false);
    expect(sameOrigin("https://evil.test", "https://buddy.test")).toBe(false);
    expect(originHost("https://buddy.test:8443")).toBe("buddy.test:8443");
  });

  it("keeps a pending code for one use in sessionStorage", () => {
    rememberPendingCode("ABCDEFGHJKMN");
    expect(takePendingCode()).toBe("ABCDEFGHJKMN");
    expect(takePendingCode()).toBeNull();
  });
});
