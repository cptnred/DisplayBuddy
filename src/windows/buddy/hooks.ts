import { useEffect, useState } from "react";

export const BLINK_MIN_MS = 3000;
export const BLINK_MAX_MS = 7000;
/** How long the eyes stay in the "blinking" state (matches the CSS keyframe). */
export const BLINK_DURATION_MS = 160;

/** Random delay until the next blink, uniformly in [3 s, 7 s). */
export function nextBlinkDelay(random: () => number = Math.random): number {
  const v = random();
  const r = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5;
  return BLINK_MIN_MS + r * (BLINK_MAX_MS - BLINK_MIN_MS);
}

/**
 * Blink scheduler: a single setTimeout chain (no animation loop).
 * Returns `true` for BLINK_DURATION_MS at random 3–7 s intervals while enabled.
 */
export function useBlink(enabled: boolean, random: () => number = Math.random): boolean {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setBlinking(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlinking(true);
        timer = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_DURATION_MS);
      }, nextBlinkDelay(random));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled, random]);

  return blinking;
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function queryReduced(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_QUERY).matches
    : false;
}

/** Live `prefers-reduced-motion: reduce` state. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(queryReduced);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}
