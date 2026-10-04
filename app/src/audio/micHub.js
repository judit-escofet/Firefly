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

  // iOS Safari 17+: ask for a recording session up front, so capture and the firefly's voice share
  // one audio route (the speaker, not the quiet earpiece). Harmless where unsupported.
  if (!file) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    } catch {}
  }

  // Everything up to here runs synchronously inside the tap (iOS requirement).
  let ctx = new Ctx();
  ctx.resume?.().catch(() => {});
  let streamPromise;
  let fileBuffer = null;
  let fileDest = null;
  const constraints = {
    // Raw-ish audio: noise suppression / AGC would flatten exactly the screams the Guardian
    // listens for. (Speech-to-text applies its own gain: companion/stt.js.)
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  };
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
    streamPromise = navigator.mediaDevices.getUserMedia(constraints);
  }

  let stream = null;
  let node = null;
  let source = null;
  let watchdog = null;
  // What the mic is actually delivering, for the "Listening" meter and for diagnosing phones.
  const stats = { chunks: 0, zeroChunks: 0, level: 0, lastSoundAt: 0, rebuilt: 0, restarted: 0, trackRate: null, error: null };

  // iOS can leave the context 'suspended' or 'interrupted' (permission prompt, a call, Siri, the
  // screen locking). Resume whenever it isn't running; any later tap on the page also rescues it.
  const wake = () => {
    if (!self.closed && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  };
  const watchContext = (c) => {
    c.onstatechange = () => {
      if (c === ctx) wake();
    };
  };
  watchContext(ctx);
  const gestureEvents = ['touchend', 'pointerdown', 'keydown'];
  gestureEvents.forEach((e) => document.addEventListener(e, wake, true));
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || self.closed) return;
    wake();
    if (!file && stream && stream.getAudioTracks().every((t) => t.readyState === 'ended')) restartStream('mic ended while hidden');
  };
  document.addEventListener('visibilitychange', onVisible);

  const self = {
    refs: 1,
    closed: false,
    source: file ? 'file' : 'mic',
    get ctx() {
      return ctx;
    },
    get nativeRate() {
      return ctx.sampleRate;
    },
    sampleRate: 16000,
    stats,
    // Smoothed input level (RMS, 0..1) and whether it has heard anything lately.
    get level() {
      return stats.level;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // Seconds on the AudioContext clock (for latency measurements).
    now: () => ctx.currentTime,
    diagnostics() {
      const t = stream?.getAudioTracks()[0];
      return [
        `ctx ${ctx.state} ${ctx.sampleRate} Hz`,
        `track ${t ? `${t.readyState}${t.muted ? ' muted' : ''} ${stats.trackRate ?? '?'} Hz` : 'none'}`,
        `chunks ${stats.chunks} (silent ${stats.zeroChunks})`,
        `level ${stats.level.toFixed(3)}`,
        stats.rebuilt ? `rebuilt ${stats.rebuilt}` : '',
        stats.restarted ? `restarted ${stats.restarted}` : '',
        stats.error ? `error: ${stats.error}` : '',
      ].filter(Boolean).join(' · ');
    },
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
      clearTimeout(watchdog);
      subscribers.clear();
      gestureEvents.forEach((e) => document.removeEventListener(e, wake, true));
      document.removeEventListener('visibilitychange', onVisible);
      teardownGraph();
      stream?.getTracks().forEach((t) => t.stop());
      streamPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      ctx.close().catch(() => {});
      if (hub === self) hub = null;
    },
  };

  function meter(data) {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      sum += v * v;
      if (v > max) max = v;
      else if (-v > max) max = -v;
    }
    stats.chunks += 1;
    if (max === 0) stats.zeroChunks += 1;
    const rms = Math.sqrt(sum / data.length);
    stats.level = stats.level * 0.7 + rms * 0.3;
    if (rms > 0.004) stats.lastSoundAt = Date.now();
  }

  function teardownGraph() {
    if (node) node.port.onmessage = null;
    try {
      source?.disconnect();
      node?.disconnect();
    } catch {}
    source = null;
    node = null;
  }

  async function buildGraph() {
    await ctx.audioWorklet.addModule(workletUrl);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'firefly-capture');
    const sink = ctx.createGain();
    sink.gain.value = 0; // keep the graph pulling without playing the mic back
    source.connect(node).connect(sink).connect(ctx.destination);
    const resampler = createResampler(ctx.sampleRate);
    stats.chunks = 0;
    stats.zeroChunks = 0;
    node.port.onmessage = ({ data }) => {
      meter(data);
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
    if (!file) armWatchdog();
  }

  // Some iPhones hand the page a mic stream that is pure digital silence (every sample exactly 0),
  // typically when the AudioContext was created at a different rate than the mic. If nothing but
  // zeros arrives, rebuild the capture graph once on a fresh context at the mic's own rate.
  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(async () => {
      if (self.closed) return;
      wake();
      const allSilent = stats.chunks > 0 && stats.zeroChunks === stats.chunks;
      const stalled = stats.chunks === 0 && ctx.state === 'running';
      if ((allSilent || stalled) && stats.rebuilt < 2) {
        stats.rebuilt += 1;
        console.warn(`[mic] ${allSilent ? 'only silence' : 'no audio'} from the microphone: rebuilding the capture graph`);
        teardownGraph();
        const old = ctx;
        try {
          ctx = stats.trackRate ? new Ctx({ sampleRate: stats.trackRate }) : new Ctx();
        } catch {
          ctx = new Ctx();
        }
        watchContext(ctx);
        old.close().catch(() => {});
        try {
          await buildGraph();
        } catch (err) {
          stats.error = err.message;
          console.error('[mic] rebuild failed', err);
        }
      }
    }, 2500);
  }

  function useStream(s) {
    stream = s;
    const track = s.getAudioTracks()[0];
    stats.trackRate = track?.getSettings?.().sampleRate ?? null;
    // A phone call, Siri or another app can end the capture: get the mic back when possible.
    if (track && !file) track.onended = () => restartStream('mic track ended');
  }

  async function restartStream(why) {
    if (self.closed || stats.restarted > 5) return;
    stats.restarted += 1;
    console.warn(`[mic] ${why}: reopening the microphone`);
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      if (self.closed) return s.getTracks().forEach((t) => t.stop());
      teardownGraph();
      stream?.getTracks().forEach((t) => t.stop());
      useStream(s);
      await buildGraph();
    } catch (err) {
      stats.error = err.message;
      console.error('[mic] could not reopen the microphone', err);
    }
  }

  self.ready = (async () => {
    try {
      useStream(await streamPromise);
    } catch (err) {
      self.close();
      if (err?.name === 'NotAllowedError') throw new Error('microphone permission denied: allow the mic for this site, then reload');
      throw err;
    }
    if (self.closed) throw new Error('microphone closed before it started');
    await buildGraph();
    return self;
  })();
  self.ready.catch(() => {});
  return self;
}
