// Guardian entry point. The app shell calls startGuardian() once at boot; everything else
// happens through bus events (see contracts/events.md).
//
//   ?mock=1   API calls are logged instead of sent, and a floating mock panel can drive the whole
//             flow. The mic still runs (P4's mock mode: "a played scream still works").
//   ?mic=0    no microphone (teammates without one; the mock panel still drives everything)
//   ?debug=1  on-screen overlay with live score, state and inference time

import * as bus from '../bus.js';
import { realClock } from './clock.js';
import { createApi, isMockMode } from './api.js';
import { createStateMachine } from './stateMachine.js';
import { createCodePhraseSpotter, loadCodePhrase } from './codePhrase.js';
import { createCheckinTriggers } from './checkins.js';
import { createScoreLog } from './scoreLog.js';
import { createClipBuffer, encodeWav } from './audio/clipBuffer.js';
import { acquireMic } from '../audio/micHub.js';

let instance = null;

export function startGuardian({
  mock = isMockMode(),
  mic = new URLSearchParams(globalThis.location?.search ?? '').get('mic') !== '0',
  debug = new URLSearchParams(globalThis.location?.search ?? '').get('debug') === '1',
  clock = realClock,
} = {}) {
  if (instance) return instance;

  let walkId = null;
  let detector = null;
  let heldMic = null;
  let detectorStarting = null;
  let tickTimer = null;
  const clipBuffer = createClipBuffer();
  let audioSeen = false;
  const pushAudio = (x16) => {
    audioSeen = true;
    clipBuffer.push(x16);
  };
  const api = createApi({ getWalkId: () => walkId, mock });
  const status = { mode: 'off', backend: null, threshold: null, lastScore: null, lastMs: null, stats: null, error: null };

  const sm = createStateMachine({
    emit: bus.emit,
    clock,
    logEvent: (body) => api.postEvent(body),
    clip: {
      capture: () => {
        if (audioSeen) return clipBuffer.capture().then((pcm) => encodeWav(pcm));
        // No microphone audio: no clip. (Mock mode fakes one so the flow shows a clip_url; the
        // mock API never uploads it.)
        return mock ? new Promise((r) => clock.setTimeout(() => r(encodeWav(new Float32Array(16000 * 10))), 5000)) : null;
      },
      upload: (blob) => api.uploadClip(blob),
    },
  });

  const spotter = createCodePhraseSpotter({
    getPhrase: () => loadCodePhrase(),
    clock,
    onMatch: (r) =>
      bus.emit('danger.signal', {
        source: 'code_phrase',
        confidence: Number(r.score.toFixed(3)),
        detail: `heard "${r.window}"`,
      }),
  });

  const triggers = createCheckinTriggers({ clock, onTrigger: (sig) => bus.emit('danger.signal', sig) });
  const scoreLog = createScoreLog({ clock, post: (scores) => api.postScores(scores) });

  async function startMic() {
    if (!mic || detector || detectorStarting) return;
    status.mode = 'loading';
    // Synchronously, still inside the "Walk with me" tap: iOS only starts audio from a gesture.
    // The hub is shared with the companion's speech-to-text (one mic for the whole app).
    heldMic = acquireMic();
    detectorStarting = import('./audio/detector.js') // lazy: keeps TF.js out of the initial bundle
      .then(({ startScreamDetector }) =>
        startScreamDetector({
          onStatus: (t) => (status.loading = t),
          onAudio: pushAudio,
          onScore: (s) => {
            status.lastScore = s.score;
            status.lastMs = s.ms;
            scoreLog.add({ ts: s.ts, scream_score: s.score, triggered: s.triggered });
            bus.emit('guardian.score', s); // debug-only event (overlay, test page); not part of the contract
          },
          onTrigger: ({ confidence, detail }) => bus.emit('danger.signal', { source: 'scream', confidence, detail }),
        }),
      )
      .then((d) => {
        detector = d;
        Object.assign(status, { mode: d.mode, backend: d.backend, backendNote: d.backendNote, stats: d.stats, threshold: d.rule.threshold, error: null });
        if (d.contextState !== 'running') console.warn(`[guardian] audio context is ${d.contextState}: emit walk.started from inside the tap handler`);
      })
      .catch((err) => {
        status.mode = 'error';
        status.error = err.message;
        console.error('[guardian] scream detector failed to start', err);
      })
      .finally(() => (detectorStarting = null));
    return detectorStarting;
  }

  async function stopMic() {
    await detectorStarting;
    await detector?.stop();
    detector = null;
    heldMic?.release();
    heldMic = null;
    if (status.mode !== 'error') status.mode = 'off';
  }

  function tick() {
    triggers.tick();
    tickTimer = clock.setTimeout(tick, 5000);
  }

  let stopAfterCountdown = false;
  const handlers = {
    'walk.started': (e) => {
      walkId = e.walk_id;
      triggers.reset();
      scoreLog.start();
      if (tickTimer === null) tick();
      startMic(); // emit walk.started from the "start walk" tap so iOS lets audio start
    },
    'position.updated': (e) => triggers.position(e),
    'speech.heard': (e) => spotter.heard(e),
    'checkin.answered': (e) => sm.answer(e.ok),
    'pin.entered': (e) => sm.pin(e.kind),
    'danger.signal': (e) => sm.danger(e),
    'walk.ended': () => {
      sm.walkEnded();
      triggers.reset();
      if (tickTimer !== null) clock.clearTimeout(tickTimer);
      tickTimer = null;
      scoreLog.stop();
      // Keep listening while a countdown is still running so the clip can finish.
      if (sm.state === 'countdown') stopAfterCountdown = true;
      else stopMic();
    },
    'alert.state': (e) => {
      if (stopAfterCountdown && e.state !== 'countdown') {
        stopAfterCountdown = false;
        stopMic();
      }
    },
  };
  for (const [type, fn] of Object.entries(handlers)) bus.on(type, fn);

  instance = {
    sm,
    status,
    get walkId() {
      return walkId;
    },
    startMic,
    stopMic,
    pushAudio, // 16 kHz samples into the clip buffer (the detector's path; also used by tests)
    stop() {
      for (const [type, fn] of Object.entries(handlers)) bus.off(type, fn);
      sm.dispose();
      if (tickTimer !== null) clock.clearTimeout(tickTimer);
      scoreLog.stop();
      stopMic();
      instance = null;
    },
  };

  if (mock) import('./mock.js').then((m) => m.mountMock({ guardian: instance }));
  if (debug) import('./overlay.js').then((m) => m.mountOverlay({ guardian: instance }));
  bus.emit('alert.state', { state: sm.state, seconds_left: null });
  return instance;
}
