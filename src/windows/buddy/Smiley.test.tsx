import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDDY, type BuddyConfig, type EyeStyle, type MouthStyle } from "../../types";
import { BLINK_DURATION_MS, nextBlinkDelay, useBlink } from "./hooks";
import { clampSpeed, Smiley } from "./Smiley";

let reducedMotion = false;

function stubMatchMedia() {
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
}

beforeEach(() => {
  reducedMotion = false;
  stubMatchMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const cfg = (patch: Partial<BuddyConfig> = {}): BuddyConfig => ({ ...DEFAULT_BUDDY, ...patch });

describe("Smiley", () => {
  it.each<EyeStyle>(["round", "lines", "hearts"])("renders eye style %s", (eyeStyle) => {
    render(<Smiley config={cfg({ eyeStyle })} />);
    const root = screen.getByTestId("smiley");
    expect(root).toHaveAttribute("data-eyes", eyeStyle);
    expect(screen.getAllByTestId("smiley-eye")).toHaveLength(2);
  });

  it("renders distinct markup per eye style", () => {
    const markup = (["round", "lines", "hearts"] as const).map((eyeStyle) => {
      const { unmount } = render(<Smiley config={cfg({ eyeStyle })} />);
      const html = screen.getByTestId("smiley-eyes").innerHTML;
      unmount();
      return html;
    });
    expect(new Set(markup).size).toBe(3);
  });

  it.each<MouthStyle>(["smile", "wide", "neutral"])("renders mouth style %s with a hover variant", (mouthStyle) => {
    render(<Smiley config={cfg({ mouthStyle })} />);
    expect(screen.getByTestId("smiley")).toHaveAttribute("data-mouth", mouthStyle);
    const mouth = screen.getByTestId("smiley-mouth");
    expect(mouth.querySelector(".mouthRest")).not.toBeNull();
    expect(mouth.querySelector(".mouthHover")).not.toBeNull();
  });

  it("applies size and opacity to the root", () => {
    render(<Smiley config={cfg({ size: 128, opacity: 0.6 })} />);
    const root = screen.getByTestId("smiley");
    expect(root.style.width).toBe("128px");
    expect(root.style.height).toBe("128px");
    expect(root.style.opacity).toBe("0.6");
  });

  it("is hidden from assistive technology", () => {
    render(<Smiley config={cfg()} />);
    expect(screen.getByTestId("smiley")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses the face colour and a darker stroke", () => {
    render(<Smiley config={cfg({ faceColor: "#88CCFF" })} />);
    expect(screen.getByTestId("smiley-face-color")).toHaveAttribute("stop-color", "#88ccff");
    const stroke = screen.getByTestId("smiley-face").getAttribute("stroke");
    expect(stroke).toMatch(/^#[0-9a-f]{6}$/);
    expect(stroke).not.toBe("#88ccff");
  });

  it("references its own gradient id", () => {
    render(<Smiley config={cfg()} />);
    const fill = screen.getByTestId("smiley-face").getAttribute("fill")!;
    const id = /^url\(#(.+)\)$/.exec(fill)![1];
    expect(document.getElementById(id)?.tagName.toLowerCase()).toBe("radialgradient");
  });

  it("sets the speed custom property (clamped)", () => {
    render(<Smiley config={cfg({ animationSpeed: 5 })} />);
    expect(screen.getByTestId("smiley").style.getPropertyValue("--speed")).toBe("2");
    expect(clampSpeed(0.1)).toBe(0.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(1.25)).toBe(1.25);
  });

  it("has the animation class only when animate is true", () => {
    const { rerender } = render(<Smiley config={cfg({ animate: true })} />);
    expect(screen.getByTestId("smiley")).toHaveClass("animated");
    rerender(<Smiley config={cfg({ animate: false })} />);
    expect(screen.getByTestId("smiley")).not.toHaveClass("animated");
  });

  it("reflects hovered and hopping props as classes", () => {
    render(<Smiley config={cfg()} hovered hopping />);
    const root = screen.getByTestId("smiley");
    expect(root).toHaveClass("hovered");
    expect(root).toHaveClass("hopping");
  });

  it("passes className and preview through", () => {
    render(<Smiley config={cfg()} preview className="extra" />);
    const root = screen.getByTestId("smiley");
    expect(root).toHaveClass("extra");
    expect(root).toHaveClass("preview");
  });

  it("blinks periodically while animating", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(Math, "random").mockReturnValue(1); // longest delay: 7 s
    render(<Smiley config={cfg({ animate: true })} />);
    const eyes = screen.getByTestId("smiley-eyes");
    act(() => vi.advanceTimersByTime(6999));
    expect(eyes).not.toHaveClass("blink");
    act(() => vi.advanceTimersByTime(1));
    spy.mockRestore();
    expect(eyes).toHaveClass("blink");
    act(() => vi.advanceTimersByTime(BLINK_DURATION_MS));
    expect(eyes).not.toHaveClass("blink");
  });

  it("never blinks when animate=false", () => {
    vi.useFakeTimers();
    render(<Smiley config={cfg({ animate: false })} />);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByTestId("smiley-eyes")).not.toHaveClass("blink");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never blinks with prefers-reduced-motion", () => {
    reducedMotion = true;
    vi.useFakeTimers();
    render(<Smiley config={cfg({ animate: true })} />);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByTestId("smiley-eyes")).not.toHaveClass("blink");
  });
});

describe("blink scheduler", () => {
  it("nextBlinkDelay stays within 3–7 s", () => {
    expect(nextBlinkDelay(() => 0)).toBe(3000);
    expect(nextBlinkDelay(() => 0.5)).toBe(5000);
    expect(nextBlinkDelay(() => 0.999)).toBeLessThan(7000);
    expect(nextBlinkDelay(() => 5)).toBe(7000);
  });

  it("schedules repeated blinks with the given random source", () => {
    vi.useFakeTimers();
    const random = () => 0; // always 3 s
    const { result } = renderHook(() => useBlink(true, random));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(2999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(BLINK_DURATION_MS));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(true);
  });

  it("cleans up its timer on unmount and when disabled", () => {
    vi.useFakeTimers();
    const random = () => 0.5;
    const { rerender, unmount } = renderHook(({ on }) => useBlink(on, random), {
      initialProps: { on: true },
    });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ on: false });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ on: true });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
