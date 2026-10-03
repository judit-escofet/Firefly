"""Browser ⇄ Python parity check, step 1 (Python side).

Writes app/public/parity/clip.wav (at its native rate, so the JS resampler is exercised too) and
app/public/parity/python_embeddings.json. Then compare with either:
  cd app && npm run parity                       (Node, TF.js CPU backend)
  guardian-test.html → "Parity check vs Python"  (phone/laptop browser, WebGL)

  python ml/parity.py                     # synthetic 44.1 kHz test clip (chirp + noise + bursts)
  python ml/parity.py --clip some.wav     # or any clip (converted to 16-bit WAV at its native rate)
"""
import argparse
import json

import numpy as np
import soundfile as sf

from common import ROOT, head_score, load_audio, run_yamnet, to_16k, yamnet_only_score

OUT = ROOT.parent / "app" / "public" / "parity"


def synthetic(sr=44100, seconds=4.0, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sr * seconds)) / sr
    chirp = 0.3 * np.sin(2 * np.pi * (300 * t + 400 * t**2))
    bursts = 0.4 * np.sin(2 * np.pi * 2500 * t) * (np.sin(2 * np.pi * 1.5 * t) > 0.6)
    return (chirp + bursts + 0.05 * rng.standard_normal(len(t))).astype(np.float32), sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip")
    args = ap.parse_args()
    x, sr = load_audio(args.clip) if args.clip else synthetic()
    OUT.mkdir(parents=True, exist_ok=True)
    wav = OUT / "clip.wav"
    sf.write(wav, np.clip(x, -1, 1), sr, subtype="PCM_16")
    x, sr = load_audio(wav)  # read back the 16-bit version: that's what the browser sees
    scores, emb = run_yamnet(to_16k(x, sr))
    yam = yamnet_only_score(scores)
    head_path = ROOT.parent / "app/public/models/scream_head.json"
    head_scores = head_score(json.load(open(head_path)), emb, yam).round(6).tolist() if head_path.exists() else None
    json.dump(
        {"source": args.clip or "synthetic", "sample_rate": sr, "windows": len(emb),
         "yamnet_only_scores": yam.round(6).tolist(), "head_scores": head_scores,
         "embeddings": emb.round(7).tolist()},
        open(OUT / "python_embeddings.json", "w"),
    )
    print(f"wrote {wav} ({sr} Hz, {len(x) / sr:.2f} s) and python_embeddings.json ({len(emb)} windows)")


if __name__ == "__main__":
    main()
