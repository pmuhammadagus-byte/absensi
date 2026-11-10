// Absensi — kehadiran manual + lembur & gaji otomatis.
// Data disimpan lokal (localStorage) + sinkronisasi langsung ke Turso (HTTP API).


// Kunci data per-user (dipisah agar tiap akun punya absensi sendiri)
const K_RECORDS = 'absensi.records.v1';
const K_SETTINGS = 'absensi.settings.v1';

let recordsKey = K_RECORDS;
let settingsKey = K_SETTINGS;

const $ = (id) => document.getElementById(id);

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('id-ID');

/* ---------- auth (local, hash SHA-256 + salt) ---------- */

let currentUser = null;
let authMode = "login";



/* ---------- auth (local, hash SHA-256 + salt) ---------- */

const K_USERS = 'absensi.users.v1';
const K_SESSION = 'absensi.session.v1';

const enc = new TextEncoder();

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b.buffer);
}

async function hashPassword(password, salt) {
  let digest = await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + password));
  for (let i = 0; i < 800; i++) {
    digest = await crypto.subtle.digest('SHA-256', digest);
  }
  return bytesToHex(digest);
}

function loadUsers() {
  try {
    const raw = localStorage.getItem('absensi.users.v1');
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function saveUsers(users) {
  try { localStorage.setItem('absensi.users.v1', JSON.stringify(users)); } catch (e) { console.warn('Gagal simpan users', e); }
}

function normUser(u) { return String(u || '').trim().toLowerCase(); }

function simpanSesi(username) {
  if (username) localStorage.setItem('absensi.session.v1', username);
  else localStorage.removeItem('absensi.session.v1');
}

function getSesi() { return localStorage.getItem('absensi.session.v1') || ''; }

function tampilkanErrorAuth(msg) { $('authError').textContent = msg || ''; }

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

function tutupModalAuth() { $('authModal').hidden = true; tampilkanErrorAuth(''); }

async function prosesAuth(e) {
  console.log("prosesAuth triggered, mode:", authMode);
  e.preventDefault();
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  const password2 = $('authPassword2').value;
  const users = loadUsers();

  if (!username) return tampilkanErrorAuth('Username wajib diisi.');
  if (username.length < 3) return tampilkanErrorAuth('Username minimal 3 karakter.');
  if (!/^[a-zA-Z0-9._-]+/.test(username)) return tampilkanErrorAuth('Username hanya huruf, angka, titik, _, -.');
  if (!password) return tampilkanErrorAuth('Password wajib diisi.');
  if (password.length < 6) return tampilkanErrorAuth('Password minimal 6 karakter.');
  if (authMode === 'daftar' && password !== password2) return tampilkanErrorAuth('Konfirmasi password tidak sama.');

  $('btnSubmitAuth').disabled = true;
  tampilkanErrorAuth('');

  try {
    const key = normUser(username);

    if (authMode === 'daftar') {
      if (users[key]) return tampilkanErrorAuth('Username sudah terdaftar.');
      const salt = randomSalt();
      const hash = await hashPassword(password, salt);
      users[key] = { username, salt, hash, dibuat: new Date().toISOString() };
      saveUsers(users);
      simpanSesi(username);
      terapkanSesi(username);
      tutupModalAuth();
      toast('Akun ' + username + ' dibuat. Selamat datang!', 'ok');
    } else {
      const u = users[key];
      if (!u) return tampilkanErrorAuth('Username belum terdaftar.');
      const hash = await hashPassword(password, u.salt);
      if (hash !== u.hash) return tampilkanErrorAuth('Password salah.');
      simpanSesi(username);
      terapkanSesi(username);
      tutupModalAuth();
      toast('Selamat datang, ' + username, 'ok');
    }
  } catch (err) {
    console.warn(err);
    tampilkanErrorAuth('Terjadi kesalahan. Coba lagi.');
  } finally {
    $('btnSubmitAuth').disabled = false;
  }
}

function terapkanSesi(username) {
  currentUser = username || null;
  const aktif = Boolean(currentUser);

  if (aktif) {
    const safe = normUser(username).replace(/[^a-z0-9._-]/g, '_');
    recordsKey = K_RECORDS + '::' + safe;
    settingsKey = K_SETTINGS + '::' + safe;
  } else {
    recordsKey = K_RECORDS;
    settingsKey = K_SETTINGS;
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
    pullFromTurso();
  } else {
    setSyncState('off', 'lokal');
  }
}

function keluar() {
  if (!confirm('Keluar dari akun ini?')) return;
  simpanSesi('');
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
    (id) => $(id).addEventListener('change', () => {
      bacaSettingsDariForm();
      renderRekap();
    })
  );

  $('btnSync').addEventListener('click', async () => {
    bacaSettingsDariForm();
    if (!currentUser) {
      toast('Login terlebih dahulu.', 'err');
      return;
    }
    await pullFromTurso();
    await pushToTurso();
    toast('Sinkronisasi selesai', 'ok');
  });
}

function boot() {
  console.log("App booting...");
  initApp();
  initAuth();

  const sesi = getSesi();
  if (sesi) {
    terapkanSesi(sesi);
  } else {
    terapkanSesi('');
    bukaModalAuth('login');
  }
}


document.addEventListener('DOMContentLoaded', boot);