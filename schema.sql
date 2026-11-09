-- Skema Turso (SQLite) untuk aplikasi Absensi dengan auth multi-user.
-- Buat database: turso db create absensi
-- Terapkan:     turso db shell absensi < schema.sql

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,                 -- UUID
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt        TEXT NOT NULL,
    hash        TEXT NOT NULL,                    -- SHA-256 berulang + salt
    api_key     TEXT NOT NULL UNIQUE,             -- untuk sync browser
    dibuat      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tanggal     TEXT NOT NULL,                     -- YYYY-MM-DD
    jam_datang  TEXT,                              -- HH:MM
    jam_pulang  TEXT,                              -- HH:MM
    status      TEXT NOT NULL DEFAULT 'hadir',
    catatan     TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, tanggal)
);

CREATE TABLE IF NOT EXISTS pengaturan (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    nama        TEXT,
    jam_masuk_normal TEXT DEFAULT '08:00',
    jam_pulang_normal TEXT DEFAULT '17:00',
    tarif_harian REAL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_user_tanggal ON records (user_id, tanggal);
CREATE INDEX IF NOT EXISTS idx_records_user ON records (user_id);
