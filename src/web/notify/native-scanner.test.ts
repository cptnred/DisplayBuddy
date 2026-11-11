/**
 * QR scanner adapter of the native shell with a mocked barcode-scanner plugin (PLAN_V4 §6.2).
 */
import { Format } from "@tauri-apps/plugin-barcode-scanner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BarcodePlugin, type CameraPermission, createNativeScanner } from "./native-scanner";

const QR = "https://notes.example.net/pair#c=ABCDEFGHJKMN";

function fakePlugin(permission: CameraPermission = "granted") {
  let reject: ((e: Error) => void) | null = null;
  let resolve: ((v: { content: string }) => void) | null = null;
  const plugin = {
    requestPermissions: vi.fn(async () => permission),
    scan: vi.fn(
      () =>
        new Promise<{ content: string }>((res, rej) => {
          resolve = res;
          reject = rej;
        }),
    ),
    // like the plugin: rejects the running scan with "cancelled"
    cancel: vi.fn(async () => reject?.(new Error("cancelled"))),
  } satisfies BarcodePlugin;
  return {
    plugin,
    found: (content: string) => resolve?.({ content }),
    fail: (message: string) => reject?.(new Error(message)),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlayButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Scannen abbrechen"]');

afterEach(() => {
  document.documentElement.className = "";
  document.body.innerHTML = "";
});

describe("native QR scanner", () => {
  it("is available only in the Android/iOS shell", () => {
    expect(createNativeScanner({ plugin: fakePlugin().plugin, available: true, qrFormat: Format.QRCode }).isAvailable()).toBe(true);
    expect(createNativeScanner({ plugin: fakePlugin().plugin, available: false, qrFormat: Format.QRCode }).isAvailable()).toBe(false);
  });

  it("asks for the camera, scans QR codes behind the page and returns the raw text", async () => {
    const f = fakePlugin();
    const scanner = createNativeScanner({ plugin: f.plugin, available: true, qrFormat: Format.QRCode });
    const result = scanner.scan();
    await flush();
    expect(f.plugin.scan).toHaveBeenCalledWith({ windowed: true, formats: ["QR_CODE"] });
    // own cancel button over the transparent page, focused
    expect(document.documentElement.classList.contains("buddy-scanning")).toBe(true);
    expect(overlayButton()).toBe(document.activeElement);
    f.found(QR);
    expect(await result).toBe(QR);
    expect(document.documentElement.classList.contains("buddy-scanning")).toBe(false);
    expect(overlayButton()).toBeNull();
  });

  it("refused permission → camera_denied without opening the camera", async () => {
    for (const p of ["denied", "prompt", "prompt-with-rationale"] as const) {
      const f = fakePlugin(p);
      const scanner = createNativeScanner({ plugin: f.plugin, available: true, qrFormat: Format.QRCode });
      await expect(scanner.scan()).rejects.toThrow("camera_denied");
      expect(f.plugin.scan).not.toHaveBeenCalled();
    }
  });

  it("plugin errors → camera_failed, camera released, page restored", async () => {
    const f = fakePlugin();
    f.plugin.requestPermissions.mockRejectedValueOnce(new Error("boom"));
    const scanner = createNativeScanner({ plugin: f.plugin, available: true, qrFormat: Format.QRCode });
    await expect(scanner.scan()).rejects.toThrow("camera_failed");

    const result = scanner.scan();
    await flush();
    f.fail("No camera available on this device (e.g., iOS Simulator)");
    await expect(result).rejects.toThrow("camera_failed");
    expect(f.plugin.cancel).toHaveBeenCalled();
    expect(overlayButton()).toBeNull();
    expect(document.documentElement.classList.contains("buddy-scanning")).toBe(false);
  });

  it("„Abbrechen“ (button, Escape or cancel()) resolves null", async () => {
    const f = fakePlugin();
    const scanner = createNativeScanner({ plugin: f.plugin, available: true, qrFormat: Format.QRCode });

    let result = scanner.scan();
    await flush();
    overlayButton()!.click();
    expect(await result).toBeNull();

    result = scanner.scan();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await result).toBeNull();

    result = scanner.scan();
    await flush();
    await scanner.cancel();
    expect(await result).toBeNull();
    expect(f.plugin.cancel).toHaveBeenCalledTimes(3);
    expect(overlayButton()).toBeNull();
  });

  it("cancel() without a running scan does not touch the plugin", async () => {
    const f = fakePlugin();
    await createNativeScanner({ plugin: f.plugin, available: true, qrFormat: Format.QRCode }).cancel();
    expect(f.plugin.cancel).not.toHaveBeenCalled();
  });
});
