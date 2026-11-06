//! Periodic maintenance (PLAN_V3_SYNC §5.4, §7.2):
//! - note revisions older than 30 days are deleted;
//! - tombstones (notes and reminders) received more than 180 days ago are deleted and
//!   `users.min_cursor` is raised to the highest purged `seq` (older cursors → 410);
//! - expired sessions are deleted, old login-brake counters forgotten;
//! - once per UTC day `VACUUM INTO <backup_dir>/buddy-YYYYMMDD.db`, 14 copies kept.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use buddy_core::zoned::format_utc;
use chrono::{DateTime, Duration, Utc};

use crate::AppState;
use crate::db::{BEGIN_WRITE, Db};

pub const REVISION_DAYS: i64 = 30;
pub const TOMBSTONE_DAYS: i64 = 180;
pub const BACKUPS_KEPT: usize = 14;
pub const INTERVAL_SECS: u64 = 3600;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PurgeStats {
    pub revisions: u64,
    pub tombstones: u64,
    pub sessions: u64,
}

pub async fn purge(db: &Db, now: DateTime<Utc>) -> Result<PurgeStats> {
    let rev_cut = format_utc(&(now - Duration::days(REVISION_DAYS)));
    let tomb_cut = format_utc(&(now - Duration::days(TOMBSTONE_DAYS)));
    let mut tx = db.begin_with(BEGIN_WRITE).await?;
    let revisions = sqlx::query("DELETE FROM note_revisions WHERE stored_at < ?")
        .bind(&rev_cut)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let mut tombstones = 0;
    let users: Vec<i64> = sqlx::query_scalar("SELECT id FROM users")
        .fetch_all(&mut *tx)
        .await?;
    for user in users {
        let mut max_seq: Option<i64> = None;
        for table in ["notes", "reminders"] {
            let (sel, del) = match table {
                "notes" => (
                    "SELECT MAX(seq) FROM notes WHERE user_id = ? AND deleted = 1 AND received_at < ?",
                    "DELETE FROM notes WHERE user_id = ? AND deleted = 1 AND received_at < ?",
                ),
                _ => (
                    "SELECT MAX(seq) FROM reminders WHERE user_id = ? AND deleted = 1 AND received_at < ?",
                    "DELETE FROM reminders WHERE user_id = ? AND deleted = 1 AND received_at < ?",
                ),
            };
            let m: Option<i64> = sqlx::query_scalar(sel)
                .bind(user)
                .bind(&tomb_cut)
                .fetch_one(&mut *tx)
                .await?;
            max_seq = max_seq.max(m);
            tombstones += sqlx::query(del)
                .bind(user)
                .bind(&tomb_cut)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        }
        if let Some(m) = max_seq {
            sqlx::query("UPDATE users SET min_cursor = MAX(min_cursor, ?) WHERE id = ?")
                .bind(m)
                .bind(user)
                .execute(&mut *tx)
                .await?;
        }
    }
    let sessions = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(format_utc(&now))
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(PurgeStats {
        revisions,
        tombstones,
        sessions,
    })
}

pub fn backup_path(dir: &Path, now: DateTime<Utc>) -> PathBuf {
    dir.join(format!("buddy-{}.db", now.format("%Y%m%d")))
}

/// Writes today's backup if it does not exist yet and keeps the newest 14.
/// Returns the path if a backup was written.
pub async fn backup(db: &Db, dir: &Path, now: DateTime<Utc>) -> Result<Option<PathBuf>> {
    let path = backup_path(dir, now);
    let written = if path.exists() {
        None
    } else {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating backup dir {}", dir.display()))?;
        let target = path
            .to_str()
            .context("backup path is not valid UTF-8")?
            .to_string();
        sqlx::query("VACUUM INTO ?")
            .bind(target)
            .execute(db)
            .await
            .context("VACUUM INTO")?;
        Some(path)
    };
    let mut existing: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("buddy-")?.strip_suffix(".db"))
                .is_some_and(|d| d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()))
        })
        .collect();
    existing.sort();
    if existing.len() > BACKUPS_KEPT {
        for old in &existing[..existing.len() - BACKUPS_KEPT] {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(written)
}

/// One maintenance round (logged as counts only).
pub async fn run_once(state: &AppState) {
    let now = state.clock.now();
    match purge(&state.db, now).await {
        Ok(s) => tracing::info!(
            revisions = s.revisions,
            tombstones = s.tombstones,
            sessions = s.sessions,
            "housekeeping"
        ),
        Err(e) => tracing::error!(error = %e, "housekeeping failed"),
    }
    state.throttle.prune(now);
    match backup(&state.db, &state.config.backup_dir, now).await {
        Ok(Some(p)) => tracing::info!(path = %p.display(), "backup written"),
        Ok(None) => {}
        Err(e) => tracing::error!(error = %e, "backup failed"),
    }
}

/// Runs [`run_once`] at start and every hour until `shutdown` fires.
pub async fn run(state: AppState, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(INTERVAL_SECS));
    loop {
        tokio::select! {
            _ = tick.tick() => run_once(&state).await,
            _ = shutdown.changed() => break,
        }
    }
}
