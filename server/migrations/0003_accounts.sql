-- v4: accounts, registration, recovery, pairing, invites, quotas (PLAN_V4 §4). Additive only:
-- v3 data stays as it is; existing accounts get created_via = 'cli' and no recovery code.

-- users: registration, recovery, admin lock, quotas, E2E preparation (D-101)
ALTER TABLE users ADD COLUMN created_via         TEXT    NOT NULL DEFAULT 'cli'
      CHECK (created_via IN ('cli', 'register', 'invite'));
ALTER TABLE users ADD COLUMN recovery_hash       TEXT    NULL;     -- SHA-256 (hex) of the normalised code
ALTER TABLE users ADD COLUMN recovery_created_at TEXT    NULL;
ALTER TABLE users ADD COLUMN password_changed_at TEXT    NULL;
ALTER TABLE users ADD COLUMN disabled_at         TEXT    NULL;     -- admin lock (CLI)
ALTER TABLE users ADD COLUMN quota_bytes         INTEGER NULL;     -- NULL = server default
ALTER TABLE users ADD COLUMN quota_notes         INTEGER NULL;
ALTER TABLE users ADD COLUMN quota_devices       INTEGER NULL;
ALTER TABLE users ADD COLUMN content_format      INTEGER NOT NULL DEFAULT 1;  -- 1 = plain JSON

ALTER TABLE devices ADD COLUMN created_via TEXT NOT NULL DEFAULT 'password'
      CHECK (created_via IN ('password', 'register', 'pairing', 'recovery'));

CREATE TABLE pairings (
    id                 TEXT    PRIMARY KEY,                       -- UUID v4
    user_id            INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    created_by         TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    code_hash          TEXT    NOT NULL UNIQUE,                   -- SHA-256 (hex) of the normalised code
    created_at         TEXT    NOT NULL,
    expires_at         TEXT    NOT NULL,                          -- created_at + 3 min
    cancelled_at       TEXT    NULL,
    redeemed_at        TEXT    NULL,
    redeemed_device_id TEXT    NULL REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX pairings_user ON pairings(user_id);

CREATE TABLE invites (
    code_hash  TEXT    PRIMARY KEY,                               -- SHA-256 (hex)
    created_at TEXT    NOT NULL,
    expires_at TEXT    NULL,
    used_at    TEXT    NULL,
    used_by    INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    label      TEXT    NULL                                       -- admin note, e.g. "for Anna"
);
