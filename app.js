// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) dan dapat disinkronkan ke Turso via worker.

const K_USERS = 'absensi.users.v1';
const K_SESSION = 'absensi.session.v1';

// Kunci data per-user (dipisah agar tiap akun punya absensi sendiri)
const K_RECORDS = 'absensi.records.v1';
const K_SETTINGS = 'absensi.settings.v1';
const K_SYNC = 'absensi.sync.v1';

let recordsKey = K_RECORDS;
let settingsKey = K_SETTINGS;
let syncKey = K_SYNC;

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

/* ---------- auth (server-side via Cloudflare Worker) ---------- */

let currentUser = null;
let authToken = '';
let apiBase = '';

function normUser(u) {
  return String(u || '').trim().toLowerCase();
}

function simpanSesi(username, token) {
  if (username && token) {
    localStorage.setItem(K_SESSION, JSON.stringify({ username, token }));
  } else {
    localStorage.removeItem(K_SESSION);
  }
}

function getSesi() {
  try {
    const raw = localStorage.getItem(K_SESSION);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.username && v.token ? v : null;
  } catch {
    return null;
  }
}

/** Base URL worker: dari pengaturan sync, atau ?api=... di URL. */
function resolveApiBase() {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery) {
    localStorage.setItem('absensi.apibase.v1', fromQuery.replace(/\/$/, ''));
    return fromQuery.replace(/\/$/, '');
  }
  const saved = localStorage.getItem('absensi.apibase.v1');
  if (saved) return saved;
  const fromSync = load(syncKey, DEFAULT_SYNC).url;
  return fromSync ? String(fromSync).replace(/\/$/, '') : '';
}

async function apiFetch(path, options = {}) {
  if (!apiBase) throw new Error('Endpoint API belum diatur.');
  const res = await fetch(apiBase + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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
  tarifHarian: 0,        // tarif untuk 9 jam kerja normal
  jamNormalHarian: 9,    // basis jam kerja normal
};

const DEFAULT_SYNC = { url: '' };

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

let settings = { ...DEFAULT_SETTINGS };
let sync = { ...DEFAULT_SYNC };
let records = [];

/** Memuat data milik user aktif dari localStorage. */
function muatDataUser() {
  settings = load(settingsKey, DEFAULT_SETTINGS);
  sync = load(syncKey, DEFAULT_SYNC);
  records = loadArr(recordsKey);
}

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
 * Menghitung turunan satu record: jam kerja & lembur.
 * Jam kerja normal = 9 jam per hari; lembur = kelebihan di atas 9 jam.
 */
function derive(rec) {
  const JAM_NORMAL = Number(settings.jamNormalHarian) || 9;
  const durasiNormal = JAM_NORMAL * 60; // basis normal = 9 jam

  if (rec.status && rec.status !== 'hadir') {
    return { ...rec, jamKerja: 0, lembur: 0 };
  }

  const kerja = durasiMenit(rec.jamDatang, rec.jamPulang);
  const lemburMenit = Math.max(0, kerja - durasiNormal);

  return {
    ...rec,
    jamKerja: Math.round((kerja / 60) * 100) / 100,
    lembur: Math.round((lemburMenit / 60) * 100) / 100,
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

  const JAM_NORMAL = Number(settings.jamNormalHarian) || 9;
  const tarifHarian = Number(settings.tarifHarian || 0);

  // Upah harian murni dari tarif harian (9 jam kerja normal)
  const honorHarian = tarifHarian;
  const gajiHarian = honorHarian * hadir.length;
  const tarifPerJam = honorHarian / JAM_NORMAL;
  const upahLembur = totalLembur * tarifPerJam;
  const gajiBersih = gajiHarian + upahLembur;

  return {
    list,
    jumlahHadir: hadir.length,
    totalJamKerja,
    totalLembur,
    honorHarian,
    gajiHarian,
    tarifHarian,
    tarifPerJam,
    upahLembur,
    gajiBersih,
  };
}

/* ---------- render ---------- */

function renderRekap() {
  const periode = $('periode').value;
  const r = rekap(periode);

  $('rHadir').textContent = r.jumlahHadir;
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
      return `<tr>
        <td>${r.tanggal}</td>
        <td>${r.jamDatang || '—'}</td>
        <td>${r.jamPulang || '—'}</td>
        <td>${angka(r.jamKerja)}j</td>
        <td>${r.lembur ? angka(r.lembur) + 'j' : '—'}</td>
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
  save(recordsKey, records);
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

  const head = ['tanggal', 'jam_datang', 'jam_pulang', 'jam_kerja', 'lembur', 'status', 'catatan'];
  const lines = [head.join(',')].concat(
    list.map((r) =>
      [r.tanggal, r.jamDatang, r.jamPulang, r.jamKerja, r.lembur, r.status, `"${(r.catatan || '').replace(/"/g, '""')}"`].join(',')
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
  return Boolean(apiBase && authToken);
}

