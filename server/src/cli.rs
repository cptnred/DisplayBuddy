//! Command line (PLAN_V3_SYNC §7.1): `serve`, `user add/passwd`, `device list/revoke`,
//! `revisions`, `restore`, `vapid generate/public-key`.
//!
//! Passwords are read from the terminal without echo (twice), or as one line from stdin
//! when stdin is not a terminal (`echo … | buddy-server user add martin`); never from
//! arguments or environment variables (they end up in shell history / `ps`).

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use buddy_core::model::{Note, is_valid_note_id};
use buddy_core::sync::NoteRecord;
use buddy_core::zoned::{format_utc, parse_zone};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};

use crate::auth::password::{hash_password, validate_new_password};
use crate::db::{BEGIN_WRITE, Db};
use crate::sync;

/// Author of server-side restores (the only records the server stamps itself).
pub const RESTORE_DEVICE: &str = "server-restore";

#[derive(Parser, Debug)]
#[command(name = "buddy-server", version, about = "Display Buddy sync server")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the HTTP server (configuration from BUDDY_* environment variables).
    Serve,
    /// Manage the account.
    #[command(subcommand)]
    User(UserCmd),
    /// List or revoke devices.
    #[command(subcommand)]
    Device(DeviceCmd),
    /// List stored note revisions (losers of conflicts, kept 30 days).
    Revisions {
        /// Only revisions of this note.
        #[arg(long)]
        note: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
    },
    /// Restore a revision as the current version of its note.
    Restore { revision_id: i64 },
    /// VAPID key pair for Web Push.
    #[command(subcommand)]
    Vapid(VapidCmd),
}

#[derive(Subcommand, Debug)]
pub enum UserCmd {
    /// Create a user (password from the terminal or stdin).
    Add {
        username: String,
        /// IANA zone used for reminders without their own zone.
        #[arg(long, default_value = "UTC")]
        time_zone: String,
    },
    /// Change the password; ends all web sessions.
    Passwd {
        username: String,
        /// Also sign out every desktop/mobile device.
        #[arg(long)]
        revoke_devices: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum DeviceCmd {
    List,
    Revoke { device_id: String },
}

#[derive(Subcommand, Debug)]
pub enum VapidCmd {
    /// Create the private key (PEM, mode 0600) and print the public key.
    Generate {
        /// Defaults to BUDDY_VAPID_PRIVATE_KEY_FILE.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Replace an existing key (existing subscriptions stop working).
        #[arg(long)]
        force: bool,
    },
    /// Print the public key (base64url) of an existing private key.
    PublicKey {
        #[arg(long)]
        file: Option<PathBuf>,
    },
}

pub fn read_password(prompt_twice: bool) -> Result<String> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        let a = rpassword::prompt_password("Passwort: ")?;
        if prompt_twice {
            let b = rpassword::prompt_password("Passwort wiederholen: ")?;
            if a != b {
                bail!("passwords do not match");
            }
        }
        Ok(a)
    } else {
        let mut line = String::new();
        stdin.lock().read_line(&mut line)?;
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }
}

pub fn validate_username(u: &str) -> Result<()> {
    let ok = !u.is_empty()
        && u.len() <= crate::api::MAX_USERNAME
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'));
    if !ok {
        bail!("username: 1–64 characters of A–Z, a–z, 0–9, . _ - @");
    }
    Ok(())
}

pub async fn user_add(
    db: &Db,
    now: DateTime<Utc>,
    username: &str,
    password: &str,
    time_zone: &str,
) -> Result<i64> {
    validate_username(username)?;
    validate_new_password(password)?;
    if parse_zone(time_zone).is_none() {
        bail!("unknown time zone {time_zone:?}");
    }
    let pw = password.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await??;
    let id = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, time_zone, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(username)
    .bind(hash)
    .bind(time_zone.trim())
    .bind(format_utc(&now))
    .fetch_one(db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => anyhow!("user {username} exists"),
        e => e.into(),
    })?;
    Ok(id)
}

