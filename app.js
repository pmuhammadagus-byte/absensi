// Hitung Gaji — kalkulasi gaji berdasarkan absensi manual (jam datang & jam pulang)
// Data disimpan di localStorage browser (tanpa backend).

const STORE_ABSEN = 'hitunggaji.absensi.v1';
const STORE_RIWAYAT = 'hitunggaji.riwayat.v1';

const $ = (id) => document.getElementById(id);

const rupiah = (n) =>
  'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

const jam = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Gagal menyimpan data:', e);
  }
}

let absensi = readStore(STORE_ABSEN, []);
let riwayat = readStore(STORE_RIWAYAT, []);

/** Menghitung selisih jam antara jamDatang dan jamPulang (mendukung shift melewati tengah malam). */
function hitungDurasi(datang, pulang) {
  const [dh, dm] = datang.split(':').map(Number);
  const [ph, pm] = pulang.split(':').map(Number);
  if ([dh, dm, ph, pm].some((v) => Number.isNaN(v))) return 0;
  let menit = ph * 60 + pm - (dh * 60 + dm);
  if (menit < 0) menit += 24 * 60; // shift malam
  return menit / 60;
}

function nomorInput(id) {
  return Math.max(0, Number($(id).value) || 0);
}

function hitungSemua() {
  const gajiPokok = nomorInput('gajiPokok');
  const tunjangan = nomorInput('tunjangan');
  const hariEfektif = Math.max(1, nomorInput('hariEfektif'));
  const jamNormal = Math.max(0.5, nomorInput('jamNormal'));
  const tarifLembur = nomorInput('tarifLembur');
  const potonganBulanan = nomorInput('potongan');

  const totalJam = absensi.reduce((acc, a) => acc + a.jamKerja, 0);
  const totalLembur = absensi.reduce((acc, a) => acc + a.lembur, 0);
  const totalHari = absensi.length;

  const honorHarian = (gajiPokok + tunjangan) / hariEfektif;
  const gajiHarian = honorHarian * totalHari;
  const potonganProporsional = (potonganBulanan / hariEfektif) * totalHari;
  const upahLembur = totalLembur * tarifLembur;
  const gajiBersih = gajiHarian - potonganProporsional + upahLembur;

  return {
    gajiPokok,
    tunjangan,
    hariEfektif,
    jamNormal,
    tarifLembur,
    potonganBulanan,
    totalJam,
    totalLembur,
    totalHari,
    honorHarian,
    gajiHarian,
    potonganProporsional,
    upahLembur,
    gajiBersih,
  };
}

