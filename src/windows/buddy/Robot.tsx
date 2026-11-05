import type { MouthStyle } from "../../types";
import { darken, lighten } from "./color";
import { BLUSH, EyeGroup, Eyes, MIRROR } from "./faceParts";
import { SkinFrame, skinStyles as styles, type SkinProps } from "./SkinFrame";

const SCREEN = "#1f2a3a";
const LED = "#7cf0ff";
const BULB = "#ff6b6b";

/** LED mouth on the screen; rest + hover variants are cross-faded like the smiley's. */
function RobotMouth({ style }: { style: MouthStyle }) {
  const stroke = { fill: "none", stroke: LED, strokeWidth: 2.8, strokeLinecap: "round" as const };
  switch (style) {
    case "wide": {
      const grille = (x: number, y: number, w: number, h: number) => (
        <>
          <rect x={x} y={y} width={w} height={h} rx={2.4} fill={LED} />
          {[1, 2, 3].map((i) => (
            <path key={i} d={`M${x + (w * i) / 4} ${y + 1.4}v${h - 2.8}`} stroke={SCREEN} strokeWidth={1.2} />
          ))}
        </>
      );
      return (
        <>
          <g className={styles.mouthRest}>{grille(41, 61, 18, 7)}</g>
          <g className={styles.mouthHover}>{grille(39, 60, 22, 9.5)}</g>
        </>
      );
    }
    case "neutral":
      return (
        <>
          <path className={styles.mouthRest} d="M43 65H57" {...stroke} />
          <path className={styles.mouthHover} d="M42.5 63.5Q50 68.5 57.5 63.5" {...stroke} />
        </>
      );
    case "smile":
    default:
      return (
        <>
          <path className={styles.mouthRest} d="M42.5 62.5Q50 68 57.5 62.5" {...stroke} />
          <path className={styles.mouthHover} d="M40 61Q50 72.5 60 61" {...stroke} />
        </>
      );
  }
}

/** Robot head with a face screen. Supports: colour (casing), all eye styles, all mouth styles. */
export function Robot(props: SkinProps) {
  const { config } = props;
  return (
    <SkinFrame
      {...props}
      skin="robot"
      testId="skin-robot"
      data={{ eyes: config.eyeStyle, mouth: config.mouthStyle }}
    >
      {({ uid, blinking, face }) => {
        const line = darken(face, 0.32);
        const ear = (
          <rect x={8} y={45} width={9.5} height={18} rx={3.5} fill={darken(face, 0.16)} stroke={line} strokeWidth={1.4} />
        );
        return (
          <>
            <defs>
              <linearGradient id={`${uid}-metal`} x1="0" y1="0" x2="0.35" y2="1">
                <stop offset="0%" stopColor={lighten(face, 0.38)} />
                <stop offset="45%" stopColor={face} data-testid="skin-primary" />
                <stop offset="100%" stopColor={darken(face, 0.14)} />
              </linearGradient>
            </defs>
            <g className={styles.tiltR} style={{ transformOrigin: "50px 23px" }}>
              <path d="M50 23V14" stroke={darken(face, 0.45)} strokeWidth={2.6} strokeLinecap="round" />
              <circle cx={50} cy={10.5} r={4.6} fill={BULB} stroke={darken(BULB, 0.25)} strokeWidth={1.2} />
              <circle className={styles.glow} cx={50} cy={10.5} r={3.2} fill="#ffe08a" />
              <circle cx={48.6} cy={9.2} r={1.3} fill="#fff" opacity={0.8} />
            </g>
            {ear}
            <g transform={MIRROR}>{ear}</g>
            <rect x={15} y={23} width={70} height={63} rx={17} fill={`url(#${uid}-metal)`} stroke={line} strokeWidth={1.6} />
            <path d="M25 31Q30 27.5 40 27.5" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" opacity={0.45} />
            <g fill={line} opacity={0.55}>
              <circle cx={21.5} cy={79.5} r={1.6} />
              <circle cx={78.5} cy={79.5} r={1.6} />
            </g>
            <rect x={23.5} y={35} width={53} height={40} rx={11} fill={SCREEN} stroke={darken(face, 0.38)} strokeWidth={1.4} />
            <path d="M29 39.5h9" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" opacity={0.14} />
            <g className={styles.cheeks} fill={BLUSH}>
              <ellipse cx={31} cy={62.5} rx={3.8} ry={2.1} />
              <ellipse cx={69} cy={62.5} rx={3.8} ry={2.1} />
            </g>
            <EyeGroup blinking={blinking} y={50} tid="skin">
              <Eyes
                style={config.eyeStyle}
                ink={LED}
                left={{ x: 38.5, y: 50 }}
                right={{ x: 61.5, y: 50 }}
                scale={0.95}
                tid="skin"
              />
            </EyeGroup>
            <g data-testid="skin-mouth">
              <RobotMouth style={config.mouthStyle} />
            </g>
          </>
        );
      }}
    </SkinFrame>
  );
}
