// Browser-only: load YAMNet on the fastest TF.js backend this phone supports.
//
// Candidates: WASM (SIMD where available; ~7 ms/window on a laptop, very consistent on phones)
// and WebGL (GPU). WebGL is skipped when the GPU can't render 32-bit floats (some older iPhones),
// because half-precision drifts from the scores the classifier was trained on. Each candidate
// loads the model and times a few windows; the fastest wins. Override with ?backend=wasm|webgl|cpu.

import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreaded from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import { loadYamnet } from './yamnet.js';

setWasmPaths({
  'tfjs-backend-wasm.wasm': wasmPlain,
  'tfjs-backend-wasm-simd.wasm': wasmSimd,
  'tfjs-backend-wasm-threaded-simd.wasm': wasmThreaded,
});

function override() {
  const b = new URLSearchParams(globalThis.location?.search ?? '').get('backend');
  return ['wasm', 'webgl', 'cpu'].includes(b) ? b : null;
}

async function usable(name) {
  try {
    if (!(await tf.setBackend(name))) return false;
    await tf.ready();
    if (name === 'webgl' && !tf.env().getBool('WEBGL_RENDER_FLOAT32_CAPABLE')) return false;
    return true;
  } catch {
    return false;
  }
}

async function timeIt(y, n = 4) {
  const x = new Float32Array(15600).map((_, i) => 0.1 * Math.sin(i / 7));
  const ms = [];
  for (let i = 0; i < n; i++) ms.push((await y.infer(x)).ms);
  return ms.sort((a, b) => a - b)[Math.floor(n / 2)];
}

export async function loadYamnetFastest({ url, onStatus } = {}) {
  const forced = override();
  const candidates = forced ? [forced] : ['wasm', 'webgl'];
  const tried = [];
  let best = null;
  for (const name of candidates) {
    onStatus?.(`loading YAMNet on ${name}…`);
    if (!(await usable(name))) {
      tried.push(`${name}: unavailable`);
      continue;
    }
    try {
      const y = await loadYamnet({ url });
      const ms = await timeIt(y);
      tried.push(`${name}: ${ms.toFixed(0)} ms`);
      if (!best || ms < best.ms) {
        best?.y.model.dispose();
        best = { name, y, ms };
      } else {
        y.model.dispose();
      }
    } catch (err) {
      tried.push(`${name}: failed (${err.message})`);
    }
  }
  if (!best) {
    // Last resort: plain JS. Slow (~130 ms/window) but correct.
    await tf.setBackend('cpu');
    const y = await loadYamnet({ url });
    best = { name: 'cpu', y, ms: await timeIt(y, 2) };
    tried.push(`cpu: ${best.ms.toFixed(0)} ms`);
  }
  await tf.setBackend(best.name); // the winner's weights live on its backend
  best.y.backend = best.name;
  best.y.backendNote = tried.join(' · ');
  console.info(`[guardian] YAMNet backend ${best.name} (${best.y.backendNote})`);
  return best.y;
}
