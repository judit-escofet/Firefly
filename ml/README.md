# Guardian ML (P2)

Trains the scream classifier that runs in the phone browser, and measures it honestly.

```
YAMNet (frozen, 1024-d embedding per 0.96 s window)  →  logistic regression  →  scream_head.json
```

The browser computes `sqrt(sigmoid(w · embedding + b) × YAMNet scream score)` every 0.24 s and
starts the countdown when **2 of the last 3 windows** reach the threshold (see "Results" for
why the fusion and the 0.24 s hop; both are recorded in `scream_head.json`). Python uses the same resampler
(`resample.py` ⇄ `app/src/guardian/audio/resampler.js`), the same 15600-sample / 7680-hop
framing, and the same trigger rule, so the numbers in `metrics.json` describe what runs on the phone.

## Setup

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
```

## Data (public, openly licensed; credits in `data/ATTRIBUTION.csv`)

```bash
mkdir -p ml/raw/fsd50k && cd ml/raw
# ESC-50 (2,000 × 5 s everyday sounds, CC-BY-NC)
curl -L -o esc50.zip https://github.com/karoldvl/ESC-50/archive/master.zip && unzip -q esc50.zip
# FSD50K labels + metadata (Zenodo 4060432)
curl -L -o gt.zip   "https://zenodo.org/api/records/4060432/files/FSD50K.ground_truth.zip/content" && unzip -q gt.zip
curl -L -o meta.zip "https://zenodo.org/api/records/4060432/files/FSD50K.metadata.zip/content" && unzip -q meta.zip
# FSD50K audio (Opus mirror on Hugging Face, 48 parquet shards, ~2.8 GB)
curl -s https://huggingface.co/api/datasets/yanei/fsd50k | python3 -c "import json,sys;[print(s['rfilename']) for s in json.load(sys.stdin)['siblings'] if s['rfilename'].endswith('.parquet')]" \
  | xargs -P 8 -I{} sh -c 'curl -sL -o "fsd50k/$(basename {})" "https://huggingface.co/datasets/yanei/fsd50k/resolve/main/{}"'
