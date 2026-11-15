// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) + sinkronisasi ke Cloudflare Worker + Turso.

const K_RECORDS = 'absensi.records.v1';
const K_SETTINGS = 'absensi.settings.v1';
const K_AUTH = 'absensi.auth.v1'; // { apiKey, username }

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

/* ---------- state ---------- */

let settings = {
  nama: '',
  jamMasukNormal: '08:00',
  jamPulangNormal: '17:00',
  tarifHarian: 0,
  jamNormalHarian: 9,
};
let records = [];
let auth = { apiKey: null, username: null };

const DEFAULT_SETTINGS = { ...settings };

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

/* ---------- storage ---------- */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch { return { ...fallback }; }
}
function loadArr(key) {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('Gagal simpan', key, e); }
}

/* ---------- Worker API ---------- */

function getApiBase() {
  const url = localStorage.getItem('absensi.apiBase');
  return url || '';
}
function setApiBase(url) {
  localStorage.setItem('absensi.apiBase', url);
}

async function apiFetch(path, options = {}) {
  const base = getApiBase();
  if (!base) throw new Error('Endpoint API belum disetel. Buka Pengaturan → isi Endpoint API.');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth.apiKey) headers['Authorization'] = `Bearer ${auth.apiKey}`;
  const res = await fetch(base.replace(/\/$/, '') + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function checkAuth() {
  const saved = load(K_AUTH, { apiKey: null, username: null });
  if (saved.apiKey) {
    auth = saved;
    try {
      // Validasi key dengan memanggil endpoint yang butuh auth
      await apiFetch('/api/settings', { method: 'GET' });
      return true;
    } catch {
      auth = { apiKey: null, username: null };
      save(K_AUTH, auth);
    }
  }
  return false;
}

async function doRegister(username, password) {
  const data = await apiFetch('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  auth = { apiKey: data.api_key, username: data.username };
  save(K_AUTH, auth);
  return data;
}

async function doLogin(username, password) {
  const data = await apiFetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  auth = { apiKey: data.api_key, username: data.username };
  save(K_AUTH, auth);
  return data;
}

function doLogout() {
  auth = { apiKey: null, username: null };
  save(K_AUTH, auth);
  records = [];
  settings = { ...DEFAULT_SETTINGS };
  save(K_RECORDS, records);
  save(K_SETTINGS, settings);
  renderRekap();
  showAuthModal();
}

async function pullFromWorker() {
  if (!auth.apiKey) return;
  setSyncState('busy', 'menyinkron');
  try {
    const [recData, setData] = await Promise.all([
      apiFetch('/api/records', { method: 'GET' }),
      apiFetch('/api/settings', { method: 'GET' })
    ]);
    records = (recData.records || []).map(r => ({
      id: r.id, tanggal: r.tanggal, jamDatang: r.jamDatang || '', jamPulang: r.jamPulang || '',
      status: r.status || 'hadir', catatan: r.catatan || ''
    }));
    save(K_RECORDS, records);
    if (setData.settings) {
      const s = setData.settings;
      settings = { ...DEFAULT_SETTINGS, nama: s.nama || '', jamMasukNormal: s.jamMasukNormal || '08:00', jamPulangNormal: s.jamPulangNormal || '17:00', tarifHarian: Number(s.tarifHarian || 0) };
      save(K_SETTINGS, settings);
      isiFormDariSettings();
    }
    renderRekap();
    setSyncState('on', 'tersinkron');
    updateUserBadge();
  } catch (err) { console.warn(err); setSyncState('err', 'gagal'); }
}

let pushTimer = null;
function pushToWorker() {
  if (!auth.apiKey) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    setSyncState('busy', 'mengirim');
    try {
      await apiFetch('/api/records', {
        method: 'PUT',
        body: JSON.stringify({ records })
      });
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: {
          nama: settings.nama || '',
          jamMasukNormal: settings.jamMasukNormal || '08:00',
          jamPulangNormal: settings.jamPulangNormal || '17:00',
          tarifHarian: Number(settings.tarifHarian || 0)
        }})
      });
      setSyncState('on', 'tersinkron');
    } catch (err) { console.warn(err); setSyncState('err', 'gagal'); }
  }, 800);
}

