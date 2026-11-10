//! Configuration from environment variables (PLAN_V3_SYNC §7.1).
//!
//! | Variable | Default | Meaning |
//! |---|---|---|
//! | `BUDDY_LISTEN` | `0.0.0.0:8080` | listen address |
//! | `BUDDY_PUBLIC_URL` | – (required for `serve`) | public origin, e.g. `https://buddy.example.org`; CSRF `Origin` check |
//! | `BUDDY_DB` | `/data/buddy.db` | SQLite database file |
//! | `BUDDY_WEB_DIR` | – | directory of the built PWA (`dist-web/`); without it only the API is served |
//! | `BUDDY_VAPID_PRIVATE_KEY_FILE` | – | P-256 private key (PEM, created by `vapid generate`) |
//! | `BUDDY_VAPID_SUBJECT` | – | `mailto:…` or `https://…` (VAPID `sub`, used by phase D) |
//! | `BUDDY_TRUSTED_PROXIES` | – | comma-separated CIDRs (Caddy's Docker network); only from there `X-Forwarded-For` counts |
//! | `BUDDY_BACKUP_DIR` | `<dir of BUDDY_DB>/backups` | nightly `VACUUM INTO` target (14 kept) |
//! | `BUDDY_FCM_SERVICE_ACCOUNT_FILE` | – | Firebase service account key (JSON) for native push to Android (FCM HTTP v1, phase N2); without it no native push |
//! | `BUDDY_REGISTRATION` | `closed` | `open`, `invite` or `closed` (self-registration from the desktop, D-86) |
//! | `BUDDY_REGISTRATION_POW_BITS` | `22` | proof-of-work difficulty (1–32 leading zero bits, D-87) |
//! | `BUDDY_REGISTRATION_DAILY_LIMIT` | `200` | registrations per day, all IPs together |
//! | `BUDDY_QUOTA_BYTES` / `_NOTES` / `_DEVICES` | – (unlimited) | default quotas per account (D-94) |
//! | `BUDDY_IMPRINT_URL` / `BUDDY_PRIVACY_URL` / `BUDDY_TERMS_URL` | – | operator pages for `GET /info` (`https://` only) |
//! | `BUDDY_OPERATOR_NAME` | – | operator shown in `GET /info` |
//! | `BUDDY_FCM_PAYLOAD` | `full` | `minimal`: FCM shows only „Erinnerung fällig“ (D-102) |
//!
//! Invalid values stop the start with a message that names the variable.
//!
//! APNs is not implemented (D-55).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use buddy_core::accounts::{LegalLinks, Quota, RegistrationMode};
use ipnet::IpNet;

/// What FCM notifications show (D-102): `Full` = title/text like Web Push (v3 behaviour),
/// `Minimal` = a fixed text, so Google never sees note content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FcmPayload {
    Full,
    Minimal,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Normalised origin (`scheme://host[:port]`, no trailing slash).
    pub public_origin: String,
    pub db_path: PathBuf,
    pub web_dir: Option<PathBuf>,
    pub vapid_private_key_file: Option<PathBuf>,
    pub vapid_subject: Option<String>,
    pub trusted_proxies: Vec<IpNet>,
    pub backup_dir: PathBuf,
    pub fcm_service_account_file: Option<PathBuf>,
    pub registration: RegistrationMode,
    pub registration_pow_bits: u32,
    pub registration_daily_limit: u32,
    /// Server-wide default quotas (`None` = unlimited); accounts may override them (CLI).
    pub quota: Quota,
    pub legal: LegalLinks,
    pub operator_name: Option<String>,
    pub fcm_payload: FcmPayload,
}

pub const DEFAULT_LISTEN: &str = "0.0.0.0:8080";
pub const DEFAULT_DB: &str = "/data/buddy.db";
pub const DEFAULT_POW_BITS: u32 = 22;
pub const DEFAULT_DAILY_LIMIT: u32 = 200;

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `https://Buddy.Example.org/` → `https://buddy.example.org`. Only `https`, or `http` for
/// `localhost`/loopback (development; browsers treat it as a secure context).
pub fn normalize_origin(url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/');
    let (scheme, rest) = url
        .split_once("://")
        .context("BUDDY_PUBLIC_URL must look like https://host")?;
    let scheme = scheme.to_ascii_lowercase();
    if rest.is_empty() || rest.contains('/') || rest.contains('?') || rest.contains('#') {
        bail!("BUDDY_PUBLIC_URL must be an origin without path, e.g. https://buddy.example.org");
    }
    let host = rest.to_ascii_lowercase();
    let host_only = host
        .rsplit_once(':')
        .filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
        .map_or(host.as_str(), |(h, _)| h);
    let loopback = matches!(host_only, "localhost" | "127.0.0.1" | "[::1]");
    match scheme.as_str() {
        "https" => {}
        "http" if loopback => {}
        _ => bail!("BUDDY_PUBLIC_URL must use https:// (http:// only for localhost)"),
    }
    Ok(format!("{scheme}://{host}"))
}

