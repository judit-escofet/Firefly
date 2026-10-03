// YAMNet framing + scoring + trigger rule. Pure (no browser APIs).
//
// YAMNet's patch is 0.96 s of log-mel frames; that needs 15600 samples at 16 kHz
// (0.96 s + 25 ms STFT window − 10 ms hop). Hop is 0.48 s = 7680 samples. Feeding YAMNet one
// 15600-sample window gives exactly one patch, identical to patch i of a whole-clip run in Python.

export const WINDOW_SAMPLES = 15600;
export const HOP_SAMPLES = 7680;

// AudioSet / YAMNet class indices (see public/models/yamnet/yamnet_class_map.csv)
export const SCREAM_CLASSES = { Shout: 6, Yell: 9, Screaming: 11 };

// Collects 16 kHz samples; calls onWindow(Float32Array(15600)) every 7680 samples once full.
// Window i covers samples [7680·i, 7680·i + 15600) — same as Python's framing.
export function createWindower(onWindow) {
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
        buf.copyWithin(0, HOP_SAMPLES, len);
        len -= HOP_SAMPLES;
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

// head = {weights: number[1024], bias, threshold, fusion?} from scream_head.json.
// fusion "geomean_yamnet": score = sqrt(sigmoid(w·e + b) × YAMNet scream score) — the classifier
// only fires when YAMNet also hears something scream-like. Same as head_score() in ml/common.py.
export function headScore(head, embedding, yamnetScore) {
  let z = head.bias;
  for (let i = 0; i < head.weights.length; i++) z += head.weights[i] * embedding[i];
  const p = 1 / (1 + Math.exp(-z));
  return head.fusion === 'geomean_yamnet' ? Math.sqrt(p * yamnetScore) : p;
}

export function validateHead(head) {
  if (!head || !Array.isArray(head.weights) || head.weights.length !== 1024) throw new Error('weights must be 1024 numbers');
  if (!Number.isFinite(head.bias)) throw new Error('bias missing');
  if (!Number.isFinite(head.threshold)) throw new Error('threshold missing');
  if (head.fusion !== undefined && head.fusion !== 'geomean_yamnet') throw new Error(`unknown fusion "${head.fusion}"`);
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
