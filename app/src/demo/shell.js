// TEMPORARY demo shell so P1 (companion) and P2 (guardian) run together before P4's app lands.
// It plays P4's role only through the bus: walk.started / position.updated / pin.entered /
// walk.ended. P4: replace this file.

import * as bus from '../bus.js';
import { startGuardian } from '../guardian/index.js';
import { startCompanion } from '../companion/index.js';
import { acquireMic } from '../audio/micHub.js';

const $ = (id) => document.getElementById(id);
const local = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};
const mock = new URLSearchParams(location.search).get('mock') === '1';
const guardian = startGuardian();
const companion = startCompanion();
$('modeNote').textContent = mock ? '(mock mode: type in the box at the bottom)' : '';

// ---- route + simulated GPS (P4 would use navigator.geolocation + P3's /location) ----
const ROUTE = [
  [40.7425, -74.1781], [40.7431, -74.1772], [40.7440, -74.1764], [40.7447, -74.1752], [40.7452, -74.1741],
];
const R = 6371000;
const hav = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const LEGS = ROUTE.slice(1).map((p, i) => hav(ROUTE[i], p));
const TOTAL = LEGS.reduce((a, b) => a + b, 0);
function pointAt(d) {
  let rem = Math.max(0, Math.min(TOTAL, d));
  for (let i = 0; i < LEGS.length; i++) {
    if (rem <= LEGS[i]) {
      const f = rem / LEGS[i];
      return [ROUTE[i][0] + (ROUTE[i + 1][0] - ROUTE[i][0]) * f, ROUTE[i][1] + (ROUTE[i + 1][1] - ROUTE[i][1]) * f];
    }
    rem -= LEGS[i];
  }
  return ROUTE.at(-1);
}

const sim = { walked: 0, speed: 1.4, paused: false, offRoute: 0, timer: null };
function tick() {
  if (!sim.paused) sim.walked = Math.min(TOTAL, sim.walked + sim.speed * 2);
  const [lat, lng] = pointAt(sim.walked);
  const remaining = TOTAL - sim.walked;
  // Off route: drift ~0.001° (≈ 85 m) east of the line.
  const pos = { lat, lng: lng + (sim.offRoute ? 0.001 : 0), remaining_m: Math.round(remaining), eta_s: Math.round(remaining / 1.3), on_route: !sim.offRoute, off_route_m: sim.offRoute };
  bus.emit('position.updated', pos);
  $('remaining').textContent = `${pos.remaining_m} m`;
  $('eta').textContent = `${Math.ceil(pos.eta_s / 60)} min`;
  if (remaining <= 0) endWalk('arrived');
}

// ---- walk lifecycle ----
let walking = false;
function startWalk({ file = null } = {}) {
  if (walking) return;
  walking = true;
  // Everything below up to emit() is synchronous, inside the tap: iOS only starts audio here.
  const testMic = file ? acquireMic({ file }) : null; // the guardian + companion join this hub
  bus.emit('walk.started', {
    walk_id: `w_demo_${Date.now().toString(36)}`,
    share_url: `${location.origin}/track/demo`,
    route: { points: ROUTE, distance_m: Math.round(TOTAL), eta_s: Math.round(TOTAL / 1.3) },
  });
  Object.assign(sim, { walked: 0, paused: false, offRoute: 0 });
  sim.timer = setInterval(tick, 2000);
  tick();
  $('walk').disabled = $('walkFile').disabled = true;
  $('end').disabled = false;
  if (testMic) {
    testMic.ready
      .then(() => new Promise((r) => setTimeout(r, 2500))) // let transcription connect
      .then(() => testMic.startFile())
      .then(({ duration }) => {
        addMsg('sys', `playing test audio (${duration.toFixed(0)} s) into the mic pipeline`);
        setTimeout(() => testMic.release(), (duration + 2) * 1000);
      })
      .catch((err) => addMsg('sys', `test audio failed: ${err.message}`));
  }
}

