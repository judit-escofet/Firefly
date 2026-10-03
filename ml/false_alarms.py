"""Run the full detector (classifier + 2-of-3 rule) over ordinary audio and count triggers.

  python ml/false_alarms.py --audio ml/background/ --head app/public/models/scream_head.json

Every file in --audio is streamed exactly like the browser does it (16 kHz, 0.96 s windows,
0.48 s hop, no padding). Reports triggers per hour for the classifier and for the YAMNet-only
baseline (threshold 0.5), lists when each trigger happened so you can listen back, and writes
false_alarms_per_hour + hours_of_background_audio into ml/metrics.json.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from common import HOP, ROOT, count_triggers, head_score, list_audio, load_audio, run_yamnet, to_16k, yamnet_only_score

METRICS = ROOT / "metrics.json"
YAMNET_ONLY_THRESHOLD = 0.5
CHUNK_S = 120  # run YAMNet on 2-minute pieces (overlapping by one window) to bound memory


def stream_scores(x16, hop=HOP):
    """Window scores for a long signal, framed identically to one continuous browser stream.
    hop = 7680 (0.48 s) or 3840 (0.24 s: two interleaved 0.48 s grids, offset by half a hop)."""
    if hop == HOP // 2:
        sa, ea = stream_scores(x16)
        sb, eb = stream_scores(x16[HOP // 2 :])
        n = min(len(sa), len(sb))
        s = np.empty((2 * n, sa.shape[1]), sa.dtype)
        e = np.empty((2 * n, ea.shape[1]), ea.dtype)
        s[0::2], s[1::2], e[0::2], e[1::2] = sa[:n], sb[:n], ea[:n], eb[:n]
        return s, e
    if hop != HOP:
        raise ValueError("hop must be 7680 or 3840 samples")
    from common import WINDOW, num_windows

    n_total = num_windows(len(x16))
    chunk_windows = CHUNK_S * 16000 // HOP
    all_scores, all_emb = [], []
    for w0 in range(0, n_total, chunk_windows):
        w1 = min(n_total, w0 + chunk_windows)
        seg = x16[w0 * HOP : (w1 - 1) * HOP + WINDOW]
        s, e = run_yamnet(seg)
        all_scores.append(s[: w1 - w0])
        all_emb.append(e[: w1 - w0])
    return np.concatenate(all_scores), np.concatenate(all_emb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default=str(ROOT / "background"))
    ap.add_argument("--head", default=str(ROOT.parent / "app/public/models/scream_head.json"))
    ap.add_argument("--threshold", type=float, help="override the head's threshold")
    args = ap.parse_args()

    head = json.load(open(args.head))
    thr = args.threshold if args.threshold is not None else head["threshold"]
    files = list_audio(args.audio)
    if not files:
        raise SystemExit(f"no audio in {args.audio}")

    def set_of(f):
        return "walk_like" if f.name.startswith("public_walk") else "hard" if f.name.startswith("public_hard") else "team"

    per_set = {}
    total_s, n_head, n_yam = 0.0, 0, 0
    events = []
    near = []  # closest calls (for tuning)
    for f in files:
        x, sr = load_audio(f)
        x16 = to_16k(x, sr)
        hop = head.get("hop_samples", HOP)
        k, n = head.get("rule_k", 2), head.get("rule_n", 3)
        # Score each 0.48 s grid on its own (context = previous windows of the same grid), then
        # interleave the two grids for the 0.24 s hop — same as the browser.
        grids = [stream_scores(x16)] + ([stream_scores(x16[HOP // 2 :])] if hop == HOP // 2 else [])
        per_grid = []
        for s_g, e_g in grids:
            y_g = yamnet_only_score(s_g)
            per_grid.append((head_score(head, e_g, y_g, s_g), y_g))
        if len(per_grid) == 2:
            m = min(len(per_grid[0][0]), len(per_grid[1][0]))
            hs = np.empty(2 * m)
            hs[0::2], hs[1::2] = per_grid[0][0][:m], per_grid[1][0][:m]
        else:
            hs = per_grid[0][0]
        ys = per_grid[0][1]
        th = count_triggers(hs, thr, k, n)
        # baseline: YAMNet-only exactly as the spec's stage A (0.48 s hop, 2 of 3)
        ty = count_triggers(ys, YAMNET_ONLY_THRESHOLD)
        secs = len(x16) / 16000
        total_s += secs
        n_head += len(th)
        n_yam += len(ty)
        st = per_set.setdefault(set_of(f), {"seconds": 0.0, "classifier": 0, "yamnet_only": 0})
        st["seconds"] += secs
        st["classifier"] += len(th)
        st["yamnet_only"] += len(ty)
        for i in th:
            events.append({"file": f.name, "at_s": round(i * hop / 16000, 1), "score": round(float(hs[i]), 3)})
        second_best = np.sort(np.lib.stride_tricks.sliding_window_view(np.pad(hs, (0, 2)), 3), axis=1)[:, -2]
        near.append(float(second_best.max()))
        print(f"  {f.name}: {secs / 60:.1f} min, classifier {len(th)} triggers, yamnet-only {len(ty)}", flush=True)

    hours = total_s / 3600
    fa = n_head / hours
    fa_yam = n_yam / hours
    print(f"\n{hours:.2f} h of background audio")
    print(f"classifier  @ {thr:.2f}: {n_head} triggers → {fa:.2f} false alarms / hour")
    print(f"yamnet-only @ {YAMNET_ONLY_THRESHOLD}: {n_yam} triggers → {fa_yam:.2f} false alarms / hour")
    breakdown = {}
    for name, st in per_set.items():
        h = st["seconds"] / 3600
        breakdown[name] = {
            "hours": round(h, 3),
            "classifier_per_hour": round(st["classifier"] / h, 2),
            "yamnet_only_per_hour": round(st["yamnet_only"] / h, 2),
        }
        print(f"  {name:10s} {h:.2f} h: classifier {st['classifier'] / h:.2f}/h, yamnet-only {st['yamnet_only'] / h:.2f}/h")

    metrics = json.load(open(METRICS)) if METRICS.exists() else {}
    metrics["false_alarms_per_hour"] = round(fa, 3)
    metrics["hours_of_background_audio"] = round(hours, 3)
    metrics.setdefault("yamnet_only_baseline", {})["false_alarms_per_hour"] = round(fa_yam, 3)
    metrics.setdefault("details", {})["false_alarms"] = {
        "threshold": thr,
        "by_set": breakdown,
        "classifier_triggers": n_head,
        "yamnet_only_triggers": n_yam,
        "background_files": [f.name for f in files],
        "background_source": "ml/background: public_walk_*/public_hard_*.wav = ESC-50 fold 5 + FSD50K eval-split clips (never used in training), concatenated; any other file = team recordings",
        "trigger_times": events,
    }
    json.dump(metrics, open(METRICS, "w"), indent=2)
    print(f"updated {METRICS}")


if __name__ == "__main__":
    main()
