// GET /api/route?from=<lat>,<lng>&to=<lat>,<lng>  -> {points: [[lat, lng], ...], distance_m, eta_s, source}
// Walking route without creating a walk: demo-mode walks (which live only on the phone) use it so
// their route follows real streets too. Same planner as POST /api/walks (lib/maps.js).
const { app } = require('../../lib/router');
const { handle, json, badRequest } = require('../../lib/http');
const { walkingRoute } = require('../../lib/maps');
const { haversine } = require('../../lib/geo');

const MAX_WALK_M = 20_000;

function point(raw, name) {
  const [lat, lng] = String(raw || '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest(`${name} must look like 40.7425,-74.1781`);
  }
  return [lat, lng];
}

app.http('route', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'route',
  handler: handle(async (request, context) => {
    const from = point(request.query.get('from'), 'from');
    const to = point(request.query.get('to'), 'to');
    if (haversine(from, to) > MAX_WALK_M) throw badRequest('Destination is too far to walk (over 20 km)');
    const r = await walkingRoute(from, to, context);
    return json(200, { points: r.points, distance_m: Math.round(r.distance_m), eta_s: Math.round(r.eta_s), source: r.source, steps: r.steps || [] },
      { 'Cache-Control': 'public, max-age=300' });
  }),
});

// POST /api/walks/{walk_id}/reroute {lat, lng} -> {route: {points, distance_m, eta_s}, steps}
// She went off the route (Google Maps' "Rerouting…"): plan from where she is now to the same
// destination and store it, so off-route distance and ETA are measured against the new route.
const db = require('../../db');
const { requireWalkId, requireLatLng, readJson, notFound, HttpError } = require('../../lib/http');

app.http('reroute', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/reroute',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const from = requireLatLng(await readJson(request), 'position');
    const { rows } = await db.query('SELECT dest_lat, dest_lng, ended_at FROM walks WHERE walk_id = $1', [walkId]);
    if (!rows[0]) throw notFound('Walk not found');
    if (rows[0].ended_at) throw new HttpError(409, 'Walk has ended');
    const r = await walkingRoute(from, [rows[0].dest_lat, rows[0].dest_lng], context);
    await db.query('UPDATE walks SET route = $2, steps = $3 WHERE walk_id = $1',
      [walkId, JSON.stringify(r.points), JSON.stringify(r.steps || [])]);
    return json(200, { route: { points: r.points, distance_m: Math.round(r.distance_m), eta_s: Math.round(r.eta_s) }, steps: r.steps || [], source: r.source });
  }),
});
