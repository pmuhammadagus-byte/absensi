# Absensi

Aplikasi absensi: catat kehadiran **manual** (jam datang & jam pulang), lembur dan gaji dihitung otomatis. Mendukung **login multi-user** dengan backend Cloudflare Worker + Turso.

Live: https://pmuhammadagus-byte.github.io/absensi/

## Fitur

- **Login & daftar** username/password (server-side, password di-hash SHA-256 + salt).
- Catat kehadiran: tanggal, jam datang, jam pulang, status (hadir/izin/sakit/cuti), catatan.
- Tombol "Datang sekarang" / "Pulang sekarang" — jam terisi otomatis, tetap bisa diedit.
- Perhitungan otomatis per periode (bulanan):
  - jam kerja = jam pulang − jam datang (shift malam didukung)
  - lembur = kelebihan di atas 9 jam kerja normal
  - gaji bersih = (tarif harian × hari hadir) + (lembur × tarif per jam)
- Edit / hapus absensi, ekspor CSV.
- **Sync cloud** via Cloudflare Worker + Turso — data tersimpan di server, bisa diakses dari perangkat lain.

## Rumus

```
JAM_NORMAL    = 9 jam

jam_kerja     = jam_pulang - jam_datang           (dibulatkan +24 jam bila negatif)
lembur        = max(0, jam_kerja - JAM_NORMAL)

tarif_per_jam = tarif_harian / JAM_NORMAL
gaji_harian   = tarif_harian * jumlah_hari_hadir
upah_lembur   = total_lembur_jam * tarif_per_jam
gaji_bersih   = gaji_harian + upah_lembur
```

## Menjalankan lokal (frontend saja)

```bash
python3 -m http.server 8080
# buka http://localhost:8080
```

Tanpa backend, aplikasi berjalan dalam mode lokal (data di `localStorage`).

## Setup backend (Cloudflare Worker + Turso)

### 1. Buat database Turso dan terapkan skema

```bash
turso db create absensi
turso db shell absensi < schema.sql
```

Catat URL database (`libsql://...`) dan auth token.

### 2. Deploy worker

```bash
cd worker
npm install
npx wrangler login                                   # sekali saja
npx wrangler secret put TURSO_DATABASE_URL           # libsql://<db>-<org>.turso.io
npx wrangler secret put TURSO_AUTH_TOKEN             # token Turso
npx wrangler deploy
```

Worker akan live di `https://absensi-api.<subdomain>.workers.dev`.

### 3. Hubungkan frontend ke worker

Buka https://pmuhammadagus-byte.github.io/absensi/

1. Klik **Masuk** → tab **Daftar** untuk membuat akun pertama.
2. Jika frontend belum tahu URL worker, klik **Pengaturan** → isi **Endpoint API** dengan URL worker (mis. `https://absensi-api.xxx.workers.dev`).
3. Setelah daftar/login, data absensi & pengaturan otomatis tersimpan ke Turso dan dapat diakses dari perangkat lain dengan login akun yang sama.

### 4. (Alternatif) Pakai parameter URL

Buka situs dengan parameter `?api=<URL worker>`:

```
https://pmuhammadagus-byte.github.io/absensi/?api=https://absensi-api.xxx.workers.dev
```

URL worker akan disimpan otomatis dan dipakai pada kunjungan berikutnya.

## Struktur

```
index.html      UI
style.css       styling
app.js          logika absensi + auth via worker
schema.sql      skema Turso (users, records, pengaturan)
worker/         Cloudflare Worker (register, login, records, settings)
```

## Keamanan

- Password **tidak** disimpan mentah: hash SHA-256 berulang (800×) + salt acak per user, disimpan di Turso.
- Token Turso **tidak** terekspos ke browser; hanya ada di secrets Cloudflare Worker.
- Setiap user mendapat `api_key` unik (dirotasi saat login) untuk akses datanya sendiri. Data per user terpisah.
- Tanpa backend, aplikasi tetap berjalan penuh secara lokal.

## Lisensi

MIT
