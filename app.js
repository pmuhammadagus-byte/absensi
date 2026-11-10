// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) + sinkronisasi langsung ke Turso (HTTP API).

const K_USERS = 'absensi.users.v1';
const K_SESSION = 'absensi.session.v1';
const K_RECORDS_BASE = 'absensi.records.v1';
const K_SETTINGS_BASE = 'absensi.settings.v1';

let recordsKey = K_RECORDS_BASE;
let settingsKey = K_SETTINGS_BASE;

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

/* ---------- state ---------- */

let currentUser = null;
let authMode = 'login';
let settings = {
  nama: '',
  jamMasukNormal: '08:00',
  jamPulangNormal: '17:00',
  tarifHarian: 0,
  jamNormalHarian: 9,
};
let records = [];

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

function loadUsers() { return load(K_USERS, {}); }
function saveUsers(users) { save(K_USERS, users); }

/* ---------- Turso HTTP API ---------- */

const TURSO_URL = 'https://opencode-cakagus.aws-us-east-1.turso.io/v2/pipeline';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTQyMzM5MDYsImlkIjoiMDFhMWMwYTMtM2QwMS03ZTQzLWFhYmMtNTIyNjA5Y2JiODA2Iiwia2lkIjoicXBBWGQyamhjRmZzdzN3SEE2WEY1VnlEakJKOXlvS0NmTW44Q2hYbUxySSIsInJpZCI6ImNmMmI3MjkxLWY0NDktNGJmZi04NGNlLWQ4ODdkM2M2NjA0NCJ9.AMKZhnDuPGo4rP76yXaPiSqtjU9zz-kXswkvlN5PeFQJofooTsebtrtRzDE9sYur1JdFYdZFiBO2GfQmBjUuAQ';

async function tursoExecute(sql, args = []) {
  const res = await fetch(TURSO_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        type: 'execute',
        stmt: {
          sql,
          args: args.map(v => v === null || v === undefined ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(Math.trunc(v)) } : { type: 'text', value: String(v) })
        }
      }]
    })
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const body = await res.json();
  const r = body.results?.[0];
  if (r?.type === 'error') throw new Error(r.error?.message || 'turso error');
  const rows = r?.response?.result?.rows || [];
  const cols = (r?.response?.result?.cols || []).map(c => c.name);
  return rows.map(row => {
    const obj = {};
    row.forEach((cell, i) => { obj[cols[i]] = cell.type === 'null' ? null : cell.value; });
    return obj;
  });
}

async function tursoPipeline(statements) {
  const res = await fetch(TURSO_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: statements.map(s => ({
        type: 'execute',
        stmt: {
          sql: s.sql,
          args: (s.args || []).map(v => v === null || v === undefined ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(Math.trunc(v)) } : { type: 'text', value: String(v) })
        }
      }))
    })
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const body = await res.json();
  return body.results || [];
}

/* ---------- sync ---------- */

function setSyncState(state, text) {
  const el = $('syncState');
  if (!el) return;
  const map = { on: 'chip-on', off: 'chip-off', busy: 'chip-busy', err: 'chip-err' };
  el.className = 'chip ' + (map[state] || 'chip-off');
  el.textContent = text;
}

async function pullFromTurso() {
  if (!currentUser) return;
  setSyncState('busy', 'menyinkron');
  try {
    const userPrefix = normUser(currentUser).replace(/[^a-z0-9._-]/g, '_');
    const [recRows, setRows] = await Promise.all([
      tursoExecute(`SELECT id, tanggal, jam_datang, jam_pulang, status, catatan FROM records WHERE user_id = ? ORDER BY tanggal ASC`, [userPrefix]),
      tursoExecute(`SELECT nama, jam_masuk_normal, jam_pulang_normal, tarif_harian FROM pengaturan WHERE user_id = ? LIMIT 1`, [userPrefix])
    ]);
    const recs = recRows.map(r => ({ id: r.id, tanggal: r.tanggal, jamDatang: r.jam_datang || '', jamPulang: r.jam_pulang || '', status: r.status || 'hadir', catatan: r.catatan || '' }));
    records = recs;
    save(recordsKey, records);
    if (setRows.length) {
      const s = setRows[0];
      settings = { ...DEFAULT_SETTINGS, nama: s.nama || '', jamMasukNormal: s.jam_masuk_normal || '08:00', jamPulangNormal: s.jam_pulang_normal || '17:00', tarifHarian: Number(s.tarif_harian || 0) };
      save(settingsKey, settings);
      isiFormDariSettings();
    }
    renderRekap();
    setSyncState('on', 'tersinkron');
  } catch (err) { console.warn(err); setSyncState('err', 'gagal'); }
}

