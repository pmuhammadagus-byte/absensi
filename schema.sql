-- Skema opsional: sinkronisasi cloud dengan Turso (SQLite).
-- Website tetap berjalan tanpa database (localStorage).
-- Jalankan: turso db shell <nama-db> < schema.sql

CREATE TABLE IF NOT EXISTS karyawan (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nama         TEXT    NOT NULL,
    gaji_pokok   REAL    NOT NULL DEFAULT 0,
    tunjangan    REAL    NOT NULL DEFAULT 0,
    hari_efektif INTEGER NOT NULL DEFAULT 22,
    jam_normal   REAL    NOT NULL DEFAULT 8,
    tarif_lembur REAL    NOT NULL DEFAULT 0,
    potongan     REAL    NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS absensi (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    karyawan_id INTEGER NOT NULL REFERENCES karyawan(id) ON DELETE CASCADE,
    tanggal     TEXT    NOT NULL,                 -- YYYY-MM-DD
    jam_datang  TEXT    NOT NULL,                 -- HH:MM (input manual)
    jam_pulang  TEXT    NOT NULL,                 -- HH:MM (input manual)
    jam_kerja   REAL    NOT NULL DEFAULT 0,
    lembur      REAL    NOT NULL DEFAULT 0,
    UNIQUE (karyawan_id, tanggal)
);

CREATE TABLE IF NOT EXISTS riwayat_gaji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    karyawan_id INTEGER NOT NULL REFERENCES karyawan(id) ON DELETE CASCADE,
    periode     TEXT    NOT NULL,                 -- YYYY-MM
    total_hari  INTEGER NOT NULL DEFAULT 0,
    total_lembur REAL   NOT NULL DEFAULT 0,
    gaji_bersih REAL    NOT NULL DEFAULT 0,
    detail      TEXT,                             -- JSON rincian
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_absensi_karyawan ON absensi (karyawan_id, tanggal);
CREATE INDEX IF NOT EXISTS idx_riwayat_karyawan ON riwayat_gaji (karyawan_id, periode);
