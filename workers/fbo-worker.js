// Cloudflare Worker — AOPA FBO fee proxy
// Deploy to: https://fbo-fees.compilotrc.workers.dev/
// Query:     ?icao=GKT  or  ?icao=KGKT  (handles both K-prefix forms)
//
// Two-step AOPA API chain:
//   1. GET /AirportsAPI/airports/{id}       → list of businesses + hasFees
//   2. GET /AirportsAPI/businesses/{bizId}  → fee line items per FBO
//
// Fee entries are returned as an array preserving aircraftType so TripCalc
// can select the correct rate for SR22T vs SF50.

const AOPA_BASE = 'https://webapp.aopa.org/AirportsAPI';
const MAX_FBOS  = 4;

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

  if (!icao) return json({ error: 'icao parameter required' }, 400);

  // Try provided form first, then alternate K-prefix form
  const candidates = [icao];
  if (/^K[A-Z0-9]{3}$/.test(icao))        candidates.push(icao.slice(1));
  else if (/^[A-Z0-9]{2,3}$/.test(icao))  candidates.push('K' + icao);

  try {
    for (const id of candidates) {
      const bizList = await getBusinessList(id);
      if (bizList.length > 0) {
        const results = await Promise.all(bizList.map(fetchFBO));
        return json({ fbos: results.filter(Boolean), resolvedId: id });
      }
    }
    return json({ fbos: [] });
  } catch {
    return json(null, 500);
  }
}

async function getBusinessList(id) {
  const r = await aopaFetch(`${AOPA_BASE}/airports/${id}`);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.businesses || []).filter(b => b.hasFees).slice(0, MAX_FBOS);
}

async function fetchFBO(biz) {
  try {
    const r = await aopaFetch(`${AOPA_BASE}/businesses/${biz.businessId}`);
    if (!r.ok) return null;
    const d = await r.json();

    // Return each fee line as its own entry — preserves aircraftType so TripCalc
    // can select the right rate (e.g. SR22T = Single-Engine Piston, SF50 = Small Jet)
    const fees = (d.businessServices || [])
      .filter(s => s.fee != null)
      .map(s => ({
        type:        (s.description || '').toLowerCase().replace(/\s+/g, '_'),
        amount:      parseAmount(s.fee),
        basis:       s.feeBasis   || '',
        aircraftType: s.aircraftType || 'All Aircraft',
        note:        s.serviceNote || '',
      }));

    return { name: d.name || biz.businessName || '', fees, updated: d.feesLastUpdate || null };
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

function parseAmount(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
