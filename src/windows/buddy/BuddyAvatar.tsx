import { useEffect, useMemo, useState, type ComponentType } from "react";
import type { BuiltinSkin, SkinData } from "../../types";
import { Cat } from "./Cat";
import { Ghost } from "./Ghost";
import { usePrefersReducedMotion } from "./hooks";
import { LottieSkin, parseLottie, type LottieMarkers, type LottieState } from "./LottieSkin";
import { clampSpeed } from "./motion";
import { Robot } from "./Robot";
import { isBuiltinSkin } from "./skins";
import { SkinFrame, type SkinProps } from "./SkinFrame";
import { useSkinData, type SkinLoader } from "./skinStore";
import { Smiley } from "./Smiley";

const BUILTIN: Record<BuiltinSkin, ComponentType<SkinProps>> = {
  smiley: Smiley,
  cat: Cat,
  robot: Robot,
  ghost: Ghost,
};

export interface BuddyAvatarProps extends SkinProps {
  /** Loader for imported skins (defaults to `api.loadSkin`, cached per id). */
  loadSkin?: SkinLoader;
}

/** Renders the configured skin: a built-in SVG face or an imported image / Lottie skin. */
export function BuddyAvatar({ loadSkin, ...props }: BuddyAvatarProps) {
  const skin = props.config.skin;
  if (isBuiltinSkin(skin)) {
    const Builtin = BUILTIN[skin];
    return <Builtin {...props} />;
  }
  return <CustomSkin key={skin} id={skin} loadSkin={loadSkin} {...props} />;
}

function warnFallback(id: string, err: unknown) {
  console.warn(`[buddy] skin "${id}" unavailable, falling back to the smiley:`, err);
}

function CustomSkin({ id, loadSkin, ...props }: SkinProps & { id: string; loadSkin?: SkinLoader }) {
  const state = useSkinData(id, loadSkin);
  const [renderFailed, setRenderFailed] = useState(false);
  const failed = state.status === "error" || renderFailed;

  useEffect(() => {
    if (state.status === "error") warnFallback(id, state.error);
  }, [id, state]);

  if (failed) return <Smiley {...props} />;
  if (state.status === "loading") {
    // Keep the box (no layout jump) while the data arrives from Rust.
    return <SkinFrame {...props} mode="html" skin={id} testId="skin-loading" />;
  }
  return (
    <LoadedSkin
      data={state.data}
      onFail={(err) => {
        warnFallback(id, err);
        setRenderFailed(true);
      }}
      {...props}
    />
  );
}

function LoadedSkin({
  data,
  onFail,
  ...props
}: SkinProps & { data: SkinData; onFail: (err: unknown) => void }) {
  const { config, hovered = false, hopping = false, alert = false } = props;
  const reduced = usePrefersReducedMotion();
  const kind = data.info.kind;

  const lottie = useMemo(() => {
    if (kind !== "lottie") return null;
    try {
      return parseLottie(data.data);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }, [kind, data.data]);

  const invalid = (kind !== "image" && kind !== "lottie") || lottie instanceof Error;
  useEffect(() => {
    if (invalid) onFail(lottie instanceof Error ? lottie : new Error(`unknown skin kind "${kind}"`));
  }, [invalid]);
  if (invalid) return null;

  if (kind === "image") {
    return (
      <SkinFrame {...props} mode="html" skin={data.info.id} testId="skin-image">
        <img src={data.data} alt="" draggable={false} onError={() => onFail(new Error("image decode failed"))} />
      </SkinFrame>
    );
  }

  const { data: anim, markers } = lottie as { data: unknown; markers: LottieMarkers };
  const lottieState: LottieState = alert ? "alert" : hopping ? "click" : hovered ? "hover" : "idle";
  return (
    <SkinFrame
      {...props}
      mode="html"
      skin={data.info.id}
      testId="skin-lottie"
      // A state with its own marker is animated by Lottie; the others keep the CSS motion.
      suppress={{ idle: !!markers.idle, hover: !!markers.hover, click: !!markers.click, alert: !!markers.alert }}
    >
      <LottieSkin
        data={anim}
        markers={markers}
        state={lottieState}
        playing={config.animate && !reduced}
        speed={clampSpeed(config.animationSpeed)}
        onError={onFail}
      />
    </SkinFrame>
  );
}
