// Route math for /location. Pure functions so they can be unit-tested with a hand-made route.
// Points are [lat, lng] arrays.

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Closest point on segment a-b to p. Projects onto a local flat plane centred on p (accurate to
// centimetres at street scale), clamps to the segment, then measures with haversine.
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

// Finds the nearest route segment and returns how far off-route p is and how much route is left.
function locateOnRoute(p, route) {
  if (!route || route.length === 0) throw new Error('empty route');
  if (route.length === 1) {
    const d = haversine(p, route[0]);
    return { offRouteM: d, remainingM: 0, segmentIndex: 0, nearest: route[0] };
  }
  let best = null;
  for (let i = 0; i < route.length - 1; i++) {
    const s = pointToSegment(p, route[i], route[i + 1]);
    if (!best || s.distance < best.distance) best = { ...s, i };
  }
  let remaining = haversine(best.point, route[best.i + 1]);
  for (let j = best.i + 1; j < route.length - 1; j++) remaining += haversine(route[j], route[j + 1]);
  return { offRouteM: best.distance, remainingM: remaining, segmentIndex: best.i, nearest: best.point };
}

const FALLBACK_SPEED = 1.3; // m/s
const MIN_SPEED = 0.3;      // slower than this counts as "stopped": use the fallback
const MAX_SPEED = 3.0;      // faster than a brisk walk is GPS jitter or a vehicle: cap it

// pings: [{ lat, lng, ts }] in time order. Average speed over the window.
function averageSpeed(pings) {
  if (!pings || pings.length < 2) return FALLBACK_SPEED;
  let dist = 0;
  for (let i = 1; i < pings.length; i++) {
    dist += haversine([pings[i - 1].lat, pings[i - 1].lng], [pings[i].lat, pings[i].lng]);
  }
  const secs = (new Date(pings[pings.length - 1].ts) - new Date(pings[0].ts)) / 1000;
  if (!(secs > 0)) return FALLBACK_SPEED;
  const v = dist / secs;
  if (v < MIN_SPEED) return FALLBACK_SPEED;
  return Math.min(v, MAX_SPEED);
}

const ON_ROUTE_M = 50;
const NEAR_DESTINATION_M = 30;

// Everything /location returns, from the walk's route/destination plus recent pings.
// A fuzzy GPS fix (large accuracy_m) widens the on-route tolerance, up to 150 m, so a bad reading
// near tall buildings doesn't flag her as off-route. off_route_m itself is always reported as measured.
function progress({ position, route, destination, recentPings, accuracyM = 0 }) {
  const { offRouteM, remainingM } = locateOnRoute(position, route);
  const toDest = haversine(position, destination);
  const speed = averageSpeed(recentPings);
  const nearDestination = toDest <= NEAR_DESTINATION_M;
  const remaining = nearDestination ? 0 : remainingM;
  const tolerance = Math.max(ON_ROUTE_M, Math.min(accuracyM || 0, 150));
  return {
    remaining_m: Math.round(remaining),
    eta_s: Math.round(remaining / speed),
    on_route: offRouteM <= tolerance,
    off_route_m: Math.round(offRouteM),
    near_destination: nearDestination,
  };
}

module.exports = {
  haversine, pointToSegment, locateOnRoute, averageSpeed, progress,
  FALLBACK_SPEED, ON_ROUTE_M, NEAR_DESTINATION_M,
};
