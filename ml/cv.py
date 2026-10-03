"""Grouped cross-validation for model selection and the threshold.

  python ml/cv.py --embeddings ml/embeddings_v2.npz --embeddings-offset ml/embeddings_v2_off.npz \
      --augment [--clean-positives] [--context 2] [--model mlp] [--features embedding+logit_scores] [--export]

Why: the single 16 % validation split (44 screams, 1.2 h of negatives) was far too small —
dropping 2 clips reshuffled it and recall at the false-alarm budget moved from 0.75 to 0.35.
Here the fixed 20 % TEST split (same one train.py uses) is set aside, and the remaining 80 % is
split 5 ways by group (StratifiedGroupKFold). Each clip is scored once by a model that never
saw it or its uploader, giving ~270 screams and ~6 h of negatives to compare settings on and to
choose the threshold from. With --export, a final model is trained on the whole 80 %, the
threshold is taken from the cross-validated scores, the test split is scored once, and
scream_head.json + metrics.json are written.
"""
import argparse
import json
import time
import warnings
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

from common import HARD_CATEGORIES, ROOT
from train import (
    FUSION, METRICS, YAMNET_ONLY_THRESHOLD, clean_positive_mask, clip_metrics, clip_scores, features,
    interleave, split_clips, stream_fa,
)
from common import count_triggers

