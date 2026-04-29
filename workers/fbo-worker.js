// Cloudflare Worker — AOPA FBO fee proxy
// Deploy to: https://fbo-fees.compilotrc.workers.dev/
// Query:     ?icao=GKT  or  ?icao=KGKT  (handles both forms)
//
// Two-step AOPA API chain:
//   1. GET /AirportsAPI/airports/{id}       → list of businesses + hasFees
//   2. GET /AirportsAPI/businesses/{bizId}  → fee line items per FBO
//
// AOPA's database is inconsistent about K-prefix: some airports are keyed
// as "GKT", others as "KGKT". We try the provided form first, then the
// alternate, and return whichever yields results.

const AOPA_BASE = 'https://webapp.aopa.org/AirportsAPI';
const MAX_FBOS  = 4; // limit parallel requests

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url  = new URL(request.url);
  const icao = (url.searchParams.get('icao') || '').trim().toUpperCase();

  if (!icao) {
    return json({ error: 'icao parameter required' }, 400);
  }

  // Build candidate identifiers to try: provided form first, then alternate.
  // e.g. GKT → [GKT, KGKT], KGKT → [KGKT, GKT], I67 → [I67, KI67]
  const candidates = [icao];
  if (/^K[A-Z0-9]{3}$/.test(icao)) {
    candidates.push(icao.slice(1));           // KGKT → GKT
  } else if (/^[A-Z0-9]{2,3}$/.test(icao)) {
    candidates.push('K' + icao);             // GKT → KGKT, I67 → KI67
  }

  try {
    for (const id of candidates) {
      const bizList = await getBusinessList(id);
      if (bizList.length > 0) {
        const results = await Promise.all(bizList.map(biz => fetchFBO(biz)));
        const fbos    = results.filter(Boolean);
        return json({ fbos, resolvedId: id });
      }
    }
    return json({ fbos: [] });

  } catch (err) {
    return json(null, 500);
  }
}

// Returns FBOs with fee data for the given airport identifier, or [] if none.
async function getBusinessList(id) {
  const apRes = await aopaFetch(`${AOPA_BASE}/airports/${id}`);
  if (!apRes.ok) return [];
  const apData = await apRes.json();
  return (apData.businesses || []).filter(b => b.hasFees).slice(0, MAX_FBOS);
}

async function fetchFBO(biz) {
  try {
    const r = await aopaFetch(`${AOPA_BASE}/businesses/${biz.businessId}`);
    if (!r.ok) return null;
    const d = await r.json();

    // Normalise fee line items into a flat map keyed by fee type
    const fees = {};
    for (const svc of (d.businessServices || [])) {
      const key    = (svc.description || '').toLowerCase().replace(/\s+/g, '_');
      const amount = parseAmount(svc.fee);
      fees[key] = { amount, basis: svc.feeBasis || '', note: svc.feeNote || '' };
    }

    return {
      name:    d.name || biz.businessName || '',
      fees,
      updated: d.feesLastUpdate || null,
    };
  } catch {
    return null;
  }
}

function aopaFetch(url) {
  return fetch(url, {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; TripCalc/1.0)',
      'Referer':    'https://webapp.aopa.org/',
    },
  });
}

function parseAmount(str) {
  if (!str) return 0;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
