//! SQLite pool (WAL, foreign keys, busy timeout) and migrations (PLAN_V3_SYNC §7.2).

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

pub type Db = SqlitePool;

/// Statement that starts every write transaction: takes the write lock up front, so two
/// concurrent pushes serialise instead of failing with SQLITE_BUSY on lock upgrade.
pub const BEGIN_WRITE: &str = "BEGIN IMMEDIATE";

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Opens (creating if missing) the database and runs all migrations.
pub async fn open(path: &Path) -> Result<Db> {
    if let Some(dir) = path.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating database directory {}", dir.display()))?;
    }
    let opts = SqliteConnectOptions::from_str("sqlite:")?
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .with_context(|| format!("opening database {}", path.display()))?;
    MIGRATOR.run(&pool).await.context("running migrations")?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opens_and_migrates_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("buddy.db");
        let pool = open(&path).await.unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            tables,
            [
                "devices",
                "note_order",
                "note_revisions",
                "notes",
                "push_log",
                "push_subscriptions",
                "reminders",
                "sessions",
                "users"
            ]
        );
        pool.close().await;
        // second open: migrations are idempotent
        open(&path).await.unwrap().close().await;
    }
}
