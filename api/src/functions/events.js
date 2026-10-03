// POST /api/walks/{walk_id}/events — log every event; alerts and arrivals also text and push.
// GET  /api/walks/{walk_id}/events?token=<share_token> — events log for the demo view.
const { app } = require('@azure/functions');
const db = require('../../db');
const {
  handle, readJson, json, badRequest, notFound, optionalTs, requireWalkId, isNum, baseUrl,
} = require('../../lib/http');
const { loadWalk, raiseAlert, markArrived, logEvent } = require('../../lib/walks');

const ALERT_TYPES = new Set(['alert_sent', 'duress']);
const KNOWN = new Set(['source', 'confidence', 'clip_url', 'ts', 'type']);

function validate(body) {
  if (typeof body.type !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(body.type)) {
    throw badRequest('type is required, e.g. "check_in", "alert_sent", "duress" or "arrived"');
  }
  if (body.source != null && (typeof body.source !== 'string' || body.source.length > 40)) {
    throw badRequest('source must be a short string');
  }
  if (body.confidence != null && (!isNum(body.confidence) || body.confidence < 0 || body.confidence > 1)) {
    throw badRequest('confidence must be a number from 0 to 1');
  }
  if (body.clip_url != null && (typeof body.clip_url !== 'string' || !/^https:\/\//.test(body.clip_url))) {
    throw badRequest('clip_url must be an https URL or null');
  }
  const extra = Object.fromEntries(Object.entries(body).filter(([k]) => !KNOWN.has(k)));
  return {
    type: body.type,
    source: body.source ?? null,
    confidence: body.confidence ?? null,
    clip_url: body.clip_url ?? null,
    ts: optionalTs(body.ts),
    data: Object.keys(extra).length ? extra : null,
  };
}

app.http('events', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/events',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    if (request.method === 'GET') return listEvents(request, walkId);

    const ev = validate(await readJson(request));
    const walk = await loadWalk(walkId);

    let outcome = { texted: [] };
    if (ALERT_TYPES.has(ev.type)) {
      outcome = await raiseAlert(walk, { clipUrl: ev.clip_url, base: baseUrl(request), log: context });
    } else if (ev.type === 'arrived') {
      outcome = await markArrived(walk, { log: context });
    }

    await logEvent(walkId, { ...ev, texted: outcome.texted });
    return json(200, { saved: true, ...outcome });
  }),
});

async function listEvents(request, walkId) {
  const token = request.query.get('token');
  const { rows: w } = await db.query('SELECT 1 FROM walks WHERE walk_id = $1 AND share_token = $2', [walkId, token]);
  if (!w[0]) throw notFound('Walk not found');
  const { rows } = await db.query(
    `SELECT ts, type, source, confidence, texted, data FROM walk_events
      WHERE walk_id = $1 ORDER BY ts DESC LIMIT 200`,
    [walkId],
  );
  // Phone numbers are masked: this view is reachable with the share link.
  return json(200, {
    events: rows.map((r) => ({ ...r, texted: (r.texted || []).map((p) => `***${p.slice(-4)}`) })),
  });
}
