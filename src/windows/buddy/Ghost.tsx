import { darken, lighten } from "./color";
import { BLUSH, EyeGroup, Eyes, MIRROR, Mouth } from "./faceParts";
import { SkinFrame, skinStyles as styles, type SkinProps } from "./SkinFrame";

const GHOST_INK = "#2e2940";

/** Body: dome on top, four scalloped lobes at the bottom (x 18..82). */
const BODY = "M18 50C18 29 32 14 50 14C68 14 82 29 82 50V79q-8 11-16 0q-8 11-16 0q-8 11-16 0q-8 11-16 0Z";
const ARM = "M20.5 53.5Q10 55.5 11.5 64.5Q12.4 67.8 15.6 66Q19 63.8 21.5 63Z";

/**
 * Friendly ghost, a pale tint of the chosen colour.
 * Supports: colour, all eye styles, all mouth styles.
 */
export function Ghost(props: SkinProps) {
  const { config } = props;
  return (
    <SkinFrame
      {...props}
      skin="ghost"
      testId="skin-ghost"
      data={{ eyes: config.eyeStyle, mouth: config.mouthStyle }}
    >
      {({ uid, blinking, face }) => {
        const pale = lighten(face, 0.62);
        const line = darken(face, 0.3);
        const fill = `url(#${uid}-ghost)`;
        return (
          <>
            <defs>
              <radialGradient id={`${uid}-ghost`} cx="40%" cy="28%" r="80%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="55%" stopColor={pale} data-testid="skin-primary" />
                <stop offset="100%" stopColor={lighten(face, 0.22)} />
              </radialGradient>
            </defs>
            <ellipse cx={50} cy={93.5} rx={17} ry={2.6} fill="#000" opacity={0.1} />
            <g className={styles.tiltR} style={{ transformOrigin: "21px 58px" }}>
              <path d={ARM} fill={fill} stroke={line} strokeWidth={1.5} strokeLinejoin="round" />
            </g>
            <g className={styles.tiltL} style={{ transformOrigin: "79px 58px" }}>
              <path d={ARM} transform={MIRROR} fill={fill} stroke={line} strokeWidth={1.5} strokeLinejoin="round" />
            </g>
            <path d={BODY} fill={fill} stroke={line} strokeWidth={1.6} strokeLinejoin="round" />
            <ellipse cx={37} cy={28} rx={8} ry={4.5} transform="rotate(-28 37 28)" fill="#fff" opacity={0.6} />
            <g className={styles.cheeks} fill={BLUSH}>
              <ellipse cx={31} cy={56} rx={5.4} ry={3.1} />
              <ellipse cx={69} cy={56} rx={5.4} ry={3.1} />
            </g>
            <EyeGroup blinking={blinking} y={45} tid="skin">
              <Eyes
                style={config.eyeStyle}
                ink={GHOST_INK}
                left={{ x: 40, y: 45 }}
                right={{ x: 60, y: 45 }}
                scale={1.08}
                tid="skin"
              />
            </EyeGroup>
            <g data-testid="skin-mouth">
              <Mouth style={config.mouthStyle} ink={GHOST_INK} uid={uid} dy={-3} scale={0.85} />
            </g>
          </>
        );
      }}
    </SkinFrame>
  );
}
