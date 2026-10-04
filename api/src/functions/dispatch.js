// Simulated 911 ("dispatch") calls. See lib/dispatch.js for how the pieces fit together.
//   POST /api/voice/token             {walk_id, name?, lat?, lng?} -> {provider, token, dispatch_display}
//   POST /api/voice/twiml             Twilio webhook (the TwiML App's Voice URL): dials the dispatcher
//   POST /api/voice/whisper           Twilio webhook: the report the dispatcher hears before connecting
//   GET|POST /api/voice/vonage/answer   Vonage webhook (the Application's Answer URL): same as twiml
//   GET|POST /api/voice/vonage/whisper  Vonage webhook: the report, played on answer
//   GET|POST /api/voice/vonage/event    Vonage webhook (Event URL): call status, logged only
//   POST /api/walks/{walk_id}/dispatch {reason, said?, name?, lat?, lng?} -> automated call
//
// Demo-mode walks (walk_id w_demo or w_local_*) exist only on the phone: the app sends her name and
// position, and those calls are limited to a few per 10 minutes (see lib/dispatch.js).
const { app } = require('../../lib/router');
const { handle, readJson, json, badRequest, notFound, requireWalkId, baseUrl, HttpError } = require('../../lib/http');
const { linkIsLive, logEvent } = require('../../lib/walks');
const d = require('../../lib/dispatch');
const vonage = require('../../lib/vonage');

const REASON_RE = /^[a-z_]{1,20}$/;
const xml = (body) => ({ status: 200, body, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } });
const LIMIT_TEXT = 'Firefly demo: too many demo emergency calls in the last few minutes. Please try again shortly.';
const NOT_SET_UP = 'Firefly cannot place this call: the demo dispatch number is not set up.';

// Twilio posts webhooks as application/x-www-form-urlencoded.
async function formParams(request) {
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

// A stored walk, or a demo walk built from what the app sent ({walk_id, name, lat, lng}).
async function resolveWalk(src) {
  if (d.isDemoWalkId(src.walk_id)) return d.demoWalk(src);
  return d.loadWalkForDispatch(src.walk_id);
}

app.http('voiceToken', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'voice/token',
  handler: handle(async (request) => {
    const body = await readJson(request);
    const walk = await resolveWalk(body);
    if (!walk || (!walk.demo && !linkIsLive(walk))) throw notFound('Walk not found');
    const dispatch = d.dispatchNumber();
    if (!dispatch) throw new HttpError(503, 'Dispatch number is missing or not allowed');
    if (!d.voiceAppConfigured()) throw new HttpError(503, 'In-app calling is not configured');
    const { provider, token } = await d.voiceToken(`walker_${walk.walk_id}`);
    return json(200, { provider, token, dispatch_display: d.displayNumber(dispatch), dispatch_tel: dispatch });
  }),
});

// Shared by both providers' "the app placed a call" webhooks: find the walk, text the dispatcher
// her live link and log the call. Awaited (Lambda may freeze work left running after the
// response), but capped at 3 s so connecting is never held up for long.
// Returns { walk, reason, limited }: limited means a demo call over the limit (don't connect).
async function startAppCall({ src, callId, base, context }) {
  const reason = REASON_RE.test(src.reason || '') ? src.reason : 'button';
  const walk = await resolveWalk(src);
  if (walk && walk.demo && !(await d.demoCallAllowed())) return { walk, reason, limited: true };
  if (walk) {
    const sideEffects = Promise.allSettled([
      d.textDispatcher(walk, reason, base, context),
      logEvent(walk.walk_id, { ts: new Date(), type: 'dispatch_call', source: reason, data: { mode: 'app', call_sid: callId || null } }),
    ]);
    await Promise.race([sideEffects, new Promise((r) => setTimeout(r, 3000))]);
  }
  return { walk, reason, limited: false };
}

async function whisperReport(query) {
  const src = Object.fromEntries(query);
  const walk = await resolveWalk(src);
  return d.reportText({ name: walk && walk.name, reason: src.reason, location: await d.whereIs(walk), connecting: true, said: src.said });
}

// ---------- Twilio ----------
app.http('voiceTwiml', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'voice/twiml',
  handler: handle(async (request, context) => {
    const params = await formParams(request);
    const base = baseUrl(request);
    if (!d.isFromTwilio(request, params, base)) throw new HttpError(403, 'Not a Twilio request');
    const dispatch = d.dispatchNumber();
    if (!dispatch) return xml(d.sayTwiml(NOT_SET_UP));
    const { walk, reason, limited } = await startAppCall({ src: params, callId: params.CallSid, base, context });
    if (limited) return xml(d.sayTwiml(LIMIT_TEXT));
    return xml(d.dialTwiml({ dispatch, walk, reason, base, said: params.said }));
  }),
});

app.http('voiceWhisper', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'voice/whisper',
  handler: handle(async (request) => {
    const params = request.method === 'POST' ? await formParams(request) : {};
    if (!d.isFromTwilio(request, params, baseUrl(request))) throw new HttpError(403, 'Not a Twilio request');
    return xml(d.sayTwiml(await whisperReport(request.query)));
  }),
});

// ---------- Automated call (fallback, and duress via the events endpoint) ----------
app.http('dispatch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'walks/{walk_id}/dispatch',
  handler: handle(async (request, context) => {
    const walkId = requireWalkId(request);
    const body = await readJson(request);
    const reason = body.reason == null ? 'button' : body.reason;
    if (!REASON_RE.test(reason)) throw badRequest('reason must be a short word like "scream" or "button"');
    const walk = await resolveWalk({ ...body, walk_id: walkId });
    if (!walk || (!walk.demo && !linkIsLive(walk))) throw notFound('Walk not found');
    const result = await d.automatedDispatchCall(walk, { reason, said: body.said, base: baseUrl(request), log: context });
    if (result.called) await logEvent(walk.walk_id, { ts: new Date(), type: 'dispatch_call', source: reason, data: { mode: 'automated', call_sid: result.call_sid || null } });
    return json(200, { ok: true, ...result });
  }),
});

// ---------- Vonage ----------
// Vonage may send webhooks as GET (query string) or POST (JSON body); read both.
async function vonageParams(request) {
  const raw = request.method === 'POST' ? await request.text() : '';
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const merged = { ...Object.fromEntries(request.query), ...body };
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
    if (!dispatch) return json(200, d.talkNcco(NOT_SET_UP));
    const base = baseUrl(request);
    const { walk, reason, limited } = await startAppCall({ src: custom, callId: merged.uuid, base, context });
    if (limited) return json(200, d.talkNcco(LIMIT_TEXT));
    return json(200, d.connectNcco({ dispatch, walk, reason, base, said: custom.said }));
  }),
});

app.http('vonageWhisper', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'voice/vonage/whisper',
  handler: handle(async (request) => {
    const { raw } = await vonageParams(request);
    if (!vonage.isFromVonage(request, raw)) throw new HttpError(403, 'Not a Vonage request');
    return json(200, d.talkNcco(await whisperReport(request.query)));
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
