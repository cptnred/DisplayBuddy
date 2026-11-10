/**
 * Pairing and recovery codes, QR pairing URL (PLAN_V4 §6.2). Mirror of
 * `crates/buddy-core/src/pairing.rs` / `accounts.rs`; both pass `pairing_vectors.json`.
 * Crockford Base32 without I, L, O, U; input normalised (upper case, spaces/hyphens removed,
 * O→0, I/L→1).
 */

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LEN = 12;
export const RECOVERY_CODE_LEN = 24;
/** A pairing code is valid for 3 minutes. */
export const PAIRING_TTL_MS = 180_000;
export const PAIR_PATH = "/pair";
/** Hosts that may use plain http:// (same rule as server_url::normalize in the app). */
export const PLAIN_HTTP_HOSTS = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"];

function normalizeCrockford(input: string, len: number): string | null {
  const code = input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return code.length === len && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

function group4(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? "";
}

/** "abcd efgh-jkmn" → "ABCDEFGHJKMN"; null if it is not a pairing code. */
export function normalizeCode(input: string): string | null {
  return normalizeCrockford(input, PAIRING_CODE_LEN);
}

/** "ABCDEFGHJKMN" → "ABCD-EFGH-JKMN". */
export function formatCode(code: string): string {
  return group4(code);
}

export function normalizeRecoveryCode(input: string): string | null {
  return normalizeCrockford(input, RECOVERY_CODE_LEN);
}

/** Six groups of four. */
export function formatRecoveryCode(code: string): string {
  return group4(code);
}

/** QR content for a normalised code; origin without trailing slash. */
export function pairingUrl(origin: string, code: string): string {
  return `${origin}${PAIR_PATH}#c=${code}`;
}

export interface PairingTarget {
  /** scheme://host[:port], lower case (default ports kept as written). */
  origin: string;
  /** Normalised code. */
  code: string;
}

function validHost(host: string): boolean {
  if (host.startsWith("[")) return /^\[[0-9a-f:.]+\]$/.test(host);
  return /^[a-z0-9.-]+$/.test(host);
}

/**
 * Parses https://<host>[:port]/pair#c=<code>; http:// only for PLAIN_HTTP_HOSTS. No user
 * info, no query, nothing after the path, exactly one fragment parameter c. Non-ASCII
 * (IDN in Unicode form) is rejected. Hand-written (not `new URL`) to match Rust exactly.
 */
export function parsePairingUrl(text: string): PairingTarget | null {
  const t = text.trim();
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(t)) return null;
  const sep = t.indexOf("://");
  if (sep < 0) return null;
  const scheme = t.slice(0, sep).toLowerCase();
  const rest = t.slice(sep + 3);
  const end = rest.search(/[/?#]/);
  if (end < 0) return null;
  const authority = rest.slice(0, end).toLowerCase();
  const after = rest.slice(end);
  if (authority.includes("@") || /\s/.test(authority)) return null;
  let host: string;
  let port: string | null = null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    host = authority.slice(0, close + 1);
    const p = authority.slice(close + 1);
    if (p.startsWith(":")) port = p.slice(1);
    else if (p !== "") return null;
  } else {
    const colon = authority.indexOf(":");
    host = colon < 0 ? authority : authority.slice(0, colon);
    if (colon >= 0) port = authority.slice(colon + 1);
  }
  if (!validHost(host)) return null;
  if (port !== null && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (!(scheme === "https" || (scheme === "http" && PLAIN_HTTP_HOSTS.includes(host)))) return null;
  const prefix = `${PAIR_PATH}#c=`;
  if (!after.startsWith(prefix)) return null;
  const code = normalizeCode(after.slice(prefix.length));
  return code ? { origin: `${scheme}://${authority}`, code } : null;
}