let pushTimer = null;
/** Kirim perubahan lokal ke server (debounce). */
function pushSync() {
  if (!syncEnabled()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    setSyncState('busy', 'mengirim');
    pushDataServer();
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
  $('tarifHarian').value = settings.tarifHarian;
  $('syncUrl').value = sync.url || '';
}

function bacaSettingsDariForm() {
  settings = {
    nama: $('nama').value.trim(),
    jamMasukNormal: $('jamMasukNormal').value || '08:00',
    jamPulangNormal: $('jamPulangNormal').value || '17:00',
    tarifHarian: Number($('tarifHarian').value) || 0,
  };
  sync = { url: $('syncUrl').value.trim() };
  if (sync.url) {
    apiBase = sync.url.replace(/\/$/, '');
    localStorage.setItem('absensi.apibase.v1', apiBase);
  }
  save(settingsKey, settings);
  save(syncKey, sync);
}

function initApp() {
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
  setSyncState('off', 'lokal');

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

  ['nama', 'jamMasukNormal', 'jamPulangNormal', 'tarifHarian'].forEach(
    (id) =>
      $(id).addEventListener('change', () => {
        bacaSettingsDariForm();
        renderRekap();
      })
  );

  ['syncUrl'].forEach((id) => $(id).addEventListener('change', bacaSettingsDariForm));

  $('btnSync').addEventListener('click', async () => {
    bacaSettingsDariForm();
    apiBase = resolveApiBase();
    if (!syncEnabled()) {
      toast('Isi Endpoint API di Pengaturan dulu.', 'err');
      bukaPengaturan(true);
      return;
    }
    await pullDataServer();
    await pushDataServer();
    toast('Sinkronisasi selesai', 'ok');
  });
}

/* ---------- UI autentikasi ---------- */

let authMode = 'login';

function tampilkanErrorAuth(msg) {
  $('authError').textContent = msg || '';
}

function setModeAuth(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('tabLogin').classList.toggle('active', login);
  $('tabLogin').setAttribute('aria-selected', String(login));
  $('tabDaftar').classList.toggle('active', !login);
  $('tabDaftar').setAttribute('aria-selected', String(!login));
  $('authTitle').textContent = login ? 'Masuk' : 'Daftar Akun';
  $('authSub').textContent = login ? 'Kelola absensi pribadi Anda' : 'Buat akun baru untuk mulai mencatat';
  $('fieldKonfirmasi').hidden = login;
  $('btnSubmitAuth').textContent = login ? 'Masuk' : 'Daftar';
  $('authPassword').setAttribute('autocomplete', login ? 'current-password' : 'new-password');
  $('authPassword2').value = '';
  tampilkanErrorAuth('');
}

function bukaModalAuth(mode = 'login') {
  setModeAuth(mode);
  $('authModal').hidden = false;
  setTimeout(() => $('authUsername').focus(), 40);
}

function tutupModalAuth() {
  $('authModal').hidden = true;
  tampilkanErrorAuth('');
}

function terapkanSesi(username, token) {
  currentUser = username || null;
  authToken = token || '';

  const aktif = Boolean(currentUser);
  if (aktif) {
    const safe = normUser(username).replace(/[^a-z0-9._-]/g, '_');
    recordsKey = `${K_RECORDS}::${safe}`;
    settingsKey = `${K_SETTINGS}::${safe}`;
    syncKey = `${K_SYNC}::${safe}`;
  } else {
    recordsKey = K_RECORDS;
    settingsKey = K_SETTINGS;
    syncKey = K_SYNC;
  }

  muatDataUser();
  isiFormDariSettings();
  resetForm();
  renderRekap();

  $('userMenu').hidden = !aktif;
  $('btnLoginTop').hidden = aktif;
  if (aktif) {
    $('userName').textContent = currentUser;
    $('userAvatar').textContent = currentUser.slice(0, 1);
    $('userDropdown').hidden = true;
    setSyncState('busy', 'menyinkron');
    pullDataServer();
  } else {
    setSyncState('off', 'lokal');
  }
}

async function prosesAuth(e) {
  e.preventDefault();
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  const password2 = $('authPassword2').value;

  if (!apiBase) {
    return tampilkanErrorAuth('Endpoint API belum diatur. Buka Pengaturan dan isi URL worker.');
  }
  if (!username) return tampilkanErrorAuth('Username wajib diisi.');
  if (username.length < 3) return tampilkanErrorAuth('Username minimal 3 karakter.');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return tampilkanErrorAuth('Username hanya huruf, angka, titik, garis bawah, minus.');
  }
  if (!password) return tampilkanErrorAuth('Password wajib diisi.');
  if (password.length < 6) return tampilkanErrorAuth('Password minimal 6 karakter.');
  if (authMode === 'daftar' && password !== password2) {
    return tampilkanErrorAuth('Konfirmasi password tidak sama.');
  }

  $('btnSubmitAuth').disabled = true;
  tampilkanErrorAuth('');

  try {
    const path = authMode === 'daftar' ? '/api/register' : '/api/login';
    const data = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    simpanSesi(data.username, data.api_key);
    terapkanSesi(data.username, data.api_key);
    tutupModalAuth();
    toast(
      authMode === 'daftar'
        ? `Akun ${data.username} dibuat. Selamat datang!`
        : `Selamat datang, ${data.username}`,
      'ok'
    );
  } catch (err) {
    console.warn(err);
    tampilkanErrorAuth(err.message || 'Gagal menghubungi server.');
  } finally {
    $('btnSubmitAuth').disabled = false;
  }
}

