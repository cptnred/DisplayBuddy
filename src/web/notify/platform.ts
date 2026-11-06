/**
 * Browser/platform detection for the PWA (pure functions over injected values).
 *
 * - iOS/iPadOS: Web Push only for home-screen web apps, iOS ≥ 16.4 (Apple, „Sending web
 *   push notifications in web apps and browsers“). iPadOS 13+ reports a Mac UA, so touch
 *   points are checked as well.
 * - Installed app: `display-mode: standalone` (MDN „Create a standalone app“), iOS also
 *   sets the non-standard `navigator.standalone`.
 */

export interface PlatformInfo {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** matchMedia('(display-mode: standalone)').matches */
  displayStandalone: boolean;
  /** iOS: navigator.standalone */
  iosStandalone?: boolean;
}

export function isIos(p: PlatformInfo): boolean {
  if (/iPad|iPhone|iPod/.test(p.userAgent)) return true;
  // iPadOS desktop-class UA
  return p.platform === "MacIntel" && (p.maxTouchPoints ?? 0) > 1;
}

export function isStandalone(p: PlatformInfo): boolean {
  return p.displayStandalone || p.iosStandalone === true;
}

export function isFirefox(p: PlatformInfo): boolean {
  return /Firefox\/|FxiOS\//.test(p.userAgent);
}

/** Reads the values from the running browser (page context only). */
export function currentPlatform(): PlatformInfo {
  const nav = globalThis.navigator as Navigator & { standalone?: boolean };
  const mm = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(display-mode: standalone)") : null;
  return {
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
    displayStandalone: mm?.matches ?? false,
    iosStandalone: nav?.standalone,
  };
}

/** base64url (VAPID public key) → bytes for `applicationServerKey`. */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Suggested device name for the login form, e.g. „iPhone (Safari)“, „Android (Chrome)“. */
export function suggestDeviceName(p: PlatformInfo): string {
  const ua = p.userAgent;
  let os = "Gerät";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua) || (p.platform === "MacIntel" && (p.maxTouchPoints ?? 0) > 1)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser: string | null = null;
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return browser ? `${os} (${browser})` : os;
}

export function sameBytes(a: ArrayBuffer | ArrayBufferView | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}
