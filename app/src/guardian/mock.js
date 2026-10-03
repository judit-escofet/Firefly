// Guardian mock (?mock=1): floating buttons + keyboard shortcuts that emit the same bus events as
// the real Guardian, so teammates can build the countdown / check-in / alert UI with no mic.
// It drives the real state machine (startGuardian with ?mock=1: API calls only logged), so
// alert.state, checkin.request and the 10 s countdown behave exactly like production.
//
// Keys: w start walk · s scream · c code phrase · l long stop · o off route
//       y answer ok · n answer not ok · u no answer · p cancel PIN · d duress PIN · e end walk

import * as bus from '../bus.js';

const ACTIONS = [
  { key: 'w', label: 'Start walk', group: 'walk', run: () =>
      bus.emit('walk.started', {
        walk_id: `mock-${Date.now().toString(36)}`,
        share_url: `${location.origin}/track/mock`,
        route: { points: [[40.7425, -74.1781], [40.742, -74.179]], distance_m: 1200, eta_s: 900 },
      }) },
  { key: 's', label: 'Scream', group: 'guardian', run: () =>
      bus.emit('danger.signal', { source: 'scream', confidence: 0.91, detail: 'mock: 3 of last 4 windows above threshold' }) },
  { key: 'c', label: 'Code phrase', group: 'guardian', run: () =>
      bus.emit('danger.signal', { source: 'code_phrase', confidence: 0.93, detail: 'mock: heard "i think i left the oven on"' }) },
  { key: 'l', label: 'Long stop', group: 'guardian', run: () =>
      bus.emit('danger.signal', { source: 'long_stop', confidence: 0.6, detail: 'mock: stopped 90 s' }) },
  { key: 'o', label: 'Off route', group: 'guardian', run: () =>
      bus.emit('danger.signal', { source: 'off_route', confidence: 0.6, detail: 'mock: 80 m off route for 30 s' }) },
  { key: 'y', label: 'Answer: ok', group: 'app', run: () => bus.emit('checkin.answered', { ok: true, text: "yeah I'm fine" }) },
  { key: 'n', label: 'Answer: not ok', group: 'app', run: () => bus.emit('checkin.answered', { ok: false, text: 'no' }) },
  { key: 'u', label: 'No answer', group: 'app', run: () => bus.emit('checkin.answered', { ok: null, text: '' }) },
  { key: 'p', label: 'PIN cancel', group: 'app', run: () => bus.emit('pin.entered', { kind: 'cancel' }) },
  { key: 'd', label: 'PIN duress', group: 'app', run: () => bus.emit('pin.entered', { kind: 'duress' }) },
  { key: 'e', label: 'End walk', group: 'walk', run: () => bus.emit('walk.ended', { reason: 'arrived' }) },
];

export function mountMock({ guardian } = {}) {
  if (typeof document === 'undefined' || document.getElementById('firefly-guardian-mock')) return;

  const panel = document.createElement('div');
  panel.id = 'firefly-guardian-mock';
  panel.innerHTML = `
    <style>
      #firefly-guardian-mock{position:fixed;right:12px;bottom:12px;z-index:99999;font:12px/1.3 system-ui,sans-serif;
        background:rgba(20,20,30,.92);color:#eee;border-radius:10px;padding:8px;width:220px;box-shadow:0 4px 18px rgba(0,0,0,.4)}
      #firefly-guardian-mock .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;cursor:pointer}
      #firefly-guardian-mock .st{font-weight:600}
      #firefly-guardian-mock .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
      #firefly-guardian-mock button{font:inherit;padding:6px 4px;border:0;border-radius:6px;cursor:pointer;color:#111;background:#ddd}
      #firefly-guardian-mock button[data-g=guardian]{background:#ffcf5c}
      #firefly-guardian-mock button[data-g=app]{background:#9fd3ff}
      #firefly-guardian-mock kbd{opacity:.6;font-size:10px}
      #firefly-guardian-mock.min .grid{display:none}
    </style>
    <div class="hd"><span>🛡️ Guardian mock</span><span class="st">idle</span></div>
    <div class="grid"></div>`;
  const grid = panel.querySelector('.grid');
  const st = panel.querySelector('.st');
  for (const a of ACTIONS) {
    const b = document.createElement('button');
    b.dataset.g = a.group;
    b.innerHTML = `${a.label} <kbd>${a.key}</kbd>`;
    b.title = a.group === 'app' ? 'Normally emitted by the app / companion' : 'Emitted by the Guardian';
    b.onclick = a.run;
    grid.appendChild(b);
  }
  panel.querySelector('.hd').onclick = () => panel.classList.toggle('min');
  // On phones the panel would cover the app's own buttons: start collapsed (tap the header).
  if (globalThis.innerWidth < 700) panel.classList.add('min');
  document.body.appendChild(panel);

  bus.on('alert.state', (e) => {
    st.textContent = e.state + (e.seconds_left != null ? ` ${e.seconds_left}s` : '');
    st.style.color = { countdown: '#ffcf5c', alerted: '#ff6b6b', resolved: '#7ee787', checking_in: '#9fd3ff' }[e.state] ?? '#eee';
  });
  bus.on('*', (e) => console.debug('[bus]', e.type, e));

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target?.tagName) || ev.target?.isContentEditable) return;
    ACTIONS.find((a) => a.key === ev.key)?.run();
  });

  if (guardian) st.textContent = guardian.sm.state;
}
