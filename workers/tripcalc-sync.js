// Cloudflare Worker — TripCalc cloud sync
// Deploy: wrangler deploy --name tripcalc-sync workers/tripcalc-sync.js
//
// Required KV namespace bindings (set in wrangler.toml or dashboard):
//   TRIPCALC_SYNC  — main data store (trips + settings, keyed by sync token)
//   TRIPCALC_LINK  — short-lived link codes (TTL 600s), code → syncToken
//
// Routes:
//   GET  /data         X-Sync-Token header  → { trips, settings, updatedAt }
//   PUT  /data         X-Sync-Token header  + JSON body → { ok: true }
//   POST /link/create  X-Sync-Token header  → { code: "XXXX1234" }
//   POST /link/redeem  body: { code }        → { syncToken } or { error: "expired" }

const CORS_ORIGINS = [
  'https://bopaero.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

addEventListener('fetch', event => event.respondWith(handle(event.request)));

async function handle(request) {
  if (request.method === 'OPTIONS') return addCors(new Response(null, { status: 204 }), request);

  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;
  const token  = (request.headers.get('X-Sync-Token') || '').trim();

  // GET /data
  if (method === 'GET' && path === '/data') {
    if (!validToken(token)) return addCors(json({ error: 'invalid token' }, 401), request);
    const raw = await TRIPCALC_SYNC.get('data:' + token);
    if (!raw) return addCors(json({ trips: [], settings: {}, updatedAt: null }), request);
    return addCors(new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } }), request);
  }

  // PUT /data
  if (method === 'PUT' && path === '/data') {
    if (!validToken(token)) return addCors(json({ error: 'invalid token' }, 401), request);
    let body;
    try { body = await request.json(); } catch { return addCors(json({ error: 'invalid json' }, 400), request); }
    if (!body || typeof body !== 'object') return addCors(json({ error: 'invalid body' }, 400), request);
    body.updatedAt = new Date().toISOString();
    await TRIPCALC_SYNC.put('data:' + token, JSON.stringify(body));
    return addCors(json({ ok: true }), request);
  }

  // POST /link/create
  if (method === 'POST' && path === '/link/create') {
    if (!validToken(token)) return addCors(json({ error: 'invalid token' }, 401), request);
    const code = genCode();
    await TRIPCALC_LINK.put('link:' + code, token, { expirationTtl: 600 });
    return addCors(json({ code }), request);
  }

  // POST /link/redeem
  if (method === 'POST' && path === '/link/redeem') {
    let body;
    try { body = await request.json(); } catch { return addCors(json({ error: 'invalid json' }, 400), request); }
    const code = (body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return addCors(json({ error: 'code required' }, 400), request);
    const syncToken = await TRIPCALC_LINK.get('link:' + code);
    if (!syncToken) return addCors(json({ error: 'expired' }, 404), request);
    await TRIPCALC_LINK.delete('link:' + code); // one-time use
    return addCors(json({ syncToken }), request);
  }

  return addCors(json({ error: 'not found' }, 404), request);
}

function validToken(t) {
  return typeof t === 'string' && /^[a-f0-9-]{32,36}$/.test(t);
}

function genCode() {
  // 8 chars from an unambiguous alphabet (no 0/O/1/I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function addCors(response, request) {
  const origin  = (request.headers.get('Origin') || '');
  const allowed = CORS_ORIGINS.some(o => origin.startsWith(o));
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',  allowed ? origin : CORS_ORIGINS[0]);
  headers.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Token');
  return new Response(response.body, { status: response.status, headers });
}
