//! Web Push sender (RFC 8030/8291/8292) on top of `web-push` 0.11 without its HTTP client.
//!
//! Sources: `web-push` 0.11 `clients/request_builder.rs` (`build_request`, also the
//! response mapping of `parse_response`), `vapid/builder.rs` / `vapid/signer.rs`
//! (JWT claims `aud`, `exp`, `sub`); Apple „Sending web push notifications in web apps and
//! browsers“ (headers TTL/Urgency/Topic, `aes128gcm`, 4 KB, JWT ≤ 1 day, `sub` = mailto
//! or https URL, status codes); MDN Push API.
//!
//! - The request is built by `web_push::request_builder::build_request` (TTL, Urgency,
//!   Topic, `Content-Encoding: aes128gcm`, `Authorization: vapid t=…, k=…`) and sent with
//!   reqwest (rustls, ring provider, no redirects).
//! - VAPID: one JWT per push-service origin (`aud`), valid 12 h (≤ 24 h), reused and
//!   re-signed at most once per hour ([`TOKEN_REUSE`]).
//! - Responses: 2xx → delivered, 404/410 → subscription gone, 413 → too large,
//!   429/5xx/network → retry (honouring `Retry-After`), 401/403 → VAPID token dropped and
//!   retried, other 4xx → permanent failure.
//!
//! Endpoints are never logged (they are capabilities).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use web_push::{
    ContentEncoding, SubscriptionInfo, Urgency, VapidSignature, VapidSignatureBuilder,
    WebPushMessageBuilder,
};

use crate::vapid::Vapid;

/// `TTL` header: 24 h (the push service keeps the message while the device is offline).
pub const TTL_SECS: u32 = 86_400;
/// Validity of a VAPID JWT (Apple: at most one day).
pub const TOKEN_VALIDITY: Duration = Duration::hours(12);
/// A JWT is reused this long, i.e. re-signed at most hourly.
pub const TOKEN_REUSE: Duration = Duration::hours(1);
/// Upper bound for a push service's `Retry-After`.
pub const MAX_RETRY_AFTER: StdDuration = StdDuration::from_secs(600);

/// One Web Push subscription (`PushSubscription.toJSON()`).
#[derive(Clone, PartialEq, Eq)]
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Subscription { .. }")
    }
}

/// Result of one send attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    Delivered,
    /// 404/410: the subscription no longer exists.
    Gone,
    /// 413: payload too large.
    TooLarge,
    /// 429, 5xx, 401/403 (after dropping the token) or a network error.
    Retry {
        after: Option<StdDuration>,
    },
    /// Anything else (bad keys, 400, …); retrying would not help.
    Failed(String),
}

#[derive(Clone)]
struct CachedToken {
    signature: VapidSignature,
    signed_at: DateTime<Utc>,
}

/// Sends encrypted Web Push messages.
pub struct WebPushSender {
    client: reqwest::Client,
    vapid: Arc<Vapid>,
    subject: String,
    tokens: Mutex<HashMap<String, CachedToken>>,
}

