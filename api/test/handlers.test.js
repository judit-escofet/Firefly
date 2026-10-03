// Handler tests with a fake database: input validation (W1), texts and the 60 s alert guard (W6).
// No AWS, Twilio or Tiger Data needed; SMS, maps and live updates run in their logging mock mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const k of Object.keys(process.env)) if (/^(TWILIO|WS|CLIPS|AWS)_/.test(k)) delete process.env[k];
process.env.PUBLIC_BASE_URL = 'https://firefly.test';
process.env.MOCK_MAPS = '1';

// ---- fake db: route SQL to handlers by a regex ----
const calls = [];
let responders = [];
const fakeDb = {
  query: async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of responders) if (re.test(sql)) return fn(params);
    return { rows: [], rowCount: 0 };
  },
};
require.cache[path.resolve(__dirname, '../db/index.js')] = {
  id: 'db', filename: 'db', loaded: true, exports: fakeDb,
};

// ---- load every endpoint; the router keeps each handler by name ----
const { byName: handlers, Request, dispatch } = require('../lib/router');
for (const f of require('fs').readdirSync(path.join(__dirname, '../src/functions'))) require(`../src/functions/${f}`);

const quiet = { log() {}, warn() {}, error() {}, info() {} };
const texts = [];
const origWarn = console.warn;

