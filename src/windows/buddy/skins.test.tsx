import { act, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SKINS, DEFAULT_BUDDY, type BuddyConfig, type EyeStyle, type MouthStyle } from "../../types";
import { Cat } from "./Cat";
import { Ghost } from "./Ghost";
import { Robot } from "./Robot";
import { BUILTIN_SKIN_INFO, isBuiltinSkin, skinFeatures } from "./skins";
import type { SkinProps } from "./SkinFrame";
import { Smiley } from "./Smiley";

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const cfg = (patch: Partial<BuddyConfig> = {}): BuddyConfig => ({ ...DEFAULT_BUDDY, ...patch });

const SKINS: Array<[string, ComponentType<SkinProps>, string]> = [
  ["smiley", Smiley, "smiley"],
  ["cat", Cat, "skin-cat"],
  ["robot", Robot, "skin-robot"],
  ["ghost", Ghost, "skin-ghost"],
];

describe.each(SKINS)("built-in skin %s", (skin, Skin, testId) => {
  it("renders with size, opacity, speed and its skin name", () => {
    render(<Skin config={cfg({ size: 144, opacity: 0.7, animationSpeed: 1.5 })} />);
    const root = screen.getByTestId(testId);
    expect(root).toHaveAttribute("data-skin", skin);
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root.style.width).toBe("144px");
    expect(root.style.height).toBe("144px");
    expect(root.style.opacity).toBe("0.7");
    expect(root.style.getPropertyValue("--speed")).toBe("1.5");
    expect(root.querySelector("svg")).toHaveAttribute("viewBox", "0 0 100 100");
  });

  it("quiet mode removes the animation class", () => {
    const { rerender } = render(<Skin config={cfg({ animate: true })} />);
    expect(screen.getByTestId(testId)).toHaveClass("animated");
    rerender(<Skin config={cfg({ animate: false })} />);
    expect(screen.getByTestId(testId)).not.toHaveClass("animated");
  });

  it("reflects hover, hop and alert", () => {
    render(<Skin config={cfg()} hovered hopping alert />);
    const root = screen.getByTestId(testId);
    expect(root).toHaveClass("hovered");
    expect(root).toHaveClass("hopping");
    expect(root).toHaveClass("alerting");
  });

  it("does not wiggle with prefers-reduced-motion", () => {
    reducedMotion = true;
    render(<Skin config={cfg()} alert />);
    expect(screen.getByTestId(testId)).not.toHaveClass("alerting");
  });

  it("blinks while animating and never in quiet mode", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(<Skin config={cfg()} />);
    const eyes = () => document.querySelector(".eyes")!;
    act(() => vi.advanceTimersByTime(3000));
    expect(eyes()).toHaveClass("blink");
    rerender(<Skin config={cfg({ animate: false })} />);
    act(() => vi.advanceTimersByTime(30000));
    expect(eyes()).not.toHaveClass("blink");
    vi.mocked(Math.random).mockRestore();
  });

  it("uses the primary colour", () => {
    const { container } = render(<Skin config={cfg({ faceColor: "#88CCFF" })} />);
    // The colour (or a tint of it for the ghost) ends up in the gradient.
    const stops = [...container.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"));
    const { container: other } = render(<Skin config={cfg({ faceColor: "#FF8800" })} />);
    const otherStops = [...other.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"));
    expect(stops).not.toEqual(otherStops);
  });

  it("uses unique gradient ids per instance", () => {
    const { container } = render(
      <>
        <Skin config={cfg()} />
        <Skin config={cfg()} />
      </>,
    );
    const ids = [...container.querySelectorAll("radialGradient, linearGradient")].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("eye and mouth styles", () => {
  const supporting = SKINS.filter(([skin]) => skinFeatures(skin).eyes);
  it.each(supporting)("%s renders distinct markup per eye style", (_skin, Skin) => {
    const markup = (["round", "lines", "hearts"] as EyeStyle[]).map((eyeStyle) => {
      const { unmount } = render(<Skin config={cfg({ eyeStyle })} />);
      const html = document.querySelector(".eyes")!.innerHTML;
      unmount();
      return html;
    });
    expect(new Set(markup).size).toBe(3);
  });

  const withMouth = SKINS.filter(([skin]) => skinFeatures(skin).mouth);
  it.each(withMouth)("%s renders distinct markup per mouth style", (_skin, Skin) => {
    const markup = (["smile", "wide", "neutral"] as MouthStyle[]).map((mouthStyle) => {
      const { unmount } = render(<Skin config={cfg({ mouthStyle })} />);
      const html = document.querySelector(".mouthRest")!.outerHTML;
      unmount();
      return html;
    });
    expect(new Set(markup).size).toBe(3);
  });

  it("cat has a fixed mouth with a hover variant", () => {
    render(<Cat config={cfg()} />);
    const mouth = screen.getByTestId("skin-mouth");
    expect(mouth.querySelector(".mouthRest")).not.toBeNull();
    expect(mouth.querySelector(".mouthHover")).not.toBeNull();
  });
});

describe("skin registry", () => {
  it("knows every built-in skin with a German label", () => {
    expect(Object.keys(BUILTIN_SKIN_INFO).sort()).toEqual([...BUILTIN_SKINS].sort());
    expect(BUILTIN_SKINS.map((s) => BUILTIN_SKIN_INFO[s].label)).toEqual(["Smiley", "Katze", "Roboter", "Geist"]);
  });

  it("custom skins support no face options", () => {
    expect(isBuiltinSkin("cat")).toBe(true);
    expect(isBuiltinSkin("0b8c7f7e-0000-4000-8000-000000000000")).toBe(false);
    expect(skinFeatures("0b8c7f7e-0000-4000-8000-000000000000")).toEqual({ color: false, eyes: false, mouth: false });
    expect(skinFeatures("cat").mouth).toBe(false);
  });
});
