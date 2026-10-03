// Scream detector (browser): mic → AudioWorklet → 16 kHz → 0.96 s windows / 0.48 s hop → YAMNet
// → score (trained head, or YAMNet-only fallback) → "2 of last 3 ≥ threshold" rule.
// Audio stays in memory; the clip buffer is fed from the same 16 kHz stream.

import workletUrl from './capture-worklet.js?url';
import { createResampler } from './resampler.js';
import { createWindower, createTriggerRule, yamnetOnlyScore, headScore, validateHead } from './windows.js';
import { loadYamnet } from './yamnet.js';

export const HEAD_URL = '/models/scream_head.json';
export const YAMNET_ONLY_THRESHOLD = 0.5;

export async function loadHead(url = HEAD_URL) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return validateHead(await res.json());
  } catch (err) {
    console.warn(`[guardian] scream_head.json unavailable (${err.message}); falling back to YAMNet-only score`);
    return null;
  }
}

function thresholdOverride() {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('threshold');
  let stored = null;
  try {
    stored = localStorage.getItem('firefly.scream_threshold');
  } catch {}
  const v = parseFloat(q ?? stored);
  return Number.isFinite(v) ? v : null;
}

// onScore({ts, score, yamnetScore, triggered, ms}); onTrigger({confidence, detail}); onAudio(Float32Array 16k)
export async function startScreamDetector({ stream, onScore, onTrigger, onAudio, useHead = true, headUrl, yamnetUrl } = {}) {
  const [yamnet, head] = await Promise.all([loadYamnet({ url: yamnetUrl }), useHead ? loadHead(headUrl) : null]);
  const threshold = thresholdOverride() ?? head?.threshold ?? YAMNET_ONLY_THRESHOLD;
  const rule = createTriggerRule({ threshold, k: 2, n: 3 });
  const recent = [];

  const ownStream = !stream;
  stream ??= await navigator.mediaDevices.getUserMedia({
    // Raw-ish audio: noise suppression / AGC would flatten exactly the screams we want to hear.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'firefly-capture');
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph pulling without playing the mic back
  source.connect(node).connect(sink).connect(ctx.destination);

  const resampler = createResampler(ctx.sampleRate);
  let busy = false;
  let queued = null; // if inference falls behind, keep only the newest window
  const stats = { windows: 0, dropped: 0, msAvg: 0, msMax: 0, lastMs: 0 };

  async function run(window) {
    if (busy) {
      if (queued) stats.dropped++;
      queued = window;
      return;
    }
    busy = true;
    try {
      const { classScores, embedding, ms } = await yamnet.infer(window);
      const yScore = yamnetOnlyScore(classScores);
      const score = head ? headScore(head, embedding, yScore) : yScore;
      const r = rule.push(score);
      stats.windows++;
      stats.lastMs = ms;
      stats.msMax = Math.max(stats.msMax, ms);
      stats.msAvg += (ms - stats.msAvg) / Math.min(stats.windows, 50);
      recent.push(score >= rule.threshold);
      if (recent.length > 4) recent.shift();
      onScore?.({ ts: new Date().toISOString(), score, yamnetScore: yScore, triggered: r.triggered, ms, classScores });
      if (r.triggered) {
        onTrigger?.({
          confidence: Number(score.toFixed(3)),
          detail: `${recent.filter(Boolean).length} of last ${recent.length} windows ≥ ${rule.threshold.toFixed(2)} (${head ? 'classifier' : 'yamnet-only'})`,
        });
      }
    } catch (err) {
      console.error('[guardian] inference failed', err);
    } finally {
      busy = false;
      if (queued) {
        const next = queued;
        queued = null;
        run(next);
      }
    }
  }

  const windower = createWindower(run);
  node.port.onmessage = ({ data }) => {
    const x16 = resampler.push(data);
    onAudio?.(x16);
    windower.push(x16);
  };

  return {
    mode: head ? 'classifier' : 'yamnet-only',
    backend: yamnet.backend,
    nativeRate: ctx.sampleRate,
    rule,
    stats,
    numTensors: yamnet.numTensors,
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      await ctx.close().catch(() => {});
      if (ownStream) stream.getTracks().forEach((t) => t.stop());
    },
  };
}
