//! Accounts (PLAN_V4 §5, §8.1): API messages, username/password rules and recovery codes.
//! camelCase on the wire; TypeScript mirror in `src/lib/sync/types.ts`; examples in
//! `tests/fixtures/api_examples.json`. Every response carries `serverTime` (clock offset).

use serde::{Deserialize, Serialize};

use crate::pairing::{code_hash, encode_crockford, group4, normalize_crockford};
use crate::sync::{DeviceKind, NoteRecord, OrderRecord, ReminderRecord};

/// `GET /info.apiLevel` of a v4 server (v3 servers answer 404 on `/info`).
pub const API_LEVEL: u32 = 2;
/// Feature names in `ServerInfo.features`.
pub const FEATURES: [&str; 5] = ["accounts", "pairing", "recovery", "export", "quota"];
/// `users.content_format`: 1 = plain JSON. Clients stop syncing on anything else (D-101).
pub const CONTENT_FORMAT_PLAIN: u32 = 1;
pub const EXPORT_FORMAT: &str = "display-buddy-export/1";

pub const PASSWORD_MIN_CHARS: usize = 12;
pub const PASSWORD_MAX_BYTES: usize = 1024;
pub const USERNAME_MIN: usize = 3;
pub const USERNAME_MAX: usize = 32;
/// 24 characters = 120 random bits (D-89).
pub const RECOVERY_CODE_LEN: usize = 24;

pub const RESERVED_USERNAMES: [&str; 23] = [
    "admin",
    "administrator",
    "root",
    "system",
    "support",
    "help",
    "info",
    "buddy",
    "displaybuddy",
    "server",
    "server-restore",
    "api",
    "www",
    "mail",
    "security",
    "abuse",
    "postmaster",
    "hostmaster",
    "webmaster",
    "noreply",
    "null",
    "undefined",
    "test",
];

/// Rules for **new** names (old CLI names stay valid): lower-cased, then
/// `^[a-z0-9][a-z0-9._-]{2,31}$` and not reserved. Returns the lower-case name.
pub fn validate_new_username(input: &str) -> Option<String> {
    let name = input.to_ascii_lowercase();
    let b = name.as_bytes();
    let ok = (USERNAME_MIN..=USERNAME_MAX).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
        && !RESERVED_USERNAMES.contains(&name.as_str());
    ok.then_some(name)
}

/// Length rules and „not the username“ (case-insensitive). The common-password list is
/// checked by the server only (offline list, D-88).
pub fn password_acceptable(password: &str, username: &str) -> bool {
    password.chars().count() >= PASSWORD_MIN_CHARS
        && password.len() <= PASSWORD_MAX_BYTES
        && !password.eq_ignore_ascii_case(username)
}

/// Recovery code from 15 random bytes (120 bits).
pub fn recovery_code_from_bytes(bytes: &[u8; 15]) -> String {
    encode_crockford(bytes, RECOVERY_CODE_LEN)
}

/// Same normalisation as pairing codes, 24 characters; `None` if it is not a recovery code.
pub fn normalize_recovery_code(input: &str) -> Option<String> {
    normalize_crockford(input, RECOVERY_CODE_LEN)
}

/// Six groups of four: `ABCD-EFGH-JKMN-PQRS-TVWX-YZ01`.
pub fn format_recovery_code(code: &str) -> String {
    group4(code)
}

/// SHA-256 (hex) of the normalised code – stored in `users.recovery_hash`.
pub fn recovery_code_hash(normalized: &str) -> String {
    code_hash(normalized)
}

// ---- public (no login) --------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RegistrationMode {
    Open,
    Invite,
    Closed,
}

/// Operator links from the configuration (`https://` only); `null` when not configured.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegalLinks {
    #[serde(default)]
    pub imprint_url: Option<String>,
    #[serde(default)]
    pub privacy_url: Option<String>,
    #[serde(default)]
    pub terms_url: Option<String>,
}

/// `GET /info` (public).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server_time: String,
    /// Server version, e.g. "0.4.0".
    pub version: String,
    pub api_level: u32,
    pub registration: RegistrationMode,
    /// Subset of [`FEATURES`].
    pub features: Vec<String>,
    pub password_min_chars: u32,
    pub legal: LegalLinks,
    #[serde(default)]
    pub operator: Option<String>,
}

/// `POST /accounts/challenge` (body `{}`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationChallenge {
    pub id: String,
    /// 16 random bytes, base64url without padding ([`crate::pow`]).
    pub challenge: String,
    pub bits: u32,
    pub expires_at: String,
    pub server_time: String,
}

/// `POST /accounts`: creates the account and the desktop device in one transaction.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountCreate {
    pub username: String,
    pub password: String,
    pub device_name: String,
    /// IANA zone of the PC (account default zone).
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Required when `registration = invite`.
    #[serde(default)]
    pub invite_code: Option<String>,
    pub challenge_id: String,
    pub nonce: u32,
}

/// Answer of `POST /accounts` and `POST /accounts/recover`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAccess {
    pub device_id: String,
    pub token: String,
    /// Normalised; shown once with [`format_recovery_code`].
    pub recovery_code: String,
    pub server_time: String,
}

/// `POST /accounts/recover`: revokes every device and session, sets the password and
/// registers the calling PC anew; the old code is used up and a new one is returned.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecover {
    pub username: String,
    pub recovery_code: String,
    pub new_password: String,
    pub device_name: String,
}

