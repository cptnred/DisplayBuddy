import { useId, type CSSProperties } from "react";
import type { BuddyConfig, EyeStyle, MouthStyle } from "../../types";
import { darken, lighten, luminance, normalizeColor } from "./color";
import { useBlink, usePrefersReducedMotion } from "./hooks";
import styles from "./Smiley.module.css";

/** Base duration of the click hop at speed 1 (keep in sync with Smiley.module.css). */
export const HOP_MS = 380;

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

export interface SmileyProps {
  config: BuddyConfig;
  hovered?: boolean;
  hopping?: boolean;
  /** Live preview in the settings window (also reacts to CSS :hover). */
  preview?: boolean;
  className?: string;
}

const INK_DARK = "#3b2a20";
const INK_LIGHT = "#fff7e6";
const BLUSH = "#ff7b8a";
const HEART = "#ef4b5f";

const EYE_L = { x: 37.5, y: 45 };
const EYE_R = { x: 62.5, y: 45 };

const HEART_PATH =
  "M0 4.6C-1.2 3.6-6.2.4-6.2-2.4c0-2.2 1.7-3.6 3.4-3.6 1.3 0 2.3.8 2.8 1.8.5-1 1.5-1.8 2.8-1.8 1.7 0 3.4 1.4 3.4 3.6 0 2.8-5 6-6.2 7Z";

function Eyes({ style, ink }: { style: EyeStyle; ink: string }) {
  const eyes = [EYE_L, EYE_R];
  switch (style) {
    case "lines":
      return (
        <>
          {eyes.map((e) => (
            <path
              key={e.x}
              data-testid="smiley-eye"
              d={`M${e.x - 5.2} ${e.y + 0.6}q5.2 1.8 10.4 0`}
              fill="none"
              stroke={ink}
              strokeWidth={3.2}
              strokeLinecap="round"
            />
          ))}
        </>
      );
    case "hearts":
      return (
        <>
          {eyes.map((e) => (
            <g key={e.x} data-testid="smiley-eye" transform={`translate(${e.x} ${e.y})`}>
              <path d={HEART_PATH} fill={HEART} />
              <ellipse cx={-2.6} cy={-3.2} rx={1.3} ry={0.9} fill="#fff" opacity={0.75} />
            </g>
          ))}
        </>
      );
    case "round":
    default:
      return (
        <>
          {eyes.map((e) => (
            <g key={e.x} data-testid="smiley-eye">
              <circle cx={e.x} cy={e.y} r={5.4} fill={ink} />
              <circle cx={e.x + 1.8} cy={e.y - 2} r={1.7} fill="#fff" opacity={0.9} />
            </g>
          ))}
        </>
      );
  }
}

/** Rest + hover variant of the mouth; they are cross-faded via opacity. */
function Mouth({ style, ink, uid }: { style: MouthStyle; ink: string; uid: string }) {
  const stroke = { fill: "none", stroke: ink, strokeWidth: 3.4, strokeLinecap: "round" as const };
  switch (style) {
    case "wide": {
      const rest = "M37 60Q50 62.5 63 60Q61.5 74 50 74Q38.5 74 37 60Z";
      const hover = "M34 58.5Q50 61.5 66 58.5Q64 78 50 78Q36 78 34 58.5Z";
      return (
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
    }
    case "neutral":
      return (
        <>
          <path className={styles.mouthRest} d="M41.5 64L58.5 64" {...stroke} />
          <path className={styles.mouthHover} d="M40 62.5Q50 68.5 60 62.5" {...stroke} />
        </>
      );
    case "smile":
    default:
      return (
        <>
          <path className={styles.mouthRest} d="M39 62Q50 70.5 61 62" {...stroke} />
          <path className={styles.mouthHover} d="M36 60.5Q50 76 64 60.5" {...stroke} />
        </>
      );
  }
}

export function Smiley({ config, hovered = false, hopping = false, preview = false, className }: SmileyProps) {
  const uid = "sm" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const reduced = usePrefersReducedMotion();
  const animate = config.animate;
  const blinking = useBlink(animate && !reduced);

  const face = normalizeColor(config.faceColor);
  const ink = luminance(face) < 0.18 ? INK_LIGHT : INK_DARK;
  const size = Math.round(config.size);
  const opacity = Math.min(1, Math.max(0, config.opacity));

  const rootStyle = {
    width: size,
    height: size,
    opacity,
    "--speed": clampSpeed(config.animationSpeed),
  } as CSSProperties;

  const classes = [
    styles.root,
    animate && styles.animated,
    hovered && styles.hovered,
    hopping && styles.hopping,
    preview && styles.preview,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={rootStyle}
      aria-hidden="true"
      data-testid="smiley"
      data-eyes={config.eyeStyle}
      data-mouth={config.mouthStyle}
      data-hovered={hovered || undefined}
    >
      <svg className={styles.svg} viewBox="0 0 100 100" width={size} height={size} focusable="false">
        <defs>
          <radialGradient id={`${uid}-face`} cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor={lighten(face, 0.45)} />
            <stop offset="48%" stopColor={face} data-testid="smiley-face-color" />
            <stop offset="100%" stopColor={darken(face, 0.12)} />
          </radialGradient>
        </defs>
        <g className={styles.hop}>
          <g className={styles.bob}>
            <g className={styles.scale}>
              <circle
                data-testid="smiley-face"
                cx={50}
                cy={50}
                r={41}
                fill={`url(#${uid}-face)`}
                stroke={darken(face, 0.28)}
                strokeWidth={1.6}
              />
              <ellipse
                cx={36}
                cy={26}
                rx={11}
                ry={6}
                transform="rotate(-28 36 26)"
                fill="#fff"
                opacity={0.32}
              />
              <g className={styles.cheeks} fill={BLUSH}>
                <ellipse cx={28.5} cy={58} rx={6.2} ry={3.6} />
                <ellipse cx={71.5} cy={58} rx={6.2} ry={3.6} />
              </g>
              <g className={`${styles.eyes} ${blinking ? styles.blink : ""}`} data-testid="smiley-eyes">
                <Eyes style={config.eyeStyle} ink={ink} />
              </g>
              <g data-testid="smiley-mouth">
                <Mouth style={config.mouthStyle} ink={ink} uid={uid} />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
