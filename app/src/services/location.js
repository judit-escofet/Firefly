// Location for the walk screen (P4 spec 4): GPS → P3's /location every 5 s → position.updated
// on the bus with the contract fields {lat, lng, remaining_m, eta_s, on_route, off_route_m}
// (+ accuracy_m, near_destination, trail). Arrival (near_destination, < 30 m) ends the walk.
//
// Mock mode: a simulated walker moves along the route at walking speed (update every 2 s).
// Presenter controls: jumpAhead() (key J), jumpToHome(), togglePause() ("stop here" → the
// Guardian's long-stop check-in after 90 s), toggleWander() (~90 m off route → off-route check-in).

import { emit } from '../bus.js';
import { api } from './api.js';
import { isMockModeEnabled } from './mockData.js';
import { pointAlong, routeLength, offsetFromRoute } from './geo.js';

const REAL_EVERY_MS = 5000;
const MOCK_EVERY_MS = 2000;
const WALK_SPEED = 1.4;

let walk = null;
let onArrived = null;
let trail = [];
let latest = null; // {lat, lng, accuracy_m}
let timers = [];
let watchId = null;
let sim = null; // {walked, total, paused, wander}
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn(state()));
const state = () => ({ mock: Boolean(sim), paused: sim?.paused ?? false, wander: sim?.wander ?? false, gps: latest ? 'fix' : 'waiting' });

async function sync() {
  if (!walk || !latest) return;
  const pos = latest;
  trail.push({ lat: pos.lat, lng: pos.lng, ts: Date.now() });
  if (trail.length > 400) trail.shift();
  const r = await api.postLocation(walk, { ...pos, speed: sim ? WALK_SPEED : undefined });
  if (!walk) return; // ended while waiting
  emit('position.updated', {
    lat: pos.lat,
    lng: pos.lng,
    remaining_m: r.remaining_m,
    eta_s: r.eta_s,
    on_route: r.on_route,
    off_route_m: r.off_route_m,
    accuracy_m: pos.accuracy_m ?? null,
    near_destination: Boolean(r.near_destination),
    trail: trail.slice(-60),
  });
  if (r.near_destination && onArrived) {
    const cb = onArrived;
    onArrived = null;
    cb();
  }
}

function simPosition() {
  // "Wander off": 95 m sideways from the route, beyond the Guardian's 75 m off-route threshold.
  const [lat, lng] = sim.wander ? offsetFromRoute(walk.route.points, sim.walked, 95) : pointAlong(walk.route.points, sim.walked);
  return { lat, lng, accuracy_m: 5 };
}

function startMock() {
  sim = { walked: 0, total: routeLength(walk.route.points), paused: false, wander: false };
  latest = simPosition();
  sync();
  timers.push(
    setInterval(() => {
      if (!sim.paused) sim.walked = Math.min(sim.total, sim.walked + (WALK_SPEED * MOCK_EVERY_MS) / 1000);
      latest = simPosition();
      sync();
    }, MOCK_EVERY_MS),
  );
}

function startReal() {
  if (!('geolocation' in navigator)) {
    console.warn('[app] no geolocation: simulating the walk');
    return startMock();
  }
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      latest = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) };
      notify();
    },
    (err) => console.warn('[app] GPS error:', err.message),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
  timers.push(setInterval(sync, REAL_EVERY_MS));
  timers.push(setTimeout(sync, 1500));
}

function onKey(e) {
  if ((e.key === 'j' || e.key === 'J') && sim && !/^(INPUT|TEXTAREA)$/.test(e.target?.tagName)) locationService.jumpAhead();
}

export const locationService = {
  // One quick fix for the walk's start point (falls back after 6 s).
  currentPosition(fallback) {
    if (isMockModeEnabled() || !('geolocation' in navigator)) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), 6000);
      navigator.geolocation.getCurrentPosition(
        (p) => (clearTimeout(t), resolve({ lat: p.coords.latitude, lng: p.coords.longitude })),
        () => (clearTimeout(t), resolve(fallback)),
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 },
      );
    });
  },

  start(activeWalk, arrived) {
    this.stop();
    walk = activeWalk;
    onArrived = arrived;
    trail = [];
    if (isMockModeEnabled()) startMock();
    else startReal();
    window.addEventListener('keydown', onKey);
    notify();
  },

  stop() {
    timers.forEach((t) => clearInterval(t));
    timers = [];
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null;
    window.removeEventListener('keydown', onKey);
    walk = null;
    sim = null;
    latest = null;
    notify();
  },

  jumpAhead(metres = 150) {
    if (!sim) return;
    sim.walked = Math.min(sim.total, sim.walked + metres);
    latest = simPosition();
    sync();
  },
  jumpToHome() {
    if (!sim) return;
    sim.walked = sim.total;
    sim.wander = false;
    latest = simPosition();
    sync();
  },
  togglePause() {
    if (!sim) return;
    sim.paused = !sim.paused;
    notify();
  },
  toggleWander() {
    if (!sim) return;
    sim.wander = !sim.wander;
    latest = simPosition();
    sync();
    notify();
  },
  subscribe(fn) {
    listeners.add(fn);
    fn(state());
    return () => listeners.delete(fn);
  },
  get trail() {
    return trail.slice();
  },
};
