//! QR pairing (PLAN_V4 §5.1/§5.2, §6.2): pairing codes, the QR URL and the API messages.
//! TypeScript mirror: `src/lib/pairing.ts` (+ messages in `src/lib/sync/types.ts`); both pass
//! `tests/fixtures/pairing_vectors.json`.
//!
//! Codes (pairing and recovery) are Crockford Base32: alphabet without I, L, O, U. Input is
//! normalised (upper case, spaces/hyphens removed, `O→0`, `I/L→1`); the server stores only the
//! SHA-256 of the normalised form. Random bytes come from the caller's CSPRNG.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::sync::DeviceKind;

pub const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// 12 characters = 60 random bits.
pub const PAIRING_CODE_LEN: usize = 12;
/// A pairing code is valid for 3 minutes.
pub const PAIRING_TTL_SECS: i64 = 180;
/// Path of the pairing page on the server (QR content: `<origin>/pair#c=<code>`).
pub const PAIR_PATH: &str = "/pair";
/// Hosts that may use plain `http://` (same rule as `server_url::normalize` in the app).
pub const PLAIN_HTTP_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"];

/// First `len * 5` bits of `bytes` (most significant first) as Crockford Base32.
pub(crate) fn encode_crockford(bytes: &[u8], len: usize) -> String {
    assert!(bytes.len() * 8 >= len * 5, "not enough random bits");
    (0..len)
        .map(|i| {
            let value = (0..5).fold(0usize, |acc, b| {
                let bit = i * 5 + b;
                (acc << 1) | usize::from((bytes[bit / 8] >> (7 - bit % 8)) & 1)
            });
            CODE_ALPHABET[value] as char
        })
        .collect()
}

/// Normalised code of exactly `len` alphabet characters, or `None`.
pub(crate) fn normalize_crockford(input: &str, len: usize) -> Option<String> {
    let code: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect();
    (code.len() == len && code.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(code)
}

/// Groups of four joined by `-` (input must be normalised).
pub(crate) fn group4(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

/// Lower-case hex SHA-256 of a normalised code (the only stored form).
pub fn code_hash(normalized: &str) -> String {
    Sha256::digest(normalized.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Pairing code from 8 random bytes (the first 60 bits are used).
pub fn code_from_bytes(bytes: &[u8; 8]) -> String {
    encode_crockford(bytes, PAIRING_CODE_LEN)
}

/// `"abcd efgh-jkmn"` → `"ABCDEFGHJKMN"`; `None` if it is not a pairing code.
pub fn normalize_code(input: &str) -> Option<String> {
    normalize_crockford(input, PAIRING_CODE_LEN)
}

/// `"ABCDEFGHJKMN"` → `"ABCD-EFGH-JKMN"` (display form).
pub fn format_code(code: &str) -> String {
    group4(code)
}

/// QR content for a normalised code; `origin` without trailing slash.
pub fn pairing_url(origin: &str, code: &str) -> String {
    format!("{origin}{PAIR_PATH}#c={code}")
}

/// A scanned QR code that is a Display Buddy pairing URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingTarget {
    /// `scheme://host[:port]`, lower case (as written in the URL, default ports are kept).
    pub origin: String,
    /// Normalised code.
    pub code: String,
}

fn valid_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[') {
        return inner.strip_suffix(']').is_some_and(|i| {
            !i.is_empty()
                && i.chars()
                    .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        });
    }
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// Parses `https://<host>[:port]/pair#c=<code>` (PLAN_V4 §6.2). `http://` only for
/// [`PLAIN_HTTP_HOSTS`]. No user info, no query, nothing after the path, exactly one
/// fragment parameter `c`. Non-ASCII (IDN in Unicode form) is rejected.
pub fn parse_pairing_url(text: &str) -> Option<PairingTarget> {
    let text = text.trim();
    if !text.is_ascii() {
        return None;
    }
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let end = rest.find(['/', '?', '#'])?;
    let authority = rest[..end].to_ascii_lowercase();
    let after = &rest[end..];
    if authority.contains('@') || authority.chars().any(|c| c.is_ascii_whitespace()) {
        return None;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(_) => {
            let close = authority.find(']')?;
            let (h, p) = authority.split_at(close + 1);
            match p.strip_prefix(':') {
                Some(p) => (h, Some(p)),
                None if p.is_empty() => (h, None),
                None => return None,
            }
        }
        None => match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority.as_str(), None),
        },
    };
    if !valid_host(host)
        || port.is_some_and(|p| {
            !p.chars().all(|c| c.is_ascii_digit()) || !p.parse::<u16>().is_ok_and(|n| n > 0)
        })
    {
        return None;
    }
    match scheme.as_str() {
        "https" => {}
        "http" if PLAIN_HTTP_HOSTS.contains(&host) => {}
        _ => return None,
    }
    let value = after.strip_prefix(PAIR_PATH)?.strip_prefix("#c=")?;
    Some(PairingTarget {
        origin: format!("{scheme}://{authority}"),
        code: normalize_code(value)?,
    })
}

// ---- API messages (PLAN_V4 §5) ------------------------------------------------

/// `POST /pairing` (desktop only) → this.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingStart {
    pub pairing_id: String,
    /// Normalised code (clients show it with [`format_code`]).
    pub code: String,
    /// QR content, [`pairing_url`].
    pub url: String,
    pub expires_at: String,
    pub server_time: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PairingState {
    Pending,
    Redeemed,
    Expired,
    Cancelled,
}

/// The device that redeemed a code (shown on the PC: „✓ ‚Pixel 8‘ ist jetzt angemeldet.“).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
}

