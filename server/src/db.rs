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
                "invites",
                "note_order",
                "note_revisions",
                "notes",
                "pairings",
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

    /// Migration 0003 on a v3 database (PLAN_V4 §13 Nr. 19): old rows unchanged,
    /// defaults set, cascade still removes everything of an account.
    #[tokio::test]
    async fn migration_0003_keeps_v3_data() {
        let dir = tempfile::tempdir().unwrap();
        let opts = SqliteConnectOptions::from_str("sqlite:")
            .unwrap()
            .filename(dir.path().join("v3.db"))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        MIGRATOR.run_to(2, &pool).await.unwrap();
        let t = "2026-11-01T08:00:00.000Z";
        for sql in [
            "INSERT INTO users (id, username, password_hash, time_zone, seq, created_at)              VALUES (1, 'Anna', 'phc', 'Europe/Berlin', 3, '2026-11-01T08:00:00.000Z')",
            "INSERT INTO devices (id, user_id, kind, name, token_hash, created_at)              VALUES ('d1', 1, 'desktop', 'PC', 'h1', '2026-11-01T08:00:00.000Z')",
            "INSERT INTO devices (id, user_id, kind, name, created_at)              VALUES ('w1', 1, 'web', 'Handy', '2026-11-01T08:00:00.000Z')",
            "INSERT INTO sessions (id_hash, user_id, device_id, created_at, expires_at)              VALUES ('s1', 1, 'w1', '2026-11-01T08:00:00.000Z', '2026-12-01T08:00:00.000Z')",
            "INSERT INTO notes (user_id, id, payload, updated_at, updated_by, seq, received_at)              VALUES (1, 'n1', '{\"title\":\"x\"}', '2026-11-01T08:00:00.000Z', 'd1', 1, '2026-11-01T08:00:00.000Z')",
            "INSERT INTO reminders (user_id, note_id, payload, updated_at, updated_by, seq, received_at)              VALUES (1, 'n1', '{}', '2026-11-01T08:00:00.000Z', 'd1', 2, '2026-11-01T08:00:00.000Z')",
            "INSERT INTO note_order (user_id, ids, updated_at, updated_by, seq)              VALUES (1, '[\"n1\"]', '2026-11-01T08:00:00.000Z', 'd1', 3)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        MIGRATOR.run(&pool).await.unwrap();

        let v3: (String, String, i64) =
            sqlx::query_as("SELECT username, time_zone, seq FROM users WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(v3, ("Anna".into(), "Europe/Berlin".into(), 3));
        let v4: (String, Option<String>, Option<String>, Option<i64>, i64) = sqlx::query_as(
            "SELECT created_via, recovery_hash, disabled_at, quota_bytes, content_format              FROM users WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(v4, ("cli".into(), None, None, None, 1));
        let via: Vec<String> = sqlx::query_scalar("SELECT created_via FROM devices ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(via, ["password", "password"]);
        let note: String = sqlx::query_scalar("SELECT payload FROM notes WHERE id = 'n1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(note, r#"{"title":"x"}"#);
        // new tables accept rows and cascade with the account
        sqlx::query(
            "INSERT INTO pairings (id, user_id, created_by, code_hash, created_at, expires_at)              VALUES ('p1', 1, 'd1', 'h', ?, ?)",
        )
        .bind(t)
        .bind(t)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO invites (code_hash, created_at, used_by) VALUES ('i', ?, 1)")
            .bind(t)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE users SET created_via = 'other' WHERE id = 1")
                .execute(&pool)
                .await
                .is_err(),
            "CHECK constraint"
        );
        sqlx::query("DELETE FROM users WHERE id = 1")
            .execute(&pool)
            .await
            .unwrap();
        for sql in [
            "SELECT COUNT(*) FROM devices",
            "SELECT COUNT(*) FROM sessions",
            "SELECT COUNT(*) FROM notes",
            "SELECT COUNT(*) FROM reminders",
            "SELECT COUNT(*) FROM note_order",
            "SELECT COUNT(*) FROM pairings",
        ] {
            let n: i64 = sqlx::query_scalar(sql).fetch_one(&pool).await.unwrap();
            assert_eq!(n, 0, "{sql}");
        }
        let used_by: Option<i64> = sqlx::query_scalar("SELECT used_by FROM invites")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(used_by, None, "invite keeps its row, used_by set null");
    }
}