/* ---------- sync (wrapper) ---------- */

function setSyncState(state, text) {
  const el = $('syncState');
  if (!el) return;
  const map = { on: 'chip-on', off: 'chip-off', busy: 'chip-busy', err: 'chip-err' };
  el.className = 'chip ' + (map[state] || 'chip-off');
  el.textContent = text;
}

async function syncNow() {
  if (!auth.apiKey) return toast('Login dulu untuk sinkronisasi.', 'err');
  await pullFromWorker();
  await pushToWorker();
  toast('Sinkronisasi selesai', 'ok');
}

/* ---------- util ---------- */

const toMinutes = (hhmm) => { if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function durasiMenit(datang, pulang) { const a = toMinutes(datang); const b = toMinutes(pulang); if (a == null || b == null) return 0; let d = b - a; if (d < 0) d += 24 * 60; return d; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- perhitungan ---------- */

function derive(rec) {
  const JAM_NORMAL = Number(settings.jamNormalHarian) || 9;
  const durasiNormal = JAM_NORMAL * 60;
  if (rec.status && rec.status !== 'hadir') return { ...rec, jamKerja: 0, lembur: 0 };
  const kerja = durasiMenit(rec.jamDatang, rec.jamPulang);
  const lemburMenit = Math.max(0, kerja - durasiNormal);
  return { ...rec, jamKerja: Math.round((kerja / 60) * 100) / 100, lembur: Math.round((lemburMenit / 60) * 100) / 100 };
}

function recordsPeriode(periode) {
  return records.filter((r) => r.tanggal.startsWith(periode)).map(derive).sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0));
}

function rekap(periode) {
  const list = recordsPeriode(periode);
  const hadir = list.filter((r) => r.status === 'hadir');
  const totalJamKerja = hadir.reduce((a, r) => a + r.jamKerja, 0);
  const totalLembur = hadir.reduce((a, r) => a + r.lembur, 0);
  const honorHarian = Number(settings.tarifHarian || 0);
  const gajiHarian = honorHarian * hadir.length;
  const tarifPerJam = honorHarian / (Number(settings.jamNormalHarian) || 9);
  const upahLembur = totalLembur * tarifPerJam;
  const gajiBersih = gajiHarian + upahLembur;
  return { list, jumlahHadir: hadir.length, totalJamKerja, totalLembur, honorHarian, gajiHarian, tarifPerJam, upahLembur, gajiBersih };
}

/* ---------- render ---------- */

function renderRekap() {
  const periode = $('periode').value;
  const r = rekap(periode);
  $('rHadir').textContent = r.jumlahHadir;
  $('rJam').textContent = angka(r.totalJamKerja);
  $('rLembur').textContent = angka(r.totalLembur);
  $('rGaji').textContent = rupiah(r.gajiBersih);
  const namaBulan = periode ? new Date(periode + '-01').toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }) : '';
  $('heroSub').textContent = r.jumlahHadir ? `${r.jumlahHadir} hari hadir · ${angka(r.totalLembur)} jam lembur · ${namaBulan}` : 'belum ada data';
  const rows = [
    [`Upah harian × ${r.jumlahHadir} hari`, rupiah(r.gajiHarian), ''],
    [`Tarif per jam (harian ÷ 9 jam)`, rupiah(r.tarifPerJam), ''],
    [`Lembur ${angka(r.totalLembur)} jam × ${rupiah(r.tarifPerJam)}`, '+ ' + rupiah(r.upahLembur), 'pos'],
  ];
  $('breakdown').innerHTML = rows.map(([k, v, cls]) => `<li class="${cls}"><span>${k}</span><span>${v}</span></li>`).join('');
  renderTabel(r.list);
}

function renderTabel(list) {
  const tbody = $('tabelAbsen').querySelector('tbody');
  $('countLabel').textContent = list.length + ' entri';
  tbody.innerHTML = list.map((r) => `<tr>
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
  </tr>`).join('');
  $('emptyAbsen').classList.toggle('show', list.length === 0);
  $('tabelAbsen').style.display = list.length ? '' : 'none';
  tbody.querySelectorAll('[data-hapus]').forEach((btn) => btn.addEventListener('click', () => hapusRecord(btn.dataset.hapus)));
  tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => muatKeForm(btn.dataset.edit)));
}

