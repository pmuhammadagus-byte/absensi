# Absensi

Aplikasi absensi sederhana: catat kehadiran **manual** (jam datang & jam pulang terisi otomatis dari jam sekarang, tapi bisa diubah), lalu lembur dan gaji dihitung otomatis.

Live: https://pmuhammadagus-byte.github.io/absensi/

## Fitur

- Catat kehadiran: tanggal, jam datang, jam pulang, status (hadir/izin/sakit/cuti), catatan.
- Tombol "Isi Jam Datang = Sekarang" / "Isi Jam Pulang = Sekarang" — tetap bisa diedit manual.
- Perhitungan otomatis per periode (bulanan):
  - jam kerja = jam pulang − jam datang (shift malam didukung)
  - lembur = kelebihan di atas 9 jam kerja normal
  - telat = menit setelah jam masuk + toleransi
  - gaji harian, upah lembur, potongan telat, gaji bersih
- Edit / hapus absensi, ekspor CSV.
- Sinkronisasi cloud opsional ke **Turso** (SQLite) melalui Cloudflare Worker.

## Rumus

```
JAM_NORMAL    = 9 jam

jam_kerja     = jam_pulang - jam_datang           (dibulatkan +24 jam bila negatif)
lembur        = max(0, jam_kerja - JAM_NORMAL)
telat         = max(0, (jam_datang - (jam_masuk_normal + toleransi)))

tarif_per_jam = tarif_harian / JAM_NORMAL
gaji_harian   = tarif_harian * jumlah_hari_hadir
upah_lembur   = total_lembur_jam * tarif_per_jam
potongan      = total_telat_menit * potongan_per_menit
gaji_bersih   = gaji_harian + upah_lembur - potongan
```

## Menjalankan lokal

```bash
python3 -m http.server 8080
# buka http://localhost:8080
```

Tanpa konfigurasi apa pun, aplikasi langsung berjalan dalam mode lokal (data di `localStorage`).

## Sinkronisasi Turso

1. Buat database dan terapkan skema:

```bash
turso db create absensi
turso db shell absensi < schema.sql
```

2. Deploy worker sinkronisasi:

```bash
cd worker
npm install
npx wrangler secret put TURSO_DATABASE_URL   # libsql://<db>-<org>.turso.io
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put SYNC_TOKEN           # token bebas, dipakai juga di web
npx wrangler deploy
```

3. Buka website → **Pengaturan** → isi `Endpoint Sync` (URL worker) dan `Sync Token`, lalu klik **Sync Turso**.

Selama `Endpoint Sync` kosong, aplikasi tetap berjalan penuh secara lokal.

## Struktur

```
index.html      UI
style.css       styling
app.js          logika absensi, perhitungan, sync
schema.sql      skema Turso/SQLite
worker/         Cloudflare Worker untuk API sinkronisasi
```

## Alternatif database

| Database | Catatan |
| --- | --- |
| Turso / SQLite | dipakai — gratis, ringan, HTTP API |
| Cloudflare D1 | naturan kalau worker sudah di Cloudflare |
| Firebase Firestore | realtime, SDK mudah |
| MongoDB Atlas | skema fleksibel, gratis 512MB |
| Neon (Postgres) | serverless SQL, gratis tier |

## Lisensi

MIT
