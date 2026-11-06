//! CSRF protection for cookie requests (PLAN_V3_SYNC §7.5; OWASP CSRF Prevention Cheat
//! Sheet: Fetch Metadata, Origin verification, custom request header).
//!
//! Applies to unsafe methods (everything except GET/HEAD/OPTIONS) of requests that carry
//! the session cookie and do **not** authenticate with `Authorization: Bearer` (a
//! cross-site page cannot set that header without a CORS preflight, and the server allows
//! no CORS), plus `POST /session` (login CSRF). `POST /devices` from the desktop/native
//! clients sets no cookie and is not affected (`auth::csrf_guard` decides).
//!
//! 1. `Sec-Fetch-Site` present: only `same-origin` (and `none`, a user-initiated request)
//!    pass. Stricter than the plan (which only names `cross-site`): `same-site` is rejected
//!    too, because the PWA is always served from the same origin, and a sibling subdomain
//!    must not be able to write.
//! 2. `Sec-Fetch-Site` missing (older browsers): `Origin` must equal `BUDDY_PUBLIC_URL`.
//! 3. `X-Buddy-Request: 1` is required.

use axum::http::{HeaderMap, Method, header};

use crate::error::AppError;

pub const CUSTOM_HEADER: &str = "x-buddy-request";

pub fn is_unsafe(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub fn has_bearer(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.len() > 7 && v[..7].eq_ignore_ascii_case("bearer ") && !v[7..].trim().is_empty()
        })
}

/// `Ok` if the request may proceed.
pub fn check(method: &Method, headers: &HeaderMap, public_origin: &str) -> Result<(), AppError> {
    if !is_unsafe(method) || has_bearer(headers) {
        return Ok(());
    }
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    match text("sec-fetch-site") {
        Some(site) => {
            if !matches!(
                site.trim().to_ascii_lowercase().as_str(),
                "same-origin" | "none"
            ) {
                return Err(AppError::forbidden("cross-site request rejected"));
            }
        }
        None => {
            let ok = text("origin").is_some_and(|o| {
                o.trim()
                    .trim_end_matches('/')
                    .eq_ignore_ascii_case(public_origin)
            });
            if !ok {
                return Err(AppError::forbidden("origin not allowed"));
            }
        }
    }
    if text(CUSTOM_HEADER).map(str::trim) != Some("1") {
        return Err(AppError::forbidden("missing X-Buddy-Request header"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const ORIGIN: &str = "https://buddy.example.org";

    fn headers(list: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in list {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    #[test]
    fn rules() {
        let post = Method::POST;
        let ok = |h: &[(&'static str, &'static str)]| check(&post, &headers(h), ORIGIN).is_ok();
        assert!(ok(&[
            ("sec-fetch-site", "same-origin"),
            ("x-buddy-request", "1")
        ]));
        assert!(!ok(&[
            ("sec-fetch-site", "cross-site"),
            ("x-buddy-request", "1")
        ]));
        assert!(!ok(&[
            ("sec-fetch-site", "same-site"),
            ("x-buddy-request", "1")
        ]));
        assert!(!ok(&[("sec-fetch-site", "same-origin")]));
        assert!(ok(&[
            ("origin", "https://buddy.example.org"),
            ("x-buddy-request", "1")
        ]));
        assert!(!ok(&[
            ("origin", "https://evil.example"),
            ("x-buddy-request", "1")
        ]));
        assert!(!ok(&[("x-buddy-request", "1")]));
        // bearer requests and safe methods are exempt
        assert!(ok(&[
            ("authorization", "Bearer abc"),
            ("sec-fetch-site", "cross-site")
        ]));
        assert!(!ok(&[
            ("authorization", "Bearer "),
            ("sec-fetch-site", "cross-site")
        ]));
        assert!(
            check(
                &Method::GET,
                &headers(&[("sec-fetch-site", "cross-site")]),
                ORIGIN
            )
            .is_ok()
        );
        assert!(check(&Method::DELETE, &headers(&[]), ORIGIN).is_err());
    }
}
