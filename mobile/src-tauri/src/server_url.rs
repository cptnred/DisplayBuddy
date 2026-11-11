//! Validation of `BUDDY_PUBLIC_URL`, the server origin baked into the shell at build time
//! (PLAN_V3_SYNC §10.2). Shared by `build.rs` (fails the build on a bad value) and the
//! app (HTTP scope), so both always agree.
//!
//! Same rules as the server (`server/src/config.rs`): an origin without path, `https://`;
//! `http://` only for loopback hosts and the Android emulator's alias of the host
//! machine (`10.0.2.2`, Android emulator networking docs), used by the CI emulator test.

/// Default server when the build has no `BUDDY_PUBLIC_URL` (PLAN_V4 §6.5, D-97).
// used by build.rs (the app gets it as BUDDY_SERVER_ORIGIN) and the tests
#[cfg_attr(not(test), allow(dead_code))]
pub const FALLBACK_ORIGIN: &str = "https://buddy.pev-point.de";

/// Hosts that may use plain `http://` (development and emulator tests only).
const PLAIN_HTTP_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]", "10.0.2.2"];

/// Returns the normalised origin (`scheme://host[:port]`, lower case, no trailing slash).
pub fn normalize(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "BUDDY_PUBLIC_URL must look like https://host".to_string())?;
    let scheme = scheme.to_ascii_lowercase();
    if rest.is_empty()
        || rest.contains(['/', '?', '#', '@', '*'])
        || rest.chars().any(char::is_whitespace)
    {
        return Err(
            "BUDDY_PUBLIC_URL must be an origin without path, e.g. https://buddy.example.org"
                .to_string(),
        );
    }
    let host = rest.to_ascii_lowercase();
    let (host_only, port) = if host.starts_with('[') {
        // IPv6 literal: "[::1]" or "[::1]:8080"
        let end = host
            .find(']')
            .ok_or_else(|| "BUDDY_PUBLIC_URL has an invalid IPv6 host".to_string())?;
        let (h, after) = host.split_at(end + 1);
        match after.strip_prefix(':') {
            Some(p) => (h, Some(p)),
            None if after.is_empty() => (h, None),
            None => return Err("BUDDY_PUBLIC_URL has an invalid IPv6 host".to_string()),
        }
    } else {
        match host.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (host.as_str(), None),
        }
    };
    if let Some(p) = port
        && (p.is_empty() || p.len() > 5 || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return Err("BUDDY_PUBLIC_URL has an invalid port".to_string());
    }
    if !host_only.starts_with('[') && host_only.contains(':') {
        return Err("BUDDY_PUBLIC_URL has an invalid host".to_string());
    }
    if host_only.is_empty() {
        return Err("BUDDY_PUBLIC_URL has no host".to_string());
    }
    match scheme.as_str() {
        "https" => {}
        "http" if PLAIN_HTTP_HOSTS.contains(&host_only) => {}
        _ => {
            return Err(
                "BUDDY_PUBLIC_URL must use https:// (http:// only for localhost or 10.0.2.2)"
                    .to_string(),
            );
        }
    }
    Ok(format!("{scheme}://{host}"))
}

/// URL pattern for the HTTP plugin scope: only the API below the origin.
pub fn api_scope(origin: &str) -> String {
    format!("{origin}/api/v1/*")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_origins() {
        assert_eq!(
            normalize(" https://Buddy.Example.org/ ").unwrap(),
            "https://buddy.example.org"
        );
        assert_eq!(
            normalize("https://buddy.example.org:8443").unwrap(),
            "https://buddy.example.org:8443"
        );
    }

    #[test]
    fn plain_http_only_for_loopback_and_emulator_host() {
        assert_eq!(
            normalize("http://10.0.2.2:8080").unwrap(),
            "http://10.0.2.2:8080"
        );
        assert_eq!(
            normalize("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(normalize("http://[::1]:8080").unwrap(), "http://[::1]:8080");
        assert!(normalize("http://buddy.example.org").is_err());
        assert!(normalize("http://192.168.1.2:8080").is_err());
    }

    #[test]
    fn rejects_paths_credentials_wildcards_and_garbage() {
        for bad in [
            "",
            "buddy.example.org",
            "https://",
            "https://buddy.example.org/api",
            "https://buddy.example.org?x=1",
            "https://user@buddy.example.org",
            "https://*.example.org",
            "https://buddy.example.org:abc",
            "ftp://buddy.example.org",
            "https://buddy example.org",
        ] {
            assert!(normalize(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn fallback_origin_is_normalised() {
        assert_eq!(normalize(FALLBACK_ORIGIN).as_deref(), Ok(FALLBACK_ORIGIN));
    }

    #[test]
    fn scope_covers_only_the_api() {
        assert_eq!(
            api_scope("https://buddy.example.org"),
            "https://buddy.example.org/api/v1/*"
        );
    }
}
