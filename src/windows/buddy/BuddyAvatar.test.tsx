import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDDY, type BuddyConfig, type SkinData, type SkinInfo } from "../../types";

const anim = {
  setSpeed: vi.fn(),
  goToAndStop: vi.fn(),
  playSegments: vi.fn(),
  resetSegments: vi.fn(),
  play: vi.fn(),
  destroy: vi.fn(),
};
const loadAnimation = vi.fn((_params: unknown) => anim);
vi.mock("lottie-web/build/player/lottie_light", () => ({ default: { loadAnimation } }));

let skinsListener: ((s: SkinInfo[]) => void) | null = null;
vi.mock("../../lib/api", () => ({
  api: {
    loadSkin: vi.fn(),
    onSkinsChanged: vi.fn(async (cb: (s: SkinInfo[]) => void) => {
      skinsListener = cb;
      return () => {};
    }),
  },
}));

import { api } from "../../lib/api";
import { BuddyAvatar } from "./BuddyAvatar";
import { readMarkers } from "./LottieSkin";
import { resetSkinCache } from "./skinStore";

const IMG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOTTIE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MARKER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const info = (id: string, kind: SkinInfo["kind"]): SkinInfo => ({
  id,
  name: id.slice(0, 4),
  kind,
  mime: kind === "image" ? "image/png" : "application/json",
});
const LOTTIE_JSON = JSON.stringify({ v: "5.7.0", fr: 30, ip: 0, op: 60, w: 100, h: 100, layers: [] });
const MARKER_JSON = JSON.stringify({
  v: "5.7.0",
  fr: 30,
  ip: 0,
  op: 120,
  w: 100,
  h: 100,
  layers: [],
  markers: [
    { tm: 0, cm: "idle", dr: 30 },
    { tm: 30, cm: '{"name":"hover"}', dr: 20 },
    { tm: 60, cm: "alert", dr: 30 },
  ],
});
const SKINS: Record<string, SkinData> = {
  [IMG_ID]: { info: info(IMG_ID, "image"), data: "data:image/png;base64,iVBORw0KGgo=" },
  [LOTTIE_ID]: { info: info(LOTTIE_ID, "lottie"), data: LOTTIE_JSON },
  [MARKER_ID]: { info: info(MARKER_ID, "lottie"), data: MARKER_JSON },
};

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
  vi.clearAllMocks();
  resetSkinCache();
  skinsListener = null;
  vi.mocked(api.loadSkin).mockImplementation(async (id: string) => {
    const s = SKINS[id];
    if (!s) throw new Error(`not found: ${id}`);
    return s;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const cfg = (patch: Partial<BuddyConfig> = {}): BuddyConfig => ({ ...DEFAULT_BUDDY, ...patch });

describe("BuddyAvatar", () => {
  it("renders built-in skins without loading anything", () => {
    render(<BuddyAvatar config={cfg({ skin: "ghost" })} />);
    expect(screen.getByTestId("skin-ghost")).toBeInTheDocument();
    expect(api.loadSkin).not.toHaveBeenCalled();
  });

  it("renders an image skin as a non-draggable <img> in the animated wrapper", async () => {
    render(<BuddyAvatar config={cfg({ skin: IMG_ID, size: 120 })} hovered />);
    const root = await screen.findByTestId("skin-image");
    const img = root.querySelector("img")!;
    expect(img).toHaveAttribute("src", SKINS[IMG_ID].data);
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveAttribute("alt", "");
    expect(root).toHaveClass("animated", "hovered", "html");
    expect(root.style.width).toBe("120px");
  });

  it("caches skins per id", async () => {
    const { unmount } = render(<BuddyAvatar config={cfg({ skin: IMG_ID })} />);
    await screen.findByTestId("skin-image");
    unmount();
    render(<BuddyAvatar config={cfg({ skin: IMG_ID })} />);
    await screen.findByTestId("skin-image");
    expect(api.loadSkin).toHaveBeenCalledTimes(1);
  });

  it("drops deleted skins from the cache on skins-changed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BuddyAvatar config={cfg({ skin: IMG_ID })} />);
    await screen.findByTestId("skin-image");
    vi.mocked(api.loadSkin).mockRejectedValue(new Error("gone"));
    await act(async () => skinsListener!([]));
    expect(api.loadSkin).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("smiley")).toBeInTheDocument();
  });

  it("uses an injected loader", async () => {
    const loader = vi.fn(async () => SKINS[IMG_ID]);
    render(<BuddyAvatar config={cfg({ skin: IMG_ID })} loadSkin={loader} />);
    await screen.findByTestId("skin-image");
    expect(loader).toHaveBeenCalledWith(IMG_ID);
    expect(api.loadSkin).not.toHaveBeenCalled();
  });

  it("falls back to the smiley (with a warning) for an unknown id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BuddyAvatar config={cfg({ skin: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })} />);
    expect(await screen.findByTestId("smiley")).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to the smiley for invalid Lottie JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.loadSkin).mockResolvedValue({ info: info(LOTTIE_ID, "lottie"), data: "{nope" });
    render(<BuddyAvatar config={cfg({ skin: LOTTIE_ID })} />);
    expect(await screen.findByTestId("smiley")).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    expect(loadAnimation).not.toHaveBeenCalled();
  });

  it("plays a Lottie skin (svg renderer, loop) and destroys it on unmount", async () => {
    const { unmount } = render(<BuddyAvatar config={cfg({ skin: LOTTIE_ID, animationSpeed: 1.5 })} />);
    await waitFor(() => expect(loadAnimation).toHaveBeenCalledTimes(1));
    const params = loadAnimation.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({ renderer: "svg", loop: true });
    expect(params.container).toBe(screen.getByTestId("lottie-container"));
    await waitFor(() => expect(anim.play).toHaveBeenCalled());
    expect(anim.setSpeed).toHaveBeenCalledWith(1.5);
    expect(anim.playSegments).not.toHaveBeenCalled();
    // Without markers the wrapper keeps the CSS motion.
    expect(screen.getByTestId("skin-lottie")).not.toHaveClass("noIdle");
    unmount();
    expect(anim.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops a Lottie skin on frame 0 in quiet mode", async () => {
    render(<BuddyAvatar config={cfg({ skin: LOTTIE_ID, animate: false })} />);
    await waitFor(() => expect(anim.goToAndStop).toHaveBeenCalledWith(0, true));
    expect(anim.play).not.toHaveBeenCalled();
  });

  it("stops a Lottie skin on frame 0 with reduced motion", async () => {
    reducedMotion = true;
    render(<BuddyAvatar config={cfg({ skin: LOTTIE_ID })} />);
    await waitFor(() => expect(anim.goToAndStop).toHaveBeenCalledWith(0, true));
    expect(anim.play).not.toHaveBeenCalled();
  });

  it("plays marker segments for the matching state", async () => {
    const { rerender } = render(<BuddyAvatar config={cfg({ skin: MARKER_ID })} />);
    await waitFor(() => expect(anim.playSegments).toHaveBeenLastCalledWith([0, 30], true));
    const root = screen.getByTestId("skin-lottie");
    expect(root).toHaveClass("noIdle", "noHover");
    expect(root).not.toHaveClass("noHop");

    rerender(<BuddyAvatar config={cfg({ skin: MARKER_ID })} hovered />);
    expect(anim.playSegments).toHaveBeenLastCalledWith([30, 50], true);
    rerender(<BuddyAvatar config={cfg({ skin: MARKER_ID })} alert />);
    expect(anim.playSegments).toHaveBeenLastCalledWith([60, 90], true);
    // Lottie handles the alert itself: no CSS wiggle on top.
    expect(screen.getByTestId("skin-lottie")).not.toHaveClass("alerting");
    // No "click" marker → idle segment + CSS hop.
    rerender(<BuddyAvatar config={cfg({ skin: MARKER_ID })} hopping />);
    expect(anim.playSegments).toHaveBeenLastCalledWith([0, 30], true);
    expect(screen.getByTestId("skin-lottie")).toHaveClass("hopping");
  });

  it("falls back to the smiley when lottie-web fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadAnimation.mockImplementationOnce(() => {
      throw new Error("bad animation");
    });
    render(<BuddyAvatar config={cfg({ skin: LOTTIE_ID })} />);
    expect(await screen.findByTestId("smiley")).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
  });
});

describe("readMarkers", () => {
  it("reads plain and JSON-comment names, ignores unknown ones", () => {
    expect(
      readMarkers([
        { tm: 5, cm: "Idle", dr: 10 },
        { tm: 20, cm: '{"name":"click"}', dr: 0 },
        { tm: 40, cm: "other", dr: 5 },
        { cm: "hover" },
      ]),
    ).toEqual({ idle: { start: 5, end: 15 }, click: { start: 20, end: 21 } });
    expect(readMarkers(undefined)).toEqual({});
  });
});
