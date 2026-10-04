// Place search for "Where are you walking to?" (OpenStreetMap Nominatim), with a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { byName, Request } = require('../lib/router');
require('../src/functions/geocode.js');

const call = (q) => byName.geocode(new Request({ method: 'GET', url: `https://x/api/geocode?${new URLSearchParams(q)}` }), console);
const realFetch = global.fetch;
test.after(() => { global.fetch = realFetch; });

test('returns up to 5 places, one per name, biased toward her position, with an app User-Agent', async () => {
  let seenUrl, seenHeaders;
  const station = (lat, road) => ({ name: 'Newark Penn Station', lat: String(lat), lon: '-74.164', display_name: `Newark Penn Station, ${road}, Newark`, address: { city: 'Newark' } });
  global.fetch = async (url, init) => {
    seenUrl = new URL(url); seenHeaders = init.headers;
    return { ok: true, json: async () => [station(40.7345, 'Penn Station Buses'), station(40.7342, 'Market Street'),
      { name: 'Penn Plaza', lat: '40.735', lon: '-74.163', display_name: 'Penn Plaza, Newark', address: { suburb: 'Ironbound' } }] };
  };
  const res = await call({ q: 'penn station', lat: 40.7425, lng: -74.1781 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody.results.map((r) => r.label), ['Newark Penn Station, Newark', 'Penn Plaza, Ironbound']);
  assert.equal(seenUrl.hostname, 'nominatim.openstreetmap.org');
  assert.ok(seenUrl.searchParams.get('viewbox'), 'biased to her area');
  assert.equal(seenUrl.searchParams.get('bounded'), '0', 'farther places still allowed');
  assert.match(seenHeaders['User-Agent'], /Firefly/);
});

test('short or failed searches give clear errors', async () => {
  assert.equal((await call({ q: 'ab' })).status, 400);
  global.fetch = async () => { throw new Error('offline'); };
  const res = await call({ q: 'somewhere new' });
  assert.equal(res.status, 502);
  assert.match(res.jsonBody.error, /Place search is unavailable/);
});
