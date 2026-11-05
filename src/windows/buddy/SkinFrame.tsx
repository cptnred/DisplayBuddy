import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BuddyConfig } from "../../types";
import { normalizeColor } from "./color";
import { useBlink, usePrefersReducedMotion } from "./hooks";
import { clampSpeed, PULSE_MS } from "./motion";
import styles from "./skin.module.css";

/** Props shared by every buddy skin (built-in or imported). */
export interface SkinProps {
  config: BuddyConfig;
  hovered?: boolean;
  hopping?: boolean;
  /** A reminder is due: wiggle (animated) or a single pulse on change (quiet mode). */
  alert?: boolean;
  /** Number of due reminders; in quiet mode a growing count triggers one gentle pulse. */
  alertCount?: number;
  /** Live preview in the settings window (also reacts to CSS :hover). */
  preview?: boolean;
  className?: string;
}

export interface SvgFrameContext {
  /** Unique, CSS-safe id prefix for <defs>. */
  uid: string;
  /** True while the eyes should play the blink keyframe. */
  blinking: boolean;
  /** Normalised primary colour (#rrggbb). */
  face: string;
}

/** CSS motions that the skin's own content replaces (Lottie markers). */
export interface MotionOverrides {
  idle?: boolean;
  hover?: boolean;
  click?: boolean;
  alert?: boolean;
}

interface FrameBase extends SkinProps {
  testId: string;
  skin: string;
  suppress?: MotionOverrides;
  data?: Record<string, string | undefined>;
}

type FrameProps =
  | (FrameBase & { mode?: "svg"; children: (ctx: SvgFrameContext) => ReactNode })
  | (FrameBase & { mode: "html"; children?: ReactNode });

/** `true` for PULSE_MS whenever `count` grows while `enabled`. */
function usePulse(enabled: boolean, count: number): boolean {
  const [pulsing, setPulsing] = useState(false);
  const last = useRef(count);
  useEffect(() => {
    const grew = count > last.current;
    last.current = count;
    if (!enabled || !grew) return;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => {
      clearTimeout(t);
      setPulsing(false);
    };
  }, [enabled, count]);
  return enabled && pulsing;
}

/**
 * The common shell of all skins: size, opacity, speed, hover/hop/bob/blink/alert classes and the
 * wrapper elements the shared CSS animates. Built-in skins draw into a 100×100 viewBox.
 */
export function SkinFrame(props: FrameProps) {
  const { config, hovered = false, hopping = false, alert = false, preview = false, className } = props;
  const { testId, skin, suppress = {}, data } = props;
  const uid = "sk" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const reduced = usePrefersReducedMotion();
  const animate = config.animate;
  const motion = animate && !reduced;
  const isSvg = props.mode !== "html";
  const blinking = useBlink(isSvg && motion);
  const pulsing = usePulse(alert && !animate && !reduced, alert ? (props.alertCount ?? 1) : 0);

  const size = Math.round(config.size);
  const rootStyle = {
    width: size,
    height: size,
    opacity: Math.min(1, Math.max(0, config.opacity)),
    "--speed": clampSpeed(config.animationSpeed),
  } as CSSProperties;

  const classes = [
    styles.root,
    !isSvg && styles.html,
    animate && styles.animated,
    suppress.idle && styles.noIdle,
    suppress.hover && styles.noHover,
    suppress.click && styles.noHop,
    hovered && styles.hovered,
    hopping && styles.hopping,
    alert && motion && !suppress.alert && styles.alerting,
    pulsing && styles.pulse,
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
      data-testid={testId}
      data-skin={skin}
      data-hovered={hovered || undefined}
      data-alert={alert || undefined}
      {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
    >
      <div className={styles.wiggle}>
        {props.mode === "html" ? (
          <div className={styles.bob}>
            <div className={styles.hop}>
              <div className={styles.scale}>
                <div className={styles.content}>{props.children}</div>
              </div>
            </div>
          </div>
        ) : (
          <svg className={styles.bob} viewBox="0 0 100 100" width={size} height={size} focusable="false">
            <g className={styles.hop}>
              <g className={styles.scale}>
                {props.children({ uid, blinking, face: normalizeColor(config.faceColor) })}
              </g>
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

export { styles as skinStyles };
