/**
 * Interprets what the user scanned or typed on the login page (PLAN_V4 §6.2). All code and
 * URL rules come from src/lib/pairing.ts (shared vectors with Rust); this file only decides
 * which form it is and compares origins.
 */
import { normalizeCode, parsePairingUrl } from "../../lib/pairing";

export type PairingInput =
  /** A pairing code; `origin` is set when it came as a QR URL (null for a typed code). */
  | { kind: "code"; code: string; origin: string | null }
  | { kind: "invalid" };

/** QR text or typed input → code (+ origin of the QR URL). */
export function parsePairingInput(text: string): PairingInput {
  const target = parsePairingUrl(text);
  if (target) return { kind: "code", code: target.code, origin: target.origin };
  const code = normalizeCode(text);
  return code ? { kind: "code", code, origin: null } : { kind: "invalid" };
}

/** Lower case, default port dropped (the QR keeps ports as written, `location.origin` drops them). */
function canonicalOrigin(origin: string): string {
  return origin
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/^(https:\/\/[^/]+):443$/, "$1")
    .replace(/^(http:\/\/[^/]+):80$/, "$1");
}

export function sameOrigin(a: string, b: string): boolean {
  return canonicalOrigin(a) === canonicalOrigin(b);
}

/** "https://buddy.example.org" → "buddy.example.org" (display only). */
export function originHost(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Native app, foreign origin confirmed: the code survives the reload after `server_set`
 * (PLAN_V4 §6.2 step 3) in sessionStorage – never in the URL. It is valid for 3 minutes on
 * the server anyway; a stale one simply fails with pairing_invalid.
 */
export const PENDING_CODE_KEY = "buddy-pending-pairing-code";

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberPendingCode(code: string): void {
  try {
    session()?.setItem(PENDING_CODE_KEY, code);
  } catch {
    // storage blocked: the user types the code again
  }
}

/** Reads and removes the pending code (one use). */
export function takePendingCode(): string | null {
  try {
    const s = session();
    const code = s?.getItem(PENDING_CODE_KEY) ?? null;
    s?.removeItem(PENDING_CODE_KEY);
    return code ? normalizeCode(code) : null;
  } catch {
    return null;
  }
}
