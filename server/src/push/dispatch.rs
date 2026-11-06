//! Per-device delivery of one occurrence (PLAN_V3_SYNC §7.4).
//!
//! For an occurrence `(noteId, at)` every active device of the account **without a
//! `push_log` row** is considered:
//!
//! | kind | channel | rule |
//! |---|---|---|
//! | `web` with subscription | Web Push | always |
//! | `mobile` with native token | native (phase N2) | [`mobile_needs_push`] |
//! | `desktop` | – | local toast |
//!
//! A row is *claimed* first (`INSERT OR IGNORE`, status `pending`), so concurrent ticks can
//! never send twice. The delivery then runs as its own task with up to three retries
//! (5 s, 30 s, 2 min) and ends as `sent`, `gone` (subscription/token removed) or `failed`.
//! `pending` rows left by a crash are dropped when the scheduler starts and re-sent while
//! the occurrence is younger than 24 h (at-least-once across crashes).
//! Devices without a usable channel get no row: a subscription or token registered later
//! still receives the push inside the 24 h window.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use buddy_core::model::{Note, Reminder};
use buddy_core::sync::{NativePushPlatform, ReminderPushPayload};
use buddy_core::zoned::format_utc;
use tokio::task::JoinSet;

use crate::AppState;
use crate::db::Db;
use crate::error::ApiResult;
use crate::push::native::{NativeOutcome, mobile_needs_push, parse_platform, platform_str};
use crate::push::payload::{Shrink, encode_fitting, reminder_payload, test_payload, topic};
use crate::push::webpush::{SendOutcome, Subscription};

/// One due occurrence with everything the payload needs.
#[derive(Debug, Clone)]
pub struct Occurrence {
    pub user_id: i64,
    pub note_id: String,
    /// Normalised UTC instant (`YYYY-MM-DDTHH:MM:SS.sssZ`) – the `push_log` key.
    pub at: String,
    /// Seq of the version that introduced this occurrence (migration 0002).
    pub at_seq: i64,
    pub reminder: Reminder,
    /// Effective IANA zone (reminder zone, else account zone).
    pub zone: String,
    pub note: Option<Note>,
}

/// What a message says.
#[derive(Debug, Clone)]
pub enum Content {
    Reminder(Box<Occurrence>),
    Test,
}

impl Content {
    pub fn payload(&self, shrink: Shrink) -> ReminderPushPayload {
        match self {
            Content::Reminder(o) => {
                reminder_payload(&o.reminder, &o.at, &o.zone, o.note.as_ref(), shrink)
            }
            Content::Test => test_payload(),
        }
    }

    fn topic(&self) -> Option<String> {
        match self {
            Content::Reminder(o) => Some(topic(&o.note_id)),
            Content::Test => None,
        }
    }
}

/// Where a message goes.
#[derive(Debug, Clone)]
pub enum Target {
    Web(Subscription),
    Native {
        platform: NativePushPlatform,
        token: String,
    },
}

impl Target {
    pub fn channel(&self) -> &'static str {
        match self {
            Target::Web(_) => "webpush",
            Target::Native { platform, .. } => platform_str(*platform),
        }
    }
}

/// Final result of one delivery (all attempts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    Gone,
    Failed,
    /// No channel available (VAPID or native push not configured).
    Unavailable,
}

