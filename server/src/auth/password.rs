//! Password hashing with Argon2id (OWASP Password Storage Cheat Sheet: m = 19 MiB, t = 2,
//! p = 1; argon2 0.6 `Params::DEFAULT_*` are exactly these values). Verification is
//! constant time inside `argon2`; unknown users are verified against a dummy hash so the
//! response time does not reveal whether a user exists.

use std::sync::LazyLock;

use anyhow::{Result, anyhow};
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};

/// Minimum password length in characters (PLAN_V3_SYNC §7.5).
pub const MIN_PASSWORD_CHARS: usize = 12;
/// Upper bound to keep hashing cost bounded (OWASP: allow long passphrases, but cap).
pub const MAX_PASSWORD_BYTES: usize = 1024;

fn hasher() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("static Argon2 params are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// `Err` with a German-free technical message if the password is not acceptable.
pub fn validate_new_password(pw: &str) -> Result<()> {
    if pw.chars().count() < MIN_PASSWORD_CHARS {
        return Err(anyhow!(
            "password must have at least {MIN_PASSWORD_CHARS} characters"
        ));
    }
    if pw.len() > MAX_PASSWORD_BYTES {
        return Err(anyhow!(
            "password must have at most {MAX_PASSWORD_BYTES} bytes"
        ));
    }
    Ok(())
}

/// PHC string (`$argon2id$v=19$m=19456,t=2,p=1$…`) with a random salt.
pub fn hash_password(pw: &str) -> Result<String> {
    hasher()
        .hash_password(pw.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("hashing password: {e}"))
}

/// Constant-time verification; `false` for malformed hashes.
pub fn verify_password(pw: &str, phc: &str) -> bool {
    if pw.len() > MAX_PASSWORD_BYTES {
        return false;
    }
    hasher().verify_password(pw.as_bytes(), phc).is_ok()
}

static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password("dummy password for timing equalisation").expect("hashing works")
});

/// Same cost as a real verification, always `false` (unknown user).
pub fn verify_dummy(pw: &str) -> bool {
    let _ = verify_password(pw, &DUMMY_HASH);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{h}");
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("correct horse batterY", &h));
        assert!(!verify_password("x", "not a phc string"));
        assert_ne!(h, hash_password("correct horse battery").unwrap(), "salted");
        assert!(!verify_dummy("anything"));
    }

    #[test]
    fn password_rules() {
        assert!(validate_new_password("elevenchars").is_err());
        assert!(validate_new_password("twelve chars").is_ok());
        assert!(
            validate_new_password("äöüäöüäöüäöü").is_ok(),
            "counts characters"
        );
        assert!(validate_new_password(&"x".repeat(1025)).is_err());
    }
}
