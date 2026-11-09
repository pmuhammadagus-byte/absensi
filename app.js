// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) dan dapat disinkronkan ke Turso via worker.

const K_RECORDS = 'absensi.records.v1';
const K_SETTINGS = 'absensi.settings.v1';
const K_SYNC = 'absensi.sync.v1';

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

const DEFAULT_SETTINGS = {
  nama: '',
  jamMasukNormal: '08:00',
  jamPulangNormal: '17:00',
  toleransi: 10,
  gajiPokok: 0,
  tunjangan: 0,
  hariEfektif: 22,
  tarifLembur: 0,
  potonganMenit: 0,
};

const DEFAULT_SYNC = { url: '', token: '' };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}
function loadArr(key) {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Gagal menyimpan', key, e);
  }
}

let settings = load(K_SETTINGS, DEFAULT_SETTINGS);
let sync = load(K_SYNC, DEFAULT_SYNC);
let records = loadArr(K_RECORDS);

/* ---------- util waktu ---------- */

const toMinutes = (hhmm) => {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Durasi kerja dalam menit; shift malam (pulang < datang) dihitung lewat tengah malam. */
function durasiMenit(datang, pulang) {
  const a = toMinutes(datang);
  const b = toMinutes(pulang);
  if (a == null || b == null) return 0;
  let d = b - a;
  if (d < 0) d += 24 * 60;
  return d;
}

/* ---------- perhitungan ---------- */

/**
 * Menghitung turunan satu record: jam kerja, lembur, menit telat.
 * Lembur dihitung terhadap jam pulang normal (atau durasi normal bila jam pulang lebih pendek).
 */
function derive(rec) {
  const masukNormal = toMinutes(settings.jamMasukNormal) ?? 8 * 60;
  const pulangNormal = toMinutes(settings.jamPulangNormal) ?? 17 * 60;
  const durasiNormal = durasiMenit(settings.jamMasukNormal, settings.jamPulangNormal);
  const toleransi = Number(settings.toleransi) || 0;

  if (rec.status && rec.status !== 'hadir') {
    return { ...rec, jamKerja: 0, lembur: 0, telat: 0 };
  }

  const kerja = durasiMenit(rec.jamDatang, rec.jamPulang);
  const datangMenit = toMinutes(rec.jamDatang);

  const telat = datangMenit == null ? 0 : Math.max(0, datangMenit - (masukNormal + toleransi));

  let lemburMenit = 0;
  if (kerja > durasiNormal) lemburMenit = kerja - durasiNormal;
  const pulangMenit = toMinutes(rec.jamPulang);
  if (pulangMenit != null && pulangMenit > pulangNormal && pulangMenit - pulangNormal > lemburMenit) {
    lemburMenit = pulangMenit - pulangNormal;
  }

  return {
    ...rec,
    jamKerja: Math.round((kerja / 60) * 100) / 100,
    lembur: Math.round((lemburMenit / 60) * 100) / 100,
    telat,
  };
}

function recordsPeriode(periode) {
  return records
    .filter((r) => r.tanggal.startsWith(periode))
    .map(derive)
    .sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0));
}

function rekap(periode) {
  const list = recordsPeriode(periode);
  const hadir = list.filter((r) => r.status === 'hadir');
  const totalJamKerja = hadir.reduce((a, r) => a + r.jamKerja, 0);
  const totalLembur = hadir.reduce((a, r) => a + r.lembur, 0);
  const totalTelatMenit = hadir.reduce((a, r) => a + r.telat, 0);

  const hariEfektif = Math.max(1, Number(settings.hariEfektif) || 22);
  const honorHarian = (Number(settings.gajiPokok) + Number(settings.tunjangan)) / hariEfektif;
  const gajiHarian = honorHarian * hadir.length;
  const upahLembur = totalLembur * Number(settings.tarifLembur || 0);
  const potonganTelat = totalTelatMenit * Number(settings.potonganMenit || 0);
  const gajiBersih = gajiHarian + upahLembur - potonganTelat;

  return {
    list,
    jumlahHadir: hadir.length,
    jumlahTelat: hadir.filter((r) => r.telat > 0).length,
    totalJamKerja,
    totalLembur,
    totalTelatMenit,
    honorHarian,
    gajiHarian,
    upahLembur,
    potonganTelat,
    gajiBersih,
  };
}

/* ---------- render ---------- */

