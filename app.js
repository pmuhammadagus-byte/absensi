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