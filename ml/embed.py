"""Extract YAMNet embeddings for every clip in ml/data/positive and ml/data/negative.

  python ml/embed.py --in ml/data --out ml/embeddings.npz

Each clip is resampled to 16 kHz with the browser's exact resampler, padded with 0.48 s of
silence on both sides (so a 1 s scream still spans ≥ 3 windows, like in a live stream), and cut
into the browser's 0.96 s / 0.48 s windows. Saved per window: embedding, YAMNet-only score, RMS,
and the clip it came from. Splitting happens later, by clip group, in train.py.
"""
import argparse
import csv
import time
from pathlib import Path

import numpy as np

from common import HOP, ROOT, WINDOW, list_audio, load_audio, run_yamnet, to_16k, yamnet_only_score

PAD = HOP  # 0.48 s of silence each side


def window_rms(x16, n):
    return np.array([np.sqrt(np.mean(x16[i * HOP : i * HOP + WINDOW] ** 2)) for i in range(n)], dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(ROOT / "data"))
    ap.add_argument("--out", default=str(ROOT / "embeddings.npz"))
    args = ap.parse_args()
    data = Path(args.inp)

    meta = {}
    attr = data / "ATTRIBUTION.csv"
    if attr.exists():
        for r in csv.DictReader(open(attr)):
            meta[str((ROOT / r["file"]).resolve())] = r

    clips = [(p, 1) for p in list_audio(data / "positive")] + [(p, 0) for p in list_audio(data / "negative")]
    if not clips:
        raise SystemExit(f"no audio under {data}/positive or {data}/negative")
    print(f"{sum(l for _, l in clips)} positive and {sum(1 - l for _, l in clips)} negative clips")

    X, ys, yam, rms, clip_idx, win_idx = [], [], [], [], [], []
    clip_path, clip_label, clip_group, clip_category, clip_seconds = [], [], [], [], []
    t0 = time.time()
    for ci, (path, label) in enumerate(clips):
        try:
            x, sr = load_audio(path)
        except Exception as err:
            print(f"  skip {path}: {err}")
            continue
        x16 = to_16k(x, sr)
        x16 = np.concatenate([np.zeros(PAD, np.float32), x16, np.zeros(PAD, np.float32)])
        scores, emb = run_yamnet(x16)
        n = len(emb)
        m = meta.get(str(path.resolve()), {})
        k = len(clip_path)
        rel = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
        clip_path.append(rel)
        clip_label.append(label)
        # Group = who/what the recording came from, so near-duplicates never straddle train/test.
        # Team recordings: a subfolder (e.g. team/anna-session1/) is one group, else each file is.
        own = f"dir:{path.parent.relative_to(ROOT)}" if path.parent.name != "team" else f"file:{rel}"
        clip_group.append(m.get("group") or own)
        clip_category.append(m.get("category") or ("team_positive" if label else "team_negative"))
        clip_seconds.append(len(x) / sr)
        X.append(emb.astype(np.float32))
        yam.append(yamnet_only_score(scores).astype(np.float32))
        rms.append(window_rms(x16, n))
        ys.append(np.full(n, label, np.int8))
        clip_idx.append(np.full(n, k, np.int32))
        win_idx.append(np.arange(n, dtype=np.int32))
        if (ci + 1) % 250 == 0:
            print(f"  {ci + 1}/{len(clips)} clips, {time.time() - t0:.0f} s")

    np.savez_compressed(
        args.out,
        X=np.concatenate(X), y=np.concatenate(ys), yamnet_score=np.concatenate(yam), rms=np.concatenate(rms),
        clip=np.concatenate(clip_idx), window=np.concatenate(win_idx),
        clip_path=np.array(clip_path), clip_label=np.array(clip_label, np.int8), clip_group=np.array(clip_group),
        clip_category=np.array(clip_category), clip_seconds=np.array(clip_seconds, np.float32),
    )
    n_win = sum(len(a) for a in X)
    print(f"wrote {args.out}: {len(clip_path)} clips, {n_win} windows ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