async function call(name, { method = 'POST', body, params = {}, query = {}, headers = {} } = {}) {
  const url = new URL('https://firefly.test/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new Request({
    method, url: url.toString(), params,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ctx = { ...quiet, warn: (m) => texts.push(m) };
  return handlers[name](req, ctx);
}

test.beforeEach(() => { calls.length = 0; texts.length = 0; responders = []; console.warn = (m) => texts.push(m); });
test.after(() => { console.warn = origWarn; });

const goodProfile = {
  name: 'Priya',
  contacts: [{ name: 'Mom', phone: '+15551230001' }, { name: 'Sam', phone: '+15551230002' }],
  code_phrase: 'the blue umbrella',
  pin_hash: 'h1', duress_pin_hash: 'h2',
};

test('profile: valid profile returns a user_id', async () => {
  const res = await call('profile', { body: goodProfile });
  assert.equal(res.status, 200);
  assert.match(res.jsonBody.user_id, /^u_/);
});

test('profile: bad input returns 400 with a clear message', async () => {
  const cases = [
    [{ ...goodProfile, contacts: [] }, /1 to 3/],
    [{ ...goodProfile, contacts: [1, 2, 3, 4].map((i) => ({ phone: `+1555123000${i}` })) }, /1 to 3/],
    [{ ...goodProfile, contacts: [{ phone: '555-1234' }] }, /\+15551234567/],
    [{ ...goodProfile, code_phrase: 'two words' }, /3 words/],
    [{ ...goodProfile, duress_pin_hash: 'h1' }, /different/],
    [{ ...goodProfile, pin_hash: undefined }, /pin_hash/],
  ];
  for (const [body, msg] of cases) {
    const res = await call('profile', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.jsonBody.error, msg);
  }
  assert.equal((await call('profile', { body: '{not json' })).status, 400);
});

test('walks: bad coordinates return 400; good request returns Walk JSON and texts contacts', async () => {
  let res = await call('walks', { body: { user_id: 'u_test', start: { lat: 'x', lng: 0 }, destination: { lat: 0, lng: 0 } } });
  assert.equal(res.status, 400);
  assert.match(res.jsonBody.error, /start.lat/);

  responders = [
    [/FROM users/, () => ({ rows: [{ name: 'Priya', contacts: goodProfile.contacts }] })],
    [/INSERT INTO walks/, (p) => ({ rows: [{
      walk_id: p[0], user_id: p[1], start_lat: p[2], start_lng: p[3], dest_lat: p[4], dest_lng: p[5],
      dest_label: p[6], route: JSON.parse(p[7]), distance_m: p[8], eta_s: p[9], share_token: p[10],
      status: 'walking', started_at: new Date(), ended_at: null,
    }] })],
  ];
  res = await call('walks', { body: {
    user_id: 'u_test', start: { lat: 40.7425, lng: -74.1781 }, destination: { lat: 40.739, lng: -74.172, label: 'Home' },
  } });
  assert.equal(res.status, 201);
  const w = res.jsonBody;
  assert.match(w.walk_id, /^w_/);
  assert.ok(w.share_token.length >= 16);
  assert.equal(w.share_url, `https://firefly.test/track/${w.share_token}`);
  assert.ok(w.route.points.length > 1 && w.route.distance_m > 0 && w.route.eta_s > 0);
  assert.ok(texts.some((t) => t.includes('Priya started walking home with Firefly. Follow along: https://firefly.test/track/')));
});

test('location: validates input and returns the contract fields', async () => {
  assert.equal((await call('location', { params: { walk_id: 'w_456' }, body: { lat: 200, lng: 0 } })).status, 400);
  assert.equal((await call('location', { params: { walk_id: 'w_456' }, body: { lat: 40, lng: -74, accuracy_m: -1 } })).status, 400);
  assert.equal((await call('location', { params: { walk_id: 'bad id' }, body: { lat: 40, lng: -74 } })).status, 400);

  responders = [[/FROM walks/, () => ({ rows: [{
    route: [[40.7425, -74.1781], [40.739, -74.172]], dest_lat: 40.739, dest_lng: -74.172, ended_at: null,
  }] })]];
  const res = await call('location', { params: { walk_id: 'w_456' }, body: { lat: 40.742, lng: -74.1776, accuracy_m: 8, ts: new Date().toISOString() } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.jsonBody).sort(), ['eta_s', 'near_destination', 'off_route_m', 'on_route', 'remaining_m']);
  assert.ok(calls.some((c) => /INSERT INTO locations/.test(c.sql)));
  assert.ok(texts.some((t) => t.includes('"type":"position"')));
});

test('W6: alert texts the exact message once; a second alert within 60 s does not text', async () => {
  let alertAllowed = true;
  responders = [
    [/FROM walks w JOIN users/, () => ({ rows: [{
      walk_id: 'w_456', share_token: 'Xk3v9QpL2mN7rT8wZ1yB4cDe', name: 'Priya', contacts: goodProfile.contacts,
    }] })],
    [/UPDATE walks\s+SET status = 'alert'/, () => {
      const ok = alertAllowed; alertAllowed = false;
      return ok ? { rows: [{ clip_url: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }],
  ];
  const first = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'alert_sent', source: 'scream', confidence: 0.91, clip_url: null, ts: '2026-10-03T23:41:15Z' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.jsonBody.texted, ['+15551230001', '+15551230002']);
  const expected = 'Firefly alert: Priya may need help. Live location: https://firefly.test/track/Xk3v9QpL2mN7rT8wZ1yB4cDe\n'
    + "She's been asked to stay on the line. If you think she's in danger, call 911.";
  assert.ok(texts.some((t) => t.endsWith(expected)), texts.join('\n'));

  texts.length = 0;
  const second = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'duress' } });
  assert.equal(second.jsonBody.duplicate, true);
  assert.deepEqual(second.jsonBody.texted, []);
  assert.ok(!texts.some((t) => t.includes('[sms mock]')));
  assert.equal(calls.filter((c) => /INSERT INTO walk_events/.test(c.sql)).length, 2, 'both events are still logged');
});

test('events: bad input returns 400', async () => {
  for (const body of [{}, { type: 'Alert Sent' }, { type: 'check_in', confidence: 3 }, { type: 'check_in', ts: 'yesterday' }]) {
    assert.equal((await call('events', { params: { walk_id: 'w_456' }, body })).status, 400, JSON.stringify(body));
  }
});

