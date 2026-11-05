/** Client-side validation of bookmark URLs (the backend validates again). */

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** "mailto:x", "javascript:…" – a scheme without "//" that is not "host:port". */
const OPAQUE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

/**
 * Trims the input, prefixes `https://` when no scheme is given and accepts only
 * http/https URLs with a host. Returns the (prefixed) string as typed, not `URL.href`.
 */
export function normalizeBookmarkUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Bitte eine Adresse eingeben." };
  if (/\s/.test(raw)) return { ok: false, error: "Ungültige Adresse." };
  const url = HAS_SCHEME.test(raw) || OPAQUE_SCHEME.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Ungültige Adresse." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Nur http- und https-Adressen sind erlaubt." };
  }
  if (!parsed.hostname) return { ok: false, error: "Ungültige Adresse." };
  return { ok: true, url };
}

/** Host of a URL without "www.", or "" if it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}
