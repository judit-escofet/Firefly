// YAMNet framing + scoring + trigger rule. Pure (no browser APIs).
//
// YAMNet's patch is 0.96 s of log-mel frames; that needs 15600 samples at 16 kHz
// (0.96 s + 25 ms STFT window − 10 ms hop). Hop is 0.48 s = 7680 samples. Feeding YAMNet one
// 15600-sample window gives exactly one patch, identical to patch i of a whole-clip run in Python.

export const WINDOW_SAMPLES = 15600;
export const HOP_SAMPLES = 7680;

// AudioSet / YAMNet class indices (see public/models/yamnet/yamnet_class_map.csv)
export const SCREAM_CLASSES = { Shout: 6, Yell: 9, Screaming: 11 };

// Collects 16 kHz samples; calls onWindow(Float32Array(15600)) every `hop` samples once full.
// Window i covers samples [hop·i, hop·i + 15600) — same as Python's framing. The trained head
// can ask for a smaller hop (hop_samples in scream_head.json) for faster, steadier detection.
export function createWindower(onWindow, hop = HOP_SAMPLES) {
  let buf = new Float32Array(WINDOW_SAMPLES * 2);
  let len = 0;
  return {
    push(samples) {
      if (len + samples.length > buf.length) {
        const bigger = new Float32Array(Math.max(buf.length * 2, len + samples.length));
        bigger.set(buf.subarray(0, len));
        buf = bigger;
      }
      buf.set(samples, len);
      len += samples.length;
      while (len >= WINDOW_SAMPLES) {
        onWindow(buf.slice(0, WINDOW_SAMPLES));
        buf.copyWithin(0, hop, len);
        len -= hop;
      }
    },
  };
}

// Frame a whole 16 kHz signal (tests + parity). Short clips are zero-padded to one window.
export function frameSignal(signal) {
  const frames = [];
  createWindower((w) => frames.push(w)).push(
    signal.length >= WINDOW_SAMPLES ? signal : Float32Array.from({ length: WINDOW_SAMPLES }, (_, i) => signal[i] ?? 0),
  );
  return frames;
}

export function yamnetOnlyScore(classScores) {
  return Math.max(classScores[SCREAM_CLASSES.Shout], classScores[SCREAM_CLASSES.Yell], classScores[SCREAM_CLASSES.Screaming]);
}

// head = {weights, bias, threshold, features?, fusion?, hop_samples?, rule_k?, rule_n?} from
// scream_head.json. Same as head_score() in ml/common.py.
// features "embedding+logit_scores": weights = 1024 for the embedding, then 521 for the
//   log-odds of every YAMNet class score (clipped to [1e-4, 1 − 1e-4]), so the head can learn
//   "screaming but also cheering/laughing → not distress".
// fusion "geomean_yamnet": score = sqrt(sigmoid(w·x + b) × YAMNet scream score) — the classifier
//   only fires when YAMNet also hears something scream-like.
export function headScore(head, embedding, yamnetScore, classScores) {
  if (head.model_type === 'mlp') {
    // Build input vector: embedding, optionally with logit_scores appended
    let x = new Float64Array(embedding.length + (head.features === 'embedding+logit_scores' ? 521 : 0));
    for (let i = 0; i < 1024; i++) x[i] = embedding[i];
    if (head.features === 'embedding+logit_scores') {
      for (let j = 0; j < 521; j++) {
        const p = Math.min(1 - 1e-4, Math.max(1e-4, classScores[j]));
        x[1024 + j] = Math.log(p / (1 - p));
      }
    }
    // Forward pass through each layer
    for (const layer of head.layers) {
      const out = new Float64Array(layer.out_features);
      for (let j = 0; j < layer.out_features; j++) {
        let z = layer.bias[j];
        const rowOffset = j * layer.in_features;
        for (let i = 0; i < layer.in_features; i++) z += layer.weights[rowOffset + i] * x[i];
        out[j] = layer.activation === 'relu' ? Math.max(0, z) : z;
      }
      x = out;
    }
    const p = 1 / (1 + Math.exp(-x[0]));
    return head.fusion === 'geomean_yamnet' ? Math.sqrt(p * yamnetScore) : p;
  }
  let z = head.bias;
  for (let i = 0; i < 1024; i++) z += head.weights[i] * embedding[i];
  if (head.features === 'embedding+logit_scores') {
    for (let j = 0; j < 521; j++) {
      const p = Math.min(1 - 1e-4, Math.max(1e-4, classScores[j]));
      z += head.weights[1024 + j] * Math.log(p / (1 - p));
    }
  }
  const p = 1 / (1 + Math.exp(-z));
  return head.fusion === 'geomean_yamnet' ? Math.sqrt(p * yamnetScore) : p;
}

export function validateHead(head) {
  if (!head) throw new Error('head is required');
  if (head?.features !== undefined && !['embedding', 'embedding+logit_scores'].includes(head.features)) throw new Error(`unknown features "${head.features}"`);
  if (head.model_type === 'mlp') {
    if (!Array.isArray(head.layers) || head.layers.length < 1) throw new Error('mlp head must have at least one layer');
    for (let l = 0; l < head.layers.length; l++) {
      const layer = head.layers[l];
      if (!Number.isInteger(layer.in_features) || !Number.isInteger(layer.out_features))
        throw new Error(`layer ${l}: in_features and out_features must be integers`);
      if (!Array.isArray(layer.weights) || layer.weights.length !== layer.in_features * layer.out_features)
        throw new Error(`layer ${l}: weights must be ${layer.in_features * layer.out_features} numbers`);
      if (!Array.isArray(layer.bias) || layer.bias.length !== layer.out_features)
        throw new Error(`layer ${l}: bias must be ${layer.out_features} numbers`);
    }
  } else {
    const nWeights = head?.features === 'embedding+logit_scores' ? 1024 + 521 : 1024;
    if (!Array.isArray(head.weights) || head.weights.length !== nWeights) throw new Error(`weights must be ${nWeights} numbers`);
    if (!Number.isFinite(head.bias)) throw new Error('bias missing');
  }
  if (!Number.isFinite(head.threshold)) throw new Error('threshold missing');
  if (head.fusion !== undefined && head.fusion !== 'geomean_yamnet') throw new Error(`unknown fusion "${head.fusion}"`);
  if (head.hop_samples !== undefined && !(Number.isInteger(head.hop_samples) && head.hop_samples >= 1600 && head.hop_samples <= HOP_SAMPLES))
    throw new Error('hop_samples must be an integer between 1600 and 7680');
  if (head.rule_k !== undefined && !(head.rule_k >= 1 && head.rule_n >= head.rule_k)) throw new Error('bad rule_k / rule_n');
  return head;
}

// "k of the last n windows ≥ threshold". After a trigger the history clears, so one scream
// produces one danger.signal (the state machine ignores repeats anyway).
export function createTriggerRule({ threshold = 0.5, k = 2, n = 3 } = {}) {
  let history = [];
  return {
    get threshold() {
      return threshold;
    },
    set threshold(t) {
      threshold = t;
    },
    push(score) {
      history.push(score >= threshold);
      if (history.length > n) history.shift();
      const hits = history.filter(Boolean).length;
      if (hits >= k) {
        history = [];
        return { triggered: true, hits, of: n };
      }
      return { triggered: false, hits, of: n };
    },
    reset() {
      history = [];
    },
  };
}
