//! Push delivery (PLAN_V3_SYNC §6, §7.4): Web Push for the PWA, a native channel trait for
//! the mobile shell (FCM in phase N2), and the endpoints
//! `PUT/DELETE /push/subscription` (session cookie) and `POST /push/test` (both auth kinds).
//!
//! Endpoint hardening (the server POSTs to URLs supplied by clients): only `https://` with
//! a DNS host name (no IP literals, no `localhost`, no credentials), at most 2048 bytes,
//! keys must be a valid P-256 point and a 16-byte secret; no redirects are followed.
//! Tests may allow plain `http://` on loopback ([`PushOptions::allow_insecure_endpoints`]).

pub mod dispatch;
pub mod native;
pub mod payload;
pub mod webpush;

use std::sync::Arc;
use std::time::Duration as StdDuration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{post, put};
use axum::{Router, middleware};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use buddy_core::sync::{PushSubscription, error_codes};
use buddy_core::zoned::format_utc;

use crate::AppState;
use crate::api::ApiJson;
use crate::auth::{self, Auth, Via};
use crate::config::Config;
use crate::error::{ApiResult, AppError};
use crate::vapid::Vapid;
use dispatch::{Content, Delivery, MaxRetries, RETRY_DELAYS, SharedNative, Target};
use native::NoopNativeChannel;
use webpush::{Subscription, WebPushSender};

pub const MAX_ENDPOINT: usize = 2048;
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(30);
const CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(10);

/// Construction options (tests override them).
pub struct PushOptions {
    /// Accept `http://` endpoints on loopback addresses and bypass proxies for them
    /// (local fake push service in tests). Never in production.
    pub allow_insecure_endpoints: bool,
    pub retry_delays: [StdDuration; 3],
    pub native: SharedNative,
}

impl Default for PushOptions {
    fn default() -> Self {
        Self {
            allow_insecure_endpoints: false,
            retry_delays: RETRY_DELAYS,
            native: Arc::new(NoopNativeChannel),
        }
    }
}

/// Push channels of the server (part of [`AppState`]).
pub struct PushService {
    /// `None` without VAPID key.
    pub web: Option<WebPushSender>,
    pub native: SharedNative,
    pub allow_insecure_endpoints: bool,
    pub retry_delays: [StdDuration; 3],
}

/// HTTP client for push services: rustls with the ring provider (D-52, no aws-lc/cmake),
/// platform/system root certificates, no redirects, timeouts.
pub fn http_client(allow_insecure_endpoints: bool) -> anyhow::Result<reqwest::Client> {
    // Ok(()) or "already installed" – both fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("buddy-server/", env!("CARGO_PKG_VERSION")));
    if allow_insecure_endpoints {
        // only the local fake push service (loopback) is reached this way
        b = b.no_proxy();
    } else {
        b = b.https_only(true);
    }
    Ok(b.build()?)
}

impl PushService {
    pub fn new(config: &Config, vapid: Option<Arc<Vapid>>) -> Self {
        Self::with_options(config, vapid, PushOptions::default())
    }

    /// VAPID `sub`: `BUDDY_VAPID_SUBJECT`, else the public URL (Apple: mailto: or https).
    pub fn with_options(config: &Config, vapid: Option<Arc<Vapid>>, opts: PushOptions) -> Self {
        let web = vapid.and_then(|v| {
            let subject = v
                .subject
                .clone()
                .or_else(|| config.vapid_subject.clone())
                .unwrap_or_else(|| config.public_origin.clone());
            match http_client(opts.allow_insecure_endpoints) {
                Ok(client) => Some(WebPushSender::new(client, v, subject)),
                Err(e) => {
                    tracing::error!(error = %e, "building the push HTTP client failed; web push disabled");
                    None
                }
            }
        });
        Self {
            web,
            native: opts.native,
            allow_insecure_endpoints: opts.allow_insecure_endpoints,
            retry_delays: opts.retry_delays,
        }
    }
}

/// Routes below `/api/v1` (merged in `build_app`).
pub fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/push/subscription",
            put(put_subscription).delete(delete_subscription),
        )
        .route("/push/test", post(push_test))
        .layer(middleware::from_fn_with_state(state, auth::extend_session))
}

fn decode_b64url(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim().trim_end_matches('=')).ok()
}

