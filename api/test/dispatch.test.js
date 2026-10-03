// Simulated 911 dispatch: safety rules, TwiML, webhooks and the duress auto-call.
// No Twilio account needed: without settings, calls and texts are logged (mock mode).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(TWILIO|DISPATCH)_/.test(k)) delete process.env[k];
process.env.PUBLIC_BASE_URL = 'https://firefly.test';

const calls = [];
let responders = [];
require.cache[path.resolve(__dirname, '../db/index.js')] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { query: async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of responders) if (re.test(sql)) return fn(params);
    return { rows: [], rowCount: 0 };
  } },
};

const { byName: handlers, Request } = require('../lib/router');
for (const f of require('fs').readdirSync(path.join(__dirname, '../src/functions'))) require(`../src/functions/${f}`);
const d = require('../lib/dispatch');

const logs = [];
const ctx = { log() {}, info() {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
function call(name, { method = 'POST', body, params = {}, query = {}, headers = {}, form = false } = {}) {
  const url = new URL('https://firefly.test/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const raw = body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  return handlers[name](new Request({
    method, url: url.toString(), params, body: raw,
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
  }), ctx);
}

const WALK = { walk_id: 'w_456', share_token: 'Xk3v9QpL2mN7rT8wZ1yB4cDe', ended_at: null, name: 'Priya' };
const walkRows = () => [/FROM walks w JOIN users/, () => ({ rows: [{ ...WALK, contacts: [{ phone: '+15551230001' }] }] })];
test.beforeEach(() => { calls.length = 0; logs.length = 0; responders = []; delete process.env.DISPATCH_NUMBER; delete process.env.TWILIO_AUTH_TOKEN; });

test('never dials 911, other emergency numbers or N11 service numbers', () => {
  for (const n of ['911', '+1911', '112', '999', '988', '+19115551234', '+12115551234', '(911) 555-1234', '+10005551234', '555-1234'])
    assert.equal(d.isEmergencyNumber(n), true, n);
  for (const n of ['+13128262020', '3128262020', '(312) 826-2020', '+15551230001']) assert.equal(d.isEmergencyNumber(n), false, n);
});

test('dispatch number defaults to 312-826-2020 and refuses a 911 override', () => {
  assert.equal(d.dispatchNumber(), '+13128262020');
  assert.equal(d.displayNumber(d.dispatchNumber()), '(312) 826-2020');
  process.env.DISPATCH_NUMBER = '911';
  assert.equal(d.dispatchNumber(), null);
});

test('in-app call TwiML dials the dispatcher with a whisper report, and texts them her live link', async () => {
  responders = [walkRows()];
  const res = await call('voiceTwiml', { form: true, body: { walk_id: 'w_456', reason: 'scream', CallSid: 'CA1' } });
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/xml/);
  assert.match(res.body, /<Number url="https:\/\/firefly\.test\/api\/voice\/whisper\?walk_id=w_456&amp;reason=scream">\+13128262020<\/Number>/);
  assert.match(res.body, /answerOnBridge="true"/);
  assert.doesNotMatch(res.body, /911</);
  assert.ok(logs.some((m) => m.includes('[sms mock] would text +13128262020') && m.includes('/track/Xk3v9QpL2mN7rT8wZ1yB4cDe')));
  assert.ok(calls.some((c) => /INSERT INTO walk_events/.test(c.sql) && c.params[2] === 'dispatch_call'));
});

test('TwiML refuses to dial when DISPATCH_NUMBER is an emergency number', async () => {
  process.env.DISPATCH_NUMBER = '+1 911';
  const res = await call('voiceTwiml', { form: true, body: { walk_id: 'w_456' } });
  assert.doesNotMatch(res.body, /<Dial/);
  assert.match(res.body, /not set up/);
});

