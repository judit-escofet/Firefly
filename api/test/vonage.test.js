// Vonage provider for the simulated 911 call. A throwaway RSA key and a fake fetch: no real calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(TWILIO|DISPATCH|VONAGE)_/.test(k)) delete process.env[k];
process.env.PUBLIC_BASE_URL = 'https://firefly.test';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const VONAGE = {
  VONAGE_APPLICATION_ID: 'd4c1d00a-0000-4000-8000-000000000000',
  VONAGE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'), // as stored in JSON
  VONAGE_FROM_NUMBER: '+1 (707) 737-6070',
  VONAGE_API_KEY: 'key', VONAGE_API_SECRET: 'secret',
};

const dbCalls = [];
let responders = [];
require.cache[path.resolve(__dirname, '../db/index.js')] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { query: async (sql, params) => {
    dbCalls.push({ sql, params });
    for (const [re, fn] of responders) if (re.test(sql)) return fn(params);
    return { rows: [], rowCount: 0 };
  } },
};
const { byName: handlers, Request } = require('../lib/router');
for (const f of require('fs').readdirSync(path.join(__dirname, '../src/functions'))) require(`../src/functions/${f}`);
const vonage = require('../lib/vonage');
const d = require('../lib/dispatch');

const fetched = [];
const realFetch = global.fetch;
const logs = [];
const ctx = { log: (m) => logs.push(m), info() {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const WALK_ROW = [/FROM walks w JOIN users/, () => ({ rows: [{ walk_id: 'w_456', share_token: 'Xk3v9QpL2mN7rT8wZ1yB4cDe', ended_at: null, name: 'Priya' }] })];

function call(name, { method = 'POST', body, query = {}, headers = {}, params = {} } = {}) {
  const url = new URL('https://firefly.test/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return handlers[name](new Request({ method, url: url.toString(), params, body: body && JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers } }), ctx);
}

test.beforeEach(() => {
  Object.assign(process.env, VONAGE);
  delete process.env.VONAGE_SIGNATURE_SECRET;
  fetched.length = 0; dbCalls.length = 0; logs.length = 0; responders = [];
  global.fetch = async (url, init = {}) => {
    fetched.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith('/v1/users')) return { ok: true, status: 201, json: async () => ({ id: 'USR-1' }) };
    if (u.endsWith('/v1/calls')) return { ok: true, status: 201, json: async () => ({ uuid: 'call-uuid-1', status: 'started' }) };
    if (u.endsWith('/sms/json')) return { ok: true, status: 200, json: async () => ({ messages: [{ status: '0' }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
});
test.after(() => { global.fetch = realFetch; });

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

test('application JWT is RS256-signed with the private key and names the application', () => {
  const jwt = vonage.appJwt();
  const [h, p, s] = jwt.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  assert.equal(decode(jwt).application_id, VONAGE.VONAGE_APPLICATION_ID);
});

test('Vonage is chosen when configured; the browser token is a Client SDK login for this walker', async () => {
  assert.equal(d.provider(), 'vonage');
  responders = [WALK_ROW];
  const res = await call('voiceToken', { body: { walk_id: 'w_456' } });
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.provider, 'vonage');
  const claims = decode(res.jsonBody.token);
  assert.equal(claims.sub, 'walker_w_456');
  assert.ok(claims.acl.paths['/*/sessions/**']);
  assert.ok(fetched.some((f) => f.url.endsWith('/v1/users')), 'the Client SDK user is created first');
});

test('answer webhook: connects to 312-826-2020 from the Vonage number, with the report on answer', async () => {
  responders = [WALK_ROW];
  const res = await call('vonageAnswer', { body: { uuid: 'u1', custom_data: { walk_id: 'w_456', reason: 'scream' } } });
  const [connect] = res.jsonBody;
  assert.equal(connect.action, 'connect');
  assert.equal(connect.from, '17077376070');
  assert.equal(connect.endpoint[0].number, '13128262020');
  assert.equal(connect.endpoint[0].onAnswer.url, 'https://firefly.test/api/voice/vonage/whisper?walk_id=w_456&reason=scream');
  assert.ok(fetched.some((f) => f.url.endsWith('/sms/json') && String(f.init.body).includes('to=13128262020')), 'dispatcher gets the live link by text');
});

test('answer webhook accepts custom_data as a JSON string (GET-style)', async () => {
  responders = [WALK_ROW];
  const res = await call('vonageAnswer', { method: 'GET', query: { custom_data: JSON.stringify({ walk_id: 'w_456', reason: 'button' }) } });
  assert.match(res.jsonBody[0].endpoint[0].onAnswer.url, /reason=button/);
});

test('whisper webhook: the spoken report, as an NCCO talk action', async () => {
  responders = [WALK_ROW, [/FROM locations/, () => ({ rows: [{ lat: 40.742, lng: -74.1776, ts: new Date() }] })]];
  const res = await call('vonageWhisper', { method: 'GET', query: { walk_id: 'w_456', reason: 'scream' } });
  assert.equal(res.jsonBody[0].action, 'talk');
  assert.match(res.jsonBody[0].text, /simulation, not a real 9 1 1 call.*Priya may need help: a scream was detected/);
});

test('webhooks must carry a valid Vonage signature once the signature secret is set', async () => {
  process.env.VONAGE_SIGNATURE_SECRET = 'sig-secret';
  responders = [WALK_ROW];
  const body = { uuid: 'u1', custom_data: { walk_id: 'w_456' } };
  assert.equal((await call('vonageAnswer', { body })).status, 403);
  const raw = JSON.stringify(body);
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), payload_hash: crypto.createHash('sha256').update(raw).digest('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'sig-secret').update(`${h}.${p}`).digest('base64url');
  assert.equal((await call('vonageAnswer', { body, headers: { authorization: `Bearer ${h}.${p}.${sig}` } })).status, 200);
  const forged = crypto.createHmac('sha256', 'wrong').update(`${h}.${p}`).digest('base64url');
  assert.equal((await call('vonageAnswer', { body, headers: { authorization: `Bearer ${h}.${p}.${forged}` } })).status, 403);
});

test('duress: the automated call goes through Vonage to 312-826-2020 with the report', async () => {
  responders = [WALK_ROW,
    [/UPDATE walks\s+SET status = 'alert'/, () => ({ rows: [{ clip_url: null }], rowCount: 1 })],
    [/UPDATE walks SET last_dispatch_at/, () => ({ rowCount: 1 })]];
  const res = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'duress' } });
  assert.equal(res.jsonBody.dispatch_called, true);
  const placed = fetched.find((f) => f.url === 'https://api.nexmo.com/v1/calls');
  const body = JSON.parse(placed.init.body);
  assert.deepEqual(body.to, [{ type: 'phone', number: '13128262020' }]);
  assert.deepEqual(body.from, { type: 'phone', number: '17077376070' });
  assert.match(body.ncco[0].text, /entered her duress PIN/);
  assert.equal(body.ncco[0].loop, 2);
  assert.match(placed.init.headers.Authorization, /^Bearer ey/);
});

test('demo-mode call (walk only on the phone): carries her name, position and what she said', async () => {
  responders = [[/count\(\*\)::int AS n FROM walk_events/, () => ({ rows: [{ n: 0 }] })]];
  const tok = await call('voiceToken', { body: { walk_id: 'w_local_abc', name: 'Priya' } });
  assert.equal(tok.status, 200);
  assert.equal(decode(tok.jsonBody.token).sub, 'walker_w_demo');

  const res = await call('vonageAnswer', { body: { uuid: 'u1', custom_data: { walk_id: 'w_local_abc', reason: 'distress', said: "I've been stabbed", name: 'Priya', lat: 40.742, lng: -74.1776 } } });
  const whisper = new URL(res.jsonBody[0].endpoint[0].onAnswer.url);
  assert.equal(whisper.searchParams.get('name'), 'Priya');
  assert.equal(whisper.searchParams.get('said'), "I've been stabbed");
  assert.ok(!fetched.some((f) => f.url.endsWith('/sms/json')), 'no tracking link to text for a demo walk');

  const report = await call('vonageWhisper', { method: 'GET', query: Object.fromEntries(whisper.searchParams) });
  assert.match(report.jsonBody[0].text, /Priya may need help: she said she is hurt or in danger\. She said: "I've been stabbed"\. Her last known location is latitude 40\.7420, longitude minus 74\.1776/);
});

test('demo-mode calls are limited: over the limit, the caller hears a message and nobody is dialled', async () => {
  responders = [[/count\(\*\)::int AS n FROM walk_events/, () => ({ rows: [{ n: 6 }] })]];
  const res = await call('vonageAnswer', { body: { uuid: 'u1', custom_data: { walk_id: 'w_demo', reason: 'button' } } });
  assert.equal(res.jsonBody[0].action, 'talk');
  assert.match(res.jsonBody[0].text, /too many demo emergency calls/);
  const auto = await call('dispatch', { params: { walk_id: 'w_demo' }, body: { reason: 'button', name: 'Priya' } });
  assert.deepEqual(auto.jsonBody, { ok: true, called: false, limited: true });
  assert.ok(!fetched.some((f) => f.url.endsWith('/v1/calls')));
});
