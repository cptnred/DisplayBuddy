import { darken, lighten, luminance } from "./color";
import { BLUSH, EyeGroup, Eyes, INK_DARK, INK_LIGHT, Mouth } from "./faceParts";
import { SkinFrame, skinStyles as styles, type SkinProps } from "./SkinFrame";

export { clampSpeed, HOP_MS, SPEED_MAX, SPEED_MIN } from "./motion";
export type { SkinProps } from "./SkinFrame";
/** @deprecated use SkinProps */
export type SmileyProps = SkinProps;

/** The classic round face. Supports: colour, all eye styles, all mouth styles. */
export function Smiley(props: SkinProps) {
  const { config } = props;
  return (
    <SkinFrame
      {...props}
      skin="smiley"
      testId="smiley"
      data={{ eyes: config.eyeStyle, mouth: config.mouthStyle }}
    >
      {({ uid, blinking, face }) => {
        const ink = luminance(face) < 0.18 ? INK_LIGHT : INK_DARK;
        return (
          <>
            <defs>
              <radialGradient id={`${uid}-face`} cx="38%" cy="30%" r="75%">
                <stop offset="0%" stopColor={lighten(face, 0.45)} />
                <stop offset="48%" stopColor={face} data-testid="smiley-face-color" />
                <stop offset="100%" stopColor={darken(face, 0.12)} />
              </radialGradient>
            </defs>
            <circle
              data-testid="smiley-face"
              cx={50}
              cy={50}
              r={41}
              fill={`url(#${uid}-face)`}
              stroke={darken(face, 0.28)}
              strokeWidth={1.6}
            />
            <ellipse cx={36} cy={26} rx={11} ry={6} transform="rotate(-28 36 26)" fill="#fff" opacity={0.32} />
            <g className={styles.cheeks} fill={BLUSH}>
              <ellipse cx={28.5} cy={58} rx={6.2} ry={3.6} />
              <ellipse cx={71.5} cy={58} rx={6.2} ry={3.6} />
            </g>
            <EyeGroup blinking={blinking} y={45} tid="smiley">
              <Eyes style={config.eyeStyle} ink={ink} left={{ x: 37.5, y: 45 }} right={{ x: 62.5, y: 45 }} tid="smiley" />
            </EyeGroup>
            <g data-testid="smiley-mouth">
              <Mouth style={config.mouthStyle} ink={ink} uid={uid} />
            </g>
          </>
        );
      }}
    </SkinFrame>
  );
}
