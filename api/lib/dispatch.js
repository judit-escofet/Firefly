// Simulated emergency dispatch ("fake 911") over Vonage Voice or Twilio Voice.
// Vonage is used when VONAGE_APPLICATION_ID + VONAGE_PRIVATE_KEY + VONAGE_FROM_NUMBER are set,
// otherwise Twilio. Both do the same thing; only the call instructions differ (NCCO vs TwiML).
//
// The demo stands in a normal phone number (DISPATCH_NUMBER, default 312-826-2020) for 911.
// Safety rule from the team plan: Firefly never calls real 911. isEmergencyNumber() refuses 911,
// other emergency short codes and N11 service numbers, so a misconfigured DISPATCH_NUMBER can't.
//
// Two ways a dispatch call happens:
//   1. In the app (scream alert or the Call 911 button): the browser gets a Twilio Voice token
//      (/api/voice/token) and calls our TwiML App, whose webhook (/api/voice/twiml) dials the
//      dispatch number. Before connecting, the dispatcher hears a short report (whisper), then
//      talks with her through the app's mic and speaker.
//   2. Automated (duress PIN, or when the in-app call can't start): Twilio calls the dispatch
//      number and reads the report. Nothing appears on her screen.
// Either way the dispatch number also gets a text with her live tracking link.
const db = require('../db');
const { twilioClient, textAll } = require('./sms');
const vonage = require('./vonage');

const DEFAULT_DISPATCH_NUMBER = '+13128262020';
// Demo-mode walks live only on the phone, so the app sends her name and position with the call.
// Those calls are limited (they aren't tied to a stored walk) so the public URL can't burn credit.
const DEMO_WALK = 'w_demo';
const DEMO_LIMIT = 6;            // calls
const DEMO_WINDOW_MINUTES = 10;
const AUTOMATED_GUARD_SECONDS = 60;