cd ../.. && ml/.venv/bin/python ml/prepare_data.py
```

| Set | What | Used for |
| --- | --- | --- |
| `data/positive/fsd50k` | FSD50K "Screaming" clips not tagged as playful (horror, fear, pain…) | train / val / test |
| `data/negative/fsd50k` | playful screams (kids, fans, cheering) + 50 walk-home classes: laughter, crowds, kids talking, sirens, horns, traffic, footsteps, speech, music, phones, dogs, wind… | train / val / test |
| `data/negative/esc50` | ESC-50 folds 1–4 | train / val / test |
| `background/public_*.wav` | ESC-50 fold 5 + FSD50K **eval-split** everyday clips, concatenated (≈ 5.4 h) | false alarms only |
| `data/positive/team`, `data/negative/team`, `background/` | **your own recordings**: drop files in, rerun embed → train → false_alarms | everything |

Shout/Yell clips are left out of both classes (a shouted "help!" is distress; a shouted
"over here!" isn't). Splits are by *group* (Freesound uploader / ESC-50 source recording /
file), so one person's near-identical takes can never be in both train and test.

**Honest caveat:** the background set is a proxy built from short public clips. The plan's
G4 asks for 60+ min of a real campus walk, hall, music and cafeteria. Record that, put it in
`ml/background/`, and rerun `false_alarms.py` before quoting the number.

## Pipeline

```bash
ml/.venv/bin/python ml/embed.py --in ml/data --out ml/embeddings.npz
ml/.venv/bin/python ml/train.py --embeddings ml/embeddings.npz --out app/public/models/scream_head.json
ml/.venv/bin/python ml/false_alarms.py --audio ml/background/ --head app/public/models/scream_head.json
```

`train.py` and `false_alarms.py` both write into `ml/metrics.json` (the pitch numbers, plus a
`details` block: split sizes, chosen C, which test negatives fired, which screams were missed,
and the timestamp of every background false alarm so you can listen back).

## Results so far (public data only, 2026-10-03)

Test set: 59 scream clips + 908 negative clips, held out by uploader. Background: 5.38 h never
used in training (4.21 h everyday sounds + 1.17 h crowds/cheering/laughter/playful screams).

| | **Current model** | Previous (0.48 s hop) | YAMNet-only (spec stage A) | Target |
| --- | --- | --- | --- | --- |
| Recall (test clips) | **0.71** | 0.59 | 0.29 | ≥ 0.85 (G3) ❌ |
| Precision (test clips) | 0.58 | 0.63 | 0.85 | |
| False alarms / h, all background | 10.4 | 6.1 | 0.37 | ≤ 1 (G4) ❌ |
| … everyday sounds | 6.4 | 3.6 | 0.48 | |
| … crowds / cheering / playful screams | 24.7 | 15.3 | 0.0 | |
| Scream → trigger (test scream, 8 window alignments) | **1.8–1.9 s, 8/8 caught** | 1.9–5 s, 6/8 caught | | < 2 s (G6) |

Current model = `scream_head.json`: YAMNet embedding → logistic regression (trained with
3 noisy outdoor copies of every scream), fused with YAMNet's own scream score
(`sqrt(p × yamnet)`), evaluated every **0.24 s**, trigger when **2 of the last 3** windows ≥ 0.40.

What we learned (all choices made on the validation split, never on test or background):

1. **Plain logistic regression at 90 % recall**: 68.7 false alarms/h. Unusable.
2. **Fusing with YAMNet's scream score** halved everyday false alarms at the same recall.
3. **0.24 s hop instead of 0.48 s** was the biggest win: at 0.48 s a 1 s scream only covers
   about two windows, so whether "2 of 3" fires depended on where the windows happened to fall
   (a clear test scream was missed at 2 of 8 alignments, and detection took up to 5 s).
   At 0.24 s it is caught at every alignment within ~1.9 s. Validation recall 0.57 → 0.73.
   Costs 2× inference, which is fine at ~7–12 ms per window on WASM.
4. No measurable gain from: hard-negative weighting, stricter positive windows, a small MLP,
   adding YAMNet's 521 class scores as features, other k-of-n rules, noise augmentation
   (kept anyway; it's cheap and aimed at outdoor conditions).
5. The validation false-alarm estimate (1.2 h) was optimistic: ≤ 1/h there became 6.4/h
   on the 4.2 h everyday background. Distress vs playful screams/cheering stays hard from 1 s.

**What would move the numbers next:**
- **Team recordings.** FSD50K screams are acted, often distant or clipped; a real scream near
  the phone (G6) is louder and cleaner. Put them in `data/positive/team/<person>-<session>/`.
- **Calibrate on real walks, not on the test set.** Record a few ordinary walks (≥ 30 min,
  separate from the 60 min used for G4), put them in `background/`, and pick the threshold
  from those runs: `false_alarms.py --threshold 0.5` etc. Raising the threshold trades recall
  for fewer false alarms; every alert still has the 10 s cancel window.
- Without retraining: `?threshold=0.5` in the URL or `localStorage["firefly.scream_threshold"]`.

To reproduce the current model:

```bash
ml/.venv/bin/python ml/embed.py --in ml/data --out ml/embeddings_v2.npz --augment 3
ml/.venv/bin/python ml/embed.py --in ml/data --out ml/embeddings_v2_off.npz --augment 3 --offset 3840
ml/.venv/bin/python ml/train.py --embeddings ml/embeddings_v2.npz --embeddings-offset ml/embeddings_v2_off.npz \
    --hop 0.24 --rule 2/3 --augment
ml/.venv/bin/python ml/false_alarms.py
```

## Browser ⇄ Python parity

```bash
ml/.venv/bin/python ml/parity.py      # writes app/public/parity/{clip.wav,python_embeddings.json}
cd app && npm run parity              # Node: JS resampler + TF.js YAMNet vs Python → PASS/FAIL
```

On a phone: `guardian-test.html` → **Parity check vs Python** (same check on the WebGL backend).

## Recording team clips (positives)

Warn people nearby first. Record outdoors at 1 m, 3 m and in a pocket; 2–3 s screams with a
few seconds of normal sound around them; save as wav (or m4a/webm if ffmpeg is installed) in
`ml/data/positive/team/<person>-<session>/`. Each subfolder is one split group, so takes from
the same session never end up in both train and test. Loose files directly in `team/` are
grouped one per file.
