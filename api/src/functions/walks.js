// POST /api/walks — plan a walking route, create the walk and its share link, text the contacts.
const crypto = require('crypto');
const { app } = require('../../lib/router');
const db = require('../../db');
const { walkingRoute } = require('../../lib/maps');
const { textAll } = require('../../lib/sms');
const { handle, readJson, json, badRequest, requireLatLng, baseUrl, HttpError } = require('../../lib/http');
const { messages, shareUrl, walkJson, logEvent } = require('../../lib/walks');

const MAX_WALK_M = 20_000;

app.http('walks', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks',
  handler: handle(async (request, context) => {
    const body = await readJson(request);
    if (typeof body.user_id !== 'string' || !body.user_id) throw badRequest('user_id is required');
    const start = requireLatLng(body.start, 'start');
    const dest = requireLatLng(body.destination, 'destination');
    const label = typeof body.destination.label === 'string' ? body.destination.label.slice(0, 120) : null;

    const { rows: users } = await db.query('SELECT name, contacts FROM users WHERE user_id = $1', [body.user_id]);
    if (!users[0]) throw badRequest('Unknown user_id: create a profile first with POST /api/profile');
    const user = users[0];

    let route;
    try {
      route = await walkingRoute(start, dest);
    } catch (err) {
      context.error(err);
      throw new HttpError(502, 'Could not get a walking route from Amazon Location');
    }
    if (route.distance_m > MAX_WALK_M) throw badRequest('Destination is too far to walk (over 20 km)');

    const walkId = `w_${crypto.randomBytes(8).toString('hex')}`;
    const shareToken = crypto.randomBytes(18).toString('base64url'); // 24 chars, 144 bits

    const { rows } = await db.query(
      `INSERT INTO walks (walk_id, user_id, start_lat, start_lng, dest_lat, dest_lng, dest_label,
                          route, distance_m, eta_s, share_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [walkId, body.user_id, start[0], start[1], dest[0], dest[1], label,
       JSON.stringify(route.points), Math.round(route.distance_m), Math.round(route.eta_s), shareToken],
    );

    const base = baseUrl(request);
    const url = shareUrl(base, shareToken);
    const phones = user.contacts.map((c) => c.phone);
    const texted = await textAll(phones, messages.started(user.name, url), context);
    await logEvent(walkId, { ts: new Date(), type: 'walk_started', texted });

    return json(201, walkJson(rows[0], base));
  }),
});