fn parse_registration(v: Option<String>) -> Result<RegistrationMode> {
    match v.as_deref() {
        None | Some("closed") => Ok(RegistrationMode::Closed),
        Some("open") => Ok(RegistrationMode::Open),
        Some("invite") => Ok(RegistrationMode::Invite),
        Some(o) => bail!("BUDDY_REGISTRATION must be open, invite or closed, not {o:?}"),
    }
}

fn parse_number<T>(name: &str, v: Option<String>, min: T, max: T) -> Result<Option<T>>
where
    T: std::str::FromStr + PartialOrd + Copy + std::fmt::Display,
{
    let Some(v) = v else { return Ok(None) };
    match v.parse::<T>() {
        Ok(n) if n >= min && n <= max => Ok(Some(n)),
        _ => bail!("{name} must be a whole number from {min} to {max}, not {v:?}"),
    }
}

/// Operator links are shown in the apps and opened in a browser: `https://` only.
fn parse_link(name: &str, v: Option<String>) -> Result<Option<String>> {
    let Some(v) = v else { return Ok(None) };
    let host = v.strip_prefix("https://").unwrap_or_default();
    if host.is_empty()
        || host.starts_with('/')
        || v.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        bail!("{name} must be an https:// URL");
    }
    Ok(Some(v))
}

pub fn parse_proxies(s: &str) -> Result<Vec<IpNet>> {
    s.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| {
            p.parse::<IpNet>()
                .or_else(|_| p.parse::<std::net::IpAddr>().map(IpNet::from))
                .with_context(|| format!("BUDDY_TRUSTED_PROXIES: invalid network {p:?}"))
        })
        .collect()
}

impl Config {
    /// Reads the configuration from `vars` (normally `std::env::vars()`).
    /// `require_public_url` is true for `serve`; CLI commands only need the database.
    pub fn from_vars<I>(vars: I, require_public_url: bool) -> Result<Self>
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let map: std::collections::HashMap<String, String> = vars.into_iter().collect();
        let get = |k: &str| non_empty(map.get(k).cloned());

