import { BUILTIN_SKINS, type BuiltinSkin } from "../../types";

/** Which appearance options a skin uses; the settings window hides the others. */
export interface SkinFeatures {
  color: boolean;
  eyes: boolean;
  mouth: boolean;
}

/**
 * Built-in skins and what they support:
 * - Smiley:  colour (face), eyes, mouth
 * - Katze:   colour (fur), eyes – the mouth is the fixed cat "ω"
 * - Roboter: colour (casing), eyes (LEDs), mouth (LED variants)
 * - Geist:   colour (pale tint), eyes, mouth
 * Imported image / Lottie skins support none of them (only size, opacity, animation).
 */
export const BUILTIN_SKIN_INFO: Record<BuiltinSkin, { label: string; features: SkinFeatures }> = {
  smiley: { label: "Smiley", features: { color: true, eyes: true, mouth: true } },
  cat: { label: "Katze", features: { color: true, eyes: true, mouth: false } },
  robot: { label: "Roboter", features: { color: true, eyes: true, mouth: true } },
  ghost: { label: "Geist", features: { color: true, eyes: true, mouth: true } },
};

const CUSTOM_FEATURES: SkinFeatures = { color: false, eyes: false, mouth: false };

export function isBuiltinSkin(skin: string): skin is BuiltinSkin {
  return (BUILTIN_SKINS as readonly string[]).includes(skin);
}

export function skinFeatures(skin: string): SkinFeatures {
  return isBuiltinSkin(skin) ? BUILTIN_SKIN_INFO[skin].features : CUSTOM_FEATURES;
}
