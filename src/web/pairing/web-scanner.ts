/**
 * QR scanner of the PWA (contract.ts `QrScanner`, PLAN_V4 §6.2 way B).
 *
 * - Camera: `navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}}})`
 *   (MDN MediaDevices.getUserMedia; `ideal` so desktops without a rear camera still work).
 *   NotAllowedError/SecurityError → `camera_denied`, anything else → `camera_failed`.
 * - Decoding: `BarcodeDetector` with format `qr_code` where present (MDN Barcode Detection
 *   API; not in Safari iOS/Firefox per browser-compat-data, so only an optional extra),
 *   otherwise jsQR 1.4.0 (README: RGBA `Uint8ClampedArray`, width, height) loaded with a
 *   dynamic import → own chunk.
 * - The stream is stopped (`MediaStreamTrack.stop()` on every track) on success, cancel,
 *   error and when the page is hidden or left (`visibilitychange`, `pagehide`).
 * - `isAvailable()` only checks that getUserMedia exists – no permission prompt.
 *
 * The scanner brings its own full-screen overlay (video + „Abbrechen“), so the UI only
 * awaits `scan()` like with the native plugin.
 */
import type { QrScanner } from "../contract";

type JsQR = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" }) => { data: string } | null;

/** The part of the Barcode Detection API we use (not in TypeScript's DOM lib). */
export interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
export interface BarcodeDetectorCtor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

export interface WebScannerOptions {
  /** Default: navigator.mediaDevices. */
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | null;
  /** Default: globalThis.BarcodeDetector; null forces jsQR. */
  barcodeDetector?: BarcodeDetectorCtor | null;
  /** Default: dynamic import of jsqr. */
  loadJsQR?: () => Promise<JsQR>;
  /** Pause between two decode attempts (ms). */
  intervalMs?: number;
}

type Decoder = (video: HTMLVideoElement) => Promise<string | null>;

/** Longest edge fed to jsQR (cost grows with the pixel count). */
const MAX_EDGE = 800;

function defaultMediaDevices(): Pick<MediaDevices, "getUserMedia"> | null {
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  return md && typeof md.getUserMedia === "function" ? md : null;
}

async function barcodeDecoder(Ctor: BarcodeDetectorCtor): Promise<Decoder | null> {
  try {
    const formats = await Ctor.getSupportedFormats?.();
    if (formats && !formats.includes("qr_code")) return null;
    const detector = new Ctor({ formats: ["qr_code"] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function jsqrDecoder(load: () => Promise<JsQR>): Promise<Decoder> {
  const jsQR = await load();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas");
  return async (video) => {
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight, 1));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    return jsQR(image.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function cameraError(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name;
  return new Error(name === "NotAllowedError" || name === "SecurityError" ? "camera_denied" : "camera_failed");
}

/** Full-screen preview with a cancel button (keyboard: Escape, focus moves to the button). */
function createOverlay(onCancel: () => void): { root: HTMLElement; video: HTMLVideoElement; remove(): void } {
  const previousFocus = document.activeElement as HTMLElement | null;
  const root = document.createElement("div");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "QR-Code scannen");
  root.style.cssText =
    "position:fixed;inset:0;z-index:1000;background:#000;color:#fff;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:16px;padding:16px;";
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.setAttribute("playsinline", ""); // iOS: no forced full-screen player
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "max-width:100%;max-height:70vh;border-radius:8px;";
  const hint = document.createElement("p");
  hint.textContent = "Kamera-Zugriff wird nur zum Scannen benötigt.";
  hint.style.margin = "0";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Abbrechen";
  button.setAttribute("aria-label", "Scannen abbrechen");
  button.style.cssText = "min-height:44px;padding:0 20px;font:inherit;border-radius:8px;";
  button.addEventListener("click", onCancel);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };
  root.addEventListener("keydown", onKey);
  root.append(video, hint, button);
  document.body.append(root);
  button.focus();
  return {
    root,
    video,
    remove() {
      video.srcObject = null;
      root.remove();
      previousFocus?.focus?.();
    },
  };
}

export function createWebScanner(options: WebScannerOptions = {}): QrScanner {
  const mediaDevices = () => (options.mediaDevices === undefined ? defaultMediaDevices() : options.mediaDevices);
  const detectorCtor = () =>
    options.barcodeDetector === undefined
      ? ((globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null)
      : options.barcodeDetector;
  const loadJsQR = options.loadJsQR ?? (() => import("jsqr").then((m) => m.default as JsQR));
  const intervalMs = options.intervalMs ?? 200;
  let cancelCurrent: (() => void) | null = null;

  return {
    isAvailable: () => mediaDevices() !== null,

    async cancel() {
      cancelCurrent?.();
    },

    async scan() {
      cancelCurrent?.(); // one scan at a time
      const md = mediaDevices();
      if (!md) throw new Error("camera_failed");
      let settle: ((value: string | null) => void) | null = null;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        settle?.(null);
      };
      cancelCurrent = cancel;

      let stream: MediaStream | null = null;
      let overlay: ReturnType<typeof createOverlay> | null = null;
      const onHidden = () => {
        if (document.visibilityState === "hidden") cancel();
      };
      try {
        const Ctor = detectorCtor();
        const decode = (Ctor && (await barcodeDecoder(Ctor))) || (await jsqrDecoder(loadJsQR).catch(() => null));
        if (!decode) throw new Error("camera_failed");
        if (cancelled) return null;
        try {
          stream = await md.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        } catch (e) {
          throw cameraError(e);
        }
        if (cancelled) return null;
        document.addEventListener("visibilitychange", onHidden);
        globalThis.addEventListener("pagehide", cancel);
        overlay = createOverlay(cancel);
        const video = overlay.video;
        video.srcObject = stream;
        void Promise.resolve(video.play?.()).catch(() => undefined);

        return await new Promise<string | null>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          settle = (value) => {
            if (timer !== null) clearTimeout(timer);
            settle = null;
            resolve(value);
          };
          const tick = async () => {
            timer = null;
            if (!settle) return;
            try {
              // HAVE_CURRENT_DATA: a frame is there to decode
              const text = video.readyState >= 2 ? await decode(video) : null;
              if (!settle) return;
              if (text) settle(text);
              else timer = setTimeout(() => void tick(), intervalMs);
            } catch {
              settle = null;
              reject(new Error("camera_failed"));
            }
          };
          if (cancelled) settle(null);
          else void tick();
        });
      } finally {
        stopStream(stream);
        overlay?.remove();
        document.removeEventListener("visibilitychange", onHidden);
        globalThis.removeEventListener("pagehide", cancel);
        if (cancelCurrent === cancel) cancelCurrent = null;
      }
    },
  };
}
