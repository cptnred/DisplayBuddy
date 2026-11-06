//! FCM HTTP v1 channel for the Android shell (PLAN_V3_SYNC §7.4, §10.5; D-55: Android only,
//! no APNs).
//!
//! Sources (Firebase documentation):
//! - „Authorize send requests“: OAuth 2.0 access token for the scope
//!   `https://www.googleapis.com/auth/firebase.messaging`, obtained from a service account.
//!   The token is fetched with the JWT bearer grant (RFC 7523) as described in Google's
//!   „Using OAuth 2.0 for Server to Server Applications“: a JWT signed with RS256 by the
//!   service account key, claims `iss` = `client_email`, `scope`, `aud` = `token_uri`,
//!   `iat`, `exp` ≤ 1 h; POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&
//!   assertion=<jwt>` to `token_uri`. Access tokens are reused until shortly before expiry.
//! - „Build app server send requests“ / REST reference `projects.messages.send`:
//!   `POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send` with
//!   `{"message": {"token", "notification", "data", "android"}}`; `data` values are strings;
//!   `android.ttl` as duration string, `android.priority` `HIGH`, `android.collapse_key`,
//!   `android.notification.channel_id` / `tag`.
//! - „Best practices for FCM registration token management“ + `ErrorCode` reference:
//!   `UNREGISTERED` (404) and `INVALID_ARGUMENT` (400) mean the token is invalid → delete it;
//!   `QUOTA_EXCEEDED` (429), `UNAVAILABLE` (503), `INTERNAL` (500) → retry with back-off;
//!   `SENDER_ID_MISMATCH` (403) → the token belongs to another Firebase project (never
//!   deliverable with this key) → delete; `THIRD_PARTY_AUTH_ERROR` is APNs-only.
//!
//! The RSA signature uses `ring` (already in the tree through rustls, D-52); the private
//! key is the PKCS#8 PEM `private_key` of the service account JSON. Logs never contain the
//! device token, the access token or the key.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use buddy_core::sync::{NativePushPlatform, ReminderPushPayload};
use chrono::{DateTime, Duration, Utc};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::clock::Clock;
use crate::push::native::{BoxFuture, NativeOutcome, NativePushChannel};
use crate::push::payload::topic;

/// OAuth scope for FCM HTTP v1.
pub const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Production FCM endpoint.
pub const FCM_BASE: &str = "https://fcm.googleapis.com";
/// Google's OAuth token endpoint (the `token_uri` of every service account file).
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
/// Android notification channel created by the shell (`CHANNEL_ID` in
/// `src/web/notify/native-plan.ts`).
pub const ANDROID_CHANNEL: &str = "reminders";
/// Same TTL as Web Push (§7.4): FCM keeps the message while the phone is offline.
const TTL: &str = "86400s";
/// Lifetime of the signed assertion (Google: at most one hour).
const ASSERTION_LIFETIME: i64 = 3600;
/// Access tokens are renewed this long before they expire.
const TOKEN_MARGIN: i64 = 300;
/// Longest accepted device token (FCM tokens are ~160 characters).
pub const MAX_TOKEN: usize = 4096;

/// Fields of a Google service account key file that the channel needs.
#[derive(Deserialize, Clone)]
pub struct ServiceAccount {
    #[serde(rename = "type")]
    pub kind: String,
    pub project_id: String,
    pub private_key_id: String,
    pub private_key: String,
    pub client_email: String,
    #[serde(default)]
    pub token_uri: Option<String>,
}

impl std::fmt::Debug for ServiceAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never print the key
        f.debug_struct("ServiceAccount")
            .field("project_id", &self.project_id)
            .field("client_email", &self.client_email)
            .finish_non_exhaustive()
    }
}

impl ServiceAccount {
    pub fn parse(json: &str) -> Result<Self> {
        let sa: ServiceAccount = serde_json::from_str(json)
            .context("the FCM service account file is not a service account key (JSON)")?;
        if sa.kind != "service_account" {
            bail!("the FCM credentials file must have \"type\": \"service_account\"");
        }
        let project_ok = !sa.project_id.is_empty()
            && sa
                .project_id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !project_ok {
            bail!("project_id of the FCM service account is invalid");
        }
        if sa.client_email.is_empty() {
            bail!("client_email of the FCM service account is missing");
        }
        Ok(sa)
    }

    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| {
            format!("reading BUDDY_FCM_SERVICE_ACCOUNT_FILE {}", path.display())
        })?;
        Self::parse(&text)
    }
}