/// `scheme://host[:port]` of an endpoint (VAPID `aud`, RFC 8292 §2).
pub fn audience(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    // `port()` is `None` for the scheme's default port.
    Some(match url.port() {
        Some(p) => format!("{}://{host}:{p}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<StdDuration> {
    let v = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: u64 = v.trim().parse().ok()?;
    Some(StdDuration::from_secs(secs).min(MAX_RETRY_AFTER))
}

/// Maps a push-service status (RFC 8030 §5, Apple's table) to an outcome.
pub fn classify(status: u16, retry: Option<StdDuration>) -> SendOutcome {
    match status {
        200..=299 => SendOutcome::Delivered,
        404 | 410 => SendOutcome::Gone,
        413 => SendOutcome::TooLarge,
        429 | 500..=599 => SendOutcome::Retry { after: retry },
        // 401/403: VAPID token rejected (e.g. expired); the caller drops it and retries
        401 | 403 => SendOutcome::Retry { after: None },
        s => SendOutcome::Failed(format!("push service answered {s}")),
    }
}

impl WebPushSender {
    pub fn new(client: reqwest::Client, vapid: Arc<Vapid>, subject: String) -> Self {
        Self {
            client,
            vapid,
            subject,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    /// The JWT for `aud`, from the cache unless older than [`TOKEN_REUSE`].
    fn signature(
        &self,
        info: &SubscriptionInfo,
        aud: &str,
        now: DateTime<Utc>,
    ) -> Result<VapidSignature, String> {
        let mut cache = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = cache.get(aud)
            && now >= t.signed_at
            && now - t.signed_at < TOKEN_REUSE
        {
            return Ok(t.signature.clone());
        }
        let mut b = VapidSignatureBuilder::from_pem(self.vapid.private_pem().as_bytes(), info)
            .map_err(|e| format!("VAPID key: {e:?}"))?;
        let exp = u64::try_from((now + TOKEN_VALIDITY).timestamp()).unwrap_or(0);
        b.add_claim("aud", aud);
        b.add_claim("exp", exp);
        b.add_claim("sub", self.subject.as_str());
        let signature = b.build().map_err(|e| format!("VAPID signature: {e:?}"))?;
        cache.insert(
            aud.to_string(),
            CachedToken {
                signature: signature.clone(),
                signed_at: now,
            },
        );
        Ok(signature)
    }

    fn drop_token(&self, aud: &str) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(aud);
    }

    /// Number of cached tokens (tests).
    pub fn cached_tokens(&self) -> usize {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// One attempt: encrypt `payload` for `sub` and POST it.
    pub async fn send(
        &self,
        sub: &Subscription,
        payload: &[u8],
        topic: Option<&str>,
        now: DateTime<Utc>,
    ) -> SendOutcome {
        let info = SubscriptionInfo::new(
            sub.endpoint.as_str(),
            sub.p256dh.as_str(),
            sub.auth.as_str(),
        );
        let Some(aud) = audience(&sub.endpoint) else {
            return SendOutcome::Failed("invalid endpoint".into());
        };
        let signature = match self.signature(&info, &aud, now) {
            Ok(s) => s,
            Err(e) => return SendOutcome::Failed(e),
        };
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_ttl(TTL_SECS);
        builder.set_urgency(Urgency::High);
        if let Some(t) = topic {
            builder.set_topic(t.to_string());
        }
        builder.set_payload(ContentEncoding::Aes128Gcm, payload);
        builder.set_vapid_signature(signature);
        let message = match builder.build() {
            Ok(m) => m,
            Err(web_push::WebPushError::PayloadTooLarge) => return SendOutcome::TooLarge,
            Err(e) => return SendOutcome::Failed(format!("building message: {e:?}")),
        };
        let request = web_push::request_builder::build_request::<Vec<u8>>(message);
        // http 0.2 (web-push) → reqwest (http 1); reqwest sets Content-Length itself.
        let mut out = self.client.post(sub.endpoint.as_str());
        for (name, value) in request.headers() {
            if name.as_str().eq_ignore_ascii_case("content-length") {
                continue;
            }
            out = out.header(name.as_str(), value.as_bytes());
        }
        let res = match out.body(request.into_body()).send().await {
            Ok(r) => r,
            Err(e) => {
                // reqwest errors carry the URL; log only the kind.
                tracing::warn!(
                    timeout = e.is_timeout(),
                    connect = e.is_connect(),
                    "web push request failed"
                );
                return SendOutcome::Retry { after: None };
            }
        };
        let status = res.status().as_u16();
        let outcome = classify(status, retry_after(res.headers()));
        if matches!(status, 401 | 403) {
            self.drop_token(&aud);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn sender() -> (WebPushSender, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vapid.pem");
        crate::vapid::generate(&path, false).unwrap();
        let vapid = Arc::new(Vapid::load(&path, None).unwrap());
        let client = crate::push::http_client(false).unwrap();
        (
            WebPushSender::new(client, vapid, "mailto:admin@example.org".into()),
            dir,
        )
    }

    fn info() -> SubscriptionInfo {
        // RFC 8291 §5 example receiver key and auth secret
        SubscriptionInfo::new(
            "https://web.push.apple.com/QGuQyavXutnMH8",
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
        )
    }

    /// `vapid generate` writes PKCS#8 (`BEGIN PRIVATE KEY`); web-push 0.11 must read it
    /// (`VapidSignatureBuilder::read_pem` → `ES256KeyPair::from_pem`) and sign with the
    /// same key the PWA gets as `applicationServerKey`.
    #[test]
    fn web_push_reads_the_pkcs8_pem_of_vapid_generate() {
        let (s, _dir) = sender();
        assert!(s.vapid.private_pem().contains("BEGIN PRIVATE KEY"));
        let now = Utc::now();
        let sig = s
            .signature(&info(), "https://web.push.apple.com", now)
            .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(&sig.auth_k), s.vapid.public_key());
        // the JWT carries our aud/exp/sub
        let claims = sig.auth_t.split('.').nth(1).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["sub"], "mailto:admin@example.org");
        let exp = claims["exp"].as_i64().unwrap();
        assert_eq!(exp, (now + TOKEN_VALIDITY).timestamp());
        assert!(exp - now.timestamp() <= 24 * 3600);
    }

    #[test]
    fn tokens_are_reused_for_an_hour_per_audience() {
        let (s, _dir) = sender();
        let t0 = buddy_core::zoned::parse_instant("2026-11-06T10:00:00Z").unwrap();
        let a = s.signature(&info(), "https://a.example", t0).unwrap();
        let b = s
            .signature(&info(), "https://a.example", t0 + Duration::minutes(59))
            .unwrap();
        assert_eq!(a, b, "reused within the hour");
        let other = s.signature(&info(), "https://b.example", t0).unwrap();
        assert_ne!(a.auth_t, other.auth_t, "one token per push service");
        assert_eq!(s.cached_tokens(), 2);
        let c = s
            .signature(&info(), "https://a.example", t0 + Duration::minutes(60))
            .unwrap();
        assert_ne!(a.auth_t, c.auth_t, "re-signed after an hour");
        // clock jumped back: re-sign instead of trusting a token from the "future"
        let d = s
            .signature(&info(), "https://a.example", t0 - Duration::minutes(5))
            .unwrap();
        assert_ne!(c.auth_t, d.auth_t);
        s.drop_token("https://a.example");
        assert_eq!(s.cached_tokens(), 1);
    }

    #[test]
    fn audiences_are_origins() {
        assert_eq!(
            audience("https://web.push.apple.com/QGuQ").as_deref(),
            Some("https://web.push.apple.com")
        );
        assert_eq!(
            audience("https://fcm.googleapis.com:443/fcm/send/x").as_deref(),
            Some("https://fcm.googleapis.com")
        );
        assert_eq!(
            audience("http://127.0.0.1:4567/push/1").as_deref(),
            Some("http://127.0.0.1:4567")
        );
        assert_eq!(audience("not a url"), None);
    }

    #[test]
    fn status_mapping() {
        assert_eq!(classify(201, None), SendOutcome::Delivered);
        assert_eq!(classify(404, None), SendOutcome::Gone);
        assert_eq!(classify(410, None), SendOutcome::Gone);
        assert_eq!(classify(413, None), SendOutcome::TooLarge);
        let after = Some(StdDuration::from_secs(7));
        assert_eq!(classify(429, after), SendOutcome::Retry { after });
        assert_eq!(classify(503, None), SendOutcome::Retry { after: None });
        assert_eq!(classify(403, None), SendOutcome::Retry { after: None });
        assert!(matches!(classify(400, None), SendOutcome::Failed(_)));
    }

    #[test]
    fn retry_after_is_capped() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::RETRY_AFTER, "99999".parse().unwrap());
        assert_eq!(retry_after(&h), Some(MAX_RETRY_AFTER));
        h.insert(reqwest::header::RETRY_AFTER, "3".parse().unwrap());
        assert_eq!(retry_after(&h), Some(StdDuration::from_secs(3)));
        h.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&h), None);
    }
}