let pushTimer = null;
function pushToTurso() {
  if (!currentUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    setSyncState('busy', 'mengirim');
    try {
      const userPrefix = normUser(currentUser).replace(/[^a-z0-9._-]/g, '_');
      const statements = [{ sql: 'DELETE FROM records WHERE user_id = ?', args: [userPrefix] }];
      for (const r of records) {
        if (!r.id || !r.tanggal) continue;
        statements.push({ sql: `INSERT INTO records (id, user_id, tanggal, jam_datang, jam_pulang, status, catatan, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`, args: [r.id, userPrefix, r.tanggal, r.jamDatang || null, r.jamPulang || null, r.status || 'hadir', r.catatan || null] });
      }
      statements.push({
        sql: `INSERT INTO pengaturan (user_id, nama, jam_masuk_normal, jam_pulang_normal, tarif_harian, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET nama=excluded.nama, jam_masuk_normal=excluded.jam_masuk_normal, jam_pulang_normal=excluded.jam_pulang_normal, tarif_harian=excluded.tarif_harian, updated_at=datetime('now')`,
        args: [userPrefix, settings.nama || '', settings.jamMasukNormal || '08:00', settings.jamPulangNormal || '17:00', Number(settings.tarifHarian || 0)]
      });
      await tursoPipeline(statements);
      setSyncState('on', 'tersinkron');
    } catch (err) { console.warn(err); setSyncState('err', 'gagal'); }
  }, 800);
}

/* ---------- util ---------- */

function normUser(u) { return String(u || '').trim().toLowerCase(); }
function simpanSesi(username) { if (username) localStorage.setItem(K_SESSION, username); else localStorage.removeItem(K_SESSION); }
function getSesi() { return localStorage.getItem(K_SESSION) || ''; }
function muatDataUser() { settings = load(settingsKey, DEFAULT_SETTINGS); records = loadArr(recordsKey); }

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

function isiFormDariSettings() {
  $('nama').value = settings.nama || '';
  $('jamMasukNormal').value = settings.jamMasukNormal;
  $('jamPulangNormal').value = settings.jamPulangNormal;
  $('tarifHarian').value = settings.tarifHarian;
}
function bacaSettingsDariForm() {
  settings = { ...settings, nama: $('nama').value.trim(), jamMasukNormal: $('jamMasukNormal').value || '08:00', jamPulangNormal: $('jamPulangNormal').value || '17:00', tarifHarian: Number($('tarifHarian').value) || 0 };
  save(settingsKey, settings);
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
  save(recordsKey, records); resetForm(); renderRekap(); pushToTurso();
}
function hapusRecord(id) { if (!confirm('Hapus absensi ini?')) return; records = records.filter((r) => r.id !== id); save(recordsKey, records); renderRekap(); pushToTurso(); toast('Dihapus'); }
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

/* ---------- auth ---------- */

const enc = new TextEncoder();
function bytesToHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function randomSalt() { const b = new Uint8Array(16); crypto.getRandomValues(b); return bytesToHex(b.buffer); }
async function hashPassword(password, salt) {
  let digest = await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + password));
  for (let i = 0; i < 800; i++) digest = await crypto.subtle.digest('SHA-256', digest);
  return bytesToHex(digest);
}
function tampilkanErrorAuth(msg) { $('authError').textContent = msg || ''; }
function setModeAuth(mode) {
  authMode = mode; const login = mode === 'login';
  $('tabLogin').classList.toggle('active', login); $('tabDaftar').classList.toggle('active', !login);
  $('authTitle').textContent = login ? 'Masuk' : 'Daftar Akun'; $('fieldKonfirmasi').hidden = login;
  $('btnSubmitAuth').textContent = login ? 'Masuk' : 'Daftar'; tampilkanErrorAuth('');
}
function bukaModalAuth(mode = 'login') { setModeAuth(mode); $('authModal').hidden = false; setTimeout(() => $('authUsername').focus(), 40); }
function tutupModalAuth() { $('authModal').hidden = true; }

