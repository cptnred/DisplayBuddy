import type { ReactNode } from "react";
import type { EyeStyle, MouthStyle } from "../../types";
import styles from "./skin.module.css";

/** Shared drawing parts of the built-in skins (viewBox 0 0 100 100). */

export const INK_DARK = "#3b2a20";
export const INK_LIGHT = "#fff7e6";
export const BLUSH = "#ff7b8a";
export const HEART = "#ef4b5f";

export interface Pt {
  x: number;
  y: number;
}

const HEART_PATH =
  "M0 4.6C-1.2 3.6-6.2.4-6.2-2.4c0-2.2 1.7-3.6 3.4-3.6 1.3 0 2.3.8 2.8 1.8.5-1 1.5-1.8 2.8-1.8 1.7 0 3.4 1.4 3.4 3.6 0 2.8-5 6-6.2 7Z";

/** Mirror transform for symmetric parts (x → 100 - x). */
export const MIRROR = "matrix(-1 0 0 1 100 0)";

function EyeShape({ style, ink }: { style: EyeStyle; ink: string }) {
  switch (style) {
    case "lines":
      return <path d="M-5.2 0.6q5.2 1.8 10.4 0" fill="none" stroke={ink} strokeWidth={3.2} strokeLinecap="round" />;
    case "hearts":
      return (
        <>
          <path d={HEART_PATH} fill={HEART} />
          <ellipse cx={-2.6} cy={-3.2} rx={1.3} ry={0.9} fill="#fff" opacity={0.75} />
        </>
      );
    case "round":
    default:
      return (
        <>
          <circle r={5.4} fill={ink} />
          <circle cx={1.8} cy={-2} r={1.7} fill="#fff" opacity={0.9} />
        </>
      );
  }
}

/** Two eyes in the given style; the caller wraps them in the blinking `.eyes` group. */
export function Eyes({
  style,
  ink,
  left,
  right,
  scale = 1,
  tid,
}: {
  style: EyeStyle;
  ink: string;
  left: Pt;
  right: Pt;
  scale?: number;
  tid: string;
}) {
  return (
    <>
      {[left, right].map((e) => (
        <g
          key={e.x}
          data-testid={`${tid}-eye`}
          transform={`translate(${e.x} ${e.y})${scale !== 1 ? ` scale(${scale})` : ""}`}
        >
          <EyeShape style={style} ink={ink} />
        </g>
      ))}
    </>
  );
}

/**
 * Rest + hover variant of the mouth; they are cross-faded via opacity.
 * Drawn around (50, 64); `dy`/`scale` place it on other faces.
 */
export function Mouth({
  style,
  ink,
  uid,
  dy = 0,
  scale = 1,
}: {
  style: MouthStyle;
  ink: string;
  uid: string;
  dy?: number;
  scale?: number;
}) {
  const stroke = { fill: "none", stroke: ink, strokeWidth: 3.4, strokeLinecap: "round" as const };
  const transform =
    dy !== 0 || scale !== 1 ? `translate(50 ${64 + dy}) scale(${scale}) translate(-50 -64)` : undefined;
  let parts;
  switch (style) {
    case "wide": {
      const rest = "M37 60Q50 62.5 63 60Q61.5 74 50 74Q38.5 74 37 60Z";
      const hover = "M34 58.5Q50 61.5 66 58.5Q64 78 50 78Q36 78 34 58.5Z";
      parts = (
        <>
          <defs>
            <clipPath id={`${uid}-mr`}>
              <path d={rest} />
            </clipPath>
            <clipPath id={`${uid}-mh`}>
              <path d={hover} />
            </clipPath>
          </defs>
          <g className={styles.mouthRest}>
            <path d={rest} fill={ink} stroke={ink} strokeWidth={1.4} strokeLinejoin="round" />
            <ellipse cx={50} cy={72} rx={6.5} ry={3.4} fill={BLUSH} clipPath={`url(#${uid}-mr)`} />
          </g>
          <g className={styles.mouthHover}>
            <path d={hover} fill={ink} stroke={ink} strokeWidth={1.4} strokeLinejoin="round" />
            <ellipse cx={50} cy={75.5} rx={8} ry={4.2} fill={BLUSH} clipPath={`url(#${uid}-mh)`} />
          </g>
        </>
      );
      break;
    }
    case "neutral":
      parts = (
        <>
          <path className={styles.mouthRest} d="M41.5 64L58.5 64" {...stroke} />
          <path className={styles.mouthHover} d="M40 62.5Q50 68.5 60 62.5" {...stroke} />
        </>
      );
      break;
    case "smile":
    default:
      parts = (
        <>
          <path className={styles.mouthRest} d="M39 62Q50 70.5 61 62" {...stroke} />
          <path className={styles.mouthHover} d="M36 60.5Q50 76 64 60.5" {...stroke} />
        </>
      );
  }
  return <g transform={transform}>{parts}</g>;
}

/** The blinking eye group (shared `.eyes`/`.blink` classes, origin at the eye line). */
export function EyeGroup({
  blinking,
  y,
  tid,
  children,
}: {
  blinking: boolean;
  y: number;
  tid: string;
  children: ReactNode;
}) {
  return (
    <g
      className={`${styles.eyes} ${blinking ? styles.blink : ""}`}
      style={{ transformOrigin: `50px ${y}px` }}
      data-testid={`${tid}-eyes`}
    >
      {children}
    </g>
  );
}
