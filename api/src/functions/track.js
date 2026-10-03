// Endpoints the contacts' tracking page uses. The share token is the only credential.
//   GET /api/negotiate?token=<share_token>[&walk_id=]  -> Web PubSub URL limited to that walk's group
//   GET /api/track/{share_token}                       -> walk snapshot: route, trail, last position
//   GET /api/tiles/{z}/{x}/{y}                          -> Azure Maps tile proxy (keeps the key server-side)
const { app } = require('@azure/functions');
const db = require('../../db');
const { clientUrlForWalk } = require('../../lib/pubsub');
const { handle, json, HttpError, badRequest } = require('../../lib/http');
const { loadWalkByToken, linkIsLive } = require('../../lib/walks');

const expired = () => new HttpError(410, 'link expired');

async function liveWalk(token) {
  const walk = await loadWalkByToken(token);
  if (!linkIsLive(walk)) throw expired(); // unknown token and old walk look the same on purpose
  return walk;
}

app.http('negotiate', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'negotiate',
  handler: handle(async (request) => {
    const token = request.query.get('token') || request.query.get('share_token');
    const walk = await liveWalk(token);
    const walkId = request.query.get('walk_id');
    if (walkId && walkId !== walk.walk_id) throw expired();
    const url = await clientUrlForWalk(walk.walk_id);
    if (!url) throw new HttpError(503, 'Live updates are not configured');
    return json(200, { url, walk_id: walk.walk_id });
  }),
});

app.http('track', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'track/{share_token}',
  handler: handle(async (request) => {
    const walk = await liveWalk(request.params.share_token);
    const [{ rows: trail }, { rows: last }] = await Promise.all([
      db.query('SELECT lat, lng FROM locations WHERE walk_id = $1 ORDER BY ts', [walk.walk_id]),
      db.query('SELECT * FROM locations WHERE walk_id = $1 ORDER BY ts DESC LIMIT 1', [walk.walk_id]),
    ]);
    const l = last[0];
    return json(200, {
      walk_id: walk.walk_id,
      name: walk.name,
      status: walk.status,
      started_at: walk.started_at,
      ended_at: walk.ended_at,
      destination: { lat: walk.dest_lat, lng: walk.dest_lng, label: walk.dest_label },
      route: { points: walk.route, distance_m: walk.distance_m, eta_s: walk.eta_s },
      trail: trail.map((p) => [p.lat, p.lng]),
      last: l
        ? {
            lat: l.lat, lng: l.lng, ts: l.ts, accuracy_m: l.accuracy_m,
            remaining_m: l.remaining_m, eta_s: l.eta_s, off_route_m: l.off_route_m,
          }
        : null,
      clip_url: walk.status === 'alert' ? walk.clip_url : null,
    });
  }),
});

app.http('tiles', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tiles/{z}/{x}/{y}',
  handler: handle(async (request) => {
    const [z, x, y] = ['z', 'x', 'y'].map((k) => Number.parseInt(request.params[k], 10));
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw badRequest('Bad tile coordinates');
    }
    if (!process.env.AZURE_MAPS_KEY) throw new HttpError(503, 'Map tiles are not configured');
    const url = new URL('https://atlas.microsoft.com/map/tile');
    url.searchParams.set('api-version', '2024-04-01');
    url.searchParams.set('tilesetId', 'microsoft.base.road');
    url.searchParams.set('zoom', z);
    url.searchParams.set('x', x);
    url.searchParams.set('y', y);
    url.searchParams.set('tileSize', '256');
    url.searchParams.set('subscription-key', process.env.AZURE_MAPS_KEY);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new HttpError(502, 'Tile fetch failed');
    return {
      status: 200,
      body: Buffer.from(await res.arrayBuffer()),
      headers: { 'Content-Type': res.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' },
    };
  }),
});
