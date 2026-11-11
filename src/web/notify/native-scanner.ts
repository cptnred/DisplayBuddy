/**
 * QR scanner of the native shell (PLAN_V4 §6.2, D-99) over `@tauri-apps/plugin-barcode-scanner`
 * 2.5.3: requestPermissions → scan({windowed, formats: [QRCode]}) → raw text; cancel() rejects the
 * running scan with "cancelled" (plugin source, Android and iOS).
 *
 * `windowed: true`: the plugin puts the camera BEHIND a transparent WebView. Without it the
 * camera covers the WebView and the plugin draws no cancel button, so the user could not get
 * out. While scanning, this adapter therefore hides the page, makes it transparent and shows
 * its own „Abbrechen“ button (plugin README: "make sure your user interface is ready to show
 * what is underneath"). The UI checks the scanned text itself (src/web/pairing/parse.ts).
 */
import type { Format } from "@tauri-apps/plugin-barcode-scanner";
import type { QrScanner } from "../contract";

export type CameraPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

/** The plugin functions used here (tests pass fakes). */
export interface BarcodePlugin {
  requestPermissions(): Promise<CameraPermission>;
  scan(options: { windowed: boolean; formats: Format[] }): Promise<{ content: string }>;
  cancel(): Promise<void>;
}

export interface NativeScannerDeps {
  plugin: BarcodePlugin;
  /** Android/iOS shell (the plugin does not exist on the development machine). */
  available: boolean;
  /** Format.QRCode of the plugin ("QR_CODE"). */
  qrFormat: Format;
  doc?: Document;
}

const SCANNING_CLASS = "buddy-scanning";
const STYLE_ID = "buddy-scanner-style";
const OVERLAY_ID = "buddy-scanner-overlay";

// the camera is behind the WebView: everything of the page becomes transparent/hidden
const CSS = `html.${SCANNING_CLASS}, html.${SCANNING_CLASS} body { background: transparent !important; }
html.${SCANNING_CLASS} #root { visibility: hidden; }
#${OVERLAY_ID} { position: fixed; left: 0; right: 0; bottom: 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; align-items: center; gap: 12px; z-index: 2147483647; }
#${OVERLAY_ID} p { margin: 0; padding: 6px 12px; border-radius: 8px; color: #fff; background: rgba(0, 0, 0, 0.6); font: 16px system-ui, sans-serif; }
#${OVERLAY_ID} button { min-width: 160px; min-height: 48px; border: 0; border-radius: 24px; font: 600 17px system-ui, sans-serif;
  color: #111; background: #fff; }
#${OVERLAY_ID} button:focus-visible { outline: 3px solid #4c8dff; outline-offset: 2px; }`;

export function createNativeScanner(deps: NativeScannerDeps): QrScanner {
  const doc = deps.doc ?? globalThis.document;
  let cancelled = false;
  let running = false;

  function showOverlay(onCancel: () => void): () => void {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    doc.documentElement.classList.add(SCANNING_CLASS);
    const overlay = doc.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "QR-Code scannen");
    const hint = doc.createElement("p");
    hint.textContent = "Halte die Kamera auf den QR-Code am PC.";
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "Abbrechen";
    button.setAttribute("aria-label", "Scannen abbrechen");
    button.addEventListener("click", onCancel);
    overlay.append(hint, button);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    doc.addEventListener("keydown", onKey);
    doc.body.appendChild(overlay);
    button.focus();
    return () => {
      doc.removeEventListener("keydown", onKey);
      overlay.remove();
      doc.documentElement.classList.remove(SCANNING_CLASS);
    };
  }

  const scanner: QrScanner = {
    isAvailable: () => deps.available,
    async scan() {
      if (!deps.available || running) throw new Error("camera_failed");
      let permission: CameraPermission;
      try {
        permission = await deps.plugin.requestPermissions();
      } catch {
        throw new Error("camera_failed");
      }
      if (permission !== "granted") throw new Error("camera_denied");
      running = true;
      cancelled = false;
      const hide = showOverlay(() => void scanner.cancel());
      try {
        const result = await deps.plugin.scan({ windowed: true, formats: [deps.qrFormat] });
        return cancelled ? null : result.content;
      } catch (e) {
        if (cancelled || /cancel/i.test(String((e as Error)?.message ?? e))) return null;
        // release the camera in any case (no-op if it never started)
        await deps.plugin.cancel().catch(() => undefined);
        throw new Error("camera_failed");
      } finally {
        running = false;
        hide();
      }
    },
    async cancel() {
      if (!running) return;
      cancelled = true;
      await deps.plugin.cancel().catch(() => undefined);
    },
  };
  return scanner;
}
