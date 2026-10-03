// POST /api/walks/{walk_id}/events — log every event; alerts and arrivals also text and push.
// GET  /api/walks/{walk_id}/events?token=<share_token> — events log for the demo view.
const { app } = require('../../lib/router');
const db = require('../../db');
const {
  handle, readJson, json, badRequest, notFound, optionalTs, requireWalkId, isNum, baseUrl,
} = require('../../lib/http');
const { loadWalk, raiseAlert, markArrived, logEvent } = require('../../lib/walks');
const { automatedDispatchCall } = require('../../lib/dispatch');

const ALERT_TYPES = new Set(['alert_sent', 'duress']);
const KNOWN = new Set(['source', 'confidence', 'clip_url', 'ts', 'type']);

// Events that must never be rejected over a bad optional field: dropping an alert is worse than
// storing it with a missing clip. Their bad fields are kept aside in data.invalid instead.
const NEVER_REJECT = new Set([...ALERT_TYPES, 'arrived']);

function validate(body) {
  if (typeof body.type !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(body.type)) {
    throw badRequest('type is required, e.g. "check_in", "alert_sent", "duress" or "arrived"');
  }
  const lenient = NEVER_REJECT.has(body.type);
  const invalid = {};
  const check = (field, ok, message) => {
    if (body[field] == null || ok(body[field])) return body[field] ?? null;
    if (!lenient) throw badRequest(message);
    invalid[field] = body[field];
    return null;
  };

  const source = check('source', (v) => typeof v === 'string' && v.length <= 40, 'source must be a short string');
  const confidence = check('confidence', (v) => isNum(v) && v >= 0 && v <= 1, 'confidence must be a number from 0 to 1');
  const clipUrl = check('clip_url', (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v) && v.length <= 2000,
    'clip_url must be a URL or null');
  let ts;
  try { ts = optionalTs(body.ts); } catch (err) {
    if (!lenient) throw err;
    invalid.ts = body.ts;
    ts = new Date();
  }

  const extra = Object.fromEntries(Object.entries(body).filter(([k]) => !KNOWN.has(k)));
  if (Object.keys(invalid).length) extra.invalid = invalid;
  return { type: body.type, source, confidence, clip_url: clipUrl, ts, data: Object.keys(extra).length ? extra : null };
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
      const base = baseUrl(request);
      outcome = await raiseAlert(walk, { clipUrl: ev.clip_url, base, log: context });
      // Duress: her screen shows "All good", so there is no visible in-app call. The simulated
      // dispatcher is called automatically instead (its own once-a-minute guard).
      if (ev.type === 'duress') {
        const call = await automatedDispatchCall(walk, { reason: 'duress', base, log: context });
        outcome.dispatch_called = call.called;
        if (call.called) await logEvent(walkId, { ts: new Date(), type: 'dispatch_call', source: 'duress', data: { mode: 'automated', call_sid: call.call_sid || null } });
      }
    } else if (ev.type === 'arrived') {
      outcome = await markArrived(walk, { log: context });
    }

    await logEvent(walkId, { ...ev, texted: outcome.texted });
    // ok/notified are the team plan's names; saved/texted are kept for existing callers.
    return json(200, { ok: true, notified: outcome.texted, saved: true, ...outcome });
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
