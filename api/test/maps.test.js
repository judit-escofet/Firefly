// Route planner fallback order, with a fake fetch: OpenStreetMap walking route, else straight line.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MOCK_MAPS = '1'; // Amazon Location off (as in the workshop account)
delete process.env.OSM_ROUTES;
const { walkingRoute } = require('../lib/maps');

const realFetch = global.fetch;
test.after(() => { global.fetch = realFetch; });
const quiet = { warn() {} };
const START = [40.7425, -74.1781];
const DEST = [40.7345, -74.1639];

test('uses the OpenStreetMap walking route: follows the streets, starts and ends at her points', async () => {
  let asked;
  global.fetch = async (url) => {
    asked = String(url);
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [
      [-74.1780, 40.7424], [-74.1700, 40.7400], [-74.1650, 40.7350], [-74.1640, 40.7346]] } }] }) };
  };
  const r = await walkingRoute(START, DEST, quiet);
  assert.equal(r.source, 'osm');
  assert.match(asked, /routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\/-74\.1781,40\.7425;-74\.1639,40\.7345/);
  assert.deepEqual(r.points[0], START);
  assert.deepEqual(r.points.at(-1), DEST);
  assert.equal(r.points.length, 6, 'street points plus her exact start and end');
  assert.ok(r.distance_m > 1500 && Math.abs(r.eta_s - r.distance_m / 1.3) < 1);
});

test('falls back to a straight line when OpenStreetMap is unreachable', async () => {
  global.fetch = async () => { throw new Error('offline'); };
  const r = await walkingRoute(START, DEST, quiet);
  assert.equal(r.source, 'straight');
  assert.equal(r.mock, true);
});

test('OSM_ROUTES=0 skips OpenStreetMap entirely', async () => {
  process.env.OSM_ROUTES = '0';
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not be called'); };
  const r = await walkingRoute(START, DEST, quiet);
  assert.equal(r.source, 'straight');
  assert.equal(called, false);
  delete process.env.OSM_ROUTES;
});
