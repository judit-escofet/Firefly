// Shared microphone for the whole app: ONE getUserMedia + AudioContext, resampled once to
// 16 kHz mono, fanned out to every subscriber — the Guardian's scream model and clip buffer,
// and the Companion's live speech-to-text. Phones (iOS especially) misbehave when two parts of
// a page capture the mic separately, and only one capture can be started inside the user's tap.
//
//   const mic = acquireMic();            // synchronously, INSIDE the "Walk with me" tap handler
//   const off = mic.subscribe((pcm16k) => …);
//   await mic.ready;                     // resolves once audio is flowing (or rejects with why)
//   mic.release();                       // last holder out closes the mic
//
// acquireMic({ file: url }) plays an audio file through the exact same path instead of the mic
// (for tests and demos without a microphone); call mic.startFile() once subscribers are ready.

import workletUrl from './capture-worklet.js?url';
import { createResampler } from './resampler.js';

let hub = null;

export function currentMic() {
  return hub;
}

export function acquireMic({ file = null } = {}) {
  if (hub && !hub.closed && (!file || hub.source === 'file')) {
    hub.refs += 1;
    return hub;
  }
  if (hub && !hub.closed) hub.close();
  hub = createHub(file);
  return hub;
}

function createHub(file) {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const subscribers = new Set();
  if (!Ctx || (!file && !navigator.mediaDevices?.getUserMedia)) {
    const why = !globalThis.isSecureContext
      ? 'microphone needs HTTPS (or localhost)'
      : 'this browser has no Web Audio / microphone support';
    const err = Promise.reject(new Error(why));
    err.catch(() => {});
    return { refs: 1, closed: true, ready: err, source: 'none', subscribe: () => () => {}, release() {}, close() {}, ctx: null };
  }

  // Everything up to here runs synchronously inside the tap (iOS requirement).
  const ctx = new Ctx();
  ctx.resume?.().catch(() => {});
  let streamPromise;
  let fileBuffer = null;
  let fileDest = null;
  if (file) {
    fileDest = ctx.createMediaStreamDestination();
    streamPromise = Promise.resolve(fileDest.stream);
    fileBuffer = fetch(file)
      .then((r) => {
        if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b));
  } else {
    streamPromise = navigator.mediaDevices.getUserMedia({
      // Raw-ish audio: noise suppression / AGC would flatten exactly the screams the Guardian
      // listens for. (The companion mutes its transcription while the firefly is speaking.)
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  }

  let stream = null;
  let node = null;
  let source = null;
  const self = {
    refs: 1,
    closed: false,
    source: file ? 'file' : 'mic',
    ctx,
    nativeRate: ctx.sampleRate,
    sampleRate: 16000,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // Seconds on the AudioContext clock (for latency measurements).
    now: () => ctx.currentTime,
    async startFile() {
      if (!fileBuffer) throw new Error('not a file source');
      const src = ctx.createBufferSource();
      src.buffer = await fileBuffer;
      src.connect(fileDest);
      const startedAt = ctx.currentTime + 0.05;
      src.start(startedAt);
      return { startedAt, duration: src.buffer.duration };
    },
    release() {
      self.refs -= 1;
      if (self.refs <= 0) self.close();
    },
    close() {
      if (self.closed) return;
      self.closed = true;
      subscribers.clear();
      if (node) node.port.onmessage = null;
      try {
        source?.disconnect();
        node?.disconnect();
      } catch {}
      stream?.getTracks().forEach((t) => t.stop());
      streamPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      ctx.close().catch(() => {});
      if (hub === self) hub = null;
    },
  };

  self.ready = (async () => {
    try {
      stream = await streamPromise;
    } catch (err) {
      self.close();
      if (err?.name === 'NotAllowedError') throw new Error('microphone permission denied: allow the mic for this site, then reload');
      throw err;
    }
    if (self.closed) throw new Error('microphone closed before it started');
    await ctx.audioWorklet.addModule(workletUrl);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'firefly-capture');
    const sink = ctx.createGain();
    sink.gain.value = 0; // keep the graph pulling without playing the mic back
    source.connect(node).connect(sink).connect(ctx.destination);
    const resampler = createResampler(ctx.sampleRate);
    node.port.onmessage = ({ data }) => {
      const x16 = resampler.push(data);
      if (!x16.length) return;
      for (const fn of subscribers) {
        try {
          fn(x16);
        } catch (err) {
          console.error('[mic] subscriber threw', err);
        }
      }
    };
    return self;
  })();
  self.ready.catch(() => {});
  return self;
}
