// GET /api/geocode?q=<place or address>[&lat=&lng=]  -> {results: [{label, lat, lng}]} (max 5)
// For the "Where are you walking to?" prompt. Uses OpenStreetMap's Nominatim (free, no key; Amazon
// Location is blocked in the workshop account). Results are biased toward her current position.
// Nominatim's policy: identify the app, at most ~1 request/second (the app debounces typing) and
// cache: identical searches are answered from memory for 10 minutes.
const { app } = require('../../lib/router');
const { handle, json, badRequest, HttpError } = require('../../lib/http');

const cache = new Map(); // key -> {at, results}
const CACHE_MS = 10 * 60e3;
const USER_AGENT = 'Firefly-hackathon-app/1.0 (walk-home safety demo; github.com/judit-escofet/Firefly)';

function shortLabel(item) {
  const a = item.address || {};
  const first = item.name || [a.house_number, a.road].filter(Boolean).join(' ') || item.display_name.split(',')[0];
  const area = a.neighbourhood || a.suburb || a.city || a.town || a.village || a.county || '';
  return [first, area && area !== first ? area : null].filter(Boolean).join(', ');
}

app.http('geocode', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'geocode',
  handler: handle(async (request) => {
    const q = String(request.query.get('q') || '').trim();
    if (q.length < 3) throw badRequest('Type at least 3 characters');
    if (q.length > 120) throw badRequest('Search is too long');
    const lat = Number(request.query.get('lat'));
    const lng = Number(request.query.get('lng'));
    const near = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    const key = `${q.toLowerCase()}|${near ? `${lat.toFixed(2)},${lng.toFixed(2)}` : ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(200, { results: hit.results });

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '1');
    if (near) {
      // Prefer places within ~15 km of her, without excluding farther ones.
      const d = 0.15;
      url.searchParams.set('viewbox', `${lng - d},${lat + d},${lng + d},${lat - d}`);
      url.searchParams.set('bounded', '0');
    }
    let items;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      items = await res.json();
    } catch (err) {
      throw new HttpError(502, `Place search is unavailable right now (${err.message})`);
    }
    // One result per name: big places (stations, campuses) come back once per entrance.
    const seen = new Set();
    const results = (Array.isArray(items) ? items : []).map((it) => ({
      label: shortLabel(it),
      detail: it.display_name,
      lat: Number(it.lat),
      lng: Number(it.lon),
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && !seen.has(r.label) && seen.add(r.label)).slice(0, 5);
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), results });
    return json(200, { results });
  }),
});
