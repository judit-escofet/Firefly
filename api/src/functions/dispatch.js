// Simulated 911 ("dispatch") calls. See lib/dispatch.js for how the pieces fit together.
//   POST /api/voice/token             {walk_id}  -> {provider, token, dispatch_display} for the browser
//   POST /api/voice/twiml             Twilio webhook (the TwiML App's Voice URL): dials the dispatcher
//   POST /api/voice/whisper           Twilio webhook: the report the dispatcher hears before connecting
//   GET|POST /api/voice/vonage/answer   Vonage webhook (the Application's Answer URL): same as twiml
//   GET|POST /api/voice/vonage/whisper  Vonage webhook: the report, played on answer
//   GET|POST /api/voice/vonage/event    Vonage webhook (Event URL): call status, logged only
//   POST /api/walks/{walk_id}/dispatch {reason} -> automated call (used when the in-app call can't start)
const { app } = require('../../lib/router');
const { handle, readJson, json, badRequest, notFound, requireWalkId, baseUrl, HttpError } = require('../../lib/http');
const { linkIsLive, logEvent } = require('../../lib/walks');
const d = require('../../lib/dispatch');
const vonage = require('../../lib/vonage');

const REASON_RE = /^[a-z_]{1,20}$/;
const xml = (body) => ({ status: 200, body, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } });

// Twilio posts webhooks as application/x-www-form-urlencoded.
async function formParams(request) {
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

app.http('voiceToken', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'voice/token',
  handler: handle(async (request) => {
    const body = await readJson(request);
    const walk = await d.loadWalkForDispatch(body.walk_id);
    if (!walk || !linkIsLive(walk)) throw notFound('Walk not found');
    const dispatch = d.dispatchNumber();
    if (!dispatch) throw new HttpError(503, 'Dispatch number is missing or not allowed');
    if (!d.voiceAppConfigured()) throw new HttpError(503, 'In-app calling is not configured');
    const { provider, token } = await d.voiceToken(`walker_${walk.walk_id}`);
    return json(200, {
      provider,
      token,
      dispatch_display: d.displayNumber(dispatch),
      dispatch_tel: dispatch,
    });
  }),
});

app.http('voiceTwiml', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'voice/twiml',
  handler: handle(async (request, context) => {
    const params = await formParams(request);
    const base = baseUrl(request);
    if (!d.isFromTwilio(request, params, base)) throw new HttpError(403, 'Not a Twilio request');
    const dispatch = d.dispatchNumber();
    if (!dispatch) return xml(d.sayTwiml('Firefly cannot place this call: the demo dispatch number is not set up.'));

    const { walk, reason } = await startAppCall({ walkId: params.walk_id, reason: params.reason, callId: params.CallSid, base, context });
    return xml(d.dialTwiml({ dispatch, walkId: walk && walk.walk_id, reason, base }));
  }),
});

// Shared by both providers' "the app placed a call" webhooks: find the walk, text the dispatcher
// her live link and log the call. Awaited (Lambda may freeze work left running after the
// response), but capped at 3 s so connecting is never held up for long.
async function startAppCall({ walkId, reason, callId, base, context }) {
  const why = REASON_RE.test(reason || '') ? reason : 'button';
  const walk = await d.loadWalkForDispatch(walkId);
  if (walk) {
    const sideEffects = Promise.allSettled([
      d.textDispatcher(walk, why, base, context),
      logEvent(walk.walk_id, { ts: new Date(), type: 'dispatch_call', source: why, data: { mode: 'app', call_sid: callId || null } }),
    ]);
    await Promise.race([sideEffects, new Promise((r) => setTimeout(r, 3000))]);
  }
  return { walk, reason: why };
}

app.http('voiceWhisper', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'voice/whisper',
  handler: handle(async (request) => {
    const params = request.method === 'POST' ? await formParams(request) : {};
    if (!d.isFromTwilio(request, params, baseUrl(request))) throw new HttpError(403, 'Not a Twilio request');
    const walkId = request.query.get('walk_id');
    const reason = request.query.get('reason');
    const walk = await d.loadWalkForDispatch(walkId);
    const location = walk ? await d.lastLocation(walk.walk_id) : null;
    return xml(d.sayTwiml(d.reportText({ name: walk && walk.name, reason, location, connecting: true })));
  }),
});

app.http('dispatch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/dispatch',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const body = await readJson(request);
    const reason = body.reason == null ? 'button' : body.reason;
    if (!REASON_RE.test(reason)) throw badRequest('reason must be a short word like "scream" or "button"');
    const walk = await d.loadWalkForDispatch(walkId);
    if (!walk || !linkIsLive(walk)) throw notFound('Walk not found');
    const result = await d.automatedDispatchCall(walk, { reason, base: baseUrl(request), log: context });
    if (result.called) await logEvent(walkId, { ts: new Date(), type: 'dispatch_call', source: reason, data: { mode: 'automated', call_sid: result.call_sid || null } });
    return json(200, { ok: true, ...result });
  }),
});

// ---------- Vonage ----------
// Vonage may send webhooks as GET (query string) or POST (JSON body); read both.
async function vonageParams(request) {
  const raw = request.method === 'POST' ? await request.text() : '';
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const q = Object.fromEntries(request.query);
  const merged = { ...q, ...body };
  let custom = merged.custom_data ?? {};
  if (typeof custom === 'string') { try { custom = JSON.parse(custom); } catch { custom = {}; } }
  return { raw, merged, custom };
}

app.http('vonageAnswer', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'voice/vonage/answer',
  handler: handle(async (request, context) => {
    const { raw, merged, custom } = await vonageParams(request);
    if (!vonage.isFromVonage(request, raw)) throw new HttpError(403, 'Not a Vonage request');
    const dispatch = d.dispatchNumber();
    if (!dispatch) return json(200, d.talkNcco('Firefly cannot place this call: the demo dispatch number is not set up.'));
    const base = baseUrl(request);
    const { walk, reason } = await startAppCall({ walkId: custom.walk_id, reason: custom.reason, callId: merged.uuid, base, context });
    return json(200, d.connectNcco({ dispatch, walkId: walk && walk.walk_id, reason, base }));
  }),
});

app.http('vonageWhisper', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'voice/vonage/whisper',
  handler: handle(async (request) => {
    const { raw } = await vonageParams(request);
    if (!vonage.isFromVonage(request, raw)) throw new HttpError(403, 'Not a Vonage request');
    const walk = await d.loadWalkForDispatch(request.query.get('walk_id'));
    const location = walk ? await d.lastLocation(walk.walk_id) : null;
    return json(200, d.talkNcco(d.reportText({ name: walk && walk.name, reason: request.query.get('reason'), location, connecting: true })));
  }),
});

app.http('vonageEvent', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'voice/vonage/event',
  handler: handle(async (request, context) => {
    const { merged } = await vonageParams(request);
    if (merged.status) context.log(`[vonage] call ${merged.uuid ?? '?'} ${merged.status}`);
    return json(200, { ok: true });
  }),
});