type DeviceRow = (
    String,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The target of one device for an occurrence, or `None` (rule says no / no channel).
fn route(state: &AppState, row: &DeviceRow, at_seq: i64) -> Option<Target> {
    let (_, kind, scheduled_seq, local, platform, token, endpoint, p256dh, auth) = row;
    match kind.as_str() {
        "web" => {
            state.push.web.as_ref()?;
            Some(Target::Web(Subscription {
                endpoint: endpoint.clone()?,
                p256dh: p256dh.clone()?,
                auth: auth.clone()?,
            }))
        }
        "mobile" => {
            if !mobile_needs_push(*scheduled_seq, local.as_deref(), at_seq) {
                return None;
            }
            let platform = parse_platform(platform.as_deref()?)?;
            if !state.push.native.supports(platform) {
                return None;
            }
            Some(Target::Native {
                platform,
                token: token.clone()?,
            })
        }
        _ => None,
    }
}

/// Claims and starts the deliveries of `occ`. Returns the number of started deliveries.
pub async fn dispatch(
    state: &AppState,
    occ: &Occurrence,
    tasks: &mut JoinSet<()>,
) -> ApiResult<usize> {
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT d.id, d.kind, d.scheduled_seq, d.local_notifications, d.native_push_platform, \
                d.native_push_token, s.endpoint, s.p256dh, s.auth \
         FROM devices d LEFT JOIN push_subscriptions s ON s.device_id = d.id \
         WHERE d.user_id = ? AND d.revoked_at IS NULL AND d.kind <> 'desktop' \
           AND NOT EXISTS (SELECT 1 FROM push_log l \
                           WHERE l.device_id = d.id AND l.note_id = ? AND l.at = ?) \
         ORDER BY d.id",
    )
    .bind(occ.user_id)
    .bind(&occ.note_id)
    .bind(&occ.at)
    .fetch_all(&state.db)
    .await?;
    let mut started = 0;
    for row in rows {
        let Some(target) = route(state, &row, occ.at_seq) else {
            continue;
        };
        let device_id = row.0;
        let claimed = sqlx::query(
            "INSERT OR IGNORE INTO push_log (device_id, note_id, at, channel, sent_at, status, attempts) \
             VALUES (?, ?, ?, ?, NULL, 'pending', 0)",
        )
        .bind(&device_id)
        .bind(&occ.note_id)
        .bind(&occ.at)
        .bind(target.channel())
        .execute(&state.db)
        .await?
        .rows_affected()
            == 1;
        if !claimed {
            continue;
        }
        started += 1;
        let state = state.clone();
        let content = Content::Reminder(Box::new(occ.clone()));
        tasks.spawn(async move {
            let (result, attempts) =
                deliver(&state, &device_id, &target, &content, MaxRetries::Scheduled).await;
            if let Err(e) = finish(&state, &device_id, &content, result, attempts).await {
                tracing::error!(error = ?e.message, "push_log update failed");
            }
        });
    }
    Ok(started)
}

async fn finish(
    state: &AppState,
    device_id: &str,
    content: &Content,
    result: Delivery,
    attempts: u32,
) -> ApiResult<()> {
    let Content::Reminder(occ) = content else {
        return Ok(());
    };
    let status = match result {
        Delivery::Sent => "sent",
        Delivery::Gone => "gone",
        Delivery::Failed | Delivery::Unavailable => "failed",
    };
    let sent_at = (result == Delivery::Sent).then(|| format_utc(&state.clock.now()));
    sqlx::query(
        "UPDATE push_log SET status = ?, attempts = ?, sent_at = ? \
         WHERE device_id = ? AND note_id = ? AND at = ?",
    )
    .bind(status)
    .bind(i64::from(attempts))
    .bind(sent_at)
    .bind(device_id)
    .bind(&occ.note_id)
    .bind(&occ.at)
    .execute(&state.db)
    .await?;
    tracing::info!(device = %device_id, note = %occ.note_id, status, attempts, "reminder push");
    Ok(())
}

/// Retry budget: the scheduler retries 3× (5 s, 30 s, 2 min); `POST /push/test` answers
/// at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaxRetries {
    Scheduled,
    None,
}

