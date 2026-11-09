// Worker Cloudflare untuk sinkronisasi absensi ke Turso (SQLite over HTTP).
// Deploy: wrangler deploy
// Secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SYNC_TOKEN

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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

function authorized(request, env) {
  if (!env.SYNC_TOKEN) return true; // token belum diset: izinkan (jangan untuk produksi)
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.SYNC_TOKEN}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const { pathname } = new URL(request.url);

    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

    try {
      if (pathname === '/api/health') {
        await turso(env, [{ sql: 'SELECT 1 AS ok' }]);
        return json({ ok: true });
      }

      if (pathname === '/api/records' && request.method === 'GET') {
        const [rows] = await turso(env, [
          {
            sql: 'SELECT id, tanggal, jam_datang, jam_pulang, status, catatan FROM records ORDER BY tanggal ASC',
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

      if (pathname === '/api/records' && request.method === 'PUT') {
        const body = await request.json();
        const list = Array.isArray(body?.records) ? body.records : [];

        const statements = [{ sql: 'DELETE FROM records' }];
        for (const r of list) {
          if (!r || !r.id || !r.tanggal) continue;
          statements.push({
            sql: 'INSERT INTO records (id, tanggal, jam_datang, jam_pulang, status, catatan, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))',
            args: [r.id, r.tanggal, r.jamDatang || null, r.jamPulang || null, r.status || 'hadir', r.catatan || null],
          });
        }

        await turso(env, statements);
        return json({ ok: true, count: list.length });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
