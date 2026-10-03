// Route math for the browser: an ESM port of P3's api/lib/geo.js, used when /location can't be
// reached (mock mode, Wi-Fi off) so position.updated still carries the same fields the server
// would compute. Points are [lat, lng] arrays. Keep in sync with api/lib/geo.js.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function pointToSegment(p, a, b) {
  const kx = Math.cos(toRad(p[0]));
  const ax = (a[1] - p[1]) * kx, ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * kx, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { point, t, distance: haversine(p, point) };
}

export function locateOnRoute(p, route) {
  if (route.length === 1) return { offRouteM: haversine(p, route[0]), remainingM: 0 };
  let best = null;
  for (let i = 0; i < route.length - 1; i++) {
    const s = pointToSegment(p, route[i], route[i + 1]);
    if (!best || s.distance < best.distance) best = { ...s, i };
  }
  let remaining = haversine(best.point, route[best.i + 1]);
  for (let j = best.i + 1; j < route.length - 1; j++) remaining += haversine(route[j], route[j + 1]);
  return { offRouteM: best.distance, remainingM: remaining };
}

export const FALLBACK_SPEED = 1.3;
export const NEAR_DESTINATION_M = 30;
const ON_ROUTE_M = 50;

// Same fields as POST /api/walks/{id}/location returns.
export function progress({ position, route, destination, speed = FALLBACK_SPEED, accuracyM = 0 }) {
  const { offRouteM, remainingM } = locateOnRoute(position, route);
  const nearDestination = haversine(position, destination) <= NEAR_DESTINATION_M;
  const remaining = nearDestination ? 0 : remainingM;
  return {
    remaining_m: Math.round(remaining),
    eta_s: Math.round(remaining / speed),
    on_route: offRouteM <= Math.max(ON_ROUTE_M, Math.min(accuracyM || 0, 150)),
    off_route_m: Math.round(offRouteM),
    near_destination: nearDestination,
  };
}

export function routeLength(route) {
  let d = 0;
  for (let i = 1; i < route.length; i++) d += haversine(route[i - 1], route[i]);
  return d;
}

// The point `d` metres along the route (clamped to its ends).
export function pointAlong(route, d) {
  let rem = Math.max(0, d);
  for (let i = 1; i < route.length; i++) {
    const leg = haversine(route[i - 1], route[i]);
    if (rem <= leg) {
      const f = leg === 0 ? 0 : rem / leg;
      return [route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f];
    }
    rem -= leg;
  }
  return route[route.length - 1];
}

// The point `d` metres along the route, moved `metres` sideways (perpendicular to the route's
// direction there). Used by the simulated walker's "wander off".
export function offsetFromRoute(route, d, metres) {
  const a = pointAlong(route, Math.max(0, d - 3));
  const b = pointAlong(route, d + 3);
  const p = pointAlong(route, d);
  const kx = Math.cos(toRad(p[0]));
  let dx = (b[1] - a[1]) * kx, dy = b[0] - a[0];
  const n = Math.hypot(dx, dy) || 1;
  [dx, dy] = [dx / n, dy / n];
  const mPerDeg = 111195;
  // perpendicular (rotate 90°): (−dy, dx)
  return [p[0] + (dx * metres) / mPerDeg, p[1] + (-dy * metres) / (mPerDeg * kx)];
}

// A straight-line route (what P3 also returns when Azure Maps isn't configured).
export function straightRoute(start, dest, steps = 20) {
  return Array.from({ length: steps + 1 }, (_, i) => [start[0] + ((dest[0] - start[0]) * i) / steps, start[1] + ((dest[1] - start[1]) * i) / steps]);
}

// Accepts [lat, lng] or {lat, lng} points.
export const toPair = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.lat, p.lng]);
