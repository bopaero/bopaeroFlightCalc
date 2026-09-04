// Cloudflare Worker — Mapbox Directions proxy
// Deploy to: https://tripcalc-directions.compilotrc.workers.dev/
//
// Why this exists:
//   The Mapbox token used to live in index.html, restricted by Mapbox to the
//   URL https://tripcalc.bopaero.com. That restriction is enforced off the
//   Referer header, which browsers legitimately omit (strict Referrer-Policy,
//   privacy browsers/extensions, in-app webviews) and which plain http:// does
//   not match — every such request got a silent 403 and no drive route.
//
//   Proxying fixes both halves: the token is a Worker secret (never shipped to
//   the client, no URL restriction needed), and access is gated on Origin,
//   which browsers always send on cross-origin fetches and cannot be
//   suppressed by referrer policy.
//
// Query:  ?from=LNG,LAT&to=LNG,LAT
// Returns: { distanceM, durationS, coordinates: [[lng,lat], ...] }
//          { error: "..." } on failure, with a non-200 status
//
// Secret:  wrangler secret put MAPBOX_TOKEN -c wrangler-directions.toml

const ALLOWED_ORIGINS = [
  'https://tripcalc.bopaero.com',
  'http://tripcalc.bopaero.com',
  'https://www.tripcalc.bopaero.com',
  'https://bopaero.github.io',
];

// Local dev: any localhost/127.0.0.1 port.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const CACHE_TTL = 60 * 60 * 24 * 30; // drive routes are effectively static

// Sent as Referer on the upstream Mapbox call so the proxy works whether or
// not the token still has Mapbox URL restrictions applied.
const CANONICAL_REFERER = 'https://tripcalc.bopaero.com/';

function originAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
}

function corsHeaders(origin) {
  const h = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  if (originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

// Strict coordinate parsing — this Worker holds a billable credential, so it
// must never forward arbitrary path segments to Mapbox.
function parsePair(raw) {
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  // Trim to ~1m precision; also keeps the cache key from fragmenting.
  return lng.toFixed(5) + ',' + lat.toFixed(5);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, origin);

    // Gate on Origin. Browsers always send it cross-origin; a missing or
    // unknown Origin means this is not our app calling.
    if (!originAllowed(origin)) return json({ error: 'forbidden origin' }, 403, origin);

    if (!env.MAPBOX_TOKEN) return json({ error: 'proxy misconfigured: no token' }, 500, origin);

    const url  = new URL(request.url);
    const from = parsePair(url.searchParams.get('from'));
    const to   = parsePair(url.searchParams.get('to'));
    if (!from || !to) return json({ error: 'from and to must be LNG,LAT' }, 400, origin);

    // Cache on the normalised coordinate pair, not the raw request URL.
    const cacheKey = new Request('https://directions.cache/' + from + '/' + to, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        status: 200,
        headers: { ...corsHeaders(origin), 'X-Proxy-Cache': 'HIT' },
      });
    }

    const mbUrl = 'https://api.mapbox.com/directions/v5/mapbox/driving/' +
      from + ';' + to +
      '?overview=full&geometries=geojson&access_token=' + env.MAPBOX_TOKEN;

    let upstream;
    try {
      // Send a Referer matching the canonical site URL. An unrestricted token
      // ignores this; a token still carrying Mapbox's URL restriction needs it,
      // since a server-side fetch sends no Referer of its own. Keeping it means
      // the proxy works with the token configured either way.
      upstream = await fetch(mbUrl, { headers: { 'Referer': CANONICAL_REFERER } });
    } catch (e) {
      return json({ error: 'upstream unreachable' }, 502, origin);
    }

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 200);
      // Surface the real upstream status so client logs are diagnosable, but
      // never echo the token back.
      return json({ error: 'upstream ' + upstream.status, detail }, 502, origin);
    }

    let data;
    try {
      data = await upstream.json();
    } catch (e) {
      return json({ error: 'upstream returned non-JSON' }, 502, origin);
    }

    if (!data || !data.routes || !data.routes.length) {
      return json({ error: 'no route found' }, 404, origin);
    }

    const route = data.routes[0];
    const payload = {
      distanceM: route.distance,
      durationS: route.duration,
      coordinates: route.geometry.coordinates,
    };
    const body = JSON.stringify(payload);

    // Store without CORS headers — Origin varies per caller, the cached body
    // does not.
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=' + CACHE_TTL,
      },
    })));

    return new Response(body, {
      status: 200,
      headers: { ...corsHeaders(origin), 'X-Proxy-Cache': 'MISS' },
    });
  },
};