test('whisper report: says it is a simulation, who, why, and the last location', async () => {
  responders = [walkRows(), [/FROM locations/, () => ({ rows: [{ lat: 40.742, lng: -74.1776, ts: new Date() }] })]];
  const res = await call('voiceWhisper', { form: true, body: {}, query: { walk_id: 'w_456', reason: 'scream' } });
  assert.match(res.body, /simulation, not a real 9 1 1 call/);
  assert.match(res.body, /Priya may need help: a scream was detected/);
  assert.match(res.body, /latitude 40\.7420, longitude minus 74\.1776/);
  assert.match(res.body, /Connecting you to her now/);
});

test('webhooks reject requests without a valid Twilio signature once an auth token is set', async () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  const params = { walk_id: 'w_456', CallSid: 'CA1' };
  const bad = await call('voiceTwiml', { form: true, body: params, headers: { 'x-twilio-signature': 'nope' } });
  assert.equal(bad.status, 403);
  // A correctly signed request (same algorithm Twilio uses) is accepted.
  const crypto = require('crypto');
  const url = 'https://firefly.test/api/x';
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const sig = crypto.createHmac('sha1', 'test-token').update(Buffer.from(data, 'utf-8')).digest('base64');
  responders = [walkRows()];
  const good = await call('voiceTwiml', { form: true, body: params, headers: { 'x-twilio-signature': sig } });
  assert.equal(good.status, 200);
});

test('voice token is 503 until Twilio Voice is configured; unknown walks are 404', async () => {
  assert.equal((await call('voiceToken', { body: { walk_id: 'w_nope' } })).status, 404);
  responders = [walkRows()];
  const res = await call('voiceToken', { body: { walk_id: 'w_456' } });
  assert.equal(res.status, 503);
  assert.match(res.jsonBody.error, /not configured/);
});

test('voice token, once configured, only allows outgoing calls to the TwiML App', async () => {
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_API_KEY_SID: 'SK' + '0'.repeat(32),
    TWILIO_API_KEY_SECRET: 'secret', TWILIO_TWIML_APP_SID: 'AP' + '1'.repeat(32), TWILIO_FROM_NUMBER: '+15005550006' });
  try {
    responders = [walkRows()];
    const res = await call('voiceToken', { body: { walk_id: 'w_456' } });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.dispatch_display, '(312) 826-2020');
    const payload = JSON.parse(Buffer.from(res.jsonBody.token.split('.')[1], 'base64url').toString());
    assert.equal(payload.grants.identity, 'walker_w_456');
    assert.equal(payload.grants.voice.outgoing.application_sid, 'AP' + '1'.repeat(32));
    assert.ok(!payload.grants.voice.incoming || payload.grants.voice.incoming.allow === false);
  } finally {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID', 'TWILIO_FROM_NUMBER']) delete process.env[k];
  }
});

test('duress auto-calls the dispatcher (silently); alert_sent leaves the call to the app', async () => {
  responders = [walkRows(),
    [/UPDATE walks\s+SET status = 'alert'/, () => ({ rows: [{ clip_url: null }], rowCount: 1 })],
    [/UPDATE walks SET last_dispatch_at/, () => ({ rowCount: 1 })]];
  const duress = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'duress' } });
  assert.equal(duress.jsonBody.dispatch_called, true);
  assert.ok(logs.some((m) => m.startsWith('[call mock] would call +13128262020') && /entered her duress PIN/.test(m)));

  logs.length = 0;
  const alert = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'alert_sent', source: 'scream' } });
  assert.equal(alert.jsonBody.dispatch_called, undefined);
  assert.ok(!logs.some((m) => m.startsWith('[call mock]')));
});

test('automated dispatch: at most once a minute per walk; bad reason is 400', async () => {
  responders = [walkRows(), [/UPDATE walks SET last_dispatch_at/, () => ({ rowCount: 0 })]];
  const res = await call('dispatch', { params: { walk_id: 'w_456' }, body: { reason: 'button' } });
  assert.deepEqual(res.jsonBody, { ok: true, called: false, duplicate: true });
  assert.equal((await call('dispatch', { params: { walk_id: 'w_456' }, body: { reason: 'DROP TABLE' } })).status, 400);
});