warnings.filterwarnings("ignore", category=ConvergenceWarning)
HOP_S = 0.24  # 0.24 s hop: interleave the two 0.48 s grids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embeddings", default=str(ROOT / "embeddings_v2.npz"))
    ap.add_argument("--embeddings-offset", default=str(ROOT / "embeddings_v2_off.npz"))
    ap.add_argument("--features", choices=["embedding", "embedding+logit_scores"], default="embedding")
    ap.add_argument("--context", type=int, default=0)
    ap.add_argument("--augment", action="store_true")
    ap.add_argument("--clean-positives", action="store_true")
    ap.add_argument("--model", choices=["logistic", "mlp"], default="logistic")
    ap.add_argument("--C", type=float, default=0.01)
    ap.add_argument("--hard-neg-weight", type=float, default=1.0)
    ap.add_argument("--fusion-alpha", type=float, default=0.5,
                    help="score = p^(1-a) * yamnet^a; 0.5 = geometric mean (the deployed fusion)")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--fa-budget", type=float, default=1.0, help="everyday false alarms/hour for the threshold")
    ap.add_argument("--export", action="store_true", help="train on all non-test data, score test once, write head + metrics")
    ap.add_argument("--out", default=str(ROOT.parent / "app/public/models/scream_head.json"))
    args = ap.parse_args()
    k_rule, n_rule = 2, 3

    A, B = np.load(args.embeddings), np.load(args.embeddings_offset)
    phases = (A, B)
    lab, grp, cat, aug_of = A["clip_label"], A["clip_group"], A["clip_category"], A["clip_aug_of"]
    orig_all = np.flatnonzero(aug_of < 0)
    # The test split is fixed on ALL original clips (independent of cleaning), seed 42 like train.py.
    o_tr, o_va, o_te, _ = split_clips(lab[orig_all], grp[orig_all], 42)
    usable = clean_positive_mask(A) if args.clean_positives else np.ones(len(lab), bool)
    usable[aug_of >= 0] = usable[aug_of[aug_of >= 0]]
    pool = np.array([c for c in orig_all[np.concatenate([o_tr, o_va])] if usable[c]])
    test = np.array([c for c in orig_all[o_te] if usable[c]])
    print(f"pool {len(pool)} clips ({lab[pool].sum()} screams), test {len(test)} ({lab[test].sum()} screams)"
          + (f", cleaning dropped {int((~usable[orig_all]).sum())} positives" if args.clean_positives else ""))

    def fit(train_clips):
        train_all = set(train_clips.tolist())
        if args.augment:
            train_all |= {c for c in np.flatnonzero(aug_of >= 0) if aug_of[c] in train_all and usable[c]}
        train_all = np.array(sorted(train_all))
        Xs, ys, cs = [], [], []
        for D in phases:
            clip, rms, win = D["clip"], D["rms"], D["window"]
            mx = np.zeros(len(lab), np.float32)
            np.maximum.at(mx, clip, rms)
            src = np.where(aug_of[clip] >= 0, aug_of[clip], clip).astype(np.int64)
            orig_loud = (aug_of[clip] < 0) & (rms >= 0.4 * mx[clip])
            loud_keys = set((clip[orig_loud].astype(np.int64) * 100000 + win[orig_loud]).tolist())
            loud = np.fromiter(((k in loud_keys) for k in (src * 100000 + win).tolist()), bool, len(clip))
            m = np.isin(clip, train_all) & ((lab[clip] == 0) | loud)
            Xs.append(features(D, args.features, args.context, m))
            ys.append(lab[clip[m]])
            cs.append(cat[clip[m]])
        X, y, c = np.vstack(Xs), np.concatenate(ys), np.concatenate(cs)
        sw = np.where((y == 0) & np.isin(c, list(HARD_CATEGORIES)), args.hard_neg_weight, 1.0)
        sc = StandardScaler().fit(X)
        Xs_ = sc.transform(X)
        if args.model == "logistic":
            m = LogisticRegression(C=args.C, class_weight="balanced", max_iter=4000).fit(Xs_, y, sample_weight=sw)
        else:
            rng = np.random.RandomState(0)
            pos = np.flatnonzero(y == 1)
            idx = np.concatenate([np.arange(len(y)), rng.choice(pos, max(0, (y == 0).sum() - len(pos)))])
            m = MLPClassifier(hidden_layer_sizes=(128,), alpha=1e-2, max_iter=10, batch_size=256, random_state=0).fit(Xs_[idx], y[idx])
        return sc, m

    def score(sc, m, clips):
        per = []
        for D in phases:
            mask = np.isin(D["clip"], clips)
            p = m.predict_proba(sc.transform(features(D, args.features, args.context, mask)))[:, 1]
            a = args.fusion_alpha
            fused = p ** (1 - a) * D["yamnet_score"][mask].astype(np.float64) ** a
            per.append(dict(zip(clips, clip_scores(fused, D["clip"][mask], clips))))
        return {c: interleave(per[0][c], per[1][c]) for c in clips}

    t0 = time.time()
    oof = {}
    folds = StratifiedGroupKFold(n_splits=args.folds, shuffle=True, random_state=0)
    for i, (tr, ho) in enumerate(folds.split(pool, lab[pool], grp[pool])):
        sc, m = fit(pool[tr])
        oof.update(score(sc, m, pool[ho]))
        print(f"  fold {i + 1}/{args.folds} done ({time.time() - t0:.0f} s)", flush=True)

    series = [oof[c] for c in pool]
    neg = [c for c in pool if lab[c] == 0]
    neg_s = [oof[c] for c in neg]
    curve = []
    for t in np.round(np.arange(0.10, 0.95, 0.005), 3):
        mt = clip_metrics(series, lab[pool], t, k_rule, n_rule)
        fw, hw = stream_fa(neg_s, neg, cat, t, False, k_rule, n_rule, HOP_S)
        fh, hh = stream_fa(neg_s, neg, cat, t, True, k_rule, n_rule, HOP_S)
        curve.append((float(t), mt["recall"], mt["precision"], fw, fh))
    print(f"CV pool: {lab[pool].sum()} screams, {hw:.2f} h everyday, {hh:.2f} h hard")
    cells = []
    for target in (0.60, 0.65, 0.70, 0.75, 0.80, 0.85):
        ok = [r for r in curve if r[1] >= target]
        if ok:
            r = max(ok, key=lambda r: r[0])
            cells.append(f"{target:.2f}: {r[3]:.1f}/{r[4]:.0f}")
        else:
            cells.append(f"{target:.2f}: n/a")
    print("CV matched recall → everyday/hard FA per h | " + " | ".join(cells))
    ok = [r for r in curve if r[3] <= args.fa_budget]
    best = max(ok, key=lambda r: (r[1], r[0])) if ok else curve[-1]
    print(f"CV at ≤{args.fa_budget} everyday FA/h: threshold {best[0]:.3f}, recall {best[1]:.3f}, precision {best[2]:.3f}, "
          f"everyday {best[3]:.2f}/h, hard {best[4]:.1f}/h")

    if not args.export:
        return

    threshold = best[0]
    sc, m = fit(pool)
    ts = score(sc, m, test)
    test_series = [ts[c] for c in test]
    res = clip_metrics(test_series, lab[test], threshold, k_rule, n_rule)
    tneg = [c for c in test if lab[c] == 0]
    tn_s = [ts[c] for c in tneg]
    fw_t, hw_t = stream_fa(tn_s, tneg, cat, threshold, False, k_rule, n_rule, HOP_S)
    fh_t, hh_t = stream_fa(tn_s, tneg, cat, threshold, True, k_rule, n_rule, HOP_S)
    tw = np.isin(A["clip"], test)
    yam_series = clip_scores(A["yamnet_score"][tw].astype(float), A["clip"][tw], test)
    base = clip_metrics(yam_series, lab[test], YAMNET_ONLY_THRESHOLD)
    print(f"TEST @ {threshold:.3f}: {res} | everyday {fw_t:.2f}/h ({hw_t:.2f} h), hard {fh_t:.1f}/h ({hh_t:.2f} h)")
    print(f"TEST yamnet-only @ {YAMNET_ONLY_THRESHOLD}: {base}")

    if args.model != "logistic":
        raise SystemExit("export of MLP heads: use train.py --model mlp")
    w = m.coef_[0] / sc.scale_
    b = float(m.intercept_[0] - np.sum(m.coef_[0] * sc.mean_ / sc.scale_))
    head = {
        "model": f"yamnet {args.features}" + (f" + {args.context} previous windows" if args.context else "")
        + " + logistic regression, fused with yamnet scream score",
        "model_type": "logistic",
        "features": args.features,
        "context": args.context,
        "fusion": FUSION,
        "weights": [round(float(v), 7) for v in w],
        "bias": round(b, 7),
        "threshold": threshold,
        "hop_samples": int(HOP_S * 16000),
        "rule_k": k_rule,
        "rule_n": n_rule,
        "rule": "2 of last 3 windows (hop 0.24 s) >= threshold; score = sqrt(p * max(Screaming, Shout, Yell))",
        "augmented_training": bool(args.augment),
        "selection": f"{args.folds}-fold grouped cross-validation; threshold = best CV recall with <= {args.fa_budget} everyday false alarms/h",
        "trained": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "C": args.C,
    }
    json.dump(head, open(args.out, "w"))
    print(f"wrote {args.out}")

    fp_cats = Counter(str(cat[c]) for c, s in zip(test, test_series) if lab[c] == 0 and count_triggers(s, threshold, k_rule, n_rule))
    missed = [str(A["clip_path"][c]) for c, s in zip(test, test_series) if lab[c] == 1 and not count_triggers(s, threshold, k_rule, n_rule)]
    metrics = {
        "model": head["model"],
        "threshold": threshold,
        "test_clips": {"positives": int(lab[test].sum()), "negatives": int((lab[test] == 0).sum())},
        "precision": res["precision"],
        "recall": res["recall"],
        "f1": res["f1"],
        "false_alarms_per_hour": None,
        "hours_of_background_audio": None,
        "yamnet_only_baseline": {"threshold": YAMNET_ONLY_THRESHOLD, "precision": base["precision"],
                                 "recall": base["recall"], "f1": base["f1"], "false_alarms_per_hour": None},
        "details": {
            "evaluation": "per clip; detected if 2 of 3 consecutive windows (hop 0.24 s) >= threshold anywhere in it",
            "selection": head["selection"],
            "split": "fixed 20% test split (GroupShuffleSplit by uploader, seed 42); 5-fold StratifiedGroupKFold on the rest",
            "clean_positives": bool(args.clean_positives),
            "features": args.features,
            "context": args.context,
            "C": args.C,
            "augmented_training": bool(args.augment),
            "cv": {"screams": int(lab[pool].sum()), "everyday_hours": round(hw, 2), "hard_hours": round(hh, 2),
                   "at_threshold": {"recall": best[1], "precision": best[2], "everyday_fa_per_hour": round(best[3], 2),
                                    "hard_fa_per_hour": round(best[4], 1)},
                   "curve": [{"threshold": r[0], "recall": r[1], "everyday_fa_per_hour": round(r[3], 2),
                              "hard_fa_per_hour": round(r[4], 1)} for r in curve[::4]]},
            "test_counts": {"classifier": res, "yamnet_only": base},
            "test_negatives_as_stream": {"everyday_per_hour": round(fw_t, 2), "hard_per_hour": round(fh_t, 2),
                                         "everyday_hours": round(hw_t, 3), "hard_hours": round(hh_t, 3)},
            "test_false_positive_categories": dict(fp_cats.most_common()),
            "test_missed_positive_clips": missed,
            "hard_categories": sorted(HARD_CATEGORIES),
            "data": "FSD50K Screaming clips (non-playful) vs 101 everyday sound categories from FSD50K + ESC-50 folds 1-4; see ml/data/ATTRIBUTION.csv",
        },
    }
    json.dump(metrics, open(METRICS, "w"), indent=2)
    print(f"wrote {METRICS} (run false_alarms.py next)")


if __name__ == "__main__":
    main()
