// Azure Maps walking route. Without AZURE_MAPS_KEY (or with MOCK_MAPS=1) it returns a straight-line
// mock route, which doubles as the demo's fallback mode.
const { haversine, FALLBACK_SPEED } = require('./geo');

async function walkingRoute(start, dest) {
  if (!process.env.AZURE_MAPS_KEY || process.env.MOCK_MAPS === '1') return mockRoute(start, dest);

  const url = new URL('https://atlas.microsoft.com/route/directions/json');
  url.searchParams.set('api-version', '1.0');
  url.searchParams.set('query', `${start[0]},${start[1]}:${dest[0]},${dest[1]}`);
  url.searchParams.set('travelMode', 'pedestrian');
  url.searchParams.set('subscription-key', process.env.AZURE_MAPS_KEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Azure Maps returned ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) throw new Error('Azure Maps found no walking route');
  const points = route.legs.flatMap((leg) => leg.points.map((p) => [p.latitude, p.longitude]));
  return {
    points,
    distance_m: route.summary.lengthInMeters,
    eta_s: route.summary.travelTimeInSeconds,
  };
}

function mockRoute(start, dest, steps = 20) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([start[0] + t * (dest[0] - start[0]), start[1] + t * (dest[1] - start[1])]);
  }
  const distance = haversine(start, dest);
  return { points, distance_m: Math.round(distance), eta_s: Math.round(distance / FALLBACK_SPEED), mock: true };
}

module.exports = { walkingRoute, mockRoute };
