// Cloudflare Worker — AOPA FBO fee proxy
// Deploy to: https://YOUR-FBO-WORKER.workers.dev/
// Query:     ?icao=I67  (FAA local code, no K prefix)
//
// Two-step AOPA API chain:
//   1. GET /AirportsAPI/airports/{faaId}      → list of businesses + hasFees
//   2. GET /AirportsAPI/businesses/{bizId}    → fee line items per FBO

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

  try {
    // Step 1: airport record → business list
    const apRes = await aopaFetch(`${AOPA_BASE}/airports/${icao}`);
    if (!apRes.ok) return json(null);

    const apData  = await apRes.json();
    const bizList = (apData.businesses || []).filter(b => b.hasFees).slice(0, MAX_FBOS);

    if (!bizList.length) return json({ fbos: [] });

    // Step 2: fetch fee details for each FBO in parallel
    const results = await Promise.all(bizList.map(biz => fetchFBO(biz)));
    const fbos    = results.filter(Boolean);

    return json({ fbos });

  } catch (err) {
    return json(null, 500);
  }
}

async function fetchFBO(biz) {
  try {
    const r = await aopaFetch(`${AOPA_BASE}/businesses/${biz.businessId}`);
    if (!r.ok) return null;
    const d = await r.json();

    // Normalise fee line items into a flat map keyed by fee type
    const fees = {};
    for (const svc of (d.businessServices || [])) {
      const key    = (svc.description || '').toLowerCase().replace(/\s+/g, '_'); // e.g. "tie_down"
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