        let listen = get("BUDDY_LISTEN")
            .unwrap_or_else(|| DEFAULT_LISTEN.into())
            .parse()
            .context("BUDDY_LISTEN must be host:port")?;
        let public_origin = match get("BUDDY_PUBLIC_URL") {
            Some(u) => normalize_origin(&u)?,
            None if require_public_url => bail!("BUDDY_PUBLIC_URL is required"),
            None => "http://localhost".into(),
        };
        let db_path = PathBuf::from(get("BUDDY_DB").unwrap_or_else(|| DEFAULT_DB.into()));
        let backup_dir = get("BUDDY_BACKUP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                db_path
                    .parent()
                    .map(|p| p.join("backups"))
                    .unwrap_or_else(|| PathBuf::from("backups"))
            });
        let vapid_subject = get("BUDDY_VAPID_SUBJECT");
        if let Some(s) = &vapid_subject
            && !(s.starts_with("mailto:") || s.starts_with("https://"))
        {
            bail!("BUDDY_VAPID_SUBJECT must start with mailto: or https://");
        }
        Ok(Self {
            listen,
            public_origin,
            db_path,
            web_dir: get("BUDDY_WEB_DIR").map(PathBuf::from),
            vapid_private_key_file: get("BUDDY_VAPID_PRIVATE_KEY_FILE").map(PathBuf::from),
            vapid_subject,
            trusted_proxies: parse_proxies(&get("BUDDY_TRUSTED_PROXIES").unwrap_or_default())?,
            backup_dir,
            fcm_service_account_file: get("BUDDY_FCM_SERVICE_ACCOUNT_FILE").map(PathBuf::from),
            registration: parse_registration(get("BUDDY_REGISTRATION"))?,
            registration_pow_bits: parse_number(
                "BUDDY_REGISTRATION_POW_BITS",
                get("BUDDY_REGISTRATION_POW_BITS"),
                1,
                32,
            )?
            .unwrap_or(DEFAULT_POW_BITS),
            registration_daily_limit: parse_number(
                "BUDDY_REGISTRATION_DAILY_LIMIT",
                get("BUDDY_REGISTRATION_DAILY_LIMIT"),
                1,
                1_000_000,
            )?
            .unwrap_or(DEFAULT_DAILY_LIMIT),
            quota: Quota {
                bytes: parse_number("BUDDY_QUOTA_BYTES", get("BUDDY_QUOTA_BYTES"), 1, u64::MAX)?,
                notes: parse_number("BUDDY_QUOTA_NOTES", get("BUDDY_QUOTA_NOTES"), 1, u64::MAX)?,
                devices: parse_number(
                    "BUDDY_QUOTA_DEVICES",
                    get("BUDDY_QUOTA_DEVICES"),
                    1,
                    u64::MAX,
                )?,
            },
            legal: LegalLinks {
                imprint_url: parse_link("BUDDY_IMPRINT_URL", get("BUDDY_IMPRINT_URL"))?,
                privacy_url: parse_link("BUDDY_PRIVACY_URL", get("BUDDY_PRIVACY_URL"))?,
                terms_url: parse_link("BUDDY_TERMS_URL", get("BUDDY_TERMS_URL"))?,
            },
            operator_name: match get("BUDDY_OPERATOR_NAME") {
                Some(n) if n.chars().count() > 100 || n.chars().any(char::is_control) => {
                    bail!("BUDDY_OPERATOR_NAME must have 1–100 printable characters")
                }
                n => n,
            },
            fcm_payload: match get("BUDDY_FCM_PAYLOAD").as_deref() {
                None | Some("full") => FcmPayload::Full,
                Some("minimal") => FcmPayload::Minimal,
                Some(o) => bail!("BUDDY_FCM_PAYLOAD must be minimal or full, not {o:?}"),
            },
        })
    }

    pub fn from_env(require_public_url: bool) -> Result<Self> {
        Self::from_vars(std::env::vars(), require_public_url)
    }

    /// A configuration for tests: database and backups below `dir`.
    pub fn for_tests(dir: &std::path::Path) -> Self {
        Self {
            listen: DEFAULT_LISTEN.parse().expect("valid default"),
            public_origin: "https://buddy.example.test".into(),
            db_path: dir.join("buddy.db"),
            web_dir: None,
            vapid_private_key_file: None,
            vapid_subject: None,
            trusted_proxies: Vec::new(),
            backup_dir: dir.join("backups"),
            fcm_service_account_file: None,
            registration: RegistrationMode::Closed,
            // Low difficulty keeps tests fast; the production default is 22 (D-87).
            registration_pow_bits: 8,
            registration_daily_limit: DEFAULT_DAILY_LIMIT,
            quota: Quota::default(),
            legal: LegalLinks::default(),
            operator_name: None,
            fcm_payload: FcmPayload::Full,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn origins() {
        assert_eq!(
            normalize_origin("https://Buddy.Example.org/").unwrap(),
            "https://buddy.example.org"
        );
        assert_eq!(
            normalize_origin("http://localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        assert!(normalize_origin("http://buddy.example.org").is_err());
        assert!(normalize_origin("https://buddy.example.org/app").is_err());
        assert!(normalize_origin("buddy.example.org").is_err());
    }

    #[test]
    fn defaults_and_required() {
        assert!(Config::from_vars(vars(&[]), true).is_err());
        let c = Config::from_vars(vars(&[("BUDDY_DB", "/srv/b/buddy.db")]), false).unwrap();
        assert_eq!(c.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(c.backup_dir, PathBuf::from("/srv/b/backups"));
        assert!(c.web_dir.is_none() && c.trusted_proxies.is_empty());
        assert!(c.fcm_service_account_file.is_none());
        // v4: a self-hoster who upgrades stays closed and unlimited (D-86, S15)
        assert_eq!(c.registration, RegistrationMode::Closed);
        assert_eq!(c.registration_pow_bits, 22);
        assert_eq!(c.registration_daily_limit, 200);
        assert_eq!(c.quota, Quota::default());
        assert_eq!(c.legal, LegalLinks::default());
        assert_eq!(c.operator_name, None);
        assert_eq!(c.fcm_payload, FcmPayload::Full);
    }

    #[test]
    fn v4_variables() {
        let c = Config::from_vars(
            vars(&[
                ("BUDDY_REGISTRATION", "open"),
                ("BUDDY_REGISTRATION_POW_BITS", "20"),
                ("BUDDY_REGISTRATION_DAILY_LIMIT", "50"),
                ("BUDDY_QUOTA_BYTES", "52428800"),
                ("BUDDY_QUOTA_NOTES", "5000"),
                ("BUDDY_QUOTA_DEVICES", "10"),
                ("BUDDY_IMPRINT_URL", "https://pev-point.de/impressum"),
                ("BUDDY_PRIVACY_URL", "https://pev-point.de/datenschutz"),
                ("BUDDY_TERMS_URL", " "),
                ("BUDDY_OPERATOR_NAME", "pev-point.de"),
                ("BUDDY_FCM_PAYLOAD", "minimal"),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(c.registration, RegistrationMode::Open);
        assert_eq!(c.registration_pow_bits, 20);
        assert_eq!(c.registration_daily_limit, 50);
        assert_eq!(
            c.quota,
            Quota {
                bytes: Some(52_428_800),
                notes: Some(5000),
                devices: Some(10)
            }
        );
        assert_eq!(
            c.legal.privacy_url.as_deref(),
            Some("https://pev-point.de/datenschutz")
        );
        assert_eq!(c.legal.terms_url, None, "empty = not configured");
        assert_eq!(c.operator_name.as_deref(), Some("pev-point.de"));
        assert_eq!(c.fcm_payload, FcmPayload::Minimal);
        assert_eq!(
            Config::from_vars(vars(&[("BUDDY_REGISTRATION", "invite")]), false)
                .unwrap()
                .registration,
            RegistrationMode::Invite
        );
    }

    #[test]
    fn bad_v4_values_stop_the_start() {
        for (k, v) in [
            ("BUDDY_REGISTRATION", "yes"),
            ("BUDDY_REGISTRATION", "Open"),
            ("BUDDY_REGISTRATION_POW_BITS", "0"),
            ("BUDDY_REGISTRATION_POW_BITS", "33"),
            ("BUDDY_REGISTRATION_POW_BITS", "x"),
            ("BUDDY_REGISTRATION_DAILY_LIMIT", "-1"),
            ("BUDDY_QUOTA_BYTES", "50MB"),
            ("BUDDY_QUOTA_NOTES", "0"),
            ("BUDDY_QUOTA_DEVICES", "1.5"),
            ("BUDDY_IMPRINT_URL", "http://pev-point.de/impressum"),
            ("BUDDY_PRIVACY_URL", "pev-point.de/datenschutz"),
            ("BUDDY_TERMS_URL", "https://"),
            ("BUDDY_TERMS_URL", "https://a b"),
            ("BUDDY_OPERATOR_NAME", "a\u{7}b"),
            ("BUDDY_FCM_PAYLOAD", "none"),
        ] {
            let err = Config::from_vars(vars(&[(k, v)]), false).unwrap_err();
            assert!(err.to_string().contains(k), "{k}={v}: {err}");
        }
    }

    #[test]
    fn full_config() {
        let c = Config::from_vars(
            vars(&[
                ("BUDDY_LISTEN", "127.0.0.1:9000"),
                ("BUDDY_PUBLIC_URL", "https://buddy.example.org"),
                ("BUDDY_WEB_DIR", "/app/web"),
                ("BUDDY_VAPID_PRIVATE_KEY_FILE", "/data/vapid.pem"),
                ("BUDDY_VAPID_SUBJECT", "mailto:admin@example.org"),
                ("BUDDY_TRUSTED_PROXIES", "172.30.0.0/16, 10.0.0.2"),
                ("BUDDY_FCM_SERVICE_ACCOUNT_FILE", "/data/fcm.json"),
            ]),
            true,
        )
        .unwrap();
        assert_eq!(c.public_origin, "https://buddy.example.org");
        assert_eq!(c.trusted_proxies.len(), 2);
        assert_eq!(
            c.fcm_service_account_file,
            Some(PathBuf::from("/data/fcm.json"))
        );
        assert!(
            Config::from_vars(
                vars(&[
                    ("BUDDY_PUBLIC_URL", "https://x.org"),
                    ("BUDDY_VAPID_SUBJECT", "admin@example.org")
                ]),
                true
            )
            .is_err()
        );
        assert!(
            Config::from_vars(
                vars(&[
                    ("BUDDY_PUBLIC_URL", "https://x.org"),
                    ("BUDDY_TRUSTED_PROXIES", "nope")
                ]),
                true
            )
            .is_err()
        );
    }
}