/// Where the channel talks to (tests: a local fake for both).
#[derive(Debug, Clone)]
pub struct FcmEndpoints {
    /// OAuth token endpoint.
    pub token_uri: String,
    /// FCM base URL without trailing slash.
    pub fcm_base: String,
}

impl FcmEndpoints {
    /// Production endpoints; the service account's `token_uri` must be Google's.
    pub fn production(sa: &ServiceAccount) -> Result<Self> {
        let token_uri = sa
            .token_uri
            .clone()
            .unwrap_or_else(|| GOOGLE_TOKEN_URI.into());
        if token_uri != GOOGLE_TOKEN_URI {
            bail!("token_uri of the FCM service account must be {GOOGLE_TOKEN_URI}");
        }
        Ok(Self {
            token_uri,
            fcm_base: FCM_BASE.into(),
        })
    }
}

/// Decodes a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) into DER.
fn pem_pkcs8(pem: &str) -> Result<Vec<u8>> {
    let pem = pem.replace("\\n", "\n");
    let body: String = pem
        .lines()
        .map(str::trim)
        .skip_while(|l| *l != "-----BEGIN PRIVATE KEY-----")
        .skip(1)
        .take_while(|l| *l != "-----END PRIVATE KEY-----")
        .collect();
    if body.is_empty() {
        bail!("private_key of the FCM service account is not a PKCS#8 PEM key");
    }
    STANDARD
        .decode(body)
        .context("private_key of the FCM service account is not valid base64")
}

struct CachedToken {
    value: String,
    valid_until: DateTime<Utc>,
}

/// FCM HTTP v1 sender (implements [`NativePushChannel`] for [`NativePushPlatform::Fcm`]).
pub struct FcmChannel {
    client: reqwest::Client,
    key: RsaKeyPair,
    rng: SystemRandom,
    account: ServiceAccount,
    endpoints: FcmEndpoints,
    clock: Arc<dyn Clock>,
    token: Mutex<Option<CachedToken>>,
}

/// Why an access token could not be obtained.
#[derive(Debug, PartialEq, Eq)]
enum TokenError {
    /// Network / 5xx / 429: try again later.
    Transient,
    /// Rejected credentials (4xx): needs the administrator.
    Rejected(String),
}

impl FcmChannel {
    pub fn new(
        account: ServiceAccount,
        endpoints: FcmEndpoints,
        client: reqwest::Client,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let der = pem_pkcs8(&account.private_key)?;
        let key = RsaKeyPair::from_pkcs8(&der)
            .map_err(|e| anyhow::anyhow!("private_key of the FCM service account: {e}"))?;
        Ok(Self {
            client,
            key,
            rng: SystemRandom::new(),
            account,
            endpoints,
            clock,
            token: Mutex::new(None),
        })
    }

    /// Production channel from `BUDDY_FCM_SERVICE_ACCOUNT_FILE`.
    pub fn from_file(path: &Path, clock: Arc<dyn Clock>) -> Result<Self> {
        let account = ServiceAccount::load(path)?;
        let endpoints = FcmEndpoints::production(&account)?;
        let client = crate::push::http_client(false)?;
        let channel = Self::new(account, endpoints, client, clock)?;
        tracing::info!(project = %channel.account.project_id, "native push via FCM HTTP v1 enabled");
        Ok(channel)
    }

