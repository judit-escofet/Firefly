// Scream detector (browser): mic → AudioWorklet → 16 kHz → 0.96 s windows / 0.48 s hop → YAMNet
// → score (trained head, or YAMNet-only fallback) → "2 of last 3 ≥ threshold" rule.
// Audio stays in memory; the clip buffer is fed from the same 16 kHz stream.

import workletUrl from './capture-worklet.js?url';
import { createResampler } from './resampler.js';
import { createWindower, createTriggerRule, yamnetOnlyScore, headScore, validateHead, HOP_SAMPLES } from './windows.js';
import { loadYamnetFastest } from './backend.js';
import { beginMicSession } from './micSession.js';

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

// session: from beginMicSession(), created synchronously in the user's tap (required on iOS).
// onScore({ts, score, yamnetScore, triggered, ms}); onTrigger({confidence, detail}); onAudio(Float32Array 16k)
export async function startScreamDetector({ session, onScore, onTrigger, onAudio, useHead = true, headUrl, yamnetUrl, onStatus } = {}) {
  session ??= beginMicSession(); // fine on desktop; on iOS pass one opened inside the tap
  const { ctx } = session;
  if (!ctx) await session.stream; // throws the reason (no HTTPS / no Web Audio)
  let yamnet, head, stream;
  try {
    onStatus?.('loading model + waiting for microphone permission');
    [yamnet, head, stream] = await Promise.all([
      loadYamnetFastest({ url: yamnetUrl, onStatus }),
      useHead ? loadHead(headUrl) : null,
      session.stream,
    ]);
  } catch (err) {
    if (err?.name === 'NotAllowedError') err = new Error('microphone permission denied: allow the mic for this site, then reload');
    await ctx.close().catch(() => {});
    session.stream.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    throw err;
  }
  const threshold = thresholdOverride() ?? head?.threshold ?? YAMNET_ONLY_THRESHOLD;
  const k = head?.rule_k ?? 2;
  const n = head?.rule_n ?? 3;
  const hop = head?.hop_samples ?? HOP_SAMPLES;
  const rule = createTriggerRule({ threshold, k, n });
  const recent = [];

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
      const score = head ? headScore(head, embedding, yScore, classScores) : yScore;
      const r = rule.push(score);
      stats.windows++;
      stats.lastMs = ms;
      stats.msMax = Math.max(stats.msMax, ms);
      stats.msAvg += (ms - stats.msAvg) / Math.min(stats.windows, 50);
      recent.push(score >= rule.threshold);
      if (recent.length > n + 1) recent.shift();
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

  const windower = createWindower(run, hop);
  node.port.onmessage = ({ data }) => {
    const x16 = resampler.push(data);
    onAudio?.(x16);
    windower.push(x16);
  };

  return {
    mode: head ? 'classifier' : 'yamnet-only',
    backend: yamnet.backend,
    backendNote: yamnet.backendNote,
    audioTime: () => ctx.currentTime, // seconds on the AudioContext clock (for latency tests)
    get contextState() {
      return ctx.state; // 'suspended' on iOS if the session wasn't opened inside a tap
    },
    nativeRate: ctx.sampleRate,
    rule,
    hopSeconds: hop / 16000,
    stats,
    numTensors: yamnet.numTensors,
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      await ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
