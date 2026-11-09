-- Skema Turso (SQLite) untuk aplikasi Absensi.
-- Buat database: turso db create absensi
-- Terapkan:     turso db shell absensi < schema.sql

CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,
    tanggal     TEXT NOT NULL,             -- YYYY-MM-DD
    jam_datang  TEXT,                      -- HH:MM (input manual)
    jam_pulang  TEXT,                      -- HH:MM (input manual)
    status      TEXT NOT NULL DEFAULT 'hadir',
    catatan     TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_tanggal ON records (tanggal);

CREATE TABLE IF NOT EXISTS pengaturan (
    kunci      TEXT PRIMARY KEY,
    nilai      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
