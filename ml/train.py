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
import csv
import json
import re
import time
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
from sklearn.model_selection import GroupShuffleSplit
import warnings

from sklearn.exceptions import ConvergenceWarning
from sklearn.neural_network import MLPClassifier

warnings.filterwarnings("ignore", category=ConvergenceWarning)  # fixed epoch budgets are intentional
from sklearn.preprocessing import StandardScaler

from common import HARD_CATEGORIES, HOP, ROOT, count_triggers, logit_scores

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


def clip_metrics(per_clip, labels, threshold, k=2, n=3):
    pred = np.array([len(count_triggers(s, threshold, k, n)) > 0 for s in per_clip])
    labels = np.asarray(labels).astype(bool)
    tp, fp, fn = int((pred & labels).sum()), int((pred & ~labels).sum()), int((~pred & labels).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "tp": tp, "fp": fp, "fn": fn}


def stream_fa(per_clip, clips, clip_cat, threshold, hard, k=2, n=3, hop_s=HOP / 16000):
    """False alarms per hour when the given negative clips are played back to back."""
    sel = [s for c, s in zip(clips, per_clip) if (str(clip_cat[c]) in HARD_CATEGORIES) == hard]
    if not sel:
        return None, 0.0
    stream = np.concatenate(sel)
    hours = len(stream) * hop_s / 3600
    return len(count_triggers(stream, threshold, k, n)) / hours, hours


def kth_peak(s, k=2, n=3):
    """Clip score under the k-of-n rule: the clip is detected at threshold t iff this ≥ t."""
    return np.sort(np.lib.stride_tricks.sliding_window_view(np.pad(s, (0, n - 1)), n), axis=1)[:, -k].max()


def interleave(a, b):
    n = min(len(a), len(b))
    out = np.empty(2 * n, dtype=np.float64)
    out[0::2], out[1::2] = a[:n], b[:n]
    return out


SCREAM_WORDS = re.compile(
    r"scream|shriek|screech|yell|shout|cry|crying|help|horror|terror|terrif|fear|scared|scary|frighten|panic|"
    r"agony|pain|grito|schrei|aaa+h*|ahh+",
    re.I,
)
RIDE_WORDS = re.compile(r"coaster|rollercoaster|ride|amusement", re.I)


def clean_positive_mask(d):
    """True for positive clips whose own metadata corroborates a (non-ride) scream.
    FSD50K labels a whole clip even when the scream is a tiny part of a long field recording
    (e.g. a beer-clink recording labelled "Screaming"). Decided from title/tags only, never from
    model scores, and applied identically to every split. Team recordings are always kept."""
    attr = {r["file"]: r for r in csv.DictReader(open(ROOT / "data" / "ATTRIBUTION.csv"))}
    keep = np.ones(len(d["clip_label"]), bool)
    for c, (path, label) in enumerate(zip(d["clip_path"], d["clip_label"])):
        if label != 1:
            continue
        a = attr.get(str(path).split("#")[0])
        if a is None:
            continue  # team recording
        text = f"{a['title']} {a.get('category', '')}"
        meta_tags = TAGS.get(a["freesound_id"], "")
        text = f"{text} {meta_tags}"
        keep[c] = bool(SCREAM_WORDS.search(text)) and not RIDE_WORDS.search(text)
    return keep


def _load_tags():
    tags = {}
    for split in ("dev", "eval"):
        f = ROOT / "raw" / f"FSD50K.metadata/{split}_clips_info_FSD50K.json"
        if f.exists():
            for k, v in json.load(open(f)).items():
                tags[k] = " ".join(v.get("tags", []))
    return tags


TAGS = _load_tags()