function renderRekap() {
  const periode = $('periode').value;
  const r = rekap(periode);

  $('rHadir').textContent = r.jumlahHadir;
  $('rTelat').textContent = r.jumlahTelat + 'x';
  $('rJam').textContent = angka(r.totalJamKerja) + ' jam';
  $('rLembur').textContent = angka(r.totalLembur) + ' jam';
  $('rPotongan').textContent = rupiah(r.potonganTelat);
  $('rGaji').textContent = rupiah(r.gajiBersih);

  const rows = [
    ['Honor harian', rupiah(r.honorHarian)],
    [`Gaji harian × ${r.jumlahHadir} hari`, rupiah(r.gajiHarian)],
    [`Lembur ${angka(r.totalLembur)} jam`, '+ ' + rupiah(r.upahLembur)],
    [`Telat ${r.totalTelatMenit} menit`, '− ' + rupiah(r.potonganTelat)],
  ];

  $('breakdown').innerHTML =
    rows.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join('') +
    `<li class="total"><span>Gaji Bersih</span><span>${rupiah(r.gajiBersih)}</span></li>`;

  renderTabel(r.list);
}

function renderTabel(list) {
  const tbody = $('tabelAbsen').querySelector('tbody');

  tbody.innerHTML = list
    .map((r, i) => {
      const late = r.telat > 0 ? ' <span class="badge late">telat</span>' : '';
      return `<tr>
        <td>${r.tanggal}</td>
        <td>${r.jamDatang || '-'}</td>
        <td>${r.jamPulang || '-'}</td>
        <td>${angka(r.jamKerja)} jam</td>
        <td>${angka(r.lembur)} jam</td>
        <td>${r.telat ? r.telat + ' mnt' + late : '-'}</td>
        <td><span class="badge ${r.status || 'hadir'}">${r.status || 'hadir'}</span></td>
        <td>${r.catatan ? escapeHtml(r.catatan) : '-'}</td>
        <td>
          <button class="btn small" data-edit="${r.id}" type="button">Edit</button>
          <button class="btn small danger" data-hapus="${r.id}" type="button">Hapus</button>
        </td>
      </tr>`;
    })
    .join('');

  $('emptyAbsen').style.display = list.length ? 'none' : 'block';

  tbody.querySelectorAll('[data-hapus]').forEach((btn) => {
    btn.addEventListener('click', () => hapusRecord(btn.dataset.hapus));
  });
  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => muatKeForm(btn.dataset.edit));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- operasi data ---------- */

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || 'r' + Date.now() + Math.random().toString(16).slice(2);
}

function simpanLokal() {
  save(K_RECORDS, records);
}

function hapusRecord(id) {
  if (!confirm('Hapus absensi ini?')) return;
  records = records.filter((r) => r.id !== id);
  simpanLokal();
  renderRekap();
  pushSync();
}

