import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebScanner, type BarcodeDetectorCtor } from "./web-scanner";

const QR = "https://buddy.test/pair#c=ABCDEFGHJKMN";

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function media(result: () => Promise<MediaStream>) {
  return { getUserMedia: vi.fn(result) };
}

function detector(values: string[][]): BarcodeDetectorCtor & { created: unknown[] } {
  const created: unknown[] = [];
  let i = 0;
  class Fake {
    constructor(options: unknown) {
      created.push(options);
    }
    static getSupportedFormats = async () => ["qr_code", "ean_13"];
    async detect() {
      return (values[Math.min(i++, values.length - 1)] ?? []).map((rawValue) => ({ rawValue }));
    }
  }
  return Object.assign(Fake, { created }) as unknown as BarcodeDetectorCtor & { created: unknown[] };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("web QR scanner", () => {
  it("isAvailable() only checks getUserMedia (no prompt)", () => {
    const md = media(async () => fakeStream().stream);
    expect(createWebScanner({ mediaDevices: md }).isAvailable()).toBe(true);
    expect(md.getUserMedia).not.toHaveBeenCalled();
    expect(createWebScanner({ mediaDevices: null }).isAvailable()).toBe(false);
  });

  it("uses the rear camera and BarcodeDetector; stops the stream and removes the overlay on success", async () => {
    const { stream, track } = fakeStream();
    const md = media(async () => stream);
    const Det = detector([[], [QR]]);
    const loadJsQR = vi.fn();
    const scanner = createWebScanner({ mediaDevices: md, barcodeDetector: Det, loadJsQR, intervalMs: 1 });
    await expect(scanner.scan()).resolves.toBe(QR);
    expect(md.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } }, audio: false });
    expect(Det.created).toEqual([{ formats: ["qr_code"] }]);
    expect(loadJsQR).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("falls back to jsQR without BarcodeDetector", async () => {
    const { stream, track } = fakeStream();
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const jsQR = vi.fn().mockReturnValueOnce(null).mockReturnValue({ data: QR });
    const scanner = createWebScanner({
      mediaDevices: media(async () => stream),
      barcodeDetector: null,
      loadJsQR: async () => jsQR,
      intervalMs: 1,
    });
    await expect(scanner.scan()).resolves.toBe(QR);
    expect(jsQR).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 640, 480, { inversionAttempts: "dontInvert" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("falls back to jsQR when BarcodeDetector cannot read QR codes", async () => {
    class NoQr {
      static getSupportedFormats = async () => ["ean_13"];
      async detect() {
        return [];
      }
    }
    const ctx = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const loadJsQR = vi.fn(async () => () => ({ data: QR }));
    const scanner = createWebScanner({
      mediaDevices: media(async () => fakeStream().stream),
      barcodeDetector: NoQr as unknown as BarcodeDetectorCtor,
      loadJsQR,
      intervalMs: 1,
    });
    await expect(scanner.scan()).resolves.toBe(QR);
    expect(loadJsQR).toHaveBeenCalledOnce();
  });

  it("cancel() (button, Escape, cancel(), page hidden) resolves null and stops the stream", async () => {
    for (const how of ["button", "escape", "api", "hidden"] as const) {
      const { stream, track } = fakeStream();
      const scanner = createWebScanner({ mediaDevices: media(async () => stream), barcodeDetector: detector([[]]), intervalMs: 1 });
      const result = scanner.scan();
      await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull());
      const button = document.querySelector<HTMLButtonElement>("button[aria-label='Scannen abbrechen']");
      expect(document.activeElement).toBe(button);
      if (how === "button") button?.click();
      if (how === "escape") button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (how === "api") await scanner.cancel();
      if (how === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await expect(result).resolves.toBeNull();
      expect(track.stop).toHaveBeenCalled();
      expect(document.querySelector("[role=dialog]")).toBeNull();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    }
  });

  it("pagehide stops the camera", async () => {
    const { stream, track } = fakeStream();
    const scanner = createWebScanner({ mediaDevices: media(async () => stream), barcodeDetector: detector([[]]), intervalMs: 1 });
    const result = scanner.scan();
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull());
    globalThis.dispatchEvent(new Event("pagehide"));
    await expect(result).resolves.toBeNull();
    expect(track.stop).toHaveBeenCalled();
  });

  it("a cancel while the permission prompt is open releases the camera right away", async () => {
    const { stream, track } = fakeStream();
    let grant: (s: MediaStream) => void = () => undefined;
    const md = media(() => new Promise<MediaStream>((r) => (grant = r)));
    const scanner = createWebScanner({ mediaDevices: md, barcodeDetector: detector([[QR]]) });
    const result = scanner.scan();
    await vi.waitFor(() => expect(md.getUserMedia).toHaveBeenCalled());
    await scanner.cancel();
    grant(stream);
    await expect(result).resolves.toBeNull();
    expect(track.stop).toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("maps getUserMedia errors to camera_denied / camera_failed", async () => {
    const fail = (name: string) =>
      createWebScanner({
        mediaDevices: media(async () => {
          throw Object.assign(new Error("x"), { name });
        }),
        barcodeDetector: detector([[]]),
      }).scan();
    await expect(fail("NotAllowedError")).rejects.toThrow("camera_denied");
    await expect(fail("NotFoundError")).rejects.toThrow("camera_failed");
    await expect(createWebScanner({ mediaDevices: null }).scan()).rejects.toThrow("camera_failed");
  });
});
