// POST /api/walks/{walk_id}/location — called by the app every 5 seconds.
const { app } = require('../../lib/router');
const db = require('../../db');
const { progress } = require('../../lib/geo');
const { pushToWalk } = require('../../lib/realtime');
const {
  handle, readJson, json, badRequest, notFound, HttpError,
  requireLatLng, optionalTs, requireWalkId, isNum,
} = require('../../lib/http');

const SPEED_WINDOW_S = 60;
const SPEED_MAX_ACCURACY_M = 50; // pings fuzzier than this are stored but not used for speed

app.http('location', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/location',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const body = await readJson(request);
    const position = requireLatLng(body, 'location');
    if (body.accuracy_m !== undefined && body.accuracy_m !== null && (!isNum(body.accuracy_m) || body.accuracy_m < 0)) {
      throw badRequest('accuracy_m must be a non-negative number');
    }
    const accuracyM = body.accuracy_m ?? null;
    const ts = optionalTs(body.ts);
    if (ts.getTime() > Date.now() + 2 * 60 * 1000) throw badRequest('ts is in the future');

    const { rows } = await db.query(
      `SELECT route, dest_lat, dest_lng, ended_at FROM walks WHERE walk_id = $1`,
      [walkId],
    );
    const walk = rows[0];
    if (!walk) throw notFound('Walk not found');
    if (walk.ended_at) throw new HttpError(409, 'Walk has ended');

    const { rows: recent } = await db.query(
      `SELECT lat, lng, ts FROM locations
        WHERE walk_id = $1 AND ts > $2::timestamptz - make_interval(secs => $3) AND ts < $2
          AND (accuracy_m IS NULL OR accuracy_m <= $4)
        ORDER BY ts`,
      [walkId, ts, SPEED_WINDOW_S, SPEED_MAX_ACCURACY_M],
    );
    if (accuracyM === null || accuracyM <= SPEED_MAX_ACCURACY_M) {
      recent.push({ lat: position[0], lng: position[1], ts });
    }

    const result = progress({
      position,
      route: walk.route,
      destination: [walk.dest_lat, walk.dest_lng],
      recentPings: recent,
      accuracyM: accuracyM ?? 0,
    });

    await Promise.all([
      db.query(
        `INSERT INTO locations (ts, walk_id, lat, lng, accuracy_m, off_route_m, remaining_m, eta_s)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ts, walkId, position[0], position[1], accuracyM, result.off_route_m, result.remaining_m, result.eta_s],
      ),
      pushToWalk(walkId, {
        type: 'position',
        lat: position[0],
        lng: position[1],
        accuracy_m: accuracyM,
        ts: ts.toISOString(),
        ...result,
      }, context),
    ]);

    return json(200, result);
  }),
});
