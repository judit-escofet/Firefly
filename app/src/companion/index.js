// P1 Companion entry point. The app shell calls startCompanion() once at boot; everything else
// happens through bus events.
//
// Listens: walk.started, position.updated, checkin.request, alert.state, walk.ended, speech.heard
// Emits:   speech.heard {text, final}, checkin.answered {ok, text}, companion.speaking {on, text}
//
//   ?mock=1   no network: type what she says (mock panel), canned replies, pre-generated voice
//
// Profile bits come from localStorage until P4's setup screen exists:
//   firefly.user_id (default "u_demo"), firefly.name, firefly.interests ("music,tech")

import * as bus from '../bus.js';
import { realClock } from '../guardian/clock.js';
import { acquireMic } from '../audio/micHub.js';
import { createCompanionApi } from './api.js';
import { createVoice } from './voice.js';
import { createBrain } from './brain.js';
import { createTranscriber } from './stt.js';
import { isEcho } from './echo.js';

const local = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};
const isMock = () => new URLSearchParams(globalThis.location?.search ?? '').get('mock') === '1';
// Words the transcriber should favour: her code phrase (so the Guardian hears it reliably).
const vocabulary = () => [local('firefly.code_phrase', 'i think i left the oven on')];

let instance = null;

export function startCompanion({ mock = isMock(), clock = realClock } = {}) {
  if (instance) return instance;
  const api = createCompanionApi({ mock });
  const status = { stt: 'off', lastLatencyMs: null, latencies: [] };
  let walkId = null;
  let context = {};
  let news = [];
  let mic = null;
  let transcriber = null;
  let lastSpoken = { text: '', until: 0 }; // what the firefly is saying (for the echo filter)

  const voice = createVoice({
    api,
    getContext: () => mic?.ctx ?? null,
    onSpeaking: (on, text) => {
      // Keep the line for 1.5 s after it ends: the transcriber's final for an echo arrives late.
      lastSpoken = on ? { text, until: Infinity } : { text: lastSpoken.text, until: Date.now() + 1500 };
      brain.speakingChanged(on);
      bus.emit('companion.speaking', { on, text });
    },
  });

  const brain = createBrain({
    clock,
    say: (text, { t0 }) =>
      voice.say(text, {
        t0,
        onStart: (ms) => {
          status.lastLatencyMs = Math.round(ms);
          status.latencies = [...status.latencies.slice(-19), status.lastLatencyMs];
        },
      }),
    turn: (body) => api.turn(body),
    classify: (text) => api.checkin(text),
    emit: bus.emit,
    line: (id) => voice.line(id),
    getContext: () => context,
    getNews: () => news,
    identity: () => ({ user_id: local('firefly.user_id', 'u_demo'), walk_id: walkId, name: local('firefly.name', undefined) }),
  });

  function startListening() {
    if (mock) {
      status.stt = 'mock (type in the panel)';
      return;
    }
    // Synchronously inside the "Walk with me" tap (iOS): shared with the Guardian's scream model.
    mic = acquireMic();
    status.stt = 'starting';
    mic.ready
      .then(() => {
        transcriber = createTranscriber({
          mic,
          getToken: () => api.speechToken(),
          vocabulary: vocabulary(),
          onStatus: (s) => (status.stt = s),
          onPartial: (text) => heard(text, false),
          onFinal: (text) => heard(text, true),
        });
      })
      .catch((err) => {
        status.stt = `mic error: ${err.message}`;
        console.error('[companion] microphone unavailable', err);
      });
  }

  // Her words → speech.heard (the Guardian's code-phrase spotter and the brain both listen).
  // The firefly's own voice coming back through the speaker is dropped; if she talks over the
  // firefly, it stops talking so she can be heard (barge-in).
  function heard(text, final) {
    const fireflyTalking = voice.speaking || Date.now() < lastSpoken.until;
    if (fireflyTalking && isEcho(text, lastSpoken.text)) return;
    if (voice.speaking) voice.stop();
    bus.emit('speech.heard', { text, final });
  }

  function stopListening() {
    transcriber?.stop();
    transcriber = null;
    mic?.release();
    mic = null;
    status.stt = 'off';
  }

  const handlers = {
    'walk.started': (e) => {
      walkId = e.walk_id;
      context = { eta_s: e.route?.eta_s, remaining_m: e.route?.distance_m };
      startListening(); // must stay synchronous (gesture)
      api.news(local('firefly.interests', 'music,tech').split(',')).then((items) => (news = items));
      brain.start();
    },
    'position.updated': (e) => {
      context = { eta_s: e.eta_s, remaining_m: e.remaining_m };
    },
    'speech.heard': (e) => brain.heard(e),
    'checkin.request': (e) => brain.checkinRequest(e),
    'alert.state': (e) => brain.alertState(e),
    'walk.ended': async (e) => {
      const turns = brain.history;
      brain.stop();
      if (e.reason === 'arrived') {
        const bye = (await voice.line('home')) ?? "You're home! Good night.";
        await voice.say(bye);
      }
      stopListening();
      api.end({ user_id: local('firefly.user_id', 'u_demo'), walk_id: walkId, turns }).then((r) => {
        if (r.facts?.length) console.info('[companion] remembered:', r.facts);
      });
      walkId = null;
    },
  };
  for (const [type, fn] of Object.entries(handlers)) bus.on(type, fn);

  instance = {
    status,
    brain,
    voice,
    stop() {
      for (const [type, fn] of Object.entries(handlers)) bus.off(type, fn);
      brain.stop();
      stopListening();
      instance = null;
    },
  };
  if (mock) import('./mock.js').then((m) => m.mountCompanionMock());
  return instance;
}
