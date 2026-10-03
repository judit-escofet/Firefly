// Walking route from Amazon Location Service (Routes API v2), using the Lambda's IAM role: no key.
// With MOCK_MAPS=1, or locally without AWS credentials, it returns a straight-line mock route,
// which doubles as the demo's fallback mode.
const { haversine, FALLBACK_SPEED } = require('./geo');

let client;

function useMock() {
  if (process.env.MOCK_MAPS === '1') return true;
  const inLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  return !inLambda && !hasCreds;
}

async function walkingRoute(start, dest) {
  if (useMock()) return mockRoute(start, dest);

  const { GeoRoutesClient, CalculateRoutesCommand } = require('@aws-sdk/client-geo-routes');
  if (!client) client = new GeoRoutesClient({});
  const res = await client.send(new CalculateRoutesCommand({
    Origin: [start[1], start[0]],            // Amazon Location uses [lng, lat]
    Destination: [dest[1], dest[0]],
    TravelMode: 'Pedestrian',
    LegGeometryFormat: 'Simple',
    LegAdditionalFeatures: ['Summary'],
  }), { abortSignal: AbortSignal.timeout(8000) });

  const route = res.Routes && res.Routes[0];
  if (!route) throw new Error('Amazon Location found no walking route');
  const points = route.Legs.flatMap((leg) =>
    ((leg.Geometry && leg.Geometry.LineString) || []).map(([lng, lat]) => [lat, lng]));
  if (points.length < 2) throw new Error('Amazon Location returned a route without geometry');

  let distance = route.Summary && route.Summary.Distance;
  let duration = route.Summary && route.Summary.Duration;
  if (distance == null) {
    distance = 0;
    for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
  }
  if (duration == null) duration = distance / FALLBACK_SPEED;
  return { points, distance_m: distance, eta_s: duration };
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