/* ---------- app functions ---------- */

function muatDataLokal() {
  settings = load(K_SETTINGS, DEFAULT_SETTINGS);
  records = loadArr(K_RECORDS);
}
function isiFormDariSettings() {
  $('nama').value = settings.nama || '';
  $('jamMasukNormal').value = settings.jamMasukNormal;
  $('jamPulangNormal').value = settings.jamPulangNormal;
  $('tarifHarian').value = settings.tarifHarian;
}
function bacaSettingsDariForm() {
  settings = { ...settings, nama: $('nama').value.trim(), jamMasukNormal: $('jamMasukNormal').value || '08:00', jamPulangNormal: $('jamPulangNormal').value || '17:00', tarifHarian: Number($('tarifHarian').value) || 0 };
  save(K_SETTINGS, settings);
}
function resetForm() {
  $('tanggal').value = new Date().toISOString().slice(0, 10);
  $('jamDatang').value = ''; $('jamPulang').value = ''; $('status').value = 'hadir'; $('catatan').value = '';
  $('btnTambah').textContent = 'Simpan Absensi'; $('btnBatal').hidden = true; delete $('btnTambah').dataset.editId;
}
function simpanAbsensi() {
  const tanggal = $('tanggal').value; if (!tanggal) return toast('Tanggal wajib diisi.', 'err');
  const status = $('status').value; const jamDatang = $('jamDatang').value; const jamPulang = $('jamPulang').value;
  if (status === 'hadir' && (!jamDatang || !jamPulang)) return toast('Jam datang & pulang wajib diisi.', 'err');
  const payload = { tanggal, jamDatang, jamPulang, status, catatan: $('catatan').value.trim() };
  const editId = $('btnTambah').dataset.editId;
  if (editId) { records = records.map((r) => (r.id === editId ? { ...r, ...payload } : r)); toast('Diperbarui', 'ok'); }
  else { records = records.filter((r) => r.tanggal !== tanggal); records.push({ id: 'r' + Date.now(), ...payload }); toast('Tersimpan', 'ok'); }
  save(K_RECORDS, records); resetForm(); renderRekap(); pushToWorker();
}
function hapusRecord(id) { if (!confirm('Hapus absensi ini?')) return; records = records.filter((r) => r.id !== id); save(K_RECORDS, records); renderRekap(); pushToWorker(); toast('Dihapus'); }
function muatKeForm(id) {
  const r = records.find((x) => x.id === id); if (!r) return;
  $('tanggal').value = r.tanggal; $('jamDatang').value = r.jamDatang || ''; $('jamPulang').value = r.jamPulang || ''; $('status').value = r.status || 'hadir'; $('catatan').value = r.catatan || '';
  $('btnTambah').textContent = 'Perbarui Absensi'; $('btnTambah').dataset.editId = id; $('btnBatal').hidden = false; $('tanggal').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function exportCsv() {
  const list = recordsPeriode($('periode').value); if (!list.length) return toast('Tidak ada data.', 'err');
  const head = ['tanggal', 'jam_datang', 'jam_pulang', 'jam_kerja', 'lembur', 'status', 'catatan'];
  const lines = [head.join(',')].concat(list.map((r) => [r.tanggal, r.jamDatang, r.jamPulang, r.jamKerja, r.lembur, r.status, `"${(r.catatan || '').replace(/"/g, '""')}"`].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })); a.download = `absensi-${$('periode').value}.csv`; a.click();
}

function updateUserBadge() {
  const el = $('userBadge');
  if (!el) return;
  if (auth.username) {
    el.textContent = `@${auth.username}`;
    el.className = 'chip chip-on';
    $('btnAuthModal').textContent = 'Keluar';
  } else {
    el.textContent = 'Lokal';
    el.className = 'chip chip-off';
    $('btnAuthModal').textContent = 'Masuk / Daftar';
  }
}

