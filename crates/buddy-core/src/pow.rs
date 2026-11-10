//! Registration proof-of-work (D-87, PLAN_V4 §6.1): find a `u32` nonce so that
//! `SHA-256(challenge_bytes ‖ nonce_le)` starts with at least `bits` zero bits.
//! The server verifies, the desktop solves; both pass `tests/fixtures/pow_vectors.json`.

use std::ops::Range;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// Random bytes per challenge (sent base64url without padding).
pub const CHALLENGE_BYTES: usize = 16;

/// Decodes a base64url challenge (no padding); `None` if malformed or empty.
pub fn decode_challenge(challenge: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(challenge)
        .ok()
        .filter(|b| !b.is_empty())
}

pub fn digest(challenge: &[u8], nonce: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(challenge);
    h.update(nonce.to_le_bytes());
    h.finalize().into()
}

pub fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut n = 0;
    for b in hash {
        if *b == 0 {
            n += 8;
        } else {
            return n + b.leading_zeros();
        }
    }
    n
}

fn meets(challenge: &[u8], bits: u32, nonce: u32) -> bool {
    leading_zero_bits(&digest(challenge, nonce)) >= bits
}

/// Server side: is `nonce` a solution? `false` for a malformed challenge or `bits > 256`.
pub fn verify(challenge: &str, bits: u32, nonce: u32) -> bool {
    bits <= 256 && decode_challenge(challenge).is_some_and(|c| meets(&c, bits, nonce))
}

/// Client side: first solution in `nonces` (in order). The caller enforces its deadline by
/// solving in chunks, e.g. `0..1 << 20`, `1 << 20..2 << 20`, … (desktop: 60 s, D-87).
pub fn solve(challenge: &str, bits: u32, nonces: Range<u32>) -> Option<u32> {
    if bits > 256 {
        return None;
    }
    let c = decode_challenge(challenge)?;
    nonces.into_iter().find(|n| meets(&c, bits, *n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn vectors() {
        let v: Value =
            serde_json::from_str(include_str!("../tests/fixtures/pow_vectors.json")).unwrap();
        for c in v["cases"].as_array().unwrap() {
            let ch = c["challenge"].as_str().unwrap();
            let bits = c["bits"].as_u64().unwrap() as u32;
            let first = c["firstNonce"].as_u64().unwrap() as u32;
            let bytes = decode_challenge(ch).unwrap();
            let hex: String = digest(&bytes, 0)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(hex, c["digestNonce0"].as_str().unwrap(), "{ch}");
            assert_eq!(solve(ch, bits, 0..u32::MAX), Some(first), "{ch} {bits}");
            assert!(verify(ch, bits, first));
            for bad in c["invalidNonces"].as_array().unwrap() {
                assert!(
                    !verify(ch, bits, bad.as_u64().unwrap() as u32),
                    "{ch} {bad}"
                );
            }
        }
        for bad in v["malformedChallenges"].as_array().unwrap() {
            assert!(!verify(bad.as_str().unwrap(), 0, 0));
        }
    }

    #[test]
    fn bounds() {
        assert_eq!(leading_zero_bits(&[0, 0x10, 0xff]), 11);
        assert_eq!(leading_zero_bits(&[0; 32]), 256);
        assert!(!verify("AAAAAAAAAAAAAAAAAAAAAA", 257, 0));
        assert_eq!(solve("AAAAAAAAAAAAAAAAAAAAAA", 64, 0..1000), None);
    }
}