function nationalDigits(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

// True for numbers Firefly must never dial: emergency short codes and any North American number
// with an N11 (211…911) or invalid (0xx, 1xx) area code.
function isEmergencyNumber(phone) {
  const d = nationalDigits(phone);
  if (['911', '112', '999', '000', '933', '988'].includes(d)) return true;
  if (d.length !== 10) return true;
  const area = d.slice(0, 3);
  return /^[2-9]11$/.test(area) || /^[01]/.test(area);
}

// The number to dial, or null if it's missing or not allowed.
function dispatchNumber() {
  const raw = process.env.DISPATCH_NUMBER || DEFAULT_DISPATCH_NUMBER;
  if (isEmergencyNumber(raw)) return null;
  return `+1${nationalDigits(raw)}`;
}

function displayNumber(e164) {
  const d = nationalDigits(e164);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const twilioVoiceConfigured = () => ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID', 'TWILIO_FROM_NUMBER'].every((k) => process.env[k]);
const provider = () => (vonage.voiceConfigured() ? 'vonage' : 'twilio');
const voiceAppConfigured = () => vonage.voiceConfigured() || twilioVoiceConfigured();

// Browser token for the in-app call: { provider, token }.
async function voiceToken(identity, ttl = 600) {
  if (provider() === 'vonage') {
    // If this fails, the token is still issued: the browser's login then fails and the app falls
    // back to the automated server call, so the dispatcher is still called.
    try { await vonage.ensureUser(identity); } catch (err) { console.error(`Vonage user setup failed: ${err.message}`); }
    return { provider: 'vonage', token: vonage.clientJwt(identity, ttl) };
  }
  return { provider: 'twilio', token: twilioToken(identity, ttl) };
}

// Twilio: a token that can place ONE kind of call, to our TwiML App. No incoming calls.
function twilioToken(identity, ttl) {
  const { AccessToken } = require('twilio').jwt;
  const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET, { identity, ttl });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  return token.toJwt();
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

const REASONS = {
  scream: 'a scream was detected near her phone',
  code_phrase: 'she said her secret code phrase',
  duress: 'she entered her duress PIN',
  button: 'she pressed the emergency button',
  no_response: 'she stopped answering check-ins',
  checkin: 'she said she is not okay',
  distress: 'she said she is hurt or in danger',
};

// What she said (from speech-to-text), safe to speak and to put in a URL: letters, digits, basic
// punctuation, at most 80 characters.
const cleanSaid = (s) => String(s ?? '').replace(/[^\p{L}\p{N} ',.?!-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const reasonText = (r) => REASONS[r] || 'her safety alert went off';

// Spoken numbers: "minus 74.1776" reads better than "-74.1776".
const spoken = (n) => (n < 0 ? `minus ${Math.abs(n).toFixed(4)}` : n.toFixed(4));

async function lastLocation(walkId) {
  if (!walkId) return null;
  const { rows } = await db.query('SELECT lat, lng, ts FROM locations WHERE walk_id = $1 ORDER BY ts DESC LIMIT 1', [walkId]);
  return rows[0] || null;
}

const isDemoWalkId = (id) => !id || id === DEMO_WALK || String(id).startsWith('w_local_');
const cleanName = (s) => String(s ?? '').replace(/[^\p{L} '.-]/gu, '').trim().slice(0, 40);

function demoWalk({ name, lat, lng } = {}) {
  const la = Number(lat), ln = Number(lng);
  const ok = Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 && !(la === 0 && ln === 0);
  return { walk_id: DEMO_WALK, share_token: null, name: cleanName(name) || 'A Firefly user', demo: true,
    demoLocation: ok ? { lat: la, lng: ln, ts: new Date() } : null };
}

async function demoCallAllowed() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM walk_events
      WHERE walk_id = $1 AND type = 'dispatch_call' AND ts > now() - make_interval(mins => $2)`,
    [DEMO_WALK, DEMO_WINDOW_MINUTES],
  );
  return (rows[0] ? rows[0].n : 0) < DEMO_LIMIT;
}

// Her last position: from the walk's GPS pings, or the position a demo call carried.
async function whereIs(walk) {
  if (!walk) return null;
  if (walk.demo) return walk.demoLocation;
  return lastLocation(walk.walk_id);
}

async function loadWalkForDispatch(walkId) {
  if (!walkId || !/^w_[A-Za-z0-9_-]{1,64}$/.test(walkId)) return null;
  const { rows } = await db.query(
    'SELECT w.walk_id, w.share_token, w.ended_at, u.name FROM walks w JOIN users u USING (user_id) WHERE w.walk_id = $1',
    [walkId],
  );
  return rows[0] || null;
}

// What the dispatcher hears first. Always says it's a simulation.
function reportText({ name, reason, location, connecting, said }) {
  const who = name || 'A Firefly user';
  let where = 'Her location is not known yet.';
  if (location) {
    const ageMin = Math.max(0, Math.round((Date.now() - new Date(location.ts).getTime()) / 60000));
    where = `Her last known location is latitude ${spoken(location.lat)}, longitude ${spoken(location.lng)}, ` +
      (ageMin < 1 ? 'updated less than a minute ago.' : `updated ${ageMin} minute${ageMin === 1 ? '' : 's'} ago.`);
  }
  return `This is a Firefly demo emergency call. This is a simulation, not a real 9 1 1 call. ` +
    `${who} may need help: ${reasonText(reason)}.${cleanSaid(said) ? ` She said: "${cleanSaid(said)}".` : ''} ${where} A live map link has been texted to this number. ` +
    (connecting ? 'Connecting you to her now.' : 'Her trusted contacts have also been alerted.');
}

const saidParam = (said) => (cleanSaid(said) ? `&said=${encodeURIComponent(cleanSaid(said))}` : '');
// Demo calls carry her name and position to the whisper report.
const demoParams = (walk) => (walk && walk.demo
  ? `&name=${encodeURIComponent(walk.name)}${walk.demoLocation ? `&lat=${walk.demoLocation.lat}&lng=${walk.demoLocation.lng}` : ''}`
  : '');

const say = (text) => `<Say voice="alice">${escapeXml(text)}</Say>`;

// TwiML for the in-app call: dial the dispatcher, whisper the report to them, then connect.
function dialTwiml({ dispatch, walk, reason, base, said }) {
  const walkId = walk && walk.walk_id;
  const whisper = `${base}/api/voice/whisper?walk_id=${encodeURIComponent(walkId || '')}&reason=${encodeURIComponent(reason || '')}${saidParam(said)}${demoParams(walk)}`;
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Dial callerId="${escapeXml(process.env.TWILIO_FROM_NUMBER || '')}" answerOnBridge="true" timeout="30">` +
    `<Number url="${escapeXml(whisper)}">${escapeXml(dispatch)}</Number>` +
    '</Dial>' +
    say('The demo dispatcher did not answer. Your trusted contacts have been alerted.') +
    '</Response>';
}

// Vonage: the same call as dialTwiml, as an NCCO. onAnswer plays the report to the dispatcher
// before connecting them to her.
function connectNcco({ dispatch, walk, reason, base, said }) {
  const walkId = walk && walk.walk_id;
  const whisper = `${base}/api/voice/vonage/whisper?walk_id=${encodeURIComponent(walkId || '')}&reason=${encodeURIComponent(reason || '')}${saidParam(said)}${demoParams(walk)}`;
  return [{
    action: 'connect',
    from: vonage.digits(process.env.VONAGE_FROM_NUMBER),
    timeout: 30,
    endpoint: [{ type: 'phone', number: vonage.digits(dispatch), onAnswer: { url: whisper } }],
  }];
}
const talkNcco = (text, { repeat = false } = {}) => [{ action: 'talk', text, language: 'en-US', loop: repeat ? 2 : 1 }];

const sayTwiml = (text, { repeat = false } = {}) => '<?xml version="1.0" encoding="UTF-8"?><Response>' +
  '<Pause length="1"/>' + say(text) + (repeat ? '<Pause length="1"/>' + say(`Again. ${text}`) : '') + '</Response>';

async function textDispatcher(walk, reason, base, log) {
  const dispatch = dispatchNumber();
  if (!dispatch || !walk || !walk.share_token) return []; // demo walks have no tracking page
  const link = `${base}/track/${walk.share_token}`;
  return textAll([dispatch], `FIREFLY DEMO (simulated 911): ${walk.name || 'A Firefly user'} may need help (${reasonText(reason)}). Live location: ${link}`, log);
}

// Automated call: Twilio rings the dispatcher and reads the report. At most once a minute per walk.
// Returns { called: bool, reason } and never throws.
async function automatedDispatchCall(walk, { reason, base, said, log = console }) {
  try {
    const dispatch = dispatchNumber();
    if (!dispatch) { log.error('Dispatch call refused: DISPATCH_NUMBER is missing or an emergency number'); return { called: false }; }
    if (walk.demo) {
      if (!(await demoCallAllowed())) return { called: false, limited: true };
    } else {
      const { rowCount } = await db.query(
        `UPDATE walks SET last_dispatch_at = now()
          WHERE walk_id = $1 AND (last_dispatch_at IS NULL OR last_dispatch_at < now() - make_interval(secs => $2))`,
        [walk.walk_id, AUTOMATED_GUARD_SECONDS],
      );
      if (!rowCount) return { called: false, duplicate: true };
    }

    const report = reportText({ name: walk.name, reason, said, location: await whereIs(walk), connecting: false });
    let placeCall;
    if (vonage.voiceConfigured()) {
      placeCall = vonage.createCall({ to: dispatch, ncco: talkNcco(report, { repeat: true }) }).then((c) => ({ sid: c.uuid }));
    } else if (twilioClient()) {
      placeCall = twilioClient().calls.create({ to: dispatch, from: process.env.TWILIO_FROM_NUMBER, twiml: sayTwiml(report, { repeat: true }), timeout: 30 });
    } else {
      log.warn(`[call mock] would call ${dispatch}: ${report}`);
      placeCall = Promise.resolve(null);
    }
    const [, call] = await Promise.all([textDispatcher(walk, reason, base, log), placeCall]);
    return { called: true, call_sid: call && call.sid };
  } catch (err) {
    log.error(`Automated dispatch call failed: ${err.message}`);
    return { called: false, error: true };
  }
}

// Twilio signs every webhook. Reject requests that aren't from Twilio (unless no auth token is
// configured, i.e. local mock mode, or TWILIO_VALIDATE=0 while debugging URL mismatches).
function isFromTwilio(request, params, base) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || process.env.TWILIO_VALIDATE === '0') return true;
  const signature = request.headers.get('x-twilio-signature');
  if (!signature) return false;
  const u = new URL(request.url);
  return require('twilio').validateRequest(authToken, signature, `${base}${u.pathname}${u.search}`, params);
}

module.exports = {
  isEmergencyNumber, dispatchNumber, displayNumber, voiceAppConfigured, voiceToken, provider,
  reportText, dialTwiml, sayTwiml, connectNcco, talkNcco,
  DEMO_WALK, isDemoWalkId, demoWalk, demoCallAllowed, whereIs, lastLocation, loadWalkForDispatch, textDispatcher,
  automatedDispatchCall, isFromTwilio, DEFAULT_DISPATCH_NUMBER,
};