test('alerts are never rejected over bad optional fields; the bad values are kept aside', async () => {
  responders = [
    [/FROM walks w JOIN users/, () => ({ rows: [{ walk_id: 'w_456', share_token: 'Xk3v9QpL2mN7rT8wZ1yB4cDe', name: 'Priya', contacts: goodProfile.contacts }] })],
    [/UPDATE walks\s+SET status = 'alert'/, () => ({ rows: [{ clip_url: null }], rowCount: 1 })],
  ];
  const res = await call('events', { params: { walk_id: 'w_456' }, body: { type: 'alert_sent', confidence: 3, clip_url: 'not a url', ts: 'yesterday' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody.texted, ['+15551230001', '+15551230002']);
  const insert = calls.find((c) => /INSERT INTO walk_events/.test(c.sql));
  assert.deepEqual(insert.params[7].invalid, { confidence: 3, clip_url: 'not a url', ts: 'yesterday' });
});

test('scores: inserts in one statement and caps at 200', async () => {
  responders = [[/INSERT INTO detector_scores/, (p) => ({ rowCount: p[0].length })]];
  const scores = Array.from({ length: 3 }, (_, i) => ({ ts: `2026-10-03T23:40:0${i}Z`, score: 0.1 * i }));
  const res = await call('scores', { params: { walk_id: 'w_456' }, body: { scores } });
  assert.deepEqual(res.jsonBody, { saved: 3 });
  assert.equal(calls.length, 1);
  const tooMany = Array.from({ length: 201 }, () => scores[0]);
  assert.equal((await call('scores', { params: { walk_id: 'w_456' }, body: { scores: tooMany } })).status, 400);
});

test('clip and end: bad input returns 400', async () => {
  const clip = await call('clip', { params: { walk_id: 'w_456' }, body: 'hello', headers: { 'content-type': 'text/plain' } });
  assert.equal(clip.status, 400);
  const badWav = await call('clip', { params: { walk_id: 'w_456' }, body: 'RIFFnope', headers: { 'content-type': 'audio/wav' } });
  assert.equal(badWav.status, 400);
  const end = await call('end', { params: { walk_id: 'w_456' }, body: { reason: 'tired' } });
  assert.equal(end.status, 400);
});

test('W10: unknown token and walks ended over 2 hours ago return "link expired"', async () => {
  let res = await call('track', { method: 'GET', params: { share_token: 'guessedguessedguessed' } });
  assert.equal(res.status, 410);
  assert.equal(res.jsonBody.error, 'link expired');

  responders = [[/share_token = \$1/, () => ({ rows: [{ walk_id: 'w_456', ended_at: new Date(Date.now() - 3 * 3600e3) }] })]];
  res = await call('negotiate', { method: 'GET', query: { token: 'Xk3v9QpL2mN7rT8wZ1yB4cDe' } });
  assert.equal(res.status, 410);
});

test('router: matches routes, extracts params, 404s and 405s', async () => {
  responders = [[/INSERT INTO detector_scores/, (p) => ({ rowCount: p[0].length })]];
  const ok = await dispatch({
    method: 'POST', url: 'https://firefly.test/api/walks/w_456/scores',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ scores: [{ ts: '2026-10-03T23:40:00Z', score: 0.5 }] })),
  });
  assert.deepEqual(ok.jsonBody, { saved: 1 });
  assert.equal(calls[0].params[1], 'w_456');
  assert.equal(await dispatch({ method: 'GET', url: 'https://firefly.test/api/nope' }), null);
  assert.equal((await dispatch({ method: 'DELETE', url: 'https://firefly.test/api/profile' })).status, 405);
});

test('W10: clip links reject bad file names and need no AWS for that check', async () => {
  const res = await call('clipGet', { method: 'GET', params: { walk_id: 'w_456', file: '../../etc' } });
  assert.equal(res.status, 404);
});
