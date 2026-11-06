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
//!
//! APNs is not implemented (D-55).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use ipnet::IpNet;

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
}

pub const DEFAULT_LISTEN: &str = "0.0.0.0:8080";
pub const DEFAULT_DB: &str = "/data/buddy.db";

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