function renderBreakdown(h) {
  const rows = [
    ['Honor harian (gaji + tunjangan / hari efektif)', rupiah(h.honorHarian)],
    [`Gaji harian × ${h.totalHari} hari`, rupiah(h.gajiHarian)],
    [`Lembur ${jam(h.totalLembur)} jam × ${rupiah(h.tarifLembur)}`, '+ ' + rupiah(h.upahLembur)],
    ['Potongan proporsional', '− ' + rupiah(h.potonganProporsional)],
  ];

  $('breakdown').innerHTML =
    rows
      .map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`)
      .join('') +
    `<li class="total"><span>Gaji Bersih</span><span>${rupiah(h.gajiBersih)}</span></li>`;
}

function renderRingkasan() {
  const h = hitungSemua();
  $('rHari').textContent = h.totalHari;
  $('rJam').textContent = jam(h.totalJam) + ' jam';
  $('rLembur').textContent = jam(h.totalLembur) + ' jam';
  $('rBersih').textContent = rupiah(h.gajiBersih);
  renderBreakdown(h);
}

function renderAbsensi() {
  const tbody = $('tabelAbsen').querySelector('tbody');
  const jamNormal = Math.max(0.5, nomorInput('jamNormal'));

  absensi.sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0));

  tbody.innerHTML = absensi
    .map((a, i) => {
      const lembur = Math.max(0, a.jamKerja - jamNormal);
      return `<tr>
        <td>${a.tanggal}</td>
        <td>${a.datang}</td>
        <td>${a.pulang}</td>
        <td>${jam(a.jamKerja)} jam</td>
        <td>${jam(lembur)} jam</td>
        <td><button class="btn small danger" data-hapus="${i}" type="button">Hapus</button></td>
      </tr>`;
    })
    .join('');

  $('emptyAbsen').style.display = absensi.length ? 'none' : 'block';

  tbody.querySelectorAll('[data-hapus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      absensi.splice(Number(btn.dataset.hapus), 1);
      writeStore(STORE_ABSEN, absensi);
      renderAbsensi();
      renderRingkasan();
    });
  });
}

function renderRiwayat() {
  const tbody = $('tabelRiwayat').querySelector('tbody');
  tbody.innerHTML = riwayat
    .map(
      (r, i) => `<tr>
        <td>${new Date(r.waktu).toLocaleString('id-ID')}</td>
        <td>${r.nama || '-'}</td>
        <td>${r.totalHari}</td>
        <td>${jam(r.totalLembur)}</td>
        <td>${rupiah(r.gajiBersih)}</td>
        <td><button class="btn small danger" data-hapus-riwayat="${i}" type="button">Hapus</button></td>
      </tr>`
    )
    .join('');

  $('emptyRiwayat').style.display = riwayat.length ? 'none' : 'block';

  tbody.querySelectorAll('[data-hapus-riwayat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      riwayat.splice(Number(btn.dataset.hapusRiwayat), 1);
      writeStore(STORE_RIWAYAT, riwayat);
      renderRiwayat();
    });
  });
}

function tambahAbsensi() {
  const tanggal = $('tanggal').value;
  const datang = $('jamDatang').value;
  const pulang = $('jamPulang').value;

  if (!tanggal) {
    alert('Tanggal wajib diisi.');
    return;
  }
  if (!datang || !pulang) {
    alert('Jam datang dan jam pulang wajib diisi.');
    return;
  }

  const jamKerja = hitungDurasi(datang, pulang);
  if (jamKerja <= 0) {
    alert('Durasi kerja tidak valid.');
    return;
  }

  const jamNormal = Math.max(0.5, nomorInput('jamNormal'));
  const lembur = Math.max(0, jamKerja - jamNormal);

  absensi.push({ tanggal, datang, pulang, jamKerja, lembur });
  writeStore(STORE_ABSEN, absensi);
  renderAbsensi();
  renderRingkasan();
}

function simpanRiwayat() {
  const h = hitungSemua();
  if (h.totalHari === 0) {
    alert('Belum ada data absensi untuk disimpan.');
    return;
  }
  riwayat.unshift({
    waktu: new Date().toISOString(),
    nama: $('nama').value.trim(),
    pengaturan: {
      gajiPokok: h.gajiPokok,
      tunjangan: h.tunjangan,
      hariEfektif: h.hariEfektif,
      jamNormal: h.jamNormal,
      tarifLembur: h.tarifLembur,
      potonganBulanan: h.potonganBulanan,
    },
    absensi: absensi.map((a) => ({ ...a })),
    totalHari: h.totalHari,
    totalLembur: h.totalLembur,
    gajiBersih: h.gajiBersih,
  });
  writeStore(STORE_RIWAYAT, riwayat);
  renderRiwayat();
}

function resetSemua() {
  if (!confirm('Hapus data absensi dan pengaturan saat ini?')) return;
  absensi = [];
  writeStore(STORE_ABSEN, absensi);
  $('nama').value = '';
  $('gajiPokok').value = 0;
  $('tunjangan').value = 0;
  $('hariEfektif').value = 22;
  $('jamNormal').value = 8;
  $('tarifLembur').value = 0;
  $('potongan').value = 0;
  renderAbsensi();
  renderRingkasan();
}

function init() {
  $('tanggal').value = new Date().toISOString().slice(0, 10);

  $('tambahAbsen').addEventListener('click', tambahAbsensi);
  $('simpan').addEventListener('click', simpanRiwayat);
  $('reset').addEventListener('click', resetSemua);

  ['gajiPokok', 'tunjangan', 'hariEfektif', 'jamNormal', 'tarifLembur', 'potongan'].forEach((id) => {
    $(id).addEventListener('input', () => {
      renderAbsensi();
      renderRingkasan();
    });
  });

  renderAbsensi();
  renderRingkasan();
  renderRiwayat();
}

document.addEventListener('DOMContentLoaded', init);