/// Sends `content` to `target` with the retry policy. Returns the result and the number of
/// HTTP attempts.
pub async fn deliver(
    state: &AppState,
    device_id: &str,
    target: &Target,
    content: &Content,
    retries: MaxRetries,
) -> (Delivery, u32) {
    let delays = state.push.retry_delays;
    let max_retries = match retries {
        MaxRetries::Scheduled => delays.len(),
        MaxRetries::None => 0,
    };
    let topic = content.topic();
    let mut shrink = Shrink::NORMAL;
    let mut attempts = 0u32;
    let mut retried = 0usize;
    loop {
        attempts += 1;
        let (bytes, used) = encode_fitting(|s| content.payload(s), shrink);
        shrink = used;
        let outcome = match target {
            Target::Web(sub) => match &state.push.web {
                Some(web) => {
                    web.send(sub, &bytes, topic.as_deref(), state.clock.now())
                        .await
                }
                None => return (Delivery::Unavailable, attempts),
            },
            Target::Native { platform, token } => {
                if !state.push.native.supports(*platform) {
                    return (Delivery::Unavailable, attempts);
                }
                let payload = content.payload(shrink);
                match state.push.native.send(*platform, token, &payload).await {
                    NativeOutcome::Delivered => SendOutcome::Delivered,
                    NativeOutcome::TokenGone => SendOutcome::Gone,
                    NativeOutcome::Retry => SendOutcome::Retry { after: None },
                    NativeOutcome::Failed(m) => SendOutcome::Failed(m),
                }
            }
        };
        match outcome {
            SendOutcome::Delivered => {
                let _ = mark_success(&state.db, device_id, target, state).await;
                return (Delivery::Sent, attempts);
            }
            SendOutcome::Gone => {
                if let Err(e) = remove_target(&state.db, device_id, target).await {
                    tracing::error!(error = ?e.message, "removing push target failed");
                }
                tracing::info!(device = %device_id, channel = target.channel(), "push target gone, removed");
                return (Delivery::Gone, attempts);
            }
            SendOutcome::TooLarge => match shrink.next() {
                Some(next) => {
                    shrink = next;
                    continue;
                }
                None => return (Delivery::Failed, attempts),
            },
            SendOutcome::Retry { after } => {
                let _ = mark_failure(&state.db, device_id, target).await;
                if retried >= max_retries {
                    tracing::warn!(device = %device_id, attempts, "push failed after retries");
                    return (Delivery::Failed, attempts);
                }
                let mut wait = delays[retried];
                if let Some(a) = after {
                    wait = wait.max(a);
                }
                retried += 1;
                tokio::time::sleep(wait).await;
            }
            SendOutcome::Failed(reason) => {
                let _ = mark_failure(&state.db, device_id, target).await;
                tracing::warn!(device = %device_id, %reason, "push rejected");
                return (Delivery::Failed, attempts);
            }
        }
    }
}

async fn mark_success(
    db: &Db,
    device_id: &str,
    target: &Target,
    state: &AppState,
) -> ApiResult<()> {
    if let Target::Web(sub) = target {
        sqlx::query(
            "UPDATE push_subscriptions SET last_success_at = ?, failures = 0 \
             WHERE device_id = ? AND endpoint = ?",
        )
        .bind(format_utc(&state.clock.now()))
        .bind(device_id)
        .bind(&sub.endpoint)
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn mark_failure(db: &Db, device_id: &str, target: &Target) -> ApiResult<()> {
    if let Target::Web(sub) = target {
        sqlx::query(
            "UPDATE push_subscriptions SET failures = failures + 1 \
             WHERE device_id = ? AND endpoint = ?",
        )
        .bind(device_id)
        .bind(&sub.endpoint)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// 404/410 (Web Push) or an unregistered token: forget it – but only if it was not
/// replaced in the meantime. The device registers a new one on its next start.
async fn remove_target(db: &Db, device_id: &str, target: &Target) -> ApiResult<()> {
    match target {
        Target::Web(sub) => {
            sqlx::query("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?")
                .bind(device_id)
                .bind(&sub.endpoint)
                .execute(db)
                .await?;
        }
        Target::Native { token, .. } => {
            sqlx::query(
                "UPDATE devices SET native_push_token = NULL, native_push_platform = NULL \
                 WHERE id = ? AND native_push_token = ?",
            )
            .bind(device_id)
            .bind(token)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

/// The push target of one device right now (for `POST /push/test`): `Err` explains why
/// there is none.
pub async fn target_of(state: &AppState, device_id: &str) -> ApiResult<Option<Target>> {
    let row: Option<DeviceRow> = sqlx::query_as(
        "SELECT d.id, d.kind, d.scheduled_seq, d.local_notifications, d.native_push_platform, \
                d.native_push_token, s.endpoint, s.p256dh, s.auth \
         FROM devices d LEFT JOIN push_subscriptions s ON s.device_id = d.id \
         WHERE d.id = ? AND d.revoked_at IS NULL",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    // A test always goes out (the dedupe rule is for reminders): pretend nothing is planned.
    Ok(row.and_then(|mut r| {
        r.2 = None;
        route(state, &r, 0)
    }))
}

/// Retry delays of the scheduler (§7.3).
pub const RETRY_DELAYS: [StdDuration; 3] = [
    StdDuration::from_secs(5),
    StdDuration::from_secs(30),
    StdDuration::from_secs(120),
];

/// Keeps the type in one place for `PushService`.
pub type SharedNative = Arc<dyn crate::push::native::NativePushChannel>;
