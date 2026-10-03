// Endpoints the contacts' tracking page uses. The share token is the only credential.
//   GET /api/negotiate?token=<share_token>[&walk_id=]  -> WebSocket URL; it only receives that walk's messages
//   GET /api/track/{share_token}                       -> walk snapshot: route, trail, last position
const { app } = require('../../lib/router');
const db = require('../../db');
const { clientUrlForWalk } = require('../../lib/realtime');
const { handle, json, HttpError } = require('../../lib/http');
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
    const url = clientUrlForWalk(walk.share_token);
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

// GET /api/health — for hosting health checks: 200 when the database answers.
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: handle(async () => {
    await db.query('SELECT 1');
    return json(200, { ok: true });
  }),
});
