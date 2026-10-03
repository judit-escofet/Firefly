// YAMNet (TF.js) loader + per-window inference.
// Model: google/yamnet tfjs v1 (TF Hub → Kaggle Models), vendored under public/models/yamnet/ so the
// phone doesn't depend on Kaggle's signed redirect URLs. Original source:
//   https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1  (→ kaggle.com/models/google/yamnet/tfJs/tfjs/1)
// Input: 1-D float32 waveform, 16 kHz mono, [-1, 1]. Outputs: scores [N,521], embeddings [N,1024],
// log-mel spectrogram. With a 15600-sample input N = 1.

import * as tf from '@tensorflow/tfjs';

export const YAMNET_URL = '/models/yamnet/model.json';

export async function loadYamnet({ url = YAMNET_URL, model: preloaded, backend } = {}) {
  if (backend) await tf.setBackend(backend).catch(() => false);
  await tf.ready();
  const model = preloaded ?? (await tf.loadGraphModel(url));
  const [scoresName, embName] = model.outputs.map((o) => o.name).filter((_, i) => i < 2);

  async function infer(window) {
    const t0 = performance.now();
    const input = tf.tensor1d(window);
    const [scores, embeddings] = model.execute(input, [scoresName, embName]);
    const [s, e] = await Promise.all([scores.data(), embeddings.data()]);
    input.dispose();
    scores.dispose();
    embeddings.dispose();
    // One patch per 15600-sample window; if ever more, average like YAMNet's own clip scoring.
    const rows = s.length / 521;
    const classScores = rows === 1 ? s : averageRows(s, 521);
    const embedding = rows === 1 ? e : averageRows(e, 1024);
    return { classScores, embedding, ms: performance.now() - t0 };
  }

  // First run compiles WebGL shaders (slow); do it before the walk starts.
  await infer(new Float32Array(15600));

  return { infer, backend: tf.getBackend(), model, numTensors: () => tf.memory().numTensors };
}

function averageRows(flat, width) {
  const rows = flat.length / width;
  const out = new Float32Array(width);
  for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) out[c] += flat[r * width + c] / rows;
  return out;
}
