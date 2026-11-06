//! VAPID key pair (RFC 8292) for Web Push (PLAN_V3_SYNC §7.1, §7.5).
//!
//! `vapid generate` writes a P-256 private key as PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`)
//! with mode 0600; `web-push` 0.11 (`VapidSignatureBuilder::from_pem`) reads PKCS#8 and
//! SEC1. The public key for `applicationServerKey` is the uncompressed point (65 bytes,
//! `0x04 || X || Y`), base64url without padding (MDN `PushManager.subscribe`).
//! The private key is never logged (`Debug` is redacted).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::SecretKey;
use p256::elliptic_curve::Generate;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::pkcs8::{EncodePrivateKey, LineEnding};

/// Loaded VAPID key (phase D signs with it).
pub struct Vapid {
    secret: SecretKey,
    private_pem: String,
    public_key: String,
    pub subject: Option<String>,
    pub path: PathBuf,
}

impl std::fmt::Debug for Vapid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vapid")
            .field("public_key", &self.public_key)
            .field("subject", &self.subject)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// Uncompressed public point, base64url without padding.
pub fn public_key_b64(secret: &SecretKey) -> String {
    let point = secret.public_key().to_sec1_point(false);
    URL_SAFE_NO_PAD.encode(point.as_bytes())
}

impl Vapid {
    pub fn from_pem(pem: &str, subject: Option<String>, path: PathBuf) -> Result<Self> {
        let secret = SecretKey::from_pem(pem.trim())
            .map_err(|_| anyhow::anyhow!("VAPID key is not a valid P-256 PEM private key"))?;
        Ok(Self {
            public_key: public_key_b64(&secret),
            secret,
            private_pem: pem.to_string(),
            subject,
            path,
        })
    }

    /// Reads the key file; warns if group/others can read it.
    pub fn load(path: &Path, subject: Option<String>) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)
                .with_context(|| format!("reading VAPID key {}", path.display()))?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                tracing::warn!(
                    path = %path.display(),
                    "VAPID private key is readable by group/others; run chmod 600"
                );
            }
        }
        let pem = std::fs::read_to_string(path)
            .with_context(|| format!("reading VAPID key {}", path.display()))?;
        Self::from_pem(&pem, subject, path.to_path_buf())
    }

    /// `applicationServerKey` for `GET /push/vapid-public-key`.
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// The PEM as read from disk (for `web_push::VapidSignatureBuilder::from_pem`).
    pub fn private_pem(&self) -> &str {
        &self.private_pem
    }

    pub fn secret_key(&self) -> &SecretKey {
        &self.secret
    }
}

/// Creates a new key at `path` (mode 0600, refuses to overwrite unless `force`).
/// Returns the public key (base64url).
pub fn generate(path: &Path, force: bool) -> Result<String> {
    if path.exists() && !force {
        bail!(
            "{} already exists; use --force to replace it (existing push subscriptions stop working)",
            path.display()
        );
    }
    if let Some(dir) = path.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir)?;
    }
    let secret = SecretKey::generate();
    let pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| anyhow::anyhow!("encoding VAPID key"))?;
    // Write to a temp file with 0600 from the start, then rename (no window with wider rights).
    let tmp = path.with_extension("pem.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    {
        let mut f = opts
            .open(&tmp)
            .with_context(|| format!("creating {}", tmp.display()))?;
        f.write_all(pem.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(public_key_b64(&secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_load_and_derive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys").join("vapid.pem");
        let public = generate(&path, false).unwrap();
        let raw = URL_SAFE_NO_PAD.decode(&public).unwrap();
        assert_eq!(raw.len(), 65);
        assert_eq!(raw[0], 0x04);
        assert_eq!(public.len(), 87);

        let pem = std::fs::read_to_string(&path).unwrap();
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let v = Vapid::load(&path, Some("mailto:a@example.org".into())).unwrap();
        assert_eq!(v.public_key(), public);
        assert!(!format!("{v:?}").contains("PRIVATE"));

        assert!(generate(&path, false).is_err(), "no silent overwrite");
        let again = generate(&path, true).unwrap();
        assert_ne!(again, public);
    }

    #[test]
    fn rejects_garbage() {
        assert!(Vapid::from_pem("nope", None, PathBuf::new()).is_err());
    }
}