/** Ambil data (absensi + pengaturan) dari server dan perbarui tampilan. */
async function pullDataServer() {
  if (!apiBase || !authToken) return;
  setSyncState('busy', 'menyinkron');
  try {
    const [rec, set] = await Promise.all([
      apiFetch('/api/records'),
      apiFetch('/api/settings'),
    ]);

    if (Array.isArray(rec.records)) {
      records = rec.records;
      save(recordsKey, records);
    }
    if (set.settings) {
      settings = { ...DEFAULT_SETTINGS, ...set.settings };
      save(settingsKey, settings);
      isiFormDariSettings();
    }

    renderRekap();
    setSyncState('on', 'tersinkron');
  } catch (err) {
    console.warn(err);
    setSyncState('err', 'gagal');
    toast('Gagal mengambil data dari server', 'err');
  }
}

/** Kirim data lokal ke server. */
async function pushDataServer() {
  if (!apiBase || !authToken) return;
  try {
    await apiFetch('/api/records', { method: 'PUT', body: JSON.stringify({ records }) });
    await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        settings: {
          nama: settings.nama,
          jamMasukNormal: settings.jamMasukNormal,
          jamPulangNormal: settings.jamPulangNormal,
          tarifHarian: settings.tarifHarian,
        },
      }),
    });
    setSyncState('on', 'tersinkron');
  } catch (err) {
    console.warn(err);
    setSyncState('err', 'gagal');
  }
}

function keluar() {
  if (!confirm('Keluar dari akun ini?')) return;
  simpanSesi('', '');
  terapkanSesi('');
  resetForm();
  renderRekap();
  $('userDropdown').hidden = true;
  toast('Anda telah keluar');
  bukaModalAuth('login');
}

function initAuth() {
  setModeAuth('login');
  $('tabLogin').addEventListener('click', () => setModeAuth('login'));
  $('tabDaftar').addEventListener('click', () => setModeAuth('daftar'));
  $('formAuth').addEventListener('submit', prosesAuth);
  $('btnLoginTop').addEventListener('click', () => bukaModalAuth('login'));
  $('btnLogout').addEventListener('click', keluar);

  $('btnUser').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('userDropdown');
    dd.hidden = !dd.hidden;
    $('btnUser').setAttribute('aria-expanded', String(!dd.hidden));
  });

  document.addEventListener('click', () => {
    $('userDropdown').hidden = true;
    $('btnUser').setAttribute('aria-expanded', 'false');
  });

  $('userDropdown').addEventListener('click', (e) => e.stopPropagation());

  $('btnPwToggle').addEventListener('click', () => {
    const el = $('authPassword');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('btnPwToggle').textContent = el.type === 'password' ? '👁' : '🙈';
  });

  $('authModal').addEventListener('click', (e) => {
    if (e.target === $('authModal') && currentUser) tutupModalAuth();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentUser) tutupModalAuth();
  });
}

function boot() {
  apiBase = resolveApiBase();
  initApp();
  initAuth();

  const sesi = getSesi();
  if (sesi) {
    terapkanSesi(sesi.username, sesi.token);
  } else {
    terapkanSesi('');
    bukaModalAuth('login');
  }
}

document.addEventListener('DOMContentLoaded', boot);