def features(D, kind, context=0, rows=None):
    """Feature rows for windows `rows` (bool mask). With context=N, the embeddings of the previous
    N windows of the SAME grid (0.48 s apart, ~1 s of history) are appended; at a clip's start
    the clip's first window is repeated (rows are stored clip by clip, window by window)."""
    idx = np.flatnonzero(rows) if rows is not None else np.arange(len(D["X"]))
    base = D["X"][idx] if kind == "embedding" else np.hstack([D["X"][idx], logit_scores(D["S"][idx]).astype(np.float32)])
    if context == 0:
        return base
    win = D["window"][idx]
    parts = [base]
    for k in range(1, context + 1):
        parts.append(D["X"][idx - np.minimum(win, k)])
    return np.hstack(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embeddings", default=str(ROOT / "embeddings.npz"))
    ap.add_argument("--out", default=str(ROOT.parent / "app/public/models/scream_head.json"))
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--fa-budget", type=float, default=1.0, help="max false alarms/hour on validation walk-like audio")
    ap.add_argument("--embeddings-offset", default=None,
                    help="same clips embedded with --offset 3840 (enables --hop 0.24 and doubles training windows)")
    ap.add_argument("--features", choices=["embedding", "embedding+logit_scores"], default="embedding")
    ap.add_argument("--augment", action="store_true", help="also train on the noisy copies (embed.py --augment)")
    ap.add_argument("--hop", type=float, choices=[0.48, 0.24], default=0.48)
    ap.add_argument("--rule", default="2/3", help="k/n: trigger when k of the last n windows reach the threshold")
    ap.add_argument("--model", choices=["logistic", "mlp"], default="logistic",
                    help="classifier architecture: logistic regression or MLP")
    ap.add_argument("--mlp-hidden", type=int, nargs="+", default=[128],
                    help="hidden layer sizes for MLP (default: 128)")
    ap.add_argument("--context", type=int, default=0, help="also feed the previous N windows' embeddings (0.48 s apart)")
    ap.add_argument("--clean-positives", action="store_true",
                    help="drop positive clips whose title/tags don't mention a scream (FSD50K label noise)")
    ap.add_argument("--hard-neg-weight", type=float, default=1.0,
                    help="sample weight multiplier for hard-negative categories (crowds, cheering, etc.)")
    args = ap.parse_args()
    rule_k, rule_n = map(int, args.rule.split("/"))
    if args.hop == 0.24 and not args.embeddings_offset:
        raise SystemExit("--hop 0.24 needs --embeddings-offset")

    d = np.load(args.embeddings)
    phases = [d] + ([np.load(args.embeddings_offset)] if args.embeddings_offset else [])
    for p in phases[1:]:
        assert (p["clip_path"] == d["clip_path"]).all(), "offset embeddings must come from the same clip list"
    clip_label, clip_group, clip_cat = d["clip_label"], d["clip_group"], d["clip_category"]
    aug_of = d["clip_aug_of"] if "clip_aug_of" in d.files else np.full(len(clip_label), -1)
    usable = np.ones(len(clip_label), bool)
    if args.clean_positives:
        usable = clean_positive_mask(d)
        src_ok = usable.copy()
        usable[aug_of >= 0] = src_ok[aug_of[aug_of >= 0]]  # copies follow their source
        dropped = [str(p) for p, u, a in zip(d["clip_path"], usable, aug_of) if not u and a < 0]
        print(f"clean-positives: dropped {len(dropped)} positive clips without scream metadata")
    orig = np.flatnonzero((aug_of < 0) & usable)
    print(f"{len(orig)} clips ({clip_label[orig].sum()} positive), {(aug_of >= 0).sum()} noisy copies, "
          f"{len(set(clip_group[orig]))} groups, {len(phases)} window phase(s)")

    o_tr, o_va, o_te, used_seed = split_clips(clip_label[orig], clip_group[orig], args.seed)
    train_c, val_c, test_c = orig[o_tr], orig[o_va], orig[o_te]
    for a, b in ((train_c, test_c), (val_c, test_c), (train_c, val_c)):
        assert not (set(clip_group[a]) & set(clip_group[b])), "group leak between splits"
    train_aug = np.array([c for c in np.flatnonzero((aug_of >= 0) & usable) if aug_of[c] in set(train_c)], dtype=int)
    train_all = np.concatenate([train_c, train_aug]) if args.augment else train_c

    # Training windows (all phases): every negative window; for positives only the windows that
    # are loud in the ORIGINAL clip (noisy copies reuse their source's loud windows).
    Xs, ys, cats = [], [], []
    for D in phases:
        clip, rms, win = D["clip"], D["rms"], D["window"]
        mx = np.zeros(len(clip_label), np.float32)
        np.maximum.at(mx, clip, rms)
        src = np.where(aug_of[clip] >= 0, aug_of[clip], clip).astype(np.int64)
        orig_loud = (aug_of[clip] < 0) & (rms >= 0.4 * mx[clip])
        loud_keys = set((clip[orig_loud].astype(np.int64) * 100000 + win[orig_loud]).tolist())
        loud = np.fromiter(((k in loud_keys) for k in (src * 100000 + win).tolist()), bool, len(clip))
        m = np.isin(clip, train_all) & ((clip_label[clip] == 0) | loud)
        Xs.append(features(D, args.features, args.context, m))
        ys.append(clip_label[clip[m]])
        cats.append(clip_cat[clip[m]])
    Xtr, ytr, ctr = np.vstack(Xs), np.concatenate(ys), np.concatenate(cats)
    print(f"train windows: {ytr.sum()} positive, {(ytr == 0).sum()} negative ({args.features}, augment={args.augment})")

    # Hard-negative sample weights: upweight negative windows from hard categories
    # (playful screams, cheering, laughter, crowds…) so the model pushes them further from positives.
    sample_w = np.ones(len(ytr), dtype=np.float64)
    if args.hard_neg_weight > 1.0:
        is_hard = np.array([str(c) in HARD_CATEGORIES for c in ctr])
        hard_neg = is_hard & (ytr == 0)
        sample_w[hard_neg] = args.hard_neg_weight
        print(f"hard-negative weighting: {hard_neg.sum()} windows × {args.hard_neg_weight:.1f}")

    scaler = StandardScaler().fit(Xtr)
    Xtr_s = scaler.transform(Xtr)

    def window_scores(model_p, clips):
        """Fused score per window for `clips` → dict clip → window series at the chosen hop."""
        per_phase = []
        for D in phases[: 2 if args.hop == 0.24 else 1]:
            m = np.isin(D["clip"], clips)
            p = model_p(features(D, args.features, args.context, m))
            fused = np.sqrt(p * D["yamnet_score"][m])
            per_phase.append(dict(zip(clips, clip_scores(fused, D["clip"][m], clips))))
        if args.hop == 0.24:
            return {c: interleave(per_phase[0][c], per_phase[1][c]) for c in clips}
        return per_phase[0]

    if args.model == "logistic":
        # ---------- Logistic regression (original path, now with sample weights) ----------
        best = None
        for C in (0.003, 0.01, 0.03, 0.1):
            m = LogisticRegression(C=C, class_weight="balanced", max_iter=4000).fit(Xtr_s, ytr, sample_weight=sample_w)
            ws = window_scores(lambda F: m.predict_proba(scaler.transform(F))[:, 1], val_c)
            per_clip = [ws[c] for c in val_c]
            ap_val = average_precision_score(clip_label[val_c], [kth_peak(s, rule_k, rule_n) for s in per_clip])
            print(f"  C={C:<6} val clip AP (fused) {ap_val:.4f}")
            if best is None or ap_val > best[0]:
                best = (ap_val, C, m, per_clip)
        _, best_C, model, val_per_clip = best
        model_desc = f"yamnet {args.features} + logistic regression, fused with yamnet scream score"

    else:
        # ---------- MLP ----------
        hidden = tuple(args.mlp_hidden)
        # MLPClassifier doesn't support sample_weight or class_weight. Oversample positives
        # to balance classes, and oversample hard negatives for emphasis.
        pos_mask = ytr == 1
        neg_mask = ytr == 0
        n_pos, n_neg = pos_mask.sum(), neg_mask.sum()
        # Balance: replicate positives to match negatives
        rng = np.random.RandomState(args.seed)
        pos_idx = np.flatnonzero(pos_mask)
        oversample_idx = rng.choice(pos_idx, size=max(0, n_neg - n_pos), replace=True)
        # Hard-neg emphasis: replicate hard negatives
        extra_hard = np.array([], dtype=int)
        if args.hard_neg_weight > 1.0:
            hard_idx = np.flatnonzero(np.array([str(c) in HARD_CATEGORIES for c in ctr]) & neg_mask)
            n_extra = int(len(hard_idx) * (args.hard_neg_weight - 1))
            extra_hard = rng.choice(hard_idx, size=n_extra, replace=True)
        all_idx = np.concatenate([np.arange(len(ytr)), oversample_idx, extra_hard])
        rng.shuffle(all_idx)
        Xtr_bal = Xtr_s[all_idx]
        ytr_bal = ytr[all_idx]
        print(f"MLP training set after balancing: {ytr_bal.sum()} pos, {(ytr_bal == 0).sum()} neg "
              f"(hidden={hidden}, hard extra={len(extra_hard)})")

        # No sklearn early_stopping: it holds out a random 10 % of WINDOWS, and after oversampling
        # that holdout contains copies of training positives (and windows from training clips),
        # so it can't detect overfitting. Instead the number of epochs and the L2 strength are
        # picked on the group-held-out validation split, like everything else.
        best = None
        for alpha in (1e-3, 1e-2, 1e-1):
            for epochs in (10, 30):
                m = MLPClassifier(
                    hidden_layer_sizes=hidden, activation="relu", solver="adam", alpha=alpha,
                    max_iter=epochs, early_stopping=False, random_state=args.seed, batch_size=256,
                ).fit(Xtr_bal, ytr_bal)
                ws = window_scores(lambda F: m.predict_proba(scaler.transform(F))[:, 1], val_c)
                per_clip = [ws[c] for c in val_c]
                ap_val = average_precision_score(clip_label[val_c], [kth_peak(s, rule_k, rule_n) for s in per_clip])
                print(f"  alpha={alpha:<6} epochs={epochs:<3} val clip AP (fused) {ap_val:.4f}")
                if best is None or ap_val > best[0]:
                    best = (ap_val, alpha, m, per_clip)
        _, best_alpha, model, val_per_clip = best
        best_C = best_alpha  # store in metrics as "C" for consistency
        model_desc = f"yamnet {args.features} + mlp {list(hidden)}, fused with yamnet scream score"

    R = (rule_k, rule_n)
    # Validation matched-recall table: the fair way to compare models (same recall → FA/h).
    vneg = [c for c in val_c if clip_label[c] == 0]
    vneg_s = [s for c, s in zip(val_c, val_per_clip) if clip_label[c] == 0]
    table = []
    for target in (0.60, 0.65, 0.70, 0.75, 0.80):
        ok_t = [t for t in np.arange(0.995, 0.05, -0.005) if clip_metrics(val_per_clip, clip_label[val_c], t, *R)["recall"] >= target]
        if not ok_t:
            table.append(f"{target:.2f}: n/a")
            continue
        t = ok_t[0]
        fw = stream_fa(vneg_s, vneg, clip_cat, t, False, *R, args.hop)[0]
        fh = stream_fa(vneg_s, vneg, clip_cat, t, True, *R, args.hop)[0]
        table.append(f"{target:.2f}: {fw:.1f}/{fh:.0f}")
    print("VAL matched recall → everyday/hard FA per h | " + " | ".join(table))

    # Threshold under a false-alarm budget on validation walk-like negatives.
    val_neg = [c for c in val_c if clip_label[c] == 0]
    val_neg_scores = [s for c, s in zip(val_c, val_per_clip) if clip_label[c] == 0]
    grid = np.round(np.arange(0.02, 0.99, 0.005), 3)
    curve = []
    for t in grid:
        mt = clip_metrics(val_per_clip, clip_label[val_c], t, *R)
        fa_walk, walk_h = stream_fa(val_neg_scores, val_neg, clip_cat, t, False, *R, args.hop)
        curve.append((float(t), mt["recall"], fa_walk))
    ok = [c for c in curve if c[2] <= args.fa_budget]
    threshold = min(ok, key=lambda c: (-c[1], c[0]))[0] if ok else max(grid)
    val_at = clip_metrics(val_per_clip, clip_label[val_c], threshold, *R)
    val_fa_walk, val_walk_h = stream_fa(val_neg_scores, val_neg, clip_cat, threshold, False, *R, args.hop)
    val_fa_hard, val_hard_h = stream_fa(val_neg_scores, val_neg, clip_cat, threshold, True, *R, args.hop)
    print(f"chosen {'C' if args.model == 'logistic' else 'alpha'}={best_C}, threshold {threshold:.3f} "
          f"→ val {val_at}, FA walk-like {val_fa_walk:.2f}/h ({val_walk_h:.2f} h), hard {val_fa_hard:.1f}/h")

    # ---------- Export weights ----------
    if args.model == "logistic":
        w = model.coef_[0] / scaler.scale_
        b = float(model.intercept_[0] - np.sum(model.coef_[0] * scaler.mean_ / scaler.scale_))
        # For test inference, use the raw-feature formula directly
        test_predict = lambda F: 1 / (1 + np.exp(-(F.astype(np.float64) @ w + b)))
    else:
        # MLP: fold the scaler into the first layer, export all layers
        # Layer 0: W0_raw @ scaler.transform(x) + b0 = W0_raw @ ((x - mean) / scale) + b0
        #         = (W0_raw / scale) @ x + (b0 - W0_raw @ (mean / scale))
        w0 = model.coefs_[0].T / scaler.scale_[None, :]  # (out, in) / (1, in)
        b0 = model.intercepts_[0] - (model.coefs_[0].T @ (scaler.mean_ / scaler.scale_))
        # For test inference with raw (unscaled) features
        def test_predict(F):
            x = F.astype(np.float64)
            x = x @ w0.T + b0
            x = np.maximum(0, x)
            for i in range(1, len(model.coefs_)):
                x = x @ model.coefs_[i] + model.intercepts_[i]
                if i < len(model.coefs_) - 1:
                    x = np.maximum(0, x)
            return 1 / (1 + np.exp(-np.clip(x[:, 0] if x.ndim == 2 else x, -500, 500)))

    # Test, touched once.
    tws = window_scores(test_predict, test_c)
    test_per_clip = [tws[c] for c in test_c]
    test = clip_metrics(test_per_clip, clip_label[test_c], threshold, *R)
    # Baseline = spec stage A exactly: YAMNet-only, 0.48 s hop, 2 of 3, threshold 0.5.
    tw = np.isin(d["clip"], test_c)
    yam_per_clip = clip_scores(d["yamnet_score"][tw], d["clip"][tw], test_c)
    base = clip_metrics(yam_per_clip, clip_label[test_c], YAMNET_ONLY_THRESHOLD)
    test_neg = [c for c in test_c if clip_label[c] == 0]
    tn_scores = [s for c, s in zip(test_c, test_per_clip) if clip_label[c] == 0]
    tn_yam = [s for c, s in zip(test_c, yam_per_clip) if clip_label[c] == 0]
    test_fa = {
        "classifier_walk_like_per_hour": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, False, *R, args.hop)[0], 2),
        "classifier_hard_per_hour": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, True, *R, args.hop)[0], 2),
        "yamnet_only_walk_like_per_hour": round(stream_fa(tn_yam, test_neg, clip_cat, YAMNET_ONLY_THRESHOLD, False)[0], 2),
        "yamnet_only_hard_per_hour": round(stream_fa(tn_yam, test_neg, clip_cat, YAMNET_ONLY_THRESHOLD, True)[0], 2),
        "walk_like_hours": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, False, *R, args.hop)[1], 3),
        "hard_hours": round(stream_fa(tn_scores, test_neg, clip_cat, threshold, True, *R, args.hop)[1], 3),
    }
    print(f"TEST fused @ {threshold:.3f}: {test}")
    print(f"TEST yamnet-only @ {YAMNET_ONLY_THRESHOLD}: {base}")
    print(f"TEST negatives as a stream: {test_fa}")

    fp_cats = Counter(str(clip_cat[c]) for c, s in zip(test_c, test_per_clip) if clip_label[c] == 0 and count_triggers(s, threshold, *R))
    missed = [str(d["clip_path"][c]) for c, s in zip(test_c, test_per_clip) if clip_label[c] == 1 and not count_triggers(s, threshold, *R)]

    hop_samples = int(round(args.hop * 16000))
    head = {
        "model": model_desc,
        "model_type": args.model,
        "features": args.features,
        "fusion": FUSION,
        "threshold": threshold,
        "hop_samples": hop_samples,
        "rule_k": rule_k,
        "rule_n": rule_n,
        "rule": f"{rule_k} of last {rule_n} windows (hop {args.hop} s) >= threshold; score = sqrt(p * max(Screaming, Shout, Yell)), p = classifier probability",
        "augmented_training": bool(args.augment),
        "trained": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "C": best_C,
    }
    if args.model == "logistic":
        head["weights"] = [round(float(v), 7) for v in w]
        head["bias"] = round(b, 7)
    else:
        head["layers"] = []
        head["layers"].append({
            "weights": [round(float(v), 7) for v in w0.flatten()],
            "bias": [round(float(v), 7) for v in b0],
            "in_features": w0.shape[1],
            "out_features": w0.shape[0],
            "activation": "relu"
        })
        for i in range(1, len(model.coefs_)):
            cw = model.coefs_[i].T
            cb = model.intercepts_[i]
            head["layers"].append({
                "weights": [round(float(v), 7) for v in cw.flatten()],
                "bias": [round(float(v), 7) for v in cb],
                "in_features": cw.shape[1],
                "out_features": cw.shape[0],
                "activation": "linear" if i == len(model.coefs_) - 1 else "relu"
            })

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
        "evaluation": f"per clip; a clip is detected if {rule_k} of {rule_n} consecutive windows (hop {args.hop} s) >= threshold anywhere in it",
        "features": args.features,
        "hop_s": args.hop,
        "augmented_training": bool(args.augment),
        "split": "GroupShuffleSplit by uploader/source recording: 64% train / 16% val / 20% test",
        "split_seed": used_seed,
        "threshold_rule": f"best validation recall with <= {args.fa_budget} false alarms/hour on validation walk-like negatives",
        "C": best_C,
        "train_clips": {"positives": int(clip_label[train_c].sum()), "negatives": int((clip_label[train_c] == 0).sum()),
                        "noisy_copies": int(len(train_aug)) if args.augment else 0},
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
