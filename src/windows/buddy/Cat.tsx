import { darken, lighten, luminance } from "./color";
import { BLUSH, EyeGroup, Eyes, INK_DARK, INK_LIGHT, MIRROR } from "./faceParts";
import { SkinFrame, skinStyles as styles, type SkinProps } from "./SkinFrame";

const NOSE = "#f27a93";
const INNER_EAR = "#ffb3c1";

/** Cat head. Supports: colour (fur), all eye styles. Mouth is the fixed cat "ω". */
export function Cat(props: SkinProps) {
  const { config } = props;
  return (
    <SkinFrame {...props} skin="cat" testId="skin-cat" data={{ eyes: config.eyeStyle }}>
      {({ uid, blinking, face }) => {
        const ink = luminance(face) < 0.18 ? INK_LIGHT : INK_DARK;
        const line = darken(face, 0.3);
        const fur = `url(#${uid}-fur)`;
        const ear = (
          <>
            <path
              d="M17 47L20.6 14Q21.4 9.6 25 12L46.5 27Z"
              fill={fur}
              stroke={line}
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
            <path d="M24 38.5L25.8 19.5L38.6 28.6Z" fill={INNER_EAR} opacity={0.85} strokeLinejoin="round" />
          </>
        );
        return (
          <>
            <defs>
              <radialGradient id={`${uid}-fur`} cx="38%" cy="30%" r="80%">
                <stop offset="0%" stopColor={lighten(face, 0.42)} />
                <stop offset="50%" stopColor={face} data-testid="skin-primary" />
                <stop offset="100%" stopColor={darken(face, 0.14)} />
              </radialGradient>
            </defs>
            <g className={styles.tiltL} style={{ transformOrigin: "31px 36px" }}>
              {ear}
            </g>
            <g className={styles.tiltR} style={{ transformOrigin: "69px 36px" }}>
              <g transform={MIRROR}>{ear}</g>
            </g>
            <ellipse cx={50} cy={56} rx={38} ry={32} fill={fur} stroke={line} strokeWidth={1.6} />
            <ellipse cx={34} cy={36} rx={9} ry={5} transform="rotate(-24 34 36)" fill="#fff" opacity={0.3} />
            <g stroke={darken(face, 0.22)} strokeWidth={2.6} strokeLinecap="round" opacity={0.7}>
              <path d="M50 26.5v7" />
              <path d="M42.6 27.6l1.8 6" />
              <path d="M57.4 27.6l-1.8 6" />
            </g>
            <ellipse cx={50} cy={66.5} rx={13.5} ry={8.5} fill={lighten(face, 0.55)} opacity={0.9} />
            <g className={styles.cheeks} fill={BLUSH}>
              <ellipse cx={26} cy={63} rx={5.5} ry={3.2} />
              <ellipse cx={74} cy={63} rx={5.5} ry={3.2} />
            </g>
            <EyeGroup blinking={blinking} y={51} tid="skin">
              <Eyes
                style={config.eyeStyle}
                ink={ink}
                left={{ x: 36.5, y: 51 }}
                right={{ x: 63.5, y: 51 }}
                scale={1.05}
                tid="skin"
              />
            </EyeGroup>
            <g stroke={ink} strokeWidth={1.3} strokeLinecap="round" opacity={0.45}>
              <path d="M25 65L11.5 62.5" />
              <path d="M25 68.5L12.5 71" />
              <path d="M75 65L88.5 62.5" />
              <path d="M75 68.5L87.5 71" />
            </g>
            <path d="M46.2 60.6Q50 59.6 53.8 60.6Q51.8 64 50 64.4Q48.2 64 46.2 60.6Z" fill={NOSE} />
            <g data-testid="skin-mouth" fill="none" stroke={ink} strokeWidth={2.2} strokeLinecap="round">
              <path
                className={styles.mouthRest}
                d="M50 64.4Q49.6 68.8 45.6 68.6Q43.4 68.4 42.6 66.6M50 64.4Q50.4 68.8 54.4 68.6Q56.6 68.4 57.4 66.6"
              />
              <g className={styles.mouthHover}>
                <path d="M50 64.4v2.4" />
                <path d="M44 66.8Q50 77 56 66.8Q50 69.2 44 66.8Z" fill={ink} strokeLinejoin="round" />
                <ellipse cx={50} cy={70.6} rx={2.6} ry={1.4} fill={BLUSH} stroke="none" />
              </g>
            </g>
          </>
        );
      }}
    </SkinFrame>
  );
}
