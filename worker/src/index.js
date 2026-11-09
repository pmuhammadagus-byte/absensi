// Worker Cloudflare untuk sinkronisasi absensi ke Turso (SQLite over HTTP).
// Lengkap dengan register, login, dan data per-user.
// Deploy: wrangler deploy
// Secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SESSION_SECRET

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
  'Access-Control-Allow-Credentials': 'true',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

/** Eksekusi satu atau beberapa statement ke Turso HTTP API. */
async function turso(env, statements) {
  const url = env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: statements.map((s) => ({
        type: 'execute',
        stmt: {
          sql: s.sql,
          args: (s.args || []).map((v) =>
            v === null || v === undefined
              ? { type: 'null' }
              : typeof v === 'number'
                ? { type: 'integer', value: String(Math.trunc(v)) }
                : { type: 'text', value: String(v) }
          ),
        },
      })),
    }),
  });

  if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();

  const results = (body.results || []).map((r) => {
    if (r.type === 'error') throw new Error(r.error?.message || 'turso error');
    const rows = r.response?.result?.rows || [];
    const cols = (r.response?.result?.cols || []).map((c) => c.name);
    return rows.map((row) => {
      const obj = {};
      row.forEach((cell, i) => {
        obj[cols[i]] = cell.type === 'null' ? null : cell.value;
      });
      return obj;
    });
  });

  return results;
}

/* ---------- hashing (sinkron, ringan) ---------- */

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b.buffer);
}

const enc = new TextEncoder();

async function hashPassword(password, salt) {
  let digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${password}`));
  for (let i = 0; i < 800; i++) {
    digest = await crypto.subtle.digest('SHA-256', digest);
  }
  return bytesToHex(digest);
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || 'id' + Date.now() + Math.random().toString(16).slice(2);
}

function newApiKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'ak_' + bytesToHex(b.buffer);
}

/* ---------- auth helper ---------- */

async function getSessionUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const key = auth.slice(7).trim();
  if (!key) return null;

  const [rows] = await turso(env, [
    {
      sql: 'SELECT id, username FROM users WHERE api_key = ? LIMIT 1',
      args: [key],
    },
  ]);

  return rows[0] || null;
}

function jsonBody(request) {
  return request.json().catch(() => ({}));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      /* ---------- health ---------- */
      if (pathname === '/api/health') {
        await turso(env, [{ sql: 'SELECT 1 AS ok' }]);
        return json({ ok: true });
      }

      /* ---------- register ---------- */
      if (pathname === '/api/register' && request.method === 'POST') {
        const body = await jsonBody(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');

        if (!username || username.length < 3) return json({ error: 'Username minimal 3 karakter.' }, 400);
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) return json({ error: 'Username hanya huruf, angka, titik, _, -.' }, 400);
        if (password.length < 6) return json({ error: 'Password minimal 6 karakter.' }, 400);

        const [existing] = await turso(env, [
          { sql: 'SELECT id FROM users WHERE username = ? LIMIT 1', args: [username.toLowerCase()] },
        ]);
        if (existing.length) return json({ error: 'Username sudah terdaftar.' }, 409);

        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        const id = newId();
        const apiKey = newApiKey();

        await turso(env, [
          {
            sql: 'INSERT INTO users (id, username, salt, hash, api_key, dibuat) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
            args: [id, username.toLowerCase(), salt, hash, apiKey],
          },
        ]);

        return json({ ok: true, username, api_key: apiKey });
      }

      /* ---------- login ---------- */
      if (pathname === '/api/login' && request.method === 'POST') {
        const body = await jsonBody(request);
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!username || !password) return json({ error: 'Username dan password wajib diisi.' }, 400);

        const [rows] = await turso(env, [
          { sql: 'SELECT id, username, salt, hash, api_key FROM users WHERE username = ? LIMIT 1', args: [username] },
        ]);

        if (!rows.length) return json({ error: 'Username belum terdaftar.' }, 404);
        const u = rows[0];

        const hash = await hashPassword(password, u.salt);
        if (hash !== u.hash) return json({ error: 'Password salah.' }, 401);

        // Rotate API key on login for extra safety
        const newKey = newApiKey();
        await turso(env, [
          { sql: 'UPDATE users SET api_key = ? WHERE id = ?', args: [newKey, u.id] },
        ]);

        return json({ ok: true, username: u.username, api_key: newKey });
      }

      /* ---------- records ---------- */
      if (pathname === '/api/records') {
        const user = await getSessionUser(request, env);
        if (!user) return json({ error: 'unauthorized' }, 401);

        if (request.method === 'GET') {
          const [rows] = await turso(env, [
            {
              sql: 'SELECT id, tanggal, jam_datang, jam_pulang, status, catatan FROM records WHERE user_id = ? ORDER BY tanggal ASC',
              args: [user.id],
            },
          ]);
          const records = rows.map((r) => ({
            id: r.id,
            tanggal: r.tanggal,
            jamDatang: r.jam_datang || '',
            jamPulang: r.jam_pulang || '',
            status: r.status || 'hadir',
            catatan: r.catatan || '',
          }));
          return json({ records });
        }

        if (request.method === 'PUT') {
          const body = await jsonBody(request);
          const list = Array.isArray(body?.records) ? body.records : [];

          const statements = [{ sql: 'DELETE FROM records WHERE user_id = ?', args: [user.id] }];
          for (const r of list) {
            if (!r || !r.id || !r.tanggal) continue;
            statements.push({
              sql: 'INSERT INTO records (id, user_id, tanggal, jam_datang, jam_pulang, status, catatan, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
              args: [
                r.id,
                user.id,
                r.tanggal,
                r.jamDatang || null,
                r.jamPulang || null,
                r.status || 'hadir',
                r.catatan || null,
              ],
            });
          }

          await turso(env, statements);
          return json({ ok: true, count: list.length });
        }
      }

      /* ---------- settings ---------- */
      if (pathname === '/api/settings') {
        const user = await getSessionUser(request, env);
        if (!user) return json({ error: 'unauthorized' }, 401);

        if (request.method === 'GET') {
          const [rows] = await turso(env, [
            {
              sql: 'SELECT nama, jam_masuk_normal, jam_pulang_normal, tarif_harian FROM pengaturan WHERE user_id = ? LIMIT 1',
              args: [user.id],
            },
          ]);
          const s = rows[0];
          return json({
            settings: s
              ? {
                  nama: s.nama || '',
                  jamMasukNormal: s.jam_masuk_normal || '08:00',
                  jamPulangNormal: s.jam_pulang_normal || '17:00',
                  tarifHarian: Number(s.tarif_harian || 0),
                }
              : null,
          });
        }

        if (request.method === 'PUT') {
          const body = await jsonBody(request);
          const s = body.settings || {};

          await turso(env, [
            {
              sql: `INSERT INTO pengaturan (user_id, nama, jam_masuk_normal, jam_pulang_normal, tarif_harian, updated_at)
                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(user_id) DO UPDATE SET
                      nama = excluded.nama,
                      jam_masuk_normal = excluded.jam_masuk_normal,
                      jam_pulang_normal = excluded.jam_pulang_normal,
                      tarif_harian = excluded.tarif_harian,
                      updated_at = datetime('now')`,
              args: [
                user.id,
                String(s.nama || ''),
                String(s.jamMasukNormal || '08:00'),
                String(s.jamPulangNormal || '17:00'),
                Number(s.tarifHarian || 0),
              ],
            },
          ]);
          return json({ ok: true });
        }
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
