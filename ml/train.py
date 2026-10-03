"""Train the scream head on YAMNet embeddings and export it for the browser.

  python ml/train.py --embeddings ml/embeddings.npz --out app/public/models/scream_head.json

* Split by clip GROUP (Freesound uploader / ESC-50 source recording / team session) with
  GroupShuffleSplit: 64 % train, 16 % validation, 20 % test. No clip, and no uploader, appears in
  two splits.
* Training windows: every negative window; for positive clips only the loud windows (RMS ≥ 40 %
  of that clip's loudest window), since a clip labelled "Screaming" is not screaming throughout.
  (Selection uses energy, not YAMNet, so the YAMNet-only baseline isn't favoured.)
* LogisticRegression(class_weight="balanced") on standardised embeddings; C picked on validation.
  The scaler is folded into the exported weights.
* Final score = sqrt(classifier probability × YAMNet's own scream score) ("geomean_yamnet").
  On validation this halved false alarms on everyday sounds at the same recall vs the classifier
  alone (see ml/README.md). Browser: sqrt(sigmoid(w·e + b) × max(Screaming, Shout, Yell)).
* Evaluation is per CLIP with the real trigger rule (2 of 3 consecutive windows ≥ threshold).
* Threshold: the one with the best validation recall whose false-alarm rate on the validation
  *walk-like* negatives, played back to back as one stream, is ≤ --fa-budget per hour (G4).
  Test is touched once, after everything is fixed.
"""
import argparse
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
from sklearn.model_selection import GroupShuffleSplit
from sklearn.preprocessing import StandardScaler

from common import HARD_CATEGORIES, HOP, ROOT, count_triggers

METRICS = ROOT / "metrics.json"
YAMNET_ONLY_THRESHOLD = 0.5
FUSION = "geomean_yamnet"
SEED = 42


def split_clips(clip_label, clip_group, seed):
    """GroupShuffleSplit twice (test, then val), retrying seeds until positives are spread sensibly."""
    idx = np.arange(len(clip_label))
    pos_rate = clip_label.mean()
    for s in range(seed, seed + 200):
        trval, test = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=s).split(idx, groups=clip_group))
        tr, va = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=s).split(trval, groups=clip_group[trval]))
        train, val = trval[tr], trval[va]
        if all(abs(clip_label[part].mean() - pos_rate) < 0.35 * pos_rate for part in (train, val, test)):
            return train, val, test, s
    raise RuntimeError("could not find a balanced group split")


def clip_scores(window_scores, clip_of_window, clips):
    """→ list of per-clip window-score arrays (window order), for `clips`."""
    order = np.argsort(clip_of_window, kind="stable")
    by_clip = np.split(window_scores[order], np.flatnonzero(np.diff(clip_of_window[order])) + 1)
    lookup = dict(zip(np.unique(clip_of_window[order]), by_clip))
    return [lookup[c] for c in clips]


def clip_metrics(per_clip, labels, threshold):
    pred = np.array([len(count_triggers(s, threshold)) > 0 for s in per_clip])
    labels = np.asarray(labels).astype(bool)
    tp, fp, fn = int((pred & labels).sum()), int((pred & ~labels).sum()), int((~pred & labels).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "tp": tp, "fp": fp, "fn": fn}


def stream_fa(per_clip, clips, clip_cat, threshold, hard):
    """False alarms per hour when the given negative clips are played back to back."""
    sel = [s for c, s in zip(clips, per_clip) if (str(clip_cat[c]) in HARD_CATEGORIES) == hard]
    if not sel:
        return None, 0.0
    stream = np.concatenate(sel)
    hours = len(stream) * HOP / 16000 / 3600
    return len(count_triggers(stream, threshold)) / hours, hours


