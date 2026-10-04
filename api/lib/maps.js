// Walking routes, best first:
//   1. Amazon Location Service (Routes API v2, the Lambda's IAM role, no key), unless MOCK_MAPS=1
//      or there are no AWS credentials (blocked in the workshop account).
//   2. OpenStreetMap walking routes (routing.openstreetmap.de, the service openstreetmap.org uses for
//      walking directions; free, no key). Follows real streets and paths. Off with OSM_ROUTES=0.
//   3. A straight line, only when both are unavailable (offline demo fallback).
const { haversine, FALLBACK_SPEED } = require('./geo');

const OSM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const USER_AGENT = 'Firefly-hackathon-app/1.0 (walk-home safety demo; github.com/judit-escofet/Firefly)';
let client;

function amazonAvailable() {
  if (process.env.MOCK_MAPS === '1') return false;
  const inLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  return inLambda || hasCreds;
}

async function amazonRoute(start, dest) {
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
  if (distance == null) distance = pathLength(points);
  if (duration == null) duration = distance / FALLBACK_SPEED;
  return { points, distance_m: distance, eta_s: duration, source: 'amazon', steps: [] };
}

// ---- Turn-by-turn steps ("Turn left onto Market Street"), Google Maps style ----
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (bearing) => COMPASS[Math.round(((Number(bearing) || 0) % 360) / 45) % 8];
const onto = (name) => (name ? ` onto ${name}` : '');

function stepText({ type, modifier, name, exit, bearing }) {
  const mod = modifier || 'straight';
  if (type === 'depart') return `Head ${compass(bearing)}${name ? ` on ${name}` : ''}`;
  if (type === 'arrive') return 'You have arrived';
  if (type === 'roundabout' || type === 'rotary') return `At the roundabout, take exit ${exit || 1}${onto(name)}`;
  if (mod === 'uturn') return 'Make a U-turn';
  if (mod === 'straight') return name ? `Continue onto ${name}` : 'Continue straight';
  const side = mod.replace('slight ', '').replace('sharp ', '');
  if (mod.startsWith('slight')) return `Keep ${side}${onto(name)}`;
  if (mod.startsWith('sharp')) return `Turn sharp ${side}${onto(name)}`;
  return `Turn ${side}${onto(name)}`;
}

// OSRM steps → [{text, type, modifier, name, location: [lat, lng]}]. Very short legs (< 12 m)
// are folded into one instruction ("Turn left, then turn right") so the voice doesn't chatter.
function buildSteps(osrmSteps = []) {
  const raw = osrmSteps.map((st) => ({
    type: st.maneuver.type,
    modifier: st.maneuver.modifier || null,
    name: st.name || '',
    location: [st.maneuver.location[1], st.maneuver.location[0]],
    after_m: st.distance,
    text: stepText({ type: st.maneuver.type, modifier: st.maneuver.modifier, name: st.name, exit: st.maneuver.exit, bearing: st.maneuver.bearing_after }),
  }));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const st = { ...raw[i] };
    // "New name" while going straight is just a street name change: fold it into the previous step.
    if (st.type === 'new name' && (st.modifier || 'straight') === 'straight' && out.length) continue;
    while (st.type !== 'arrive' && st.after_m < 12 && raw[i + 1] && raw[i + 1].type !== 'arrive') {
      const next = raw[++i];
      st.text = `${st.text}, then ${next.text[0].toLowerCase()}${next.text.slice(1)}`;
      st.after_m = next.after_m;
    }
    delete st.after_m;
    out.push(st);
  }
  return out;
}

async function osmFootRoute(start, dest) {
  const url = `${OSM_FOOT}/${start[1]},${start[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OpenStreetMap routing returned ${res.status}`);
  const data = await res.json();
  const route = data.code === 'Ok' && data.routes && data.routes[0];
  if (!route) throw new Error(`OpenStreetMap found no walking route (${data.code || 'no routes'})`);
  const points = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  if (points.length < 2) throw new Error('OpenStreetMap returned a route without geometry');
  // The route starts and ends on the nearest path; add her exact start and destination so the
  // line on the map and the distance math reach both points.
  if (haversine(start, points[0]) > 1) points.unshift(start);
  if (haversine(dest, points[points.length - 1]) > 1) points.push(dest);
  const distance = pathLength(points);
  const steps = buildSteps(route.legs && route.legs[0] && route.legs[0].steps);
  return { points, distance_m: distance, eta_s: distance / FALLBACK_SPEED, source: 'osm', steps };
}

function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

async function walkingRoute(start, dest, log = console) {
  if (amazonAvailable()) {
    try {
      return await amazonRoute(start, dest);
    } catch (err) {
      log.warn(`Amazon Location route failed (${err.message}); trying OpenStreetMap`);
    }
  }
  if (process.env.OSM_ROUTES !== '0') {
    try {
      return await osmFootRoute(start, dest);
    } catch (err) {
      log.warn(`OpenStreetMap route failed (${err.message}); using a straight line`);
    }
  }
  return mockRoute(start, dest);
}

function mockRoute(start, dest, steps = 20) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([start[0] + t * (dest[0] - start[0]), start[1] + t * (dest[1] - start[1])]);
  }
  const distance = haversine(start, dest);
  return {
    points, distance_m: Math.round(distance), eta_s: Math.round(distance / FALLBACK_SPEED), mock: true, source: 'straight',
    steps: [{ text: 'Head toward your destination', type: 'depart', modifier: null, name: '', location: start },
      { text: 'You have arrived', type: 'arrive', modifier: null, name: '', location: dest }],
  };
}

module.exports = { walkingRoute, mockRoute, osmFootRoute, buildSteps, stepText };
