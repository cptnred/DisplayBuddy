import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";

export type LottieState = "idle" | "hover" | "click" | "alert";
export const LOTTIE_STATES: readonly LottieState[] = ["idle", "hover", "click", "alert"];

export interface LottieSegment {
  start: number;
  end: number;
}
export type LottieMarkers = Partial<Record<LottieState, LottieSegment>>;

/** Parses the animation JSON (throws on invalid JSON). */
export function parseLottie(json: string): { data: unknown; markers: LottieMarkers } {
  const data = JSON.parse(json) as { markers?: unknown };
  if (!data || typeof data !== "object") throw new Error("lottie: not an object");
  return { data, markers: readMarkers(data.markers) };
}

/** Markers `{ tm, cm, dr }`; `cm` is the name or a JSON comment like `{"name":"idle"}`. */
export function readMarkers(raw: unknown): LottieMarkers {
  const out: LottieMarkers = {};
  if (!Array.isArray(raw)) return out;
  for (const m of raw as Array<{ tm?: unknown; cm?: unknown; dr?: unknown }>) {
    if (!m || typeof m.tm !== "number" || typeof m.cm !== "string") continue;
    let name = m.cm;
    if (name.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(name) as { name?: unknown };
        if (typeof parsed.name === "string") name = parsed.name;
      } catch {
        /* plain comment */
      }
    }
    const key = name.trim().toLowerCase() as LottieState;
    if (!LOTTIE_STATES.includes(key) || out[key]) continue;
    const dr = typeof m.dr === "number" && m.dr > 0 ? m.dr : 1;
    out[key] = { start: m.tm, end: m.tm + dr };
  }
  return out;
}

/**
 * Lottie player for imported skins. lottie-web (light build, SVG renderer, no eval) is loaded
 * on demand, so the default buddy never downloads it.
 */
export function LottieSkin({
  data,
  markers,
  state,
  playing,
  speed,
  onError,
}: {
  data: unknown;
  markers: LottieMarkers;
  state: LottieState;
  /** false in quiet mode / reduced motion → paused on frame 0. */
  playing: boolean;
  speed: number;
  onError: (err: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [anim, setAnim] = useState<AnimationItem | null>(null);
  const segmented = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let alive = true;
    let item: AnimationItem | null = null;
    import("lottie-web/build/player/lottie_light")
      .then((mod) => {
        if (!alive || !container.current) return;
        item = mod.default.loadAnimation({
          container: container.current,
          renderer: "svg",
          loop: true,
          autoplay: false,
          // lottie mutates the data; give each instance its own copy.
          animationData: structuredClone(data),
          rendererSettings: { preserveAspectRatio: "xMidYMid meet", focusable: false },
        });
        setAnim(item);
      })
      .catch((err) => alive && onErrorRef.current(err));
    return () => {
      alive = false;
      item?.destroy();
      segmented.current = false;
      setAnim(null);
    };
  }, [data]);

  useEffect(() => {
    if (!anim) return;
    anim.setSpeed(speed);
    if (!playing) {
      anim.goToAndStop(0, true);
      return;
    }
    const seg = markers[state] ?? markers.idle;
    if (seg) {
      segmented.current = true;
      anim.playSegments([seg.start, seg.end], true);
    } else {
      // Whole animation; only rewind when coming back from a segment.
      if (segmented.current) anim.resetSegments(true);
      segmented.current = false;
      anim.play();
    }
  }, [anim, playing, state, speed, markers]);

  return <div ref={container} data-testid="lottie-container" />;
}
