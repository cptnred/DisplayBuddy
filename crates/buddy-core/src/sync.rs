//! Sync records and API messages (PLAN_V3_SYNC §5.2, §6). camelCase on the wire;
//! TypeScript mirror: `src/lib/sync/types.ts`.
//!
//! Every record carries the edit time on the editing device (`updatedAt`, corrected
//! device clock, UTC) and the editing device (`updatedBy`). Deletion is a tombstone
//! (`deleted: true`, payload `null`) that takes part in LWW like any edit.

use serde::{Deserialize, Serialize};

use crate::model::{Note, Reminder};

/// Sequence number of the server change log (`users.seq`); the sync cursor.
pub type Seq = i64;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default)]
    pub deleted: bool,
    /// `None` for tombstones.
    #[serde(default)]
    pub note: Option<Note>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRecord {
    pub note_id: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default)]
    pub deleted: bool,
    /// `None` for tombstones (reminder removed).
    #[serde(default)]
    pub reminder: Option<Reminder>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrderRecord {
    pub updated_at: String,
    pub updated_by: String,
    pub ids: Vec<String>,
}

/// `GET /sync/changes?since=<cursor>&limit=<n>`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncChanges {
    pub cursor: Seq,
    pub has_more: bool,
    #[serde(default)]
    pub notes: Vec<NoteRecord>,
    #[serde(default)]
    pub reminders: Vec<ReminderRecord>,
    #[serde(default)]
    pub order: Option<OrderRecord>,
    pub server_time: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalNotifications {
    Granted,
    Denied,
}

/// Reported by the native shell after it planned local notifications (§10.3).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceState {
    /// Cursor up to which every reminder is planned locally.
    pub scheduled_seq: Seq,
    pub local_notifications: LocalNotifications,
}

/// `POST /sync/push` – the only write path; idempotent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    #[serde(default)]
    pub notes: Vec<NoteRecord>,
    #[serde(default)]
    pub reminders: Vec<ReminderRecord>,
    #[serde(default)]
    pub order: Option<OrderRecord>,
    #[serde(default)]
    pub device_state: Option<DeviceState>,
}

/// Maximum records per kind in one push (clients send packages ≤ 200).
pub const PUSH_BATCH_MAX: usize = 200;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Note,
    Reminder,
    Order,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PushStatus {
    /// Accepted (newer than the server copy) – or an identical re-send (idempotent).
    Applied,
    /// The server copy is newer; it is returned in the matching `note`/`reminder`/`order`
    /// field and the client takes it over (and shows a hint).
    Stale,
    /// Rejected by validation (bad id, unparseable time, missing payload).
    Invalid,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub kind: RecordKind,
    /// Note id (notes and reminders) or `"order"`.
    pub id: String,
    pub status: PushStatus,
    /// The record as stored on the server after this push (for `stale`: the winner).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<NoteRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder: Option<ReminderRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<OrderRecord>,
    /// The timestamp the server stored if it differs from the sent one (future clamp).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clamped_updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub results: Vec<PushResult>,
    pub cursor: Seq,
    pub server_time: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Desktop,
    Web,
    Mobile,
}

/// `POST /devices` (desktop and native shell).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    pub username: String,
    pub password: String,
    pub device_name: String,
    pub kind: DeviceKind,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginResponse {
    pub device_id: String,
    pub token: String,
    pub server_time: String,
}

/// `POST /session` (PWA; device kind `web`, `deviceId` reused when known).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogin {
    pub username: String,
    pub password: String,
    pub device_name: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub device_id: String,
    pub server_time: String,
}

/// `GET /me`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub username: String,
    pub time_zone: String,
    pub device_id: String,
    pub server_time: String,
}

/// `PUT /me`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeUpdate {
    pub time_zone: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// `PUT /push/subscription` (PWA Web Push subscription, `PushSubscription.toJSON()`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativePushPlatform {
    Fcm,
    Apns,
}

/// `PUT /devices/current/push` (native shell, phase N2).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativePushToken {
    pub platform: NativePushPlatform,
    pub token: String,
}

/// `GET /push/vapid-public-key`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VapidPublicKey {
    /// Uncompressed P-256 point, base64url without padding (`applicationServerKey`).
    pub key: String,
}

/// Payload of a reminder push (Web Push encrypted, ≤ 4 KB; native: data fields).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderPushPayload {
    /// Format version, currently 1.
    pub v: u32,
    /// `"reminder"` or `"test"`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    pub title: String,
    pub body: String,
    pub url: String,
}

/// Error body of every non-2xx API response.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ApiError {
    /// Machine-readable code, e.g. `unauthorized`, `full_resync_required`.
    pub error: String,
    pub message: String,
}