function terapkanSesi(username) {
  currentUser = username || null; const aktif = Boolean(currentUser);
  if (aktif) { const safe = normUser(username).replace(/[^a-z0-9._-]/g, '_'); recordsKey = K_RECORDS_BASE + '::' + safe; settingsKey = K_SETTINGS_BASE + '::' + safe; }
  else { recordsKey = K_RECORDS_BASE; settingsKey = K_SETTINGS_BASE; }
  muatDataUser(); isiFormDariSettings(); resetForm(); renderRekap();
  $('userMenu').hidden = !aktif; $('btnLoginTop').hidden = aktif;
  if (aktif) { $('userName').textContent = currentUser; $('userAvatar').textContent = currentUser.slice(0, 1); setSyncState('busy', 'menyinkron'); pullFromTurso(); }
  else { setSyncState('off', 'lokal'); }
}

async function prosesAuth(e) {
  e.preventDefault();
  const username = $('authUsername').value.trim(); const password = $('authPassword').value; const password2 = $('authPassword2').value;
  if (!username || username.length < 3) return tampilkanErrorAuth('Username min 3 karakter.');
  if (password.length < 6) return tampilkanErrorAuth('Password min 6 karakter.');
  if (authMode === 'daftar' && password !== password2) return tampilkanErrorAuth('Password tidak cocok.');
  const users = loadUsers(); const key = normUser(username);
  if (authMode === 'daftar') { if (users[key]) return tampilkanErrorAuth('Username sudah ada.'); const salt = randomSalt(); const hash = await hashPassword(password, salt); users[key] = { username, salt, hash }; saveUsers(users); }
  else { const u = users[key]; if (!u) return tampilkanErrorAuth('Username tidak terdaftar.'); const hash = await hashPassword(password, u.salt); if (hash !== u.hash) return tampilkanErrorAuth('Password salah.'); }
  simpanSesi(username); terapkanSesi(username); tutupModalAuth(); toast('Selamat datang, ' + username, 'ok');
}

function keluar() { if (!confirm('Keluar?')) return; simpanSesi(''); terapkanSesi(''); bukaModalAuth('login'); }

/* ---------- init ---------- */

function initApp() {
  const t = new Date(); $('todayLabel').textContent = t.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
  const tick = () => { const n = new Date(); const s = String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0'); $('nowMasuk').textContent=s; $('nowPulang').textContent=s; };
  tick(); setInterval(tick, 20000);
  $('btnMasuk').addEventListener('click', () => { $('jamDatang').value = $('nowMasuk').textContent; toast('Jam datang diisi'); });
  $('btnPulang').addEventListener('click', () => { $('jamPulang').value = $('nowPulang').textContent; toast('Jam pulang diisi'); });
  $('btnTambah').addEventListener('click', simpanAbsensi); $('btnBatal').addEventListener('click', resetForm); $('btnExport').addEventListener('click', exportCsv); $('periode').addEventListener('change', renderRekap);
  $('btnPengaturan').addEventListener('click', () => { $('cardPengaturan').hidden = !$('cardPengaturan').hidden; if(!$('cardPengaturan').hidden) $('cardPengaturan').scrollIntoView(); });
  $('btnTutupPengaturan').addEventListener('click', () => { bacaSettingsDariForm(); renderRekap(); $('cardPengaturan').hidden = true; });
  ['nama', 'jamMasukNormal', 'jamPulangNormal', 'tarifHarian'].forEach(id => $(id).addEventListener('change', () => { bacaSettingsDariForm(); renderRekap(); }));
  $('btnSync').addEventListener('click', async () => { if (!currentUser) return toast('Login dulu', 'err'); await pullFromTurso(); await pushToTurso(); toast('Sync selesai', 'ok'); });
}

function initAuth() {
  $('tabLogin').addEventListener('click', () => setModeAuth('login')); $('tabDaftar').addEventListener('click', () => setModeAuth('daftar'));
  $('formAuth').addEventListener('submit', prosesAuth); $('btnLoginTop').addEventListener('click', () => bukaModalAuth('login')); $('btnLogout').addEventListener('click', keluar);
  $('btnUser').addEventListener('click', (e) => { e.stopPropagation(); $('userDropdown').hidden = !$('userDropdown').hidden; });
  document.addEventListener('click', () => $('userDropdown').hidden = true);
  $('btnPwToggle').addEventListener('click', () => { const el=$('authPassword'); el.type=el.type==='password'?'text':'password'; });
  $('authModal').addEventListener('click', (e) => { if(e.target===$('authModal') && currentUser) tutupModalAuth(); });
}

function boot() {
  $('periode').value = new Date().toISOString().slice(0, 7);
  initApp(); initAuth();
  const sesi = getSesi(); if (sesi) terapkanSesi(sesi); else { terapkanSesi(''); bukaModalAuth('login'); }
}

document.addEventListener('DOMContentLoaded', boot);