pub async fn user_passwd(
    db: &Db,
    now: DateTime<Utc>,
    username: &str,
    password: &str,
    revoke_devices: bool,
) -> Result<()> {
    validate_new_password(password)?;
    let pw = password.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await??;
    let user: i64 = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| anyhow!("no user {username}"))?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hash)
        .bind(user)
        .execute(db)
        .await?;
    // OWASP: a password change ends existing sessions.
    let devices: Vec<String> = if revoke_devices {
        sqlx::query_scalar("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL")
            .bind(user)
            .fetch_all(db)
            .await?
    } else {
        sqlx::query_scalar("SELECT DISTINCT device_id FROM sessions WHERE user_id = ?")
            .bind(user)
            .fetch_all(db)
            .await?
    };
    for d in devices {
        crate::api::revoke_device(db, &d, &format_utc(&now))
            .await
            .map_err(|e| anyhow!("revoking device: {}", e.message))?;
    }
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
pub struct DeviceRow {
    pub id: String,
    pub username: String,
    pub kind: String,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub synced_seq: i64,
    pub scheduled_seq: Option<i64>,
    pub local_notifications: Option<String>,
    pub has_push: bool,
}

pub async fn device_list(db: &Db) -> Result<Vec<DeviceRow>> {
    Ok(sqlx::query_as(
        "SELECT d.id, u.username, d.kind, d.name, d.created_at, d.last_seen_at, d.revoked_at, \
         d.synced_seq, d.scheduled_seq, d.local_notifications, \
         (p.device_id IS NOT NULL OR d.native_push_token IS NOT NULL) AS has_push \
         FROM devices d JOIN users u ON u.id = d.user_id \
         LEFT JOIN push_subscriptions p ON p.device_id = d.id ORDER BY d.created_at",
    )
    .fetch_all(db)
    .await?)
}

pub async fn device_revoke(db: &Db, now: DateTime<Utc>, device_id: &str) -> Result<()> {
    let found = crate::api::revoke_device(db, device_id, &format_utc(&now))
        .await
        .map_err(|e| anyhow!("revoking device: {}", e.message))?;
    if !found {
        bail!("no device {device_id}");
    }
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
pub struct RevisionRow {
    pub id: i64,
    pub note_id: String,
    pub updated_at: String,
    pub updated_by: String,
    pub reason: String,
    pub stored_at: String,
    pub payload: Option<String>,
}

impl RevisionRow {
    pub fn title(&self) -> String {
        self.payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Note>(p).ok())
            .map(|n| buddy_core::text::truncate_chars(&n.title, 40))
            .unwrap_or_default()
    }
}

pub async fn revisions(db: &Db, note: Option<&str>, limit: i64) -> Result<Vec<RevisionRow>> {
    let limit = limit.clamp(1, 10_000);
    let rows = match note {
        Some(n) => {
            sqlx::query_as(
                "SELECT id, note_id, updated_at, updated_by, reason, stored_at, payload \
                 FROM note_revisions WHERE note_id = ? ORDER BY id DESC LIMIT ?",
            )
            .bind(n)
            .bind(limit)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT id, note_id, updated_at, updated_by, reason, stored_at, payload \
                 FROM note_revisions ORDER BY id DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(db)
            .await?
        }
    };
    Ok(rows)
}

