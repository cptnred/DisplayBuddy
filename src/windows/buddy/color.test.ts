import { describe, expect, it } from "vitest";
import { darken, lighten, luminance, normalizeColor, parseHex, toHex } from "./color";

describe("color helpers", () => {
  it("parses long and short hex", () => {
    expect(parseHex("#FFD54A")).toEqual({ r: 255, g: 213, b: 74 });
    expect(parseHex("fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#0a0")).toEqual({ r: 0, g: 170, b: 0 });
  });

  it("rejects invalid input", () => {
    expect(parseHex("red")).toBeNull();
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("")).toBeNull();
  });

  it("formats hex with clamping and padding", () => {
    expect(toHex({ r: 0, g: 15, b: 300 })).toBe("#000fff");
  });

  it("darkens towards black", () => {
    expect(darken("#ffffff", 0.5)).toBe("#808080");
    expect(darken("#FFD54A", 0)).toBe("#ffd54a");
    expect(darken("#FFD54A", 1)).toBe("#000000");
  });

  it("darker shade is actually darker", () => {
    expect(luminance(darken("#FFD54A", 0.3))).toBeLessThan(luminance("#FFD54A"));
  });

  it("lightens towards white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(luminance(lighten("#FFD54A", 0.4))).toBeGreaterThan(luminance("#FFD54A"));
  });

  it("clamps the amount", () => {
    expect(darken("#ffffff", 2)).toBe("#000000");
    expect(darken("#ffffff", -1)).toBe("#ffffff");
    expect(darken("#ffffff", Number.NaN)).toBe("#ffffff");
  });

  it("falls back to the default face colour for invalid input", () => {
    expect(darken("nope", 0)).toBe("#ffd54a");
    expect(normalizeColor("nope")).toBe("#ffd54a");
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
  });

  it("computes luminance extremes", () => {
    expect(luminance("#000")).toBe(0);
    expect(luminance("#fff")).toBeCloseTo(1);
  });
});
