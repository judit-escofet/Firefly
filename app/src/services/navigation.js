// Turn-by-turn navigation, Google Maps style.
//
// The route's steps come from the backend ({text, type, modifier, name, location}). On every
// position.updated this works out the next turn and how far away it is:
//   nav.update  {text, type, modifier, distance_m, then, rerouting}  → the banner on the walk screen
//   nav.prompt  {text}                                               → the firefly says it (companion)
// Spoken: "In 200 feet, turn left onto Summit Street" about 60 m before a turn, then "Turn left
// onto Summit Street" at about 15 m. Each only once per turn.
//
// Rerouting: more than 50 m off the route for 15 s → plan again from where she is to the same
// destination (at most every 30 s). Not in demo mode: there the "wander off" control is how the
// off-route safety check-in is shown, and rerouting would cancel it.

import { bus } from '../bus.js';
import { haversine, locateOnRoute, routeLength } from './geo.js';
import { formatDistance } from './units.js';
import { api } from './api.js';
import { isMockModeEnabled } from './mockData.js';

export const PREPARE_M = 60;
export const NOW_M = 15;
export const REROUTE_OFF_M = 50;
export const REROUTE_AFTER_MS = 15000;
export const REROUTE_GAP_MS = 30000;

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// "200 feet", "0.3 miles": how far to say before a turn (rounded like a person would).
export function spokenNavDistance(m) {
  const { value, unit } = formatDistance(m);
  if (unit === 'ft') return `${Math.max(50, Math.round(Number(value) / 50) * 50)} feet`;
  return value === '1.0' ? '1 mile' : `${value.replace(/\.0$/, '')} miles`;
}

function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return cum;
}

// How far along the route each step's turn is (nearest route vertex, searching forward).
export function placeSteps(points, steps = []) {
  const cum = cumulative(points);
  let from = 0;
  return steps.map((s) => {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < points.length; i++) {
      const d = haversine(points[i], s.location);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    from = best;
    return { ...s, along_m: cum[best] };
  });
}

export function prepareRoute(points, steps) {
  return { points, total: routeLength(points), steps: placeSteps(points, steps) };
}

// The next turn from this position: {index, step, distance_m, then, offRouteM}, or {done}.
export function nextTurn(position, nav) {
  const { remainingM, offRouteM } = locateOnRoute(position, nav.points);
  const along = nav.total - remainingM;
  const index = nav.steps.findIndex((s, k) => k > 0 && s.along_m > along + 3);
  if (index < 0) return { done: true, offRouteM };
  const step = nav.steps[index];
  return { index, step, distance_m: Math.max(0, step.along_m - along), then: nav.steps[index + 1] ?? null, offRouteM };
}

// What to say for this turn at this distance, given what was already said (0, 1 = heads-up, 2 = now).
export function promptFor(turn, alreadySaid) {
  const { step, distance_m: d } = turn;
  if (step.type === 'arrive') {
    return d <= 80 && alreadySaid < 1 ? { level: 1, text: `Your destination is ${spokenNavDistance(d)} ahead.` } : null;
  }
  if (d <= NOW_M && alreadySaid < 2) return { level: 2, text: `${step.text}.` };
  if (d <= PREPARE_M && alreadySaid < 1) return { level: 1, text: `In ${spokenNavDistance(d)}, ${lowerFirst(step.text)}.` };
  return null;
}

// ---- controller ----
let nav = null;
let walkRef = null;
let onRouteChange = null;
let said = new Map();
let offSince = null;
let lastRerouteAt = 0;
let rerouting = false;
let offs = [];

function setRoute(points, steps) {
  nav = steps && steps.length ? prepareRoute(points, steps) : null;
  said = new Map();
}

function publish(turn) {
  if (!turn || turn.done) return bus.emit('nav.update', { done: true, rerouting });
  const then = turn.then ? (turn.then.type === 'arrive' ? 'Then you arrive' : `Then ${lowerFirst(turn.then.text)}`) : null;
  bus.emit('nav.update', {
    text: turn.step.text, type: turn.step.type, modifier: turn.step.modifier,
    distance_m: Math.round(turn.distance_m), then, rerouting,
  });
}

async function maybeReroute(e, pos) {
  if (isMockModeEnabled() || rerouting || !walkRef) return;
  if (!((e.off_route_m ?? 0) > REROUTE_OFF_M)) {
    offSince = null;
    return;
  }
  const now = Date.now();
  offSince ??= now;
  if (now - offSince < REROUTE_AFTER_MS || now - lastRerouteAt < REROUTE_GAP_MS) return;
  rerouting = true;
  bus.emit('nav.update', { rerouting: true, text: 'Rerouting…' });
  try {
    const r = await api.reroute(walkRef, { lat: pos[0], lng: pos[1] });
    if (!walkRef) return;
    walkRef = { ...walkRef, route: { ...walkRef.route, ...r.route }, steps: r.steps };
    setRoute(r.route.points, r.steps);
    onRouteChange?.(walkRef);
    const turn = nav && nextTurn(pos, nav);
    if (turn && !turn.done) bus.emit('nav.prompt', { text: `Rerouting. ${turn.step.text} in ${spokenNavDistance(turn.distance_m)}.` });
  } catch (err) {
    console.warn('[nav] reroute failed', err);
  } finally {
    rerouting = false;
    lastRerouteAt = Date.now();
    offSince = null;
  }
}

function onPosition(e) {
  if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) return;
  const pos = [e.lat, e.lng];
  maybeReroute(e, pos);
  if (!nav) return;
  const turn = nextTurn(pos, nav);
  publish(turn);
  if (turn.done) return;
  const p = promptFor(turn, said.get(turn.index) ?? 0);
  if (p) {
    said.set(turn.index, p.level);
    bus.emit('nav.prompt', { text: p.text });
  }
}

export const navigation = {
  // walk: {route: {points}, steps}. onChange(walk) after a reroute.
  start(walk, { onRouteChange: cb } = {}) {
    this.stop();
    walkRef = walk;
    onRouteChange = cb ?? null;
    setRoute(walk.route.points, walk.steps);
    offs = [bus.on('position.updated', onPosition)];
    if (nav) {
      const first = nav.steps[0];
      if (first && first.type === 'depart') bus.emit('nav.prompt', { text: `${first.text}.` });
      publish(nextTurn(walk.route.points[0], nav));
    }
  },
  stop() {
    offs.forEach((off) => off());
    offs = [];
    nav = null;
    walkRef = null;
    offSince = null;
    rerouting = false;
  },
};
