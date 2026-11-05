/** Shared timing helpers for all buddy skins (CSS does the actual animating). */

/** Base duration of the click hop at speed 1 (keep in sync with skin.module.css). */
export const HOP_MS = 380;
/** Duration of the single "reminder due" pulse in quiet mode (keep in sync with skin.module.css). */
export const PULSE_MS = 700;

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}
