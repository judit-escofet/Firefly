// Scream detector (browser): shared mic (src/audio/micHub.js, 16 kHz) → 0.96 s windows every
// 0.24 s → YAMNet → score (trained head, or YAMNet-only fallback) → "2 of last 3 ≥ threshold".
// Audio stays in memory; the clip buffer is fed from the same 16 kHz stream.

import { createWindower, createTriggerRule, yamnetOnlyScore, headScore, validateHead, HOP_SAMPLES } from './windows.js';
import { loadYamnetFastest } from './backend.js';
import { acquireMic } from '../../audio/micHub.js';

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

// Uses the shared mic hub (src/audio/micHub.js). Whoever starts listening should call
// acquireMic() synchronously inside the user's tap first (iOS); the detector then takes its own
// reference to that same hub here and releases it on stop().
// onScore({ts, score, yamnetScore, triggered, ms}); onTrigger({confidence, detail}); onAudio(Float32Array 16k)
export async function startScreamDetector({ onScore, onTrigger, onAudio, useHead = true, headUrl, yamnetUrl, onStatus } = {}) {
  const mic = acquireMic();
  let yamnet, head;
  try {
    onStatus?.('loading model + waiting for microphone permission');
    [yamnet, head] = await Promise.all([
      loadYamnetFastest({ url: yamnetUrl, onStatus }),
      useHead ? loadHead(headUrl) : null,
      mic.ready,
    ]);
  } catch (err) {
    mic.release();
    throw err;
  }
  const { ctx } = mic;
  const threshold = thresholdOverride() ?? head?.threshold ?? YAMNET_ONLY_THRESHOLD;
  const k = head?.rule_k ?? 2;
  const n = head?.rule_n ?? 3;
  const hop = head?.hop_samples ?? HOP_SAMPLES;
  const rule = createTriggerRule({ threshold, k, n });
  const recent = [];

  // Embedding history for heads with context: window i's grid-mates are i−step, i−2·step…
  const step = Math.round(HOP_SAMPLES / hop); // 2 at the 0.24 s hop
  const history = [];
  const prevFor = () => {
    const out = [];
    for (let k = 1; k <= (head?.context ?? 0); k++) {
      const j = history.length - 1 - k * step;
      // clamp to the earliest window of the same grid
      out.push(history[j >= 0 ? j : (history.length - 1) % step] ?? history[0]);
    }
    return out;
  };
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
      history.push(Float32Array.from(embedding));
      if (history.length > 4 * step + 1) history.shift();
      const score = head ? headScore(head, embedding, yScore, classScores, prevFor()) : yScore;
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
  const unsubscribe = mic.subscribe((x16) => {
    onAudio?.(x16);
    windower.push(x16);
  });

  return {
    mode: head ? 'classifier' : 'yamnet-only',
    backend: yamnet.backend,
    backendNote: yamnet.backendNote,
    audioTime: () => ctx.currentTime, // seconds on the AudioContext clock (for latency tests)
    get contextState() {
      return ctx.state; // 'suspended' on iOS if the session wasn't opened inside a tap
    },
    nativeRate: mic.nativeRate,
    mic,
    rule,
    hopSeconds: hop / 16000,
    stats,
    numTensors: yamnet.numTensors,
    async stop() {
      unsubscribe();
      mic.release();
    },
  };
}
