// Shared microphone for the whole app: ONE getUserMedia + AudioContext, resampled once to
// 16 kHz mono, fanned out to every subscriber — the Guardian's scream model and clip buffer,
// and the Companion's live speech-to-text. Phones (iOS especially) misbehave when two parts of
// a page capture the mic separately, and only one capture can be started inside the user's tap.
//
//   const mic = acquireMic();            // synchronously, INSIDE the "Walk with me" tap handler
//   const off = mic.subscribe((pcm16k) => …);
//   await mic.ready;                     // resolves once audio is flowing (or rejects with why)
//   mic.revive();                        // inside any later tap: wake a stalled mic (iOS)
//   mic.release();                       // last holder out closes the mic
//
// acquireMic({ file: url }) plays an audio file through the exact same path instead of the mic
// (for tests and demos without a microphone); call mic.startFile() once subscribers are ready.
//
// iPhone notes (why this file is more careful than it looks like it needs to be):
//  - With echo cancellation OFF, iOS Safari tends to stop delivering mic audio as soon as the
//    page plays sound (the firefly greets her right away). On iOS we ask for echo cancellation
//    (the voice-processing path phone calls use), which keeps capture alive during playback.
//  - The AudioContext can be left 'suspended' or 'interrupted' (permission prompt, a call, Siri,
//    the screen locking), and capture can stall if the context and the mic disagree on sample
//    rate. A heartbeat notices when audio stops arriving and rebuilds: fresh context at the mic's
//    rate, then a fresh mic stream, then the older ScriptProcessor capture path.

import workletUrl from './capture-worklet.js?url';
import { createResampler } from './resampler.js';

let hub = null;

export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

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

// Audio constraints. Desktop/Android: raw audio, because noise suppression / AGC flatten exactly
// the screams the Guardian listens for. iOS: echo cancellation + noise suppression on (the
// voice-processing path; see the note at the top). Either way speech-to-text adds its own voice
// gate and gain (companion/stt.js).
export function micConstraints(ios = isIOS()) {
  return {
    audio: ios
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  };
}

const STALL_MS = 2500; // no audio for this long = stalled
const MAX_AUTO_RECOVERIES = 8;

