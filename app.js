// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) dan dapat disinkronkan ke Turso via worker.

const K_RECORDS = 'absensi.records.v1';
const K_SETTINGS = 'absensi.settings.v1';
const K_SYNC = 'absensi.sync.v1';

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

/* ---------- toast ---------- */
let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast ' + kind;
  }, 2600);
}

const DEFAULT_SETTINGS = {
  nama: '',
  jamMasukNormal: '08:00',
  jamPulangNormal: '17:00',
  toleransi: 10,
  tarifHarian: 0,        // tarif untuk 9 jam kerja normal
  jamNormalHarian: 9,    // basis jam kerja normal
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
 * Jam kerja normal = 9 jam per hari; lembur = kelebihan di atas 9 jam.
 */
function derive(rec) {
  const masukNormal = toMinutes(settings.jamMasukNormal) ?? 8 * 60;
  const toleransi = Number(settings.toleransi) || 0;
  const JAM_NORMAL = Number(settings.jamNormalHarian) || 9;
  const durasiNormal = JAM_NORMAL * 60; // basis normal = 9 jam

  if (rec.status && rec.status !== 'hadir') {
    return { ...rec, jamKerja: 0, lembur: 0, telat: 0 };
  }

  const kerja = durasiMenit(rec.jamDatang, rec.jamPulang);
  const datangMenit = toMinutes(rec.jamDatang);

  const telat = datangMenit == null ? 0 : Math.max(0, datangMenit - (masukNormal + toleransi));

  // Lembur = kelebihan di atas 9 jam kerja normal
  const lemburMenit = Math.max(0, kerja - durasiNormal);

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

  const JAM_NORMAL = Number(settings.jamNormalHarian) || 9;
  const tarifHarian = Number(settings.tarifHarian || 0);

  // Upah harian murni dari tarif harian (9 jam kerja normal)
  const honorHarian = tarifHarian;
  const gajiHarian = honorHarian * hadir.length;
  const tarifPerJam = honorHarian / JAM_NORMAL;
  const upahLembur = totalLembur * tarifPerJam;
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
    tarifHarian,
    tarifPerJam,
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
  $('rTelat').textContent = r.jumlahTelat;
  $('rJam').textContent = angka(r.totalJamKerja);
  $('rLembur').textContent = angka(r.totalLembur);
  $('rGaji').textContent = rupiah(r.gajiBersih);

  const namaBulan = periode
    ? new Date(periode + '-01').toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })
    : '';
  $('heroSub').textContent = r.jumlahHadir
    ? `${r.jumlahHadir} hari hadir · ${angka(r.totalLembur)} jam lembur · ${namaBulan}`
    : 'belum ada data pada periode ini';

  const rows = [
    [`Upah harian × ${r.jumlahHadir} hari`, rupiah(r.gajiHarian), ''],
    [`Tarif per jam (harian ÷ 9 jam)`, rupiah(r.tarifPerJam), ''],
    [`Lembur ${angka(r.totalLembur)} jam × ${rupiah(r.tarifPerJam)}`, '+ ' + rupiah(r.upahLembur), 'pos'],
    [`Potongan telat ${r.totalTelatMenit} menit`, '− ' + rupiah(r.potonganTelat), 'neg'],
  ];

  $('breakdown').innerHTML = rows
    .map(([k, v, cls]) => `<li class="${cls}"><span>${k}</span><span>${v}</span></li>`)
    .join('');

  renderTabel(r.list);
}