/// Checks a `PushSubscription.toJSON()` and normalises the keys (no padding).
pub fn validate_subscription(
    sub: &PushSubscription,
    allow_insecure: bool,
) -> Result<Subscription, &'static str> {
    let endpoint = sub.endpoint.trim();
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT {
        return Err("endpoint must have 1–2048 characters");
    }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "endpoint is not a URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("endpoint must not contain credentials or a fragment");
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let ip: Option<std::net::IpAddr> = host.trim_matches(['[', ']']).parse().ok();
    let loopback_http =
        allow_insecure && url.scheme() == "http" && ip.is_some_and(|i| i.is_loopback());
    if !loopback_http {
        if url.scheme() != "https" {
            return Err("endpoint must use https");
        }
        let domain_ok = ip.is_none()
            && host.contains('.')
            && !host.ends_with('.')
            && !host.ends_with("localhost");
        if !domain_ok {
            return Err("endpoint must name a push service host");
        }
    }
    let p256dh = decode_b64url(&sub.keys.p256dh).ok_or("keys.p256dh is not base64url")?;
    if p256dh.len() != 65 || p256::PublicKey::from_sec1_bytes(&p256dh).is_err() {
        return Err("keys.p256dh is not an uncompressed P-256 point");
    }
    let auth = decode_b64url(&sub.keys.auth).ok_or("keys.auth is not base64url")?;
    if auth.len() != 16 {
        return Err("keys.auth must be 16 bytes");
    }
    Ok(Subscription {
        endpoint: endpoint.to_string(),
        p256dh: URL_SAFE_NO_PAD.encode(&p256dh),
        auth: URL_SAFE_NO_PAD.encode(&auth),
    })
}

fn require_session(auth: &Auth) -> ApiResult<()> {
    if matches!(auth.via, Via::Session { .. }) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "the web push subscription belongs to the web app (session cookie)",
        ))
    }
}

async fn put_subscription(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(body): ApiJson<PushSubscription>,
) -> ApiResult<StatusCode> {
    require_session(&auth)?;
    if state.push.web.is_none() {
        return Err(AppError::not_found(
            "web push is not configured on this server",
        ));
    }
    let sub = validate_subscription(&body, state.push.allow_insecure_endpoints)
        .map_err(AppError::bad_request)?;
    let now = format_utc(&state.clock.now());
    let mut tx = state.db.begin_with(crate::db::BEGIN_WRITE).await?;
    // One browser = one subscription: an endpoint moves to the device that registers it.
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id <> ?")
        .bind(&sub.endpoint)
        .bind(&auth.device_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at, last_success_at, failures) \
         VALUES (?, ?, ?, ?, ?, NULL, 0) \
         ON CONFLICT (device_id) DO UPDATE SET \
           last_success_at = CASE WHEN push_subscriptions.endpoint = excluded.endpoint \
                                  THEN push_subscriptions.last_success_at END, \
           failures = CASE WHEN push_subscriptions.endpoint = excluded.endpoint \
                           THEN push_subscriptions.failures ELSE 0 END, \
           created_at = CASE WHEN push_subscriptions.endpoint = excluded.endpoint \
                             THEN push_subscriptions.created_at ELSE excluded.created_at END, \
           endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth",
    )
    .bind(&auth.device_id)
    .bind(&sub.endpoint)
    .bind(&sub.p256dh)
    .bind(&sub.auth)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(device = %auth.device_id, "web push subscription stored");
    // Due occurrences of the last 24 h reach the new subscription too.
    state.reminders_changed.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

/// Optional body of `DELETE /push/subscription` (PWA: `{"endpoint": "..."}`).
#[derive(serde::Deserialize)]
struct DeleteSubscription {
    #[serde(default)]
    endpoint: Option<String>,
}

