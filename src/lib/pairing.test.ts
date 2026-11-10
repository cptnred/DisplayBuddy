/** Same vectors as buddy-core (pairing.rs / accounts.rs). */
import vectors from "../../crates/buddy-core/tests/fixtures/pairing_vectors.json";
import {
  formatCode,
  formatRecoveryCode,
  normalizeCode,
  normalizeRecoveryCode,
  pairingUrl,
  parsePairingUrl,
} from "./pairing";

describe("pairing codes", () => {
  it("formats and normalises the generated codes", () => {
    for (const c of [...vectors.codes]) {
      expect(formatCode(c.code)).toBe(c.formatted);
      expect(normalizeCode(c.formatted)).toBe(c.code);
      expect(normalizeCode(c.formatted.toLowerCase())).toBe(c.code);
    }
  });

  it.each(vectors.normalize)("normalize($input)", ({ input, code }) => {
    expect(normalizeCode(input)).toBe(code);
  });

  it("recovery codes", () => {
    for (const c of vectors.recovery) {
      expect(formatRecoveryCode(c.code)).toBe(c.formatted);
      expect(normalizeRecoveryCode(c.formatted)).toBe(c.code);
    }
    for (const c of vectors.recoveryNormalize) expect(normalizeRecoveryCode(c.input)).toBe(c.code);
  });
});

describe("pairing URL", () => {
  it.each(vectors.urls)("parse($input)", ({ input, origin, code }) => {
    const got = parsePairingUrl(input);
    expect(got).toEqual(origin === null ? null : { origin, code });
  });

  it.each(vectors.build)("build $url", ({ origin, code, url }) => {
    expect(pairingUrl(origin, code)).toBe(url);
    expect(parsePairingUrl(url)).toEqual({ origin, code });
  });
});