def second_best_peak(s):
    """Clip score under the 2-of-3 rule: detected at threshold t iff this ≥ t."""
    return np.sort(np.lib.stride_tricks.sliding_window_view(np.pad(s, (0, 2)), 3), axis=1)[:, -2].max()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embeddings", default=str(ROOT / "embeddings.npz"))
    ap.add_argument("--out", default=str(ROOT.parent / "app/public/models/scream_head.json"))
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--fa-budget", type=float, default=1.0, help="max false alarms/hour on validation walk-like audio")
    args = ap.parse_args()

    d = np.load(args.embeddings)
    X, clip, yam, rms = d["X"], d["clip"], d["yamnet_score"], d["rms"]
    clip_label, clip_group, clip_cat = d["clip_label"], d["clip_group"], d["clip_category"]
    print(f"{len(clip_label)} clips ({clip_label.sum()} positive), {len(X)} windows, {len(set(clip_group))} groups")

    train_c, val_c, test_c, used_seed = split_clips(clip_label, clip_group, args.seed)
    for a, b in ((train_c, test_c), (val_c, test_c), (train_c, val_c)):
        assert not (set(clip_group[a]) & set(clip_group[b])), "group leak between splits"

    clip_max_rms = np.zeros(len(clip_label), np.float32)
    np.maximum.at(clip_max_rms, clip, rms)
    use = (clip_label[clip] == 0) | (rms >= 0.4 * clip_max_rms[clip])
    tr_mask = np.isin(clip, train_c) & use
    Xtr, ytr = X[tr_mask], clip_label[clip[tr_mask]]
    print(f"train windows: {ytr.sum()} positive (loud), {(ytr == 0).sum()} negative")
    scaler = StandardScaler().fit(Xtr)
    Xtr_s = scaler.transform(Xtr)

    val_win = np.isin(clip, val_c)
    best = None
    for C in (0.003, 0.01, 0.03, 0.1):
        m = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(Xtr_s, ytr)
        p = m.predict_proba(scaler.transform(X[val_win]))[:, 1]
        fused = np.sqrt(p * yam[val_win])
        per_clip = clip_scores(fused, clip[val_win], val_c)
        ap_val = average_precision_score(clip_label[val_c], [second_best_peak(s) for s in per_clip])
        print(f"  C={C:<6} val clip AP (fused) {ap_val:.4f}")
        if best is None or ap_val > best[0]:
            best = (ap_val, C, m, per_clip)
    _, C, model, val_per_clip = best

    # Threshold under a false-alarm budget on validation walk-like negatives.
    val_neg = [c for c in val_c if clip_label[c] == 0]
    val_neg_scores = [s for c, s in zip(val_c, val_per_clip) if clip_label[c] == 0]
    grid = np.round(np.arange(0.02, 0.99, 0.005), 3)
    curve = []
    for t in grid:
        mt = clip_metrics(val_per_clip, clip_label[val_c], t)
        fa_walk, walk_h = stream_fa(val_neg_scores, val_neg, clip_cat, t, hard=False)
        curve.append((float(t), mt["recall"], fa_walk))
    ok = [c for c in curve if c[2] <= args.fa_budget]
    threshold = min(ok, key=lambda c: (-c[1], c[0]))[0] if ok else max(grid)
    val_at = clip_metrics(val_per_clip, clip_label[val_c], threshold)
    val_fa_walk, val_walk_h = stream_fa(val_neg_scores, val_neg, clip_cat, threshold, hard=False)
    val_fa_hard, val_hard_h = stream_fa(val_neg_scores, val_neg, clip_cat, threshold, hard=True)
    print(f"chosen C={C}, threshold {threshold:.3f} → val {val_at}, FA walk-like {val_fa_walk:.2f}/h ({val_walk_h:.2f} h), hard {val_fa_hard:.1f}/h")

    w = model.coef_[0] / scaler.scale_
    b = float(model.intercept_[0] - np.sum(model.coef_[0] * scaler.mean_ / scaler.scale_))

    # Test, touched once.
    test_win = np.isin(clip, test_c)
    p_test = 1 / (1 + np.exp(-(X[test_win] @ w + b)))
    test_per_clip = clip_scores(np.sqrt(p_test * yam[test_win]), clip[test_win], test_c)
    test = clip_metrics(test_per_clip, clip_label[test_c], threshold)
    yam_per_clip = clip_scores(yam[test_win], clip[test_win], test_c)
    base = clip_metrics(yam_per_clip, clip_label[test_c], YAMNET_ONLY_THRESHOLD)
    test_neg = [c for c in test_c if clip_label[c] == 0]
    tn_scores = [s for c, s in zip(test_c, test_per_clip) if clip_label[c] == 0]
    tn_yam = [s for c, s in zip(test_c, yam_per_clip) if clip_label[c] == 0]
    test_fa = {
        "classifier_walk_like_per_hour": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, False)[0], 2),
        "classifier_hard_per_hour": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, True)[0], 2),
        "yamnet_only_walk_like_per_hour": round(stream_fa(tn_yam, test_neg, clip_cat, YAMNET_ONLY_THRESHOLD, False)[0], 2),
        "yamnet_only_hard_per_hour": round(stream_fa(tn_yam, test_neg, clip_cat, YAMNET_ONLY_THRESHOLD, True)[0], 2),
        "walk_like_hours": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, False)[1], 3),
        "hard_hours": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, True)[1], 3),
    }
    print(f"TEST fused @ {threshold:.3f}: {test}")
    print(f"TEST yamnet-only @ {YAMNET_ONLY_THRESHOLD}: {base}")
    print(f"TEST negatives as a stream: {test_fa}")

    fp_cats = Counter(str(clip_cat[c]) for c, s in zip(test_c, test_per_clip) if clip_label[c] == 0 and count_triggers(s, threshold))
    missed = [str(d["clip_path"][c]) for c, s in zip(test_c, test_per_clip) if clip_label[c] == 1 and not count_triggers(s, threshold)]

    head = {
        "model": "yamnet-embeddings + logistic regression, fused with yamnet scream score",
        "fusion": FUSION,
        "weights": [round(float(v), 7) for v in w],
        "bias": round(b, 7),
        "threshold": threshold,
        "rule": "2 of last 3 windows >= threshold; score = sqrt(sigmoid(w·e+b) * max(Screaming, Shout, Yell))",
        "trained": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "C": C,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(head, open(args.out, "w"))
    print(f"wrote {args.out}")

    metrics = json.load(open(METRICS)) if METRICS.exists() else {}
    for stale in ("false_alarms_per_hour", "hours_of_background_audio"):
        metrics[stale] = None  # filled by false_alarms.py for THIS model
    metrics.update(
        {
            "model": head["model"],
            "threshold": threshold,
            "test_clips": {"positives": int(clip_label[test_c].sum()), "negatives": int((clip_label[test_c] == 0).sum())},
            "precision": test["precision"],
            "recall": test["recall"],
            "f1": test["f1"],
        }
    )
    metrics["yamnet_only_baseline"] = {
        "threshold": YAMNET_ONLY_THRESHOLD, "precision": base["precision"], "recall": base["recall"], "f1": base["f1"],
        "false_alarms_per_hour": None,
    }
    metrics["details"] = {
        "evaluation": "per clip; a clip is detected if 2 of 3 consecutive windows >= threshold anywhere in it",
        "split": "GroupShuffleSplit by uploader/source recording: 64% train / 16% val / 20% test",
        "split_seed": used_seed,
        "threshold_rule": f"best validation recall with <= {args.fa_budget} false alarms/hour on validation walk-like negatives",
        "C": C,
        "train_clips": {"positives": int(clip_label[train_c].sum()), "negatives": int((clip_label[train_c] == 0).sum())},
        "val_clips": {"positives": int(clip_label[val_c].sum()), "negatives": int((clip_label[val_c] == 0).sum())},
        "val_at_threshold": {**val_at, "fa_walk_like_per_hour": round(val_fa_walk, 2), "fa_hard_per_hour": round(val_fa_hard, 2)},
        "val_tradeoff_curve": [
            {"threshold": t, "recall": r, "fa_walk_like_per_hour": round(f, 2)} for t, r, f in curve[::4]
        ],
        "test_counts": {"classifier": test, "yamnet_only": base},
        "test_negatives_as_stream": test_fa,
        "test_false_positive_categories": dict(fp_cats.most_common()),
        "test_missed_positive_clips": missed,
        "hard_categories": sorted(HARD_CATEGORIES),
        "data": "FSD50K Screaming clips (non-playful) vs 101 everyday sound categories from FSD50K + ESC-50 folds 1-4; see ml/data/ATTRIBUTION.csv",
    }
    json.dump(metrics, open(METRICS, "w"), indent=2)
    print(f"updated {METRICS}")


if __name__ == "__main__":
    main()