/// `DELETE /push/subscription`: with `{"endpoint"}` only that subscription of the calling
/// device is removed (a stale endpoint after a re-subscribe leaves the new one alone);
/// without a body (or without `endpoint`) the calling device's subscription.
async fn delete_subscription(
    State(state): State<AppState>,
    auth: Auth,
    body: axum::body::Bytes,
) -> ApiResult<StatusCode> {
    require_session(&auth)?;
    let endpoint = if body.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        serde_json::from_slice::<DeleteSubscription>(&body)
            .map_err(|_| AppError::bad_request("body must be {\"endpoint\": \"...\"} or empty"))?
            .endpoint
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
    };
    match endpoint {
        Some(e) => {
            sqlx::query("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?")
                .bind(&auth.device_id)
                .bind(e)
                .execute(&state.db)
                .await?
        }
        None => {
            sqlx::query("DELETE FROM push_subscriptions WHERE device_id = ?")
                .bind(&auth.device_id)
                .execute(&state.db)
                .await?
        }
    };
    tracing::info!(device = %auth.device_id, "web push subscription removed");
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /push/test`: one test notification to the calling device, answered after one
/// attempt (no retries, no `push_log`).
async fn push_test(State(state): State<AppState>, auth: Auth) -> ApiResult<StatusCode> {
    use buddy_core::sync::DeviceKind;
    if auth.kind == DeviceKind::Desktop {
        return Err(AppError::bad_request(
            "desktop devices show local notifications; there is no push channel",
        ));
    }
    if auth.kind == DeviceKind::Web && state.push.web.is_none() {
        return Err(AppError::not_found(
            "web push is not configured on this server",
        ));
    }
    let Some(target) = dispatch::target_of(&state, &auth.device_id).await? else {
        return Err(AppError::not_found(match auth.kind {
            DeviceKind::Web => "no push subscription for this device",
            _ => "no native push channel for this device",
        }));
    };
    let (result, _) = dispatch::deliver(
        &state,
        &auth.device_id,
        &target,
        &Content::Test,
        MaxRetries::None,
    )
    .await;
    match result {
        Delivery::Sent => Ok(StatusCode::NO_CONTENT),
        Delivery::Gone => Err(AppError::not_found(match target {
            Target::Web(_) => "push subscription expired; subscribe again",
            Target::Native { .. } => "push token expired; register again",
        })),
        Delivery::Unavailable => Err(AppError::not_found("push is not configured")),
        Delivery::Failed => Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            error_codes::INTERNAL,
            "the push service did not accept the message",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buddy_core::sync::PushSubscriptionKeys;

    // RFC 8291 §5 example keys (receiver public key and auth secret).
    const P256DH: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

    fn sub(endpoint: &str, p256dh: &str, auth: &str) -> PushSubscription {
        PushSubscription {
            endpoint: endpoint.into(),
            keys: PushSubscriptionKeys {
                p256dh: p256dh.into(),
                auth: auth.into(),
            },
        }
    }

    #[test]
    fn accepts_real_push_services() {
        for e in [
            "https://web.push.apple.com/QGuQyavXutnMH8",
            "https://fcm.googleapis.com/fcm/send/eKClHsXFm9E:APA91",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
        ] {
            let s = validate_subscription(&sub(e, P256DH, AUTH), false).unwrap();
            assert_eq!(s.endpoint, e);
        }
        // padded keys are normalised
        let s = validate_subscription(
            &sub(
                "https://web.push.apple.com/x",
                P256DH,
                "BTBZMqHH6r4Tts7J_aSIgg==",
            ),
            false,
        )
        .unwrap();
        assert_eq!(s.auth, AUTH);
    }

    #[test]
    fn rejects_dangerous_endpoints_and_bad_keys() {
        let bad = [
            "http://web.push.apple.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://localhost/x",
            "https://intranet/x",
            "https://user:pw@web.push.apple.com/x",
            "file:///etc/passwd",
            "not a url",
        ];
        for e in bad {
            assert!(
                validate_subscription(&sub(e, P256DH, AUTH), false).is_err(),
                "{e}"
            );
        }
        let long = format!("https://web.push.apple.com/{}", "a".repeat(MAX_ENDPOINT));
        assert!(validate_subscription(&sub(&long, P256DH, AUTH), false).is_err());
        let ok = "https://web.push.apple.com/x";
        assert!(validate_subscription(&sub(ok, "AAAA", AUTH), false).is_err());
        // 65 bytes but not on the curve
        let off_curve = URL_SAFE_NO_PAD.encode([4u8; 65]);
        assert!(validate_subscription(&sub(ok, &off_curve, AUTH), false).is_err());
        assert!(validate_subscription(&sub(ok, P256DH, "AAAA"), false).is_err());
        assert!(validate_subscription(&sub(ok, P256DH, "!!"), false).is_err());
    }

    #[test]
    fn loopback_http_only_when_allowed() {
        let e = "http://127.0.0.1:4000/push/1";
        assert!(validate_subscription(&sub(e, P256DH, AUTH), false).is_err());
        assert!(validate_subscription(&sub(e, P256DH, AUTH), true).is_ok());
        assert!(validate_subscription(&sub("http://10.0.0.1/x", P256DH, AUTH), true).is_err());
    }
}
