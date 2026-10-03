// Streaming windowed-sinc resampler (any rate → 16 kHz). Mirrored exactly by ml/resample.py so
// the browser and Python feed YAMNet the same samples. Keep the two in sync!
//
// Output sample n sits at input position p = n * inRate / outRate.
//   y[n] = Σ_k x[k] · h(p − k),  k ∈ [ceil(p − L), floor(p + L)],  x[k] = 0 for k < 0
//   h(t) = fc · sinc(fc · t) · hann(t / L),  fc = 0.9 · min(1, outRate / inRate),  L = ZEROS / fc
// If inRate === outRate the signal passes through unchanged.

export const TARGET_RATE = 16000;
const ZEROS = 8; // zero crossings of the sinc on each side

export function kernelParams(inRate, outRate = TARGET_RATE) {
  const fc = 0.9 * Math.min(1, outRate / inRate);
  return { fc, L: ZEROS / fc, step: inRate / outRate };
}

function h(t, fc, L) {
  if (Math.abs(t) >= L) return 0;
  const x = fc * t;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return fc * sinc * 0.5 * (1 + Math.cos((Math.PI * t) / L));
}

export function createResampler(inRate, outRate = TARGET_RATE) {
  const passthrough = inRate === outRate;
  const { fc, L } = kernelParams(inRate, outRate);
  let buf = new Float64Array(0); // input samples from absolute index `bufStart`
  let bufStart = 0;
  let total = 0; // input samples seen
  let n = 0; // next output index

  return {
    // Push input samples (Float32Array); returns the output samples now computable.
    push(input) {
      if (passthrough) return Float32Array.from(input);
      const merged = new Float64Array(buf.length + input.length);
      merged.set(buf);
      merged.set(input, buf.length);
      buf = merged;
      total += input.length;

      const out = [];
      for (;;) {
        const p = (n * inRate) / outRate;
        const kHi = Math.floor(p + L);
        if (kHi >= total) break;
        let acc = 0;
        for (let k = Math.max(0, Math.ceil(p - L)); k <= kHi; k++) acc += buf[k - bufStart] * h(p - k, fc, L);
        out.push(acc);
        n++;
      }
      // Drop input no future output needs.
      const need = Math.max(0, Math.ceil((n * inRate) / outRate - L));
      if (need > bufStart) {
        buf = buf.slice(need - bufStart);
        bufStart = need;
      }
      return Float32Array.from(out);
    },
  };
}

// Whole-signal convenience (tests, parity script).
export function resample(input, inRate, outRate = TARGET_RATE) {
  return createResampler(inRate, outRate).push(input);
}
