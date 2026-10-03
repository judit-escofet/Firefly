// Run: npm test   (node's built-in test runner, no extra packages)
const test = require('node:test');
const assert = require('node:assert/strict');
const { haversine, pointToSegment, locateOnRoute, averageSpeed, progress, FALLBACK_SPEED } = require('../lib/geo');

// Hand-made L-shaped route near the venue: east along one street, then south to "home".
const A = [40.7425, -74.1781];
const B = [40.7425, -74.1740]; // corner
const C = [40.7390, -74.1740]; // home
const route = [A, [40.7425, -74.1760], B, [40.7408, -74.1740], C];
const legAB = haversine(A, B);
const legBC = haversine(B, C);

test('haversine: 0.001° of latitude is about 111 m', () => {
  const d = haversine([40.7, -74.1], [40.701, -74.1]);
  assert.ok(Math.abs(d - 111.2) < 0.5, `got ${d}`);
});

test('pointToSegment: projects onto the middle and clamps at the ends', () => {
  const mid = pointToSegment([40.7435, -74.1760], A, B); // ~111 m north of the street
  assert.ok(Math.abs(mid.distance - 111.2) < 1, `got ${mid.distance}`);
  assert.ok(mid.t > 0 && mid.t < 1);
  const beyond = pointToSegment([40.7425, -74.1800], A, B); // west of A, along the line
  assert.equal(beyond.t, 0);
  assert.ok(Math.abs(beyond.distance - haversine([40.7425, -74.1800], A)) < 0.01);
});

test('W4: on the route, off_route_m is under 25 m', () => {
  for (const p of [[40.7425, -74.1770], [40.74255, -74.1750], [40.7400, -74.17405]]) {
    const { offRouteM } = locateOnRoute(p, route);
    assert.ok(offRouteM < 25, `${p} -> ${offRouteM}`);
  }
});

test('W4: a block away, off_route_m is over 75 m', () => {
  const p = [40.7435, -74.1765]; // one block north of the first street
  const r = progress({ position: p, route, destination: C, recentPings: [] });
  assert.ok(r.off_route_m > 75, `got ${r.off_route_m}`);
  assert.equal(r.on_route, false);
});

test('W4: remaining distance and ETA go down as she walks', () => {
  const walk = [A, [40.7425, -74.1770], [40.7425, -74.1750], B, [40.7410, -74.1740], [40.7398, -74.1740]];
  let prev = { remaining_m: Infinity, eta_s: Infinity };
  for (const p of walk) {
    const r = progress({ position: p, route, destination: C, recentPings: [] });
    assert.ok(r.remaining_m < prev.remaining_m, `${p}: ${r.remaining_m} !< ${prev.remaining_m}`);
    assert.ok(r.eta_s <= prev.eta_s);
    prev = r;
  }
});

test('remaining distance at the start equals the whole route', () => {
  const { remainingM } = locateOnRoute(A, route);
  assert.ok(Math.abs(remainingM - (legAB + legBC)) < 1);
});

test('W5: near_destination is true within 30 m of home and false at 60 m', () => {
  const at20 = [C[0] + 20 / 111_195, C[1]];
  const at60 = [C[0] + 60 / 111_195, C[1]];
  assert.equal(progress({ position: at20, route, destination: C, recentPings: [] }).near_destination, true);
  assert.equal(progress({ position: at60, route, destination: C, recentPings: [] }).near_destination, false);
});

test('ETA uses recent average speed, falling back to 1.3 m/s', () => {
  assert.equal(averageSpeed([]), FALLBACK_SPEED);
  const t0 = new Date('2026-10-03T23:40:00Z');
  const pings = [0, 10, 20].map((s, i) => ({
    lat: A[0], lng: A[1] + (i * 20) / (111_195 * Math.cos((A[0] * Math.PI) / 180)), // 20 m per 10 s
    ts: new Date(t0.getTime() + s * 1000).toISOString(),
  }));
  assert.ok(Math.abs(averageSpeed(pings) - 2.0) < 0.05);
  // standing still -> fallback, not an infinite ETA
  const still = pings.map((p) => ({ ...p, lng: A[1] }));
  assert.equal(averageSpeed(still), FALLBACK_SPEED);
  const r = progress({ position: A, route, destination: C, recentPings: pings });
  assert.ok(Math.abs(r.eta_s - r.remaining_m / averageSpeed(pings)) <= 1);
});

test('poor GPS accuracy widens the on-route tolerance', () => {
  const p = [40.74315, -74.1765]; // ~72 m off
  assert.equal(progress({ position: p, route, destination: C, recentPings: [] }).on_route, false);
  assert.equal(progress({ position: p, route, destination: C, recentPings: [], accuracyM: 90 }).on_route, true);
});
