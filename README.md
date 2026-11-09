# Hitung Gaji

Kalkulator gaji sederhana berbasis jam kerja. Jam datang dan jam pulang diisi **manual**.

Live: https://pmuhammadagus-byte.github.io/hitung-gaji/

## Fitur

- Input data karyawan: gaji pokok, tunjangan, hari kerja efektif, jam kerja normal, tarif lembur, potongan.
- Absensi manual: tanggal, jam datang, jam pulang. Mendukung shift melewati tengah malam.
- Perhitungan otomatis: honor harian, gaji harian, lembur, potongan proporsional, gaji bersih.
- Riwayat perhitungan disimpan di browser (localStorage).
- Tanpa backend, tanpa dependency — cukup file statis.

## Rumus

```
honor_harian   = (gaji_pokok + tunjangan) / hari_efektif
gaji_harian    = honor_harian * total_hari_hadir
upah_lembur    = total_jam_lembur * tarif_lembur
potongan_prop  = (potongan_bulanan / hari_efektif) * total_hari_hadir
gaji_bersih    = gaji_harian + upah_lembur - potongan_prop

jam_kerja = jam_pulang - jam_datang   (dibulatkan +24 jam bila negatif)
lembur    = max(0, jam_kerja - jam_normal)
```

## Menjalankan lokal

```bash
python3 -m http.server 8080
# buka http://localhost:8080
```

## Database opsional (Turso / SQLite)

Website berjalan penuh tanpa database. Jika nanti ingin sinkronisasi cloud, tersedia `schema.sql` untuk Turso (SQLite):

```bash
turso db create hitung-gaji
turso db shell hitung-gaji < schema.sql
```

Alasan memilih SQLite/Turso: gratis, ringan, HTTP API cocok untuk situs statis, dan tidak butuh server sendiri.

## Alternatif database lain

| Database | Cocok untuk |
| --- | --- |
| Turso / SQLite | Situs statis, data relasional kecil, gratis |
| Cloudflare D1 | Jika sudah pakai Cloudflare Pages/Workers |
| Firebase Firestore | Realtime sync, SDK JS mudah, gratis tier |
| MongoDB Atlas | Skema fleksibel, gratis 512MB |
| Neon / PlanetScale (Postgres/MySQL) | Serverless SQL, gratis tier |

## Lisensi

MIT
