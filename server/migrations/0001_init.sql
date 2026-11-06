-- Display Buddy server schema v1 (PLAN_V3_SYNC §7.2).
--
-- Time columns:
-- * server times (created_at, last_seen_at, revoked_at, expires_at, received_at, stored_at,
--   sent_at, last_success_at) are written by the server as `YYYY-MM-DDTHH:MM:SS.sssZ`
--   (fixed width, so text order = time order);
-- * device stamps (updated_at) are stored verbatim as sent (after the future clamp) and are
--   only ever compared as instants in Rust (buddy_core::lww), never in SQL.

CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    -- IANA zone; default zone for reminders without `timeZone` (§5.1)
    time_zone     TEXT    NOT NULL DEFAULT 'UTC',
    -- change-log sequence (sync cursor); += 1 for every stored record version
    seq           INTEGER NOT NULL DEFAULT 0,
    -- cursors below this value get 410 full_resync_required (tombstones purged)
    min_cursor    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
);

CREATE TABLE devices (
    id                   TEXT    PRIMARY KEY,           -- UUID v4
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind                 TEXT    NOT NULL CHECK (kind IN ('desktop', 'web', 'mobile')),
    name                 TEXT    NOT NULL,
    token_hash           TEXT    NULL UNIQUE,           -- SHA-256 (hex) of the bearer token
    created_at           TEXT    NOT NULL,
    last_seen_at         TEXT    NULL,
    revoked_at           TEXT    NULL,
    synced_seq           INTEGER NOT NULL DEFAULT 0,    -- last completely pulled state
    scheduled_seq        INTEGER NULL,                  -- deviceState (native shell)
    local_notifications  TEXT    NULL CHECK (local_notifications IN ('granted', 'denied')),
    native_push_platform TEXT    NULL CHECK (native_push_platform IN ('fcm', 'apns')),
    native_push_token    TEXT    NULL
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
    id_hash    TEXT    PRIMARY KEY,                     -- SHA-256 (hex) of the cookie value
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id  TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);
CREATE INDEX sessions_device ON sessions(device_id);

CREATE TABLE push_subscriptions (
    device_id       TEXT    PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    endpoint        TEXT    NOT NULL,
    p256dh          TEXT    NOT NULL,
    auth            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    last_success_at TEXT    NULL,
    failures        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notes (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT    NOT NULL,
    payload     TEXT    NULL,                           -- Note JSON; NULL for tombstones
    updated_at  TEXT    NOT NULL,
    updated_by  TEXT    NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL,
    received_at TEXT    NOT NULL,                       -- diagnostics only, never LWW
    PRIMARY KEY (user_id, id)
);
CREATE INDEX notes_seq ON notes(user_id, seq);

CREATE TABLE note_revisions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id    TEXT    NOT NULL,
    payload    TEXT    NULL,
    updated_at TEXT    NOT NULL,
    updated_by TEXT    NOT NULL,
    reason     TEXT    NOT NULL CHECK (reason IN ('replaced', 'rejected')),
    stored_at  TEXT    NOT NULL
);
CREATE INDEX note_revisions_note ON note_revisions(user_id, note_id);
CREATE INDEX note_revisions_stored ON note_revisions(stored_at);

CREATE TABLE reminders (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id     TEXT    NOT NULL,
    payload     TEXT    NULL,                           -- Reminder JSON; NULL for tombstones
    updated_at  TEXT    NOT NULL,
    updated_by  TEXT    NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL,
    received_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, note_id)
);
CREATE INDEX reminders_seq ON reminders(user_id, seq);

CREATE TABLE note_order (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ids        TEXT    NOT NULL,                        -- JSON array of note ids
    updated_at TEXT    NOT NULL,
    updated_by TEXT    NOT NULL,
    seq        INTEGER NOT NULL
);

-- At most one push per device and occurrence (noteId, at) – §7.4, filled by phase D.
CREATE TABLE push_log (
    device_id TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    note_id   TEXT    NOT NULL,
    at        TEXT    NOT NULL,
    channel   TEXT    NOT NULL CHECK (channel IN ('webpush', 'fcm', 'apns')),
    sent_at   TEXT    NULL,
    status    TEXT    NOT NULL,
    attempts  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, note_id, at)
);