function createHub(file) {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const subscribers = new Set();
  if (!Ctx || (!file && !navigator.mediaDevices?.getUserMedia)) {
    const why = !globalThis.isSecureContext
      ? 'microphone needs HTTPS (or localhost)'
      : 'this browser has no Web Audio / microphone support';
    const err = Promise.reject(new Error(why));
    err.catch(() => {});
    return { refs: 1, closed: true, ready: err, source: 'none', stats: {}, level: 0, subscribe: () => () => {}, revive() {}, release() {}, close() {}, diagnostics: () => why, ctx: null };
  }

  // iOS Safari 17+: a recording session up front, so capture and the firefly's voice share one
  // audio route (the speaker, not the quiet earpiece). Harmless where unsupported.
  if (!file) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    } catch {}
  }

  // Everything up to here runs synchronously inside the tap (iOS requirement).
  const constraints = micConstraints();
  let ctx = new Ctx();
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
    streamPromise = navigator.mediaDevices.getUserMedia(constraints);
  }

  let stream = null;
  let graph = null; // { source, node, kind }
  let heartbeat = null;
  let recovering = false;
  let useScriptProcessor = false;
  const stats = {
    chunks: 0, zeroChunks: 0, level: 0, lastChunkAt: 0, lastSoundAt: 0,
    recoveries: 0, revived: 0, trackRate: null, capture: null, error: null,
  };

  // Resume whenever the context isn't running; any tap on the page also rescues it.
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
    if (document.visibilityState === 'visible') wake();
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
    // Smoothed input level (RMS, 0..1); 0 as soon as audio stops arriving.
    get level() {
      return Date.now() - stats.lastChunkAt > 600 ? 0 : stats.level;
    },
    // True when the mic was flowing and then stopped (the UI offers "tap to wake").
    get stalled() {
      return !self.closed && !file && !!stream && Date.now() - stats.lastChunkAt > STALL_MS;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // Seconds on the AudioContext clock (for latency measurements).
    now: () => ctx.currentTime,
    // Call synchronously inside a tap: a tap lets iOS start audio, so this is the strongest fix.
    revive() {
      if (self.closed || file) return;
      wake();
      if (Date.now() - stats.lastChunkAt > 1200) {
        stats.revived += 1;
        swapContext(); // a new context created inside the tap is allowed to run
        recover('revived by a tap', { newStream: true });
      }
    },
    diagnostics() {
      const t = stream?.getAudioTracks()[0];
      const gap = stats.lastChunkAt ? ((Date.now() - stats.lastChunkAt) / 1000).toFixed(1) : '—';
      return [
        `${isIOS() ? 'iOS · ' : ''}ctx ${ctx.state} ${ctx.sampleRate} Hz`,
        `track ${t ? `${t.readyState}${t.muted ? ' MUTED' : ''} ${stats.trackRate ?? '?'} Hz` : 'none'}`,
        `${stats.capture ?? '—'}`,
        `chunks ${stats.chunks} (silent ${stats.zeroChunks}), last ${gap}s ago`,
        `level ${stats.level.toFixed(3)}`,
        stats.recoveries ? `recovered ${stats.recoveries}x` : '',
        stats.revived ? `tapped ${stats.revived}x` : '',
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
      clearInterval(heartbeat);
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

  function onChunk(data) {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      sum += v * v;
      if (v > max) max = v;
      else if (-v > max) max = -v;
    }
    stats.chunks += 1;
    stats.lastChunkAt = Date.now();
    if (max === 0) stats.zeroChunks += 1;
    const rms = Math.sqrt(sum / data.length);
    stats.level = stats.level * 0.7 + rms * 0.3;
    if (rms > 0.004) stats.lastSoundAt = stats.lastChunkAt;
  }

  function teardownGraph() {
    if (!graph) return;
    try {
      if (graph.kind === 'worklet') graph.node.port.onmessage = null;
      else graph.node.onaudioprocess = null;
      graph.source.disconnect();
      graph.node.disconnect();
    } catch {}
    graph = null;
  }

  // A fresh AudioContext at the mic's own sample rate (the old one is closed). Synchronous, so
  // revive() can do it inside a tap.
  function swapContext() {
    teardownGraph();
    const old = ctx;
    try {
      ctx = stats.trackRate ? new Ctx({ sampleRate: stats.trackRate }) : new Ctx();
    } catch {
      ctx = new Ctx();
    }
    ctx.resume?.().catch(() => {});
    watchContext(ctx);
    old.close().catch(() => {});
  }

  async function buildGraph() {
    teardownGraph();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const resampler = createResampler(ctx.sampleRate);
    const deliver = (data) => {
      onChunk(data);
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
    const sink = ctx.createGain();
    sink.gain.value = 0; // keep the graph pulling without playing the mic back
    let node;
    let kind = 'worklet';
    if (!useScriptProcessor && ctx.audioWorklet && globalThis.AudioWorkletNode) {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        node = new AudioWorkletNode(ctx, 'firefly-capture');
        node.port.onmessage = ({ data }) => deliver(data);
      } catch (err) {
        console.warn('[mic] AudioWorklet unavailable, using ScriptProcessor', err);
        node = null;
      }
    }
    if (!node) {
      // Older capture path: deprecated, but very reliable on iOS Safari.
      kind = 'script';
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    source.connect(node).connect(sink).connect(ctx.destination);
    graph = { source, node, kind };
    stats.capture = `${kind === 'worklet' ? 'AudioWorklet' : 'ScriptProcessor'}`;
    stats.chunks = 0;
    stats.zeroChunks = 0;
    stats.lastChunkAt = Date.now(); // grace period before the heartbeat calls it a stall
  }

  function useStream(s) {
    stream = s;
    const track = s.getAudioTracks()[0];
    stats.trackRate = track?.getSettings?.().sampleRate ?? null;
  }

  // Get audio flowing again. Each automatic attempt escalates: fresh context → fresh mic stream
  // → ScriptProcessor capture. (A tap calls this too, via revive().)
  async function recover(why, { newStream = false } = {}) {
    if (self.closed || recovering) return;
    recovering = true;
    stats.recoveries += 1;
    console.warn(`[mic] ${why}: recovering (attempt ${stats.recoveries})`);
    try {
      if (stats.recoveries >= 3) useScriptProcessor = true;
      if (newStream || stream?.getAudioTracks().every((t) => t.readyState === 'ended')) {
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        if (self.closed) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        teardownGraph();
        stream?.getTracks().forEach((t) => t.stop());
        useStream(s);
      }
      await buildGraph();
      stats.error = null;
    } catch (err) {
      stats.error = err.message;
      console.error('[mic] recovery failed', err);
    } finally {
      recovering = false;
    }
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (self.closed || recovering || !stream) return;
      wake();
      const gap = Date.now() - stats.lastChunkAt;
      const ended = stream.getAudioTracks().every((t) => t.readyState === 'ended');
      const allSilent = stats.chunks > 40 && stats.zeroChunks === stats.chunks; // digital zeros only
      if (!(ended || gap > STALL_MS || allSilent)) return;
      if (stats.recoveries >= MAX_AUTO_RECOVERIES) return; // stop looping; a tap can still revive()
      const attempt = stats.recoveries;
      if (attempt % 2 === 0 && !ended) swapContext();
      recover(ended ? 'mic ended' : allSilent ? 'mic gives only silence' : `no audio for ${(gap / 1000).toFixed(1)}s`, {
        newStream: ended || attempt % 2 === 1,
      });
    }, 1000);
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
    if (!file) startHeartbeat();
    return self;
  })();
  self.ready.catch(() => {});
  return self;
}