/// Makes a revision the current note. The server is the acting "device" here, so it
/// stamps `updatedAt` = server time and `updatedBy` = [`RESTORE_DEVICE`]; the replaced
/// current version becomes a `replaced` revision. Returns the new `seq`.
pub async fn restore(db: &Db, now: DateTime<Utc>, revision_id: i64) -> Result<i64> {
    let (user, note_id, payload): (i64, String, Option<String>) =
        sqlx::query_as("SELECT user_id, note_id, payload FROM note_revisions WHERE id = ?")
            .bind(revision_id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| anyhow!("no revision {revision_id}"))?;
    if !is_valid_note_id(&note_id) {
        bail!("revision has an invalid note id");
    }
    let mut note: Note = serde_json::from_str(payload.as_deref().context("revision is empty")?)
        .context("revision payload is not a note")?;
    let stamp = format_utc(&now);
    note.updated_at = stamp.clone();
    let rec = NoteRecord {
        id: note_id.clone(),
        updated_at: stamp.clone(),
        updated_by: RESTORE_DEVICE.into(),
        deleted: false,
        note: Some(note),
    };
    let err = |e: crate::error::AppError| anyhow!("restore failed: {}", e.message);
    let mut tx = db.begin_with(BEGIN_WRITE).await?;
    let cur: Option<(Option<String>, String, String, bool)> = sqlx::query_as(
        "SELECT payload, updated_at, updated_by, deleted FROM notes WHERE user_id = ? AND id = ?",
    )
    .bind(user)
    .bind(&note_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((p, at, by, deleted)) = cur {
        let cur = NoteRecord {
            id: note_id.clone(),
            updated_at: at,
            updated_by: by,
            deleted,
            note: p.and_then(|p| serde_json::from_str(&p).ok()),
        };
        sync::store_revision(&mut tx, user, &cur, "replaced", &stamp)
            .await
            .map_err(err)?;
    }
    let seq = sync::write_note(&mut tx, user, &rec, &stamp)
        .await
        .map_err(err)?;
    tx.commit().await?;
    Ok(seq)
}

fn opt(s: &Option<String>) -> &str {
    s.as_deref().unwrap_or("-")
}

/// Runs a CLI command other than `serve`.
pub async fn run_admin(cmd: Command, config: &crate::config::Config) -> Result<()> {
    let now = Utc::now();
    let out = &mut std::io::stdout();
    if let Command::Vapid(v) = cmd {
        let configured = config.vapid_private_key_file.clone();
        return match v {
            VapidCmd::Generate { out: path, force } => {
                let path = path
                    .or(configured)
                    .context("--out or BUDDY_VAPID_PRIVATE_KEY_FILE required")?;
                let public = crate::vapid::generate(&path, force)?;
                eprintln!("Privater Schlüssel: {} (Rechte 0600)", path.display());
                writeln!(out, "{public}")?;
                Ok(())
            }
            VapidCmd::PublicKey { file } => {
                let path = file
                    .or(configured)
                    .context("--file or BUDDY_VAPID_PRIVATE_KEY_FILE required")?;
                let v = crate::vapid::Vapid::load(&path, None)?;
                writeln!(out, "{}", v.public_key())?;
                Ok(())
            }
        };
    }
    let db = crate::db::open(&config.db_path).await?;
    let res = async {
        match cmd {
            Command::Serve | Command::Vapid(_) => unreachable!("handled by the caller"),
            Command::User(UserCmd::Add {
                username,
                time_zone,
            }) => {
                let pw = read_password(true)?;
                user_add(&db, now, &username, &pw, &time_zone).await?;
                eprintln!("Benutzer {username} angelegt.");
            }
            Command::User(UserCmd::Passwd {
                username,
                revoke_devices,
            }) => {
                let pw = read_password(true)?;
                user_passwd(&db, now, &username, &pw, revoke_devices).await?;
                eprintln!("Passwort geändert, Web-Sitzungen beendet.");
            }
            Command::Device(DeviceCmd::List) => {
                writeln!(
                    out,
                    "{:<36}  {:<8}  {:<7}  {:<24}  {:<24}  {:>6}  {:<8}  name",
                    "id", "user", "kind", "last seen", "revoked", "synced", "push"
                )?;
                for d in device_list(&db).await? {
                    writeln!(
                        out,
                        "{:<36}  {:<8}  {:<7}  {:<24}  {:<24}  {:>6}  {:<8}  {}",
                        d.id,
                        d.username,
                        d.kind,
                        opt(&d.last_seen_at),
                        opt(&d.revoked_at),
                        d.synced_seq,
                        if d.has_push { "yes" } else { "no" },
                        d.name
                    )?;
                }
            }
            Command::Device(DeviceCmd::Revoke { device_id }) => {
                device_revoke(&db, now, &device_id).await?;
                eprintln!("Gerät {device_id} abgemeldet.");
            }
            Command::Revisions { note, limit } => {
                writeln!(
                    out,
                    "{:>6}  {:<36}  {:<9}  {:<24}  {:<36}  title",
                    "id", "note", "reason", "updatedAt", "updatedBy"
                )?;
                for r in revisions(&db, note.as_deref(), limit).await? {
                    writeln!(
                        out,
                        "{:>6}  {:<36}  {:<9}  {:<24}  {:<36}  {}",
                        r.id,
                        r.note_id,
                        r.reason,
                        r.updated_at,
                        r.updated_by,
                        r.title()
                    )?;
                }
            }
            Command::Restore { revision_id } => {
                let seq = restore(&db, now, revision_id).await?;
                eprintln!("Revision {revision_id} wiederhergestellt (seq {seq}).");
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    db.close().await;
    res
}