    /// The signed JWT bearer assertion (RS256) for `now`.
    pub fn assertion(&self, now: DateTime<Utc>) -> Result<String> {
        let header = json!({"alg": "RS256", "typ": "JWT", "kid": self.account.private_key_id});
        let iat = now.timestamp();
        let claims = json!({
            "iss": self.account.client_email,
            "scope": FCM_SCOPE,
            "aud": self.endpoints.token_uri,
            "iat": iat,
            "exp": iat + ASSERTION_LIFETIME,
        });
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?)
        );
        let mut sig = vec![0u8; self.key.public().modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &self.rng,
                signing_input.as_bytes(),
                &mut sig,
            )
            .map_err(|_| anyhow::anyhow!("RSA signing failed"))?;
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig)))
    }

    async fn access_token(&self) -> Result<String, TokenError> {
        let now = self.clock.now();
        let mut cached = self.token.lock().await;
        if let Some(t) = cached.as_ref()
            && t.valid_until > now
        {
            return Ok(t.value.clone());
        }
        let assertion = self
            .assertion(now)
            .map_err(|e| TokenError::Rejected(e.to_string()))?;
        let form = format!(
            "grant_type={}&assertion={}",
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer", assertion
        );
        let res = self
            .client
            .post(&self.endpoints.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|_| TokenError::Transient)?;
        let status = res.status();
        let body = json_body(res).await;
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(TokenError::Transient);
        }
        if !status.is_success() {
            let err = body["error"].as_str().unwrap_or("unknown");
            return Err(TokenError::Rejected(format!("oauth {status} {err}")));
        }
        let Some(value) = body["access_token"].as_str().filter(|s| !s.is_empty()) else {
            return Err(TokenError::Rejected(
                "oauth answer without access_token".into(),
            ));
        };
        let expires_in = body["expires_in"].as_i64().unwrap_or(3600);
        let keep = (expires_in - TOKEN_MARGIN).max(60);
        *cached = Some(CachedToken {
            value: value.to_string(),
            valid_until: now + Duration::seconds(keep),
        });
        Ok(value.to_string())
    }

    async fn forget_token(&self) {
        *self.token.lock().await = None;
    }

    async fn send_fcm(&self, token: &str, payload: &ReminderPushPayload) -> NativeOutcome {
        let access = match self.access_token().await {
            Ok(a) => a,
            Err(TokenError::Transient) => return NativeOutcome::Retry,
            Err(TokenError::Rejected(m)) => {
                tracing::error!(reason = %m, "FCM: no OAuth access token");
                return NativeOutcome::Failed(m);
            }
        };
        let url = format!(
            "{}/v1/projects/{}/messages:send",
            self.endpoints.fcm_base, self.account.project_id
        );
        let res = self
            .client
            .post(url)
            .bearer_auth(access)
            .header("content-type", "application/json; charset=UTF-8")
            .body(fcm_message(token, payload).to_string())
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(_) => return NativeOutcome::Retry,
        };
        let status = res.status().as_u16();
        let body = json_body(res).await;
        let outcome = classify(status, &body);
        if status == 401 && outcome == NativeOutcome::Retry {
            // expired/revoked access token: fetch a new one on the next attempt
            self.forget_token().await;
        }
        outcome
    }
}

impl NativePushChannel for FcmChannel {
    fn supports(&self, platform: NativePushPlatform) -> bool {
        platform == NativePushPlatform::Fcm
    }

    fn send<'a>(
        &'a self,
        platform: NativePushPlatform,
        token: &'a str,
        payload: &'a ReminderPushPayload,
    ) -> BoxFuture<'a, NativeOutcome> {
        Box::pin(async move {
            if platform != NativePushPlatform::Fcm {
                return NativeOutcome::Failed("only FCM is supported (D-55)".into());
            }
            self.send_fcm(token, payload).await
        })
    }
}

/// The `messages:send` body: a visible notification (title/body like Web Push) plus the
/// payload fields as `data` (strings). Reminder messages of one note share
/// `collapse_key` and `tag`, so an undelivered or shown older one is replaced.
pub fn fcm_message(token: &str, p: &ReminderPushPayload) -> Value {
    let mut data = serde_json::Map::new();
    data.insert("v".into(), Value::String(p.v.to_string()));
    data.insert("type".into(), Value::String(p.kind.clone()));
    data.insert("url".into(), Value::String(p.url.clone()));
    for (k, v) in [
        ("noteId", &p.note_id),
        ("at", &p.at),
        ("timeZone", &p.time_zone),
    ] {
        if let Some(v) = v {
            data.insert(k.into(), Value::String(v.clone()));
        }
    }
    let mut android_notification = json!({ "channel_id": ANDROID_CHANNEL });
    let mut android = json!({ "priority": "HIGH", "ttl": TTL });
    if let Some(id) = &p.note_id {
        let t = topic(id);
        android["collapse_key"] = Value::String(t.clone());
        android_notification["tag"] = Value::String(t);
    }
    android["notification"] = android_notification;
    json!({
        "message": {
            "token": token,
            "notification": { "title": p.title, "body": p.body },
            "data": data,
            "android": android,
        }
    })
}

