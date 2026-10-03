// Browser ⇄ Python YAMNet parity: same WAV in, same resampling + framing, compare embeddings.
// Used by guardian-test.html (WebGL) and scripts/parity.mjs (Node, CPU).

import { resample } from './resampler.js';
import { frameSignal, yamnetOnlyScore, headScore } from './windows.js';

// Minimal PCM WAV reader (16-bit int or 32-bit float, any channels → mono float32).
export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let o = 12;
  while (o + 8 <= v.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = o + 8 + (i * fmt.channels + c) * bytes;
          acc += fmt.format === 3 ? v.getFloat32(p, true) : fmt.bits === 16 ? v.getInt16(p, true) / 32768 : NaN;
        }
        out[i] = acc / fmt.channels;
      }
      if (Number.isNaN(out[0])) throw new Error(`unsupported WAV: format ${fmt.format}, ${fmt.bits}-bit`);
      return { samples: out, sampleRate: fmt.rate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

// → {embeddings, yamnetScores, headScores} for every window, exactly as the live detector scores them.
export async function embedClip(infer, samples, sampleRate, head = null) {
  const frames = frameSignal(resample(samples, sampleRate));
  const out = { embeddings: [], yamnetScores: [], headScores: [] };
  for (const f of frames) {
    const { embedding, classScores } = await infer(f);
    const y = yamnetOnlyScore(classScores);
    const n = out.embeddings.length;
    const prev = Array.from({ length: head?.context ?? 0 }, (_, k) => out.embeddings[Math.max(0, n - 1 - k)] ?? Array.from(embedding));
    out.embeddings.push(Array.from(embedding));
    out.yamnetScores.push(y);
    out.headScores.push(head ? headScore(head, embedding, y, classScores, prev) : null);
  }
  return out;
}

export function maxAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.some((v) => v == null) || b.some((v) => v == null)) return null;
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}

export function compareEmbeddings(js, py) {
  const n = Math.min(js.length, py.length);
  let maxAbs = 0;
  let minCos = 1;
  for (let i = 0; i < n; i++) {
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < js[i].length; k++) {
      maxAbs = Math.max(maxAbs, Math.abs(js[i][k] - py[i][k]));
      dot += js[i][k] * py[i][k];
      na += js[i][k] ** 2;
      nb += py[i][k] ** 2;
    }
    minCos = Math.min(minCos, dot / (Math.sqrt(na * nb) || 1));
  }
  return { windowsJs: js.length, windowsPy: py.length, maxAbsDiff: maxAbs, minCosine: minCos, pass: js.length === py.length && minCos > 0.999 };
}