/// `GET /pairing/{id}` (only the creating device; others get 404).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub pairing_id: String,
    pub state: PairingState,
    pub expires_at: String,
    /// Set when `state = redeemed` (null if that device was deleted since).
    #[serde(default)]
    pub device: Option<PairedDevice>,
    #[serde(default)]
    pub redeemed_at: Option<String>,
    pub server_time: String,
}

/// `POST /devices/pairing` (native app; bearer token in the answer, no cookie).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingRedeem {
    pub code: String,
    pub device_name: String,
    /// Must be `mobile`.
    pub kind: DeviceKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingAccess {
    pub device_id: String,
    pub token: String,
    pub username: String,
    pub server_time: String,
}

/// `POST /session/pairing` (PWA; answer `SessionResponse` + `Set-Cookie`; CSRF applies).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPairing {
    pub code: String,
    pub device_name: String,
    /// Reused like in `POST /session`.
    #[serde(default)]
    pub device_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/pairing_vectors.json")).unwrap()
    }

    fn hex_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn codes_from_bytes_format_and_hash() {
        let v = vectors();
        for c in v["codes"].as_array().unwrap() {
            let bytes: [u8; 8] = hex_bytes(c["bytes"].as_str().unwrap()).try_into().unwrap();
            let code = code_from_bytes(&bytes);
            assert_eq!(code, c["code"].as_str().unwrap());
            assert_eq!(format_code(&code), c["formatted"].as_str().unwrap());
            assert_eq!(code_hash(&code), c["hash"].as_str().unwrap());
            assert_eq!(normalize_code(c["formatted"].as_str().unwrap()), Some(code));
        }
    }

    #[test]
    fn normalization() {
        for c in vectors()["normalize"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            assert_eq!(
                normalize_code(input).as_deref(),
                c["code"].as_str(),
                "{input:?}"
            );
        }
    }

    #[test]
    fn url_parsing() {
        for c in vectors()["urls"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            let got = parse_pairing_url(input);
            match c["origin"].as_str() {
                Some(origin) => {
                    let t = got.unwrap_or_else(|| panic!("{input:?} should parse"));
                    assert_eq!(t.origin, origin, "{input:?}");
                    assert_eq!(t.code, c["code"].as_str().unwrap(), "{input:?}");
                }
                None => assert_eq!(got, None, "{input:?}"),
            }
        }
    }

    #[test]
    fn built_urls_parse_back() {
        for c in vectors()["build"].as_array().unwrap() {
            let (origin, code) = (c["origin"].as_str().unwrap(), c["code"].as_str().unwrap());
            let url = pairing_url(origin, code);
            assert_eq!(url, c["url"].as_str().unwrap());
            let t = parse_pairing_url(&url).unwrap();
            assert_eq!((t.origin.as_str(), t.code.as_str()), (origin, code));
        }
    }
}