function muatKeForm(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  $('tanggal').value = r.tanggal;
  $('jamDatang').value = r.jamDatang || '';
  $('jamPulang').value = r.jamPulang || '';
  $('status').value = r.status || 'hadir';
  $('catatan').value = r.catatan || '';
  $('btnTambah').textContent = 'Perbarui Absensi';
  $('btnTambah').dataset.editId = id;
  $('tanggal').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetForm() {
  $('tanggal').value = todayStr();
  $('jamDatang').value = '';
  $('jamPulang').value = '';
  $('status').value = 'hadir';
  $('catatan').value = '';
  $('btnTambah').textContent = 'Simpan Absensi';
  delete $('btnTambah').dataset.editId;
}

function simpanAbsensi() {
  const tanggal = $('tanggal').value;
  if (!tanggal) return alert('Tanggal wajib diisi.');

  const status = $('status').value;
  const jamDatang = $('jamDatang').value;
  const jamPulang = $('jamPulang').value;

  if (status === 'hadir' && (!jamDatang || !jamPulang)) {
    return alert('Untuk status hadir, jam datang dan jam pulang wajib diisi.');
  }

  const payload = {
    tanggal,
    jamDatang,
    jamPulang,
    status,
    catatan: $('catatan').value.trim(),
  };

  const editId = $('btnTambah').dataset.editId;
  if (editId) {
    records = records.map((r) => (r.id === editId ? { ...r, ...payload } : r));
  } else {
    const dup = records.find((r) => r.tanggal === tanggal);
    if (dup && !confirm(`Tanggal ${tanggal} sudah ada. Timpa?`)) return;
    records = records.filter((r) => r.tanggal !== tanggal);
    records.push({ id: newId(), ...payload });
  }

  simpanLokal();
  resetForm();
  $('periode').value = tanggal.slice(0, 7);
  renderRekap();
  pushSync();
}

function exportCsv() {
  const list = recordsPeriode($('periode').value);
  if (!list.length) return alert('Tidak ada data untuk diekspor.');

  const head = ['tanggal', 'jam_datang', 'jam_pulang', 'jam_kerja', 'lembur', 'telat_menit', 'status', 'catatan'];
  const lines = [head.join(',')].concat(
    list.map((r) =>
      [r.tanggal, r.jamDatang, r.jamPulang, r.jamKerja, r.lembur, r.telat, r.status, `"${(r.catatan || '').replace(/"/g, '""')}"`].join(',')
    )
  );

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `absensi-${$('periode').value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- sync Turso ---------- */

function setSyncState(state, text) {
  const el = $('syncState');
  el.className = 'pill ' + state;
  el.textContent = text;
}

function syncEnabled() {
  return Boolean(sync.url);
}

async function api(path, options = {}) {
  const res = await fetch(sync.url.replace(/\/$/, '') + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sync.token ? { Authorization: `Bearer ${sync.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pullSync() {
  if (!syncEnabled()) return setSyncState('off', 'offline');
  setSyncState('busy', 'sync...');
  try {
    const data = await api('/api/records');
    if (Array.isArray(data.records)) {
      records = data.records;
      simpanLokal();
      renderRekap();
    }
    setSyncState('on', 'tersinkron');
  } catch (e) {
    console.warn(e);
    setSyncState('err', 'gagal sync');
  }
}

let pushTimer = null;
function pushSync() {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    setSyncState('busy', 'mengirim...');
    try {
      await api('/api/records', {
        method: 'PUT',
        body: JSON.stringify({ records }),
      });
      setSyncState('on', 'tersinkron');
    } catch (e) {
      console.warn(e);
      setSyncState('err', 'gagal kirim');
    }
  }, 700);
}

/* ---------- init ---------- */

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function isiFormDariSettings() {
  $('nama').value = settings.nama || '';
  $('jamMasukNormal').value = settings.jamMasukNormal;
  $('jamPulangNormal').value = settings.jamPulangNormal;
  $('toleransi').value = settings.toleransi;
  $('gajiPokok').value = settings.gajiPokok;
  $('tunjangan').value = settings.tunjangan;
  $('hariEfektif').value = settings.hariEfektif;
  $('tarifLembur').value = settings.tarifLembur;
  $('potonganMenit').value = settings.potonganMenit;
  $('syncUrl').value = sync.url || '';
  $('syncToken').value = sync.token || '';
}

function bacaSettingsDariForm() {
  settings = {
    nama: $('nama').value.trim(),
    jamMasukNormal: $('jamMasukNormal').value || '08:00',
    jamPulangNormal: $('jamPulangNormal').value || '17:00',
    toleransi: Number($('toleransi').value) || 0,
    gajiPokok: Number($('gajiPokok').value) || 0,
    tunjangan: Number($('tunjangan').value) || 0,
    hariEfektif: Math.max(1, Number($('hariEfektif').value) || 22),
    tarifLembur: Number($('tarifLembur').value) || 0,
    potonganMenit: Number($('potonganMenit').value) || 0,
  };
  sync = { url: $('syncUrl').value.trim(), token: $('syncToken').value.trim() };
  save(K_SETTINGS, settings);
  save(K_SYNC, sync);
}

function init() {
  isiFormDariSettings();
  resetForm();
  $('periode').value = todayStr().slice(0, 7);
  renderRekap();
  setSyncState(syncEnabled() ? 'busy' : 'off', syncEnabled() ? 'menghubungkan' : 'offline');
  if (syncEnabled()) pullSync();

  $('btnMasuk').addEventListener('click', () => ($('jamDatang').value = nowHHMM()));
  $('btnPulang').addEventListener('click', () => ($('jamPulang').value = nowHHMM()));
  $('btnTambah').addEventListener('click', simpanAbsensi);
  $('btnExport').addEventListener('click', exportCsv);
  $('periode').addEventListener('change', renderRekap);

  $('btnPengaturan').addEventListener('click', () => {
    const card = $('cardPengaturan');
    card.hidden = !card.hidden;
  });

  ['nama', 'jamMasukNormal', 'jamPulangNormal', 'toleransi', 'gajiPokok', 'tunjangan', 'hariEfektif', 'tarifLembur', 'potonganMenit'].forEach(
    (id) => $(id).addEventListener('change', () => {
      bacaSettingsDariForm();
      renderRekap();
    })
  );

  ['syncUrl', 'syncToken'].forEach((id) => $(id).addEventListener('change', bacaSettingsDariForm));

  $('btnSync').addEventListener('click', async () => {
    bacaSettingsDariForm();
    if (!syncEnabled()) {
      alert('Isi Endpoint Sync di Pengaturan terlebih dahulu.');
      return;
    }
    await pullSync();
    await api('/api/records', { method: 'PUT', body: JSON.stringify({ records }) })
      .then(() => setSyncState('on', 'tersinkron'))
      .catch(() => setSyncState('err', 'gagal kirim'));
  });
}

document.addEventListener('DOMContentLoaded', init);
