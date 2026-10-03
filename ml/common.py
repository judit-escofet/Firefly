"""Shared helpers for the Guardian ML pipeline: audio loading, YAMNet, framing, scoring rule.

Framing matches the browser exactly (app/src/guardian/audio/windows.js):
  16 kHz mono (ml/resample.py == resampler.js), windows of 15600 samples (0.96 s patch +
  STFT edge) every 7680 samples (0.48 s). Clips shorter than one window are zero-padded.
YAMNet patch i of a whole-clip run covers samples [7680 i, 7680 i + 15600), so running the
whole clip once and keeping the full windows is identical to the browser's per-window runs.
"""
import os
from pathlib import Path

import numpy as np

from resample import TARGET_RATE, resample

WINDOW = 15600
HOP = 7680
SCREAM_CLASSES = {"Shout": 6, "Yell": 9, "Screaming": 11}
YAMNET_HUB_URL = "https://tfhub.dev/google/yamnet/1"  # → kaggle.com/models/google/yamnet/tensorFlow2/yamnet/1
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm", ".aiff", ".aif"}

ROOT = Path(__file__).resolve().parent


def list_audio(folder):
    folder = Path(folder)
    return sorted(p for p in folder.rglob("*") if p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("."))


def load_audio(path):
    """→ (mono float32 at native rate, native rate). wav/flac/ogg via soundfile; others via ffmpeg."""
    import soundfile as sf

    path = str(path)
    try:
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        return x.mean(axis=1), sr
    except Exception:
        import subprocess

        sr = 48000
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
            check=True, capture_output=True,
        ).stdout
        return np.frombuffer(raw, dtype=np.float32).copy(), sr


def to_16k(x, sr):
    return resample(x, sr, TARGET_RATE)


def num_windows(n_samples):
    return 1 if n_samples < WINDOW else (n_samples - WINDOW) // HOP + 1


_model = None


def yamnet():
    global _model
    if _model is None:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        import tensorflow_hub as hub

        _model = hub.load(YAMNET_HUB_URL)
    return _model


def run_yamnet(x16):
    """16 kHz waveform → (class scores [n,521], embeddings [n,1024]) for the browser's windows."""
    import tensorflow as tf

    x16 = np.asarray(x16, dtype=np.float32)
    if len(x16) < WINDOW:
        x16 = np.pad(x16, (0, WINDOW - len(x16)))
    n = num_windows(len(x16))
    scores, emb, _ = yamnet()(tf.constant(x16))
    scores, emb = scores.numpy()[:n], emb.numpy()[:n]
    assert len(emb) == n, f"YAMNet returned {len(emb)} patches, expected {n}"
    return scores, emb


def yamnet_only_score(scores):
    return scores[:, list(SCREAM_CLASSES.values())].max(axis=1)


# Negative categories that genuinely sound like screaming (crowds, cheering, playful screams…).
# Reported separately from walk-like sounds (traffic, footsteps, speech, weather…).
HARD_CATEGORIES = {
    "playful_scream", "Cheering", "Crowd", "Laughter", "Giggle", "Chuckle_and_chortle", "Screech", "Crying_and_sobbing",
    "Gasp", "Applause", "Chatter", "esc50:laughing", "esc50:crying_baby", "esc50:fireworks",
}


def logit_scores(scores):
    """Class-score features: log-odds of all 521 YAMNet scores, clipped to [1e-4, 1 − 1e-4]."""
    p = np.clip(np.asarray(scores, dtype=np.float64), 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def head_score(head, emb, yam=None, scores=None):
    """Same as headScore() in app/src/guardian/audio/windows.js.
    features "embedding+logit_scores": w has 1024 + 521 entries (embedding, then class log-odds).
    fusion "geomean_yamnet": sqrt(sigmoid(w·x + b) × YAMNet scream score).
    model_type "mlp": multi-layer perceptron with ReLU hidden layers."""
    x = emb if head.get("features", "embedding") == "embedding" else np.hstack([emb, logit_scores(scores)])
    if head.get("model_type") == "mlp":
        # MLP: iterate through layers
        for layer in head["layers"]:
            w = np.asarray(layer["weights"], dtype=np.float64).reshape(layer["out_features"], layer["in_features"])
            b = np.asarray(layer["bias"], dtype=np.float64)
            x = x @ w.T + b
            if layer.get("activation") == "relu":
                x = np.maximum(0, x)
        z = x if np.ndim(x) == 0 else x[..., 0] if x.shape[-1] == 1 else x
    else:
        # Linear (logistic regression): w·x + b
        w = np.asarray(head["weights"], dtype=np.float64)
        z = x @ w + head["bias"]
    p = 1 / (1 + np.exp(-np.clip(z, -500, 500)))
    if head.get("fusion") == "geomean_yamnet":
        if yam is None:
            raise ValueError("this head fuses the YAMNet scream score; pass yam")
        p = np.sqrt(p * np.asarray(yam, dtype=np.float64))
    return p


def count_triggers(scores, threshold, k=2, n=3):
    """Same rule as createTriggerRule in windows.js: k of last n ≥ threshold, history clears on trigger."""
    hist, fired = [], []
    for i, s in enumerate(scores):
        hist.append(s >= threshold)
        if len(hist) > n:
            hist.pop(0)
        if sum(hist) >= k:
            fired.append(i)
            hist = []
    return fired