function showAuthModal() {
  $('cardAuth').hidden = false;
  $('cardAuth').scrollIntoView({ behavior: 'smooth' });
}

function hideAuthModal() {
  $('cardAuth').hidden = true;
}

/* ---------- init ---------- */

async function initApp() {
  // Cek query parameter ?api=
  const urlParams = new URLSearchParams(window.location.search);
  const apiParam = urlParams.get('api');
  if (apiParam) {
    setApiBase(apiParam);
  }

  muatDataLokal();
  isiFormDariSettings();
  resetForm();

  // Pengaturan Endpoint
  const apiInput = $('apiBaseInput');
  if (apiInput) apiInput.value = getApiBase();

  $('periode').value = new Date().toISOString().slice(0, 7);
  const t = new Date(); $('todayLabel').textContent = t.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
  const tick = () => { const n = new Date(); const s = String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0'); $('nowMasuk').textContent=s; $('nowPulang').textContent=s; };
  tick(); setInterval(tick, 20000);
  $('btnMasuk').addEventListener('click', () => { $('jamDatang').value = $('nowMasuk').textContent; toast('Jam datang diisi'); });
  $('btnPulang').addEventListener('click', () => { $('jamPulang').value = $('nowPulang').textContent; toast('Jam pulang diisi'); });
  $('btnTambah').addEventListener('click', simpanAbsensi); $('btnBatal').addEventListener('click', resetForm); $('btnExport').addEventListener('click', exportCsv); $('periode').addEventListener('change', renderRekap);
  $('btnPengaturan').addEventListener('click', () => { $('cardPengaturan').hidden = !$('cardPengaturan').hidden; if(!$('cardPengaturan').hidden) $('cardPengaturan').scrollIntoView(); });
  $('btnTutupPengaturan').addEventListener('click', () => {
    bacaSettingsDariForm();
    if (apiInput) setApiBase(apiInput.value.trim());
    renderRekap();
    $('cardPengaturan').hidden = true;
  });
  ['nama', 'jamMasukNormal', 'jamPulangNormal', 'tarifHarian'].forEach(id => $(id).addEventListener('change', () => { bacaSettingsDariForm(); renderRekap(); }));

  $('btnSync').addEventListener('click', syncNow);
  $('btnAuthModal').addEventListener('click', () => {
    if (auth.username) {
      if (confirm('Keluar dari akun ' + auth.username + '? Data lokal akan dibersihkan.')) {
        doLogout();
      }
    } else {
      showAuthModal();
    }
  });

  $('btnTutupAuth').addEventListener('click', hideAuthModal);
  $('btnTutupAuth2').addEventListener('click', hideAuthModal);

  // Tab Login / Register
  let authMode = 'login';
  const tabLogin = $('tabLogin');
  const tabRegister = $('tabRegister');
  const btnSubmitAuth = $('btnSubmitAuth');
  const authTitle = $('authTitle');

  tabLogin?.addEventListener('click', () => {
    authMode = 'login';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    btnSubmitAuth.textContent = 'Masuk';
    authTitle.textContent = 'Masuk Akun';
  });

  tabRegister?.addEventListener('click', () => {
    authMode = 'register';
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    btnSubmitAuth.textContent = 'Daftar Akun Baru';
    authTitle.textContent = 'Daftar Akun';
  });

  btnSubmitAuth?.addEventListener('click', async () => {
    const user = $('authUser').value.trim();
    const pass = $('authPass').value;
    if (!user || !pass) return toast('Username dan password wajib diisi.', 'err');

    try {
      if (authMode === 'register') {
        await doRegister(user, pass);
        toast('Pendaftaran berhasil!', 'ok');
      } else {
        await doLogin(user, pass);
        toast('Berhasil masuk!', 'ok');
      }
      hideAuthModal();
      updateUserBadge();
      await pullFromWorker();
    } catch (err) {
      toast(err.message || 'Gagal autentikasi', 'err');
    }
  });

  renderRekap();

  const isLoggedIn = await checkAuth();
  updateUserBadge();
  if (isLoggedIn) {
    pullFromWorker();
  }
}

document.addEventListener('DOMContentLoaded', initApp);
