"""Extract YAMNet embeddings for every clip in ml/data/positive and ml/data/negative.

  python ml/embed.py --in ml/data --out ml/embeddings.npz

Each clip is resampled to 16 kHz with the browser's exact resampler, padded with 0.48 s of
silence on both sides (so a 1 s scream still spans ≥ 3 windows, like in a live stream), and cut
into the browser's 0.96 s / 0.48 s windows. Saved per window: embedding, all 521 YAMNet class
scores, YAMNet-only score, RMS, and the clip it came from. Splitting happens later, by clip
group, in train.py.

--augment K adds K noisy copies of every positive clip: the scream at a random distance-like
gain, mixed with everyday outdoor noise (ESC-50 fold 1: rain, wind, traffic, footsteps…) at
-5…20 dB SNR. Copies keep their source clip's group and are only ever used for training.
"""
import argparse
import csv
import time
from pathlib import Path

import numpy as np

from common import HOP, ROOT, WINDOW, list_audio, load_audio, run_yamnet, to_16k, yamnet_only_score

PAD = HOP  # 0.48 s of silence each side
NOISE_CATEGORIES = {"rain", "wind", "footsteps", "car_horn", "engine", "train", "helicopter", "airplane",
                    "sea_waves", "thunderstorm", "chirping_birds", "crickets", "insects", "church_bells", "dog"}


def noise_pool():
    import csv as _csv

    esc = ROOT / "raw" / "ESC-50-master"
    rows = [r for r in _csv.DictReader(open(esc / "meta/esc50.csv")) if r["fold"] == "1" and r["category"] in NOISE_CATEGORIES]
    pool = []
    for r in rows:
        x, sr = load_audio(esc / "audio" / r["filename"])
        pool.append(to_16k(x, sr))
    return pool


def augment(x16, pool, rng):
    """Scream at a random gain mixed with outdoor noise at -5…20 dB SNR (by loud-part RMS)."""
    gain = rng.uniform(0.15, 1.0)
    s = x16 * gain
    noise = pool[rng.integers(len(pool))]
    reps = int(np.ceil(len(s) / len(noise)))
    noise = np.tile(noise, reps)[: len(s)]
    sig_rms = np.sqrt(np.mean(s[np.abs(s) >= 0.3 * np.abs(s).max()] ** 2)) + 1e-9
    noise_rms = np.sqrt(np.mean(noise**2)) + 1e-9
    snr_db = rng.uniform(-5, 20)
    mixed = s + noise * (sig_rms / noise_rms) / (10 ** (snr_db / 20))
    peak = np.abs(mixed).max()
    return (mixed / peak * 0.99 if peak > 1 else mixed).astype(np.float32)


def window_rms(x16, n):
    return np.array([np.sqrt(np.mean(x16[i * HOP : i * HOP + WINDOW] ** 2)) for i in range(n)], dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(ROOT / "data"))
    ap.add_argument("--out", default=str(ROOT / "embeddings.npz"))
    ap.add_argument("--augment", type=int, default=0, help="noisy copies per positive clip (training only)")
    ap.add_argument("--offset", type=int, default=0, help="shift the window grid by this many 16 kHz samples (e.g. 3840 = half a hop)")
    args = ap.parse_args()
    rng = np.random.default_rng(0)
    pool = noise_pool() if args.augment else []
    data = Path(args.inp)

    meta = {}
    attr = data / "ATTRIBUTION.csv"
    if attr.exists():
        for r in csv.DictReader(open(attr)):
            meta[str((ROOT / r["file"]).resolve())] = r

    clips = [(p.resolve(), 1) for p in list_audio(data / "positive")] + [(p.resolve(), 0) for p in list_audio(data / "negative")]
    if not clips:
        raise SystemExit(f"no audio under {data}/positive or {data}/negative")
    print(f"{sum(l for _, l in clips)} positive and {sum(1 - l for _, l in clips)} negative clips")

    X, S, ys, yam, rms, clip_idx, win_idx = [], [], [], [], [], [], []
    clip_path, clip_label, clip_group, clip_category, clip_seconds, clip_aug_of = [], [], [], [], [], []

    def add(x16, path, label, group, category, seconds, aug_of):
        x16 = np.concatenate([np.zeros(PAD, np.float32), x16, np.zeros(PAD, np.float32)])[args.offset :]
        scores, emb = run_yamnet(x16)
        n = len(emb)
        k = len(clip_path)
        clip_path.append(path)
        clip_label.append(label)
        clip_group.append(group)
        clip_category.append(category)
        clip_seconds.append(seconds)
        clip_aug_of.append(aug_of)
        X.append(emb.astype(np.float32))
        S.append(scores.astype(np.float16))
        yam.append(yamnet_only_score(scores).astype(np.float32))
        rms.append(window_rms(x16, n))
        ys.append(np.full(n, label, np.int8))
        clip_idx.append(np.full(n, k, np.int32))
        win_idx.append(np.arange(n, dtype=np.int32))
        return k
    t0 = time.time()
    for ci, (path, label) in enumerate(clips):
        try:
            x, sr = load_audio(path)
        except Exception as err:
            print(f"  skip {path}: {err}")
            continue
        x16 = to_16k(x, sr)
        m = meta.get(str(path.resolve()), {})
        rel = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
        # Group = who/what the recording came from, so near-duplicates never straddle train/test.
        # Team recordings: a subfolder (e.g. team/anna-session1/) is one group, else each file is.
        own = f"dir:{path.parent.relative_to(ROOT)}" if path.parent.name != "team" else f"file:{rel}"
        group = m.get("group") or own
        category = m.get("category") or ("team_positive" if label else "team_negative")
        k = add(x16, rel, label, group, category, len(x) / sr, -1)
        if label == 1:
            for j in range(args.augment):
                add(augment(x16, pool, rng), f"{rel}#aug{j}", 1, group, "scream_aug", len(x) / sr, k)
        if (ci + 1) % 250 == 0:
            print(f"  {ci + 1}/{len(clips)} clips, {time.time() - t0:.0f} s")

    np.savez_compressed(
        args.out,
        X=np.concatenate(X), S=np.concatenate(S), y=np.concatenate(ys), yamnet_score=np.concatenate(yam), rms=np.concatenate(rms),
        clip=np.concatenate(clip_idx), window=np.concatenate(win_idx),
        clip_path=np.array(clip_path), clip_label=np.array(clip_label, np.int8), clip_group=np.array(clip_group),
        clip_category=np.array(clip_category), clip_seconds=np.array(clip_seconds, np.float32),
        clip_aug_of=np.array(clip_aug_of, np.int32),
    )
    n_win = sum(len(a) for a in X)
    print(f"wrote {args.out}: {len(clip_path)} clips, {n_win} windows ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