function endWalk(reason = 'arrived') {
  if (!walking) return;
  walking = false;
  clearInterval(sim.timer);
  bus.emit('walk.ended', { reason });
  $('walk').disabled = $('walkFile').disabled = false;
  $('end').disabled = true;
}

$('walk').onclick = () => startWalk();
$('walkFile').onclick = () => startWalk({ file: '/demo/test_walk.wav' });
$('end').onclick = () => endWalk('arrived');
document.querySelectorAll('[data-sim]').forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.sim;
    if (a === 'pause') {
      sim.paused = !sim.paused;
      b.textContent = sim.paused ? 'Keep walking' : 'Stop here';
    } else if (a === 'wander') {
      sim.offRoute = sim.offRoute ? 0 : 90;
      b.textContent = sim.offRoute ? 'Back on route' : 'Wander off';
    } else if (a === 'jump') sim.walked = Math.min(TOTAL - 5, sim.walked + 250);
  };
});

// ---- conversation view ----
let partialEl = null;
function addMsg(kind, text, { partial = false } = {}) {
  const box = $('transcript');
  if (kind === 'her' && partialEl) {
    partialEl.textContent = text;
    partialEl.classList.toggle('partial', partial);
    if (!partial) partialEl = null;
  } else {
    const el = document.createElement('div');
    el.className = `msg ${kind}${partial ? ' partial' : ''}`;
    el.textContent = text;
    box.appendChild(el);
    if (kind === 'her' && partial) partialEl = el;
  }
  box.scrollTop = box.scrollHeight;
}
bus.on('speech.heard', (e) => addMsg('her', e.text, { partial: !e.final }));
bus.on('companion.speaking', (e) => {
  $('orb').classList.toggle('on', e.on);
  $('orbLabel').textContent = e.on ? 'firefly is talking' : 'firefly is listening';
  if (e.on && e.text) addMsg('ff', e.text);
});
bus.on('checkin.answered', (e) => addMsg('sys', `check-in answer: ${e.ok === true ? 'okay' : e.ok === false ? 'not okay' : 'no answer'}`));
bus.on('danger.signal', (e) => addMsg('sys', `guardian heard: ${e.source.replace('_', ' ')}`));
bus.on('guardian.score', (s) => ($('score').textContent = s.score.toFixed(2)));
setInterval(() => {
  $('stt').textContent = companion.status.stt;
  const l = companion.status.latencies;
  $('lat').textContent = l.length ? `${(l.at(-1) / 1000).toFixed(1)} s (median ${(l.slice().sort((a, b) => a - b)[l.length >> 1] / 1000).toFixed(1)})` : '–';
}, 500);

// ---- countdown screen: calm on purpose (no red, no "alert"), PIN pad ----
const PIN = () => local('firefly.pin', '1234');
const DURESS = () => local('firefly.duress_pin', '9999');
let entered = '';
const pad = $('pad');
for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']) {
  const b = document.createElement('button');
  b.textContent = k;
  if (!k) b.style.visibility = 'hidden';
  b.onclick = () => {
    if (k === '⌫') entered = entered.slice(0, -1);
    else if (entered.length < 4) entered += k;
    $('dots').textContent = '•'.repeat(entered.length);
    if (entered.length === 4) {
      const kind = entered === PIN() ? 'cancel' : entered === DURESS() ? 'duress' : null;
      entered = '';
      $('dots').textContent = '';
      if (kind) bus.emit('pin.entered', { kind }); // a wrong PIN just clears the pad
    }
  };
  pad.appendChild(b);
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').style.display = 'block';
  setTimeout(() => ($('toast').style.display = 'none'), 3500);
}
bus.on('alert.state', (e) => {
  $('gstate').textContent = e.state + (e.seconds_left != null ? ` ${e.seconds_left}s` : '');
  $('pinOverlay').classList.toggle('show', e.state === 'countdown');
  if (e.state === 'countdown' && e.seconds_left === 10) navigator.vibrate?.([200, 100, 200]);
  if (e.state === 'resolved') toast('All good, enjoy your walk.');
  if (e.state === 'alerted') toast('Your contacts have been told where you are.');
});

void guardian;
