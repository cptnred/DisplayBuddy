/** Small pure colour helpers for the smiley (no dependencies). */

export type Rgb = { r: number; g: number; b: number };

const FALLBACK: Rgb = { r: 0xff, g: 0xd5, b: 0x4a }; // DEFAULT_BUDDY.faceColor

/** Parses "#rgb" / "#rrggbb" (with or without "#"). Returns null when invalid. */
export function parseHex(input: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

function mix(color: string, target: Rgb, amount: number): string {
  const c = parseHex(color) ?? FALLBACK;
  const t = clamp01(amount);
  return toHex({
    r: c.r + (target.r - c.r) * t,
    g: c.g + (target.g - c.g) * t,
    b: c.b + (target.b - c.b) * t,
  });
}

/** Mixes the colour towards black by `amount` (0..1). Invalid input → default face colour. */
export function darken(color: string, amount: number): string {
  return mix(color, { r: 0, g: 0, b: 0 }, amount);
}

/** Mixes the colour towards white by `amount` (0..1). Invalid input → default face colour. */
export function lighten(color: string, amount: number): string {
  return mix(color, { r: 255, g: 255, b: 255 }, amount);
}

/** WCAG relative luminance 0..1. */
export function luminance(color: string): number {
  const c = parseHex(color) ?? FALLBACK;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Valid lowercase "#rrggbb"; invalid input → default face colour. */
export function normalizeColor(color: string): string {
  return toHex(parseHex(color) ?? FALLBACK);
}
