// Phone-testing overlay (?debug=1): live scream score bar, state, inference ms, backend, tensors.

import * as bus from '../bus.js';

export function mountOverlay({ guardian }) {
  if (typeof document === 'undefined' || document.getElementById('firefly-guardian-debug')) return;
  const el = document.createElement('div');
  el.id = 'firefly-guardian-debug';
  el.innerHTML = `
    <style>
      #firefly-guardian-debug{position:fixed;left:8px;top:8px;z-index:99998;font:11px/1.35 ui-monospace,monospace;
        background:rgba(0,0,0,.78);color:#e6e6e6;padding:6px 8px;border-radius:8px;width:200px;pointer-events:none}
      #firefly-guardian-debug .bar{height:8px;background:#333;border-radius:4px;position:relative;margin:4px 0}
      #firefly-guardian-debug .fill{height:100%;border-radius:4px;background:#5cc8ff;width:0}
      #firefly-guardian-debug .th{position:absolute;top:-2px;bottom:-2px;width:2px;background:#ff6b6b}
    </style>
    <div class="l1"></div><div class="bar"><div class="fill"></div><div class="th"></div></div><div class="l2"></div><div class="l3"></div>`;
  document.body.appendChild(el);
  const [l1, l2, l3] = ['.l1', '.l2', '.l3'].map((s) => el.querySelector(s));
  const fill = el.querySelector('.fill');
  const th = el.querySelector('.th');
  let state = guardian.sm.state;
  let last = null;

  bus.on('alert.state', (e) => {
    state = e.state + (e.seconds_left != null ? ` ${e.seconds_left}s` : '');
    render();
  });
  bus.on('guardian.score', (s) => {
    last = s;
    render();
  });

  function render() {
    const st = guardian.status;
    l1.textContent = `state ${state} · ${st.mode}`;
    const score = last?.score ?? 0;
    const threshold = st.threshold ?? 0.5;
    fill.style.width = `${Math.round(score * 100)}%`;
    fill.style.background = last?.triggered ? '#ff6b6b' : score >= threshold ? '#ffcf5c' : '#5cc8ff';
    th.style.left = `${Math.round(threshold * 100)}%`;
    l2.textContent = `score ${score.toFixed(2)} · yam ${(last?.yamnetScore ?? 0).toFixed(2)} · thr ${threshold.toFixed(2)}`;
    const s = st.stats;
    l3.textContent = s
      ? `${(last?.ms ?? 0).toFixed(0)} ms (avg ${s.msAvg.toFixed(0)}, max ${s.msMax.toFixed(0)}) · ${st.backend} · n=${s.windows} drop=${s.dropped}`
      : st.error
        ? `error: ${st.error}`
        : 'mic off';
  }
  render();
  setInterval(render, 1000);
}