function renderTabel(list) {
  const tbody = $('tabelAbsen').querySelector('tbody');

  $('countLabel').textContent = list.length + ' entri';

  tbody.innerHTML = list
    .map((r) => {
      const late = r.telat > 0 ? `<span class="badge late">+${r.telat}m</span>` : '';
      return `<tr>
        <td>${r.tanggal}</td>
        <td>${r.jamDatang || '—'}</td>
        <td>${r.jamPulang || '—'}</td>
        <td>${angka(r.jamKerja)}j</td>
        <td>${r.lembur ? angka(r.lembur) + 'j' : '—'}</td>
        <td>${r.telat ? r.telat + 'm' + late : '—'}</td>
        <td><span class="badge ${r.status || 'hadir'}">${r.status || 'hadir'}</span></td>
        <td>${r.catatan ? escapeHtml(r.catatan) : '—'}</td>
        <td class="td-aksi">
          <button class="btn btn-sm btn-soft" data-edit="${r.id}" type="button">Edit</button>
          <button class="btn btn-sm btn-danger" data-hapus="${r.id}" type="button">Hapus</button>
        </td>
      </tr>`;
    })
    .join('');

  $('emptyAbsen').classList.toggle('show', list.length === 0);
  $('tabelAbsen').style.display = list.length ? '' : 'none';

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
  toast('Absensi dihapus');
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
  $('btnBatal').hidden = false;
  $('tanggal').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetForm() {
  $('tanggal').value = todayStr();
  $('jamDatang').value = '';
  $('jamPulang').value = '';
  $('status').value = 'hadir';
  $('catatan').value = '';
  $('btnTambah').textContent = 'Simpan Absensi';
  $('btnBatal').hidden = true;
  delete $('btnTambah').dataset.editId;
}

function simpanAbsensi() {
  const tanggal = $('tanggal').value;
  if (!tanggal) return toast('Tanggal wajib diisi.', 'err');

  const status = $('status').value;
  const jamDatang = $('jamDatang').value;
  const jamPulang = $('jamPulang').value;

  if (status === 'hadir' && (!jamDatang || !jamPulang)) {
    return toast('Untuk status hadir, jam datang dan pulang wajib diisi.', 'err');
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
    toast('Absensi diperbarui', 'ok');
  } else {
    const dup = records.find((r) => r.tanggal === tanggal);
    if (dup && !confirm(`Tanggal ${tanggal} sudah ada. Timpa?`)) return;
    records = records.filter((r) => r.tanggal !== tanggal);
    records.push({ id: newId(), ...payload });
    toast('Absensi tersimpan', 'ok');
  }

  simpanLokal();
  resetForm();
  $('periode').value = tanggal.slice(0, 7);
  renderRekap();
  pushSync();
}

function exportCsv() {
  const list = recordsPeriode($('periode').value);
  if (!list.length) return toast('Tidak ada data untuk diekspor.', 'err');

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
  const map = { on: 'chip-on', off: 'chip-off', busy: 'chip-busy', err: 'chip-err' };
  el.className = 'chip ' + (map[state] || 'chip-off');
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
  if (!syncEnabled()) return setSyncState('off', 'lokal');
  setSyncState('busy', 'menyinkron');
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
    setSyncState('err', 'gagal');
  }
}

let pushTimer = null;
function pushSync() {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    setSyncState('busy', 'mengirim');
    try {
      await api('/api/records', {
        method: 'PUT',
        body: JSON.stringify({ records }),
      });
      setSyncState('on', 'tersinkron');
    } catch (e) {
      console.warn(e);
      setSyncState('err', 'gagal');
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
  $('tarifHarian').value = settings.tarifHarian;
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
    tarifHarian: Number($('tarifHarian').value) || 0,
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

  const tgl = new Date();
  $('todayLabel').textContent = tgl.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });

  renderRekap();
  setSyncState(syncEnabled() ? 'busy' : 'off', syncEnabled() ? 'menghubungkan' : 'lokal');
  if (syncEnabled()) pullSync();

  const jamSekarang = () => {
    const t = nowHHMM();
    $('nowMasuk').textContent = t;
    $('nowPulang').textContent = t;
  };
  jamSekarang();
  setInterval(jamSekarang, 20000);

  $('btnMasuk').addEventListener('click', () => {
    $('jamDatang').value = nowHHMM();
    toast('Jam datang diisi ' + $('jamDatang').value);
  });
  $('btnPulang').addEventListener('click', () => {
    $('jamPulang').value = nowHHMM();
    toast('Jam pulang diisi ' + $('jamPulang').value);
  });
  $('btnTambah').addEventListener('click', simpanAbsensi);
  $('btnBatal').addEventListener('click', resetForm);
  $('btnExport').addEventListener('click', exportCsv);
  $('periode').addEventListener('change', renderRekap);

  const bukaPengaturan = (buka) => {
    const card = $('cardPengaturan');
    card.hidden = buka === undefined ? !card.hidden : !buka;
    if (!card.hidden) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  $('btnPengaturan').addEventListener('click', () => bukaPengaturan());
  $('btnTutupPengaturan').addEventListener('click', () => {
    bacaSettingsDariForm();
    renderRekap();
    bukaPengaturan(false);
  });

  ['nama', 'jamMasukNormal', 'jamPulangNormal', 'toleransi', 'tarifHarian', 'potonganMenit'].forEach(
    (id) =>
      $(id).addEventListener('change', () => {
        bacaSettingsDariForm();
        renderRekap();
      })
  );

  ['syncUrl', 'syncToken'].forEach((id) => $(id).addEventListener('change', bacaSettingsDariForm));

  $('btnSync').addEventListener('click', async () => {
    bacaSettingsDariForm();
    if (!syncEnabled()) {
      toast('Isi Endpoint Sync di Pengaturan dulu.', 'err');
      bukaPengaturan(true);
      return;
    }
    await pullSync();
    await api('/api/records', { method: 'PUT', body: JSON.stringify({ records }) })
      .then(() => {
        setSyncState('on', 'tersinkron');
        toast('Sinkronisasi selesai', 'ok');
      })
      .catch(() => {
        setSyncState('err', 'gagal');
        toast('Gagal mengirim data', 'err');
      });
  });
}

document.addEventListener('DOMContentLoaded', init);