pub mod error_codes {
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    pub const BAD_REQUEST: &str = "bad_request";
    pub const NOT_FOUND: &str = "not_found";
    pub const TOO_MANY_REQUESTS: &str = "too_many_requests";
    /// HTTP 410 on `/sync/changes`: cursor older than `min_cursor` → full re-sync.
    pub const FULL_RESYNC_REQUIRED: &str = "full_resync_required";
    pub const INTERNAL: &str = "internal";
    // v4 (PLAN_V4 §5.3)
    pub const USERNAME_TAKEN: &str = "username_taken"; // 409
    pub const USERNAME_INVALID: &str = "username_invalid"; // 400
    pub const PASSWORD_WEAK: &str = "password_weak"; // 400
    pub const REGISTRATION_CLOSED: &str = "registration_closed"; // 403
    pub const INVITE_REQUIRED: &str = "invite_required"; // 403
    pub const INVITE_INVALID: &str = "invite_invalid"; // 403
    pub const CHALLENGE_INVALID: &str = "challenge_invalid"; // 400
    /// 400 – unknown, expired, cancelled or already used: deliberately ONE code.
    pub const PAIRING_INVALID: &str = "pairing_invalid";
    pub const PASSWORD_REQUIRED: &str = "password_required"; // 403
    pub const ACCOUNT_DISABLED: &str = "account_disabled"; // 403
    pub const QUOTA_EXCEEDED: &str = "quota_exceeded"; // 413
    pub const DEVICE_LIMIT: &str = "device_limit"; // 409
    /// 409 – the client does not know the account's content format (D-101).
    pub const CONTENT_FORMAT_UNSUPPORTED: &str = "content_format_unsupported";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(v: Value) {
        let typed: T = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), v);
    }

    /// The shared API examples (also type-checked by the TypeScript mirror) parse and
    /// re-serialise unchanged: field names agree on both sides.
    #[test]
    fn api_examples_round_trip() {
        let raw = include_str!("../tests/fixtures/api_examples.json");
        let ex: Value = serde_json::from_str(raw).unwrap();
        round_trip::<SyncChanges>(ex["syncChanges"].clone());
        round_trip::<PushRequest>(ex["pushRequest"].clone());
        round_trip::<PushResponse>(ex["pushResponse"].clone());
        round_trip::<DeviceLogin>(ex["deviceLogin"].clone());
        round_trip::<DeviceLoginResponse>(ex["deviceLoginResponse"].clone());
        round_trip::<SessionLogin>(ex["sessionLogin"].clone());
        round_trip::<SessionResponse>(ex["sessionResponse"].clone());
        round_trip::<Me>(ex["me"].clone());
        round_trip::<MeUpdate>(ex["meUpdate"].clone());
        round_trip::<PushSubscription>(ex["pushSubscription"].clone());
        round_trip::<NativePushToken>(ex["nativePushToken"].clone());
        round_trip::<VapidPublicKey>(ex["vapidPublicKey"].clone());
        round_trip::<ReminderPushPayload>(ex["reminderPushPayload"].clone());
        round_trip::<ApiError>(ex["apiError"].clone());

        use crate::accounts as a;
        use crate::pairing as p;
        round_trip::<a::ServerInfo>(ex["serverInfo"].clone());
        round_trip::<a::RegistrationChallenge>(ex["registrationChallenge"].clone());
        round_trip::<a::AccountCreate>(ex["accountCreate"].clone());
        round_trip::<a::AccountAccess>(ex["accountAccess"].clone());
        round_trip::<a::AccountRecover>(ex["accountRecover"].clone());
        round_trip::<a::AccountInfo>(ex["accountInfo"].clone());
        round_trip::<a::DeviceList>(ex["deviceList"].clone());
        round_trip::<a::DeviceRevoke>(ex["deviceRevoke"].clone());
        round_trip::<a::PasswordChange>(ex["passwordChange"].clone());
        round_trip::<a::RecoveryCodeRequest>(ex["recoveryCodeRequest"].clone());
        round_trip::<a::RecoveryCodeResponse>(ex["recoveryCodeResponse"].clone());
        round_trip::<a::AccountDelete>(ex["accountDelete"].clone());
        round_trip::<a::AccountExport>(ex["accountExport"].clone());
        round_trip::<p::PairingStart>(ex["pairingStart"].clone());
        round_trip::<p::PairingStatus>(ex["pairingStatus"].clone());
        round_trip::<p::PairingRedeem>(ex["pairingRedeem"].clone());
        round_trip::<p::PairingAccess>(ex["pairingAccess"].clone());
        round_trip::<p::SessionPairing>(ex["sessionPairing"].clone());
    }

    #[test]
    fn tombstone_defaults() {
        let r: NoteRecord = serde_json::from_value(json!({
            "id": "0b9a7a3e-4f5d-4c1e-9d8a-2a6b1c3d4e5f",
            "updatedAt": "2026-11-06T10:00:00.000Z",
            "updatedBy": "d1",
            "deleted": true
        }))
        .unwrap();
        assert!(r.deleted && r.note.is_none());
        let p: PushRequest = serde_json::from_value(json!({})).unwrap();
        assert_eq!(p, PushRequest::default());
    }
}