// ---- signed in (bearer or cookie) ----------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// `SUM(length(payload))` over notes, reminders and revisions.
    pub bytes: u64,
    /// Live notes.
    pub notes: u64,
    /// Devices that are not revoked.
    pub devices: u64,
}

/// Effective limits; `null` = unlimited.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub notes: Option<u64>,
    #[serde(default)]
    pub devices: Option<u64>,
}

/// `GET /me/account`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub username: String,
    pub created_at: String,
    pub time_zone: String,
    /// [`CONTENT_FORMAT_PLAIN`]; unknown → client stops syncing (`content_format_unsupported`).
    pub content_format: u32,
    pub usage: Usage,
    pub quota: Quota,
    /// `null` = the account has no recovery code (v3 accounts).
    #[serde(default)]
    pub recovery_code_created_at: Option<String>,
    pub server_time: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceCreatedVia {
    Password,
    Register,
    Pairing,
    Recovery,
}

/// One entry of `GET /me/devices` (only devices that are not revoked).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub created_at: String,
    /// „zuletzt aktiv“ – also set by the Android background sync (PLAN_V4 §14).
    #[serde(default)]
    pub last_seen_at: Option<String>,
    pub created_via: DeviceCreatedVia,
    /// The calling device.
    pub current: bool,
    /// The device has a push channel (Web Push subscription or native token).
    pub push: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub devices: Vec<DeviceInfo>,
    pub server_time: String,
}

/// `POST /me/devices/{id}/revoke`: without password only the own or a younger device
/// (D-91), else `403 password_required`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevoke {
    #[serde(default)]
    pub password: Option<String>,
}

/// `PUT /me/password`. Without `currentPassword` only desktop/mobile devices ≥ 24 h old,
/// and `signOutOthers` is forced (D-89).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    #[serde(default)]
    pub current_password: Option<String>,
    pub new_password: String,
    pub sign_out_others: bool,
}

/// `POST /me/recovery-code` (the old code becomes invalid).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCodeRequest {
    pub password: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCodeResponse {
    pub recovery_code: String,
    pub server_time: String,
}

/// `POST /me/delete` (immediate, cascade, D-92).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDelete {
    pub password: String,
    pub confirm_username: String,
}

// ---- export (PLAN_V4 §5.4, D-93) -------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportAccount {
    pub username: String,
    pub created_at: String,
    pub time_zone: String,
    pub content_format: u32,
}

/// [`DeviceInfo`] without `current`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportDevice {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    pub created_via: DeviceCreatedVia,
    pub push: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RevisionReason {
    Replaced,
    Rejected,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionExport {
    pub note_id: String,
    pub reason: RevisionReason,
    pub stored_at: String,
    /// `null` if the losing version was a tombstone.
    #[serde(default)]
    pub note: Option<crate::model::Note>,
}

/// `GET /me/export` (`Content-Disposition: attachment`). No hashes, tokens or push endpoints.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountExport {
    /// [`EXPORT_FORMAT`].
    pub format: String,
    pub exported_at: String,
    pub account: ExportAccount,
    pub devices: Vec<ExportDevice>,
    /// Live notes only.
    pub notes: Vec<NoteRecord>,
    /// Live reminders only.
    pub reminders: Vec<ReminderRecord>,
    #[serde(default)]
    pub order: Option<OrderRecord>,
    pub revisions: Vec<RevisionExport>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn usernames() {
        for ok in [
            "anna",
            "Anna",
            "a.b",
            "0x7",
            "a-b_c.d",
            "abcdefghijklmnopqrstuvwxyz012345",
        ] {
            assert_eq!(
                validate_new_username(ok),
                Some(ok.to_ascii_lowercase()),
                "{ok}"
            );
        }
        for bad in [
            "",
            "ab",
            ".anna",
            "-anna",
            "anna@x.de",
            "an na",
            "änna",
            "admin",
            "Server-Restore",
            "abcdefghijklmnopqrstuvwxyz0123456",
        ] {
            assert_eq!(validate_new_username(bad), None, "{bad}");
        }
    }

    #[test]
    fn passwords() {
        assert!(password_acceptable("correct horse battery", "anna"));
        assert!(!password_acceptable("short", "anna"));
        assert!(password_acceptable("äöüäöüäöüäöü", "anna")); // 12 chars, 24 bytes
        assert!(!password_acceptable(&"x".repeat(1025), "anna"));
        assert!(!password_acceptable("AnnaAnnaAnna", "annaannaanna"));
    }

    #[test]
    fn recovery_vectors() {
        let v: Value =
            serde_json::from_str(include_str!("../tests/fixtures/pairing_vectors.json")).unwrap();
        for c in v["recovery"].as_array().unwrap() {
            let hex = c["bytes"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let code = recovery_code_from_bytes(&bytes.try_into().unwrap());
            assert_eq!(code, c["code"].as_str().unwrap());
            assert_eq!(
                format_recovery_code(&code),
                c["formatted"].as_str().unwrap()
            );
            assert_eq!(recovery_code_hash(&code), c["hash"].as_str().unwrap());
        }
        for c in v["recoveryNormalize"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            assert_eq!(
                normalize_recovery_code(input).as_deref(),
                c["code"].as_str(),
                "{input:?}"
            );
        }
    }
}