/// Response body as JSON (`Null` if unreadable; error bodies are JSON per Google).
async fn json_body(res: reqwest::Response) -> Value {
    match res.bytes().await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// `FcmError.errorCode` of an error answer (`google.firebase.fcm.v1.FcmError` detail),
/// else the `google.rpc.Status.status`.
fn error_code(body: &Value) -> Option<&str> {
    let err = &body["error"];
    err["details"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|d| {
            d["@type"]
                .as_str()
                .is_some_and(|t| t.ends_with("google.firebase.fcm.v1.FcmError"))
        })
        .and_then(|d| d["errorCode"].as_str())
        .or_else(|| err["status"].as_str())
}

/// Fields named by a `google.rpc.BadRequest` detail.
fn violated_fields(body: &Value) -> Vec<&str> {
    body["error"]["details"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| {
            d["@type"]
                .as_str()
                .is_some_and(|t| t.ends_with("google.rpc.BadRequest"))
        })
        .flat_map(|d| d["fieldViolations"].as_array().into_iter().flatten())
        .filter_map(|v| v["field"].as_str())
        .collect()
}

/// Maps an FCM answer to the channel outcome (see the module docs for the sources).
pub fn classify(status: u16, body: &Value) -> NativeOutcome {
    if (200..300).contains(&status) {
        return NativeOutcome::Delivered;
    }
    let code = error_code(body).unwrap_or("");
    match (status, code) {
        (_, "UNREGISTERED") | (404, _) => NativeOutcome::TokenGone,
        (_, "SENDER_ID_MISMATCH") => NativeOutcome::TokenGone,
        (400, _) | (_, "INVALID_ARGUMENT") => {
            // Invalid token → delete. A violation of another field is our bug: keep the
            // token (otherwise one bad payload would wipe every device's registration).
            let fields = violated_fields(body);
            if fields.iter().all(|f| *f == "message.token") {
                NativeOutcome::TokenGone
            } else {
                NativeOutcome::Failed(format!("fcm 400 invalid field {}", fields.join(",")))
            }
        }
        (_, "THIRD_PARTY_AUTH_ERROR") => NativeOutcome::Failed("fcm third-party auth".into()),
        (401, _) => NativeOutcome::Retry,
        (429, _) | (500..=599, _) => NativeOutcome::Retry,
        (_, "QUOTA_EXCEEDED" | "UNAVAILABLE" | "INTERNAL") => NativeOutcome::Retry,
        _ => NativeOutcome::Failed(format!("fcm {status} {code}")),
    }
}

/// Valid FCM registration token: 1..=4096 characters of `[A-Za-z0-9_:.-]` (FCM tokens are
/// base64url with `:`; anything else would only be stored to fail later).
pub fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> ReminderPushPayload {
        crate::push::payload::test_payload()
    }

    fn reminder_payload() -> ReminderPushPayload {
        ReminderPushPayload {
            v: 1,
            kind: "reminder".into(),
            note_id: Some("0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f".into()),
            at: Some("2026-11-06T10:01:00.000Z".into()),
            time_zone: Some("Europe/Berlin".into()),
            title: "Erinnerung: Einkauf".into(),
            body: "Milch, Brot".into(),
            url: "/notes/0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f".into(),
        }
    }

    #[test]
    fn message_shape() {
        let m = fcm_message("tok", &reminder_payload());
        let msg = &m["message"];
        assert_eq!(msg["token"], "tok");
        assert_eq!(msg["notification"]["title"], "Erinnerung: Einkauf");
        assert_eq!(msg["notification"]["body"], "Milch, Brot");
        assert_eq!(
            msg["data"]["noteId"],
            "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f"
        );
        assert_eq!(msg["data"]["at"], "2026-11-06T10:01:00.000Z");
        assert_eq!(msg["data"]["timeZone"], "Europe/Berlin");
        assert_eq!(msg["data"]["type"], "reminder");
        assert_eq!(msg["data"]["v"], "1");
        // every data value is a string (FCM requirement)
        for v in msg["data"].as_object().unwrap().values() {
            assert!(v.is_string());
        }
        assert_eq!(msg["android"]["priority"], "HIGH");
        assert_eq!(msg["android"]["ttl"], "86400s");
        let t = topic("0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f");
        assert_eq!(msg["android"]["collapse_key"], t.as_str());
        assert_eq!(msg["android"]["notification"]["tag"], t.as_str());
        assert_eq!(msg["android"]["notification"]["channel_id"], "reminders");

        let test = fcm_message("tok", &payload());
        assert!(test["message"]["android"].get("collapse_key").is_none());
        assert!(test["message"]["data"].get("noteId").is_none());
        assert_eq!(test["message"]["data"]["type"], "test");
    }

    fn fcm_error(status: &str, code: Option<&str>, fields: &[&str]) -> Value {
        let mut details = vec![];
        if let Some(c) = code {
            details.push(json!({"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": c}));
        }
        if !fields.is_empty() {
            let v: Vec<Value> = fields
                .iter()
                .map(|f| json!({"field": f, "description": "x"}))
                .collect();
            details.push(
                json!({"@type": "type.googleapis.com/google.rpc.BadRequest", "fieldViolations": v}),
            );
        }
        json!({"error": {"code": 0, "message": "m", "status": status, "details": details}})
    }

    #[test]
    fn classification() {
        use NativeOutcome::*;
        assert_eq!(
            classify(200, &json!({"name": "projects/p/messages/1"})),
            Delivered
        );
        assert_eq!(
            classify(404, &fcm_error("NOT_FOUND", Some("UNREGISTERED"), &[])),
            TokenGone
        );
        assert_eq!(classify(404, &Value::Null), TokenGone);
        assert_eq!(
            classify(
                400,
                &fcm_error(
                    "INVALID_ARGUMENT",
                    Some("INVALID_ARGUMENT"),
                    &["message.token"]
                )
            ),
            TokenGone
        );
        assert_eq!(
            classify(
                400,
                &fcm_error("INVALID_ARGUMENT", Some("INVALID_ARGUMENT"), &[])
            ),
            TokenGone
        );
        assert!(matches!(
            classify(
                400,
                &fcm_error(
                    "INVALID_ARGUMENT",
                    Some("INVALID_ARGUMENT"),
                    &["message.android.ttl"]
                )
            ),
            Failed(_)
        ));
        assert_eq!(
            classify(
                403,
                &fcm_error("PERMISSION_DENIED", Some("SENDER_ID_MISMATCH"), &[])
            ),
            TokenGone
        );
        assert!(matches!(
            classify(403, &fcm_error("PERMISSION_DENIED", None, &[])),
            Failed(_)
        ));
        assert_eq!(
            classify(
                429,
                &fcm_error("RESOURCE_EXHAUSTED", Some("QUOTA_EXCEEDED"), &[])
            ),
            Retry
        );
        assert_eq!(
            classify(503, &fcm_error("UNAVAILABLE", Some("UNAVAILABLE"), &[])),
            Retry
        );
        assert_eq!(classify(500, &Value::Null), Retry);
        assert_eq!(
            classify(401, &fcm_error("UNAUTHENTICATED", None, &[])),
            Retry
        );
        assert!(matches!(
            classify(
                401,
                &fcm_error("UNAUTHENTICATED", Some("THIRD_PARTY_AUTH_ERROR"), &[])
            ),
            Failed(_)
        ));
    }

    #[test]
    fn tokens() {
        assert!(valid_token("eKClHsXFm9E:APA91bH_abc-DEF.123"));
        assert!(!valid_token(""));
        assert!(!valid_token("a b"));
        assert!(!valid_token("a\nb"));
        assert!(!valid_token("ä"));
        assert!(!valid_token(&"a".repeat(MAX_TOKEN + 1)));
    }

    #[test]
    fn service_account_validation() {
        let ok = json!({"type": "service_account", "project_id": "buddy-123",
            "private_key_id": "k1", "private_key": "x", "client_email": "a@b.iam.gserviceaccount.com",
            "token_uri": GOOGLE_TOKEN_URI});
        let sa = ServiceAccount::parse(&ok.to_string()).unwrap();
        assert!(!format!("{sa:?}").contains("private_key\""));
        assert_eq!(FcmEndpoints::production(&sa).unwrap().fcm_base, FCM_BASE);
        let mut bad = ok.clone();
        bad["type"] = json!("authorized_user");
        assert!(ServiceAccount::parse(&bad.to_string()).is_err());
        let mut bad = ok.clone();
        bad["project_id"] = json!("../x");
        assert!(ServiceAccount::parse(&bad.to_string()).is_err());
        let mut evil = ok.clone();
        evil["token_uri"] = json!("https://evil.example/token");
        let sa = ServiceAccount::parse(&evil.to_string()).unwrap();
        assert!(FcmEndpoints::production(&sa).is_err());
        assert!(ServiceAccount::parse("not json").is_err());
    }

    #[test]
    fn pem_parsing() {
        let pem = "-----BEGIN PRIVATE KEY-----\nAAEC\nAwQ=\n-----END PRIVATE KEY-----\n";
        assert_eq!(pem_pkcs8(pem).unwrap(), vec![0, 1, 2, 3, 4]);
        // escaped newlines (key pasted from JSON by hand)
        let escaped = "-----BEGIN PRIVATE KEY-----\\nAAEC\\nAwQ=\\n-----END PRIVATE KEY-----\\n";
        assert_eq!(pem_pkcs8(escaped).unwrap(), vec![0, 1, 2, 3, 4]);
        assert!(
            pem_pkcs8("-----BEGIN RSA PRIVATE KEY-----\nAAEC\n-----END RSA PRIVATE KEY-----")
                .is_err()
        );
    }
}
