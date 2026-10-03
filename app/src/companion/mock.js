// Companion mock (?mock=1): type what she says instead of talking. Emits speech.heard partials
// word by word, then the final, exactly like live transcription; replies are canned lines
// (spoken with the pre-generated voice when one matches). Works with all APIs off.

import * as bus from '../bus.js';

export function mountCompanionMock() {
  if (typeof document === 'undefined' || document.getElementById('firefly-companion-mock')) return;
  const box = document.createElement('form');
  box.id = 'firefly-companion-mock';
  box.innerHTML = `
    <style>
      #firefly-companion-mock{position:fixed;left:12px;bottom:96px;z-index:45;display:none;gap:6px;
        background:rgba(20,20,30,.92);padding:8px;border-radius:10px;font:13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4)}
      #firefly-companion-mock.on{display:flex}
      #firefly-companion-mock input{width:min(52vw,260px);padding:6px 8px;border-radius:6px;border:0;font:inherit}
      #firefly-companion-mock button{padding:6px 10px;border:0;border-radius:6px;background:#ffcf5c;font:inherit;font-weight:600;cursor:pointer}
    </style>
    <input placeholder="🗣️ Say something (mock speech)" aria-label="Mock speech" />
    <button type="submit">Say</button>`;
  const input = box.querySelector('input');
  box.onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const words = text.split(/\s+/);
    words.forEach((_, i) => {
      setTimeout(() => {
        const partial = words.slice(0, i + 1).join(' ');
        bus.emit('speech.heard', { text: partial, final: false });
        if (i === words.length - 1) setTimeout(() => bus.emit('speech.heard', { text, final: true }), 250);
      }, i * 120);
    });
  };
  document.body.appendChild(box);
  // Only during a walk (that's when there's someone to talk to), above the walk screen's buttons.
  bus.on('walk.started', () => box.classList.add('on'));
  bus.on('walk.ended', () => box.classList.remove('on'));
}
