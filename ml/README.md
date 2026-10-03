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

Test set: 59 scream clips + 908 negative clips, held out by uploader (fixed; never used for
any choice). Background: 5.38 h never used in training (4.21 h everyday sounds + 1.17 h
crowds/cheering/laughter/playful screams).

| | **Current model** | Previous (thr 0.40, no context) | YAMNet-only (spec stage A) | Target |
| --- | --- | --- | --- | --- |
| Recall (test clips) | **0.64** | 0.71 | 0.29 | ≥ 0.85 (G3) ❌ |
| Precision (test clips) | 0.63 | 0.58 | 0.85 | |
| False alarms / h, all background | **3.2** | 10.4 | 0.37 | ≤ 1 (G4) ❌ |
| … everyday sounds | 2.9 | 6.4 | 0.48 | |
| … crowds / cheering / playful screams | 4.3 | 24.7 | 0.0 | |
| Cross-validated prediction (recall / everyday FA/h) | 0.60 / 2.9 | — | | matches test + background ✅ |

**Current model** (`scream_head.json`): YAMNet embedding of the current window **plus the two
previous windows** (~1 s of context) → logistic regression (trained with 3 noisy outdoor
copies of every scream), fused with YAMNet's own scream score (`sqrt(p × yamnet)`), every
0.24 s, trigger when 2 of the last 3 windows ≥ 0.495. Operating point "Balanced" (team choice):
~3 false countdowns per hour of everyday sounds.

### How it was chosen (and why earlier numbers moved around)

The first versions picked settings on a single 16 % validation split (44 screams, 1.2 h of
negatives). That turned out to be pure noise: dropping 2 clips reshuffled it and recall at
the false-alarm budget jumped from 0.75 to 0.35, and a threshold that looked like 0.8 false
alarms/h there gave 6.4/h on the background. **`cv.py` replaces it with 5-fold grouped
cross-validation** on everything except the fixed test split (269 screams, 5.8 h everyday +
1.3 h hard negatives, every clip scored by a model that never saw its uploader). Its estimates
now match the test set and the background (above).

Under cross-validation, at equal recall (everyday / hard false alarms per hour):

| Recall | no context | **+ 2 windows context** | + context + MLP |
| --- | --- | --- | --- |
| 0.65 | 4.3 / 62 | **3.9 / 64** | 3.6 / 56 |
| 0.70 | 6.5 / 83 | **5.7 / 80** | 5.8 / 86 |
| 0.75 | 10.3 / 122 | **8.9 / 111** | 8.1 / 101 |
| 0.80 | 14.8 / 164 | **12.7 / 156** | 12.5 / 152 |

- Kept: 0.24 s hop (biggest single win: screams caught regardless of window alignment),
  fusion with YAMNet's score (without it: 83 everyday false alarms/h), 2 windows of context
  (10–15 % fewer false alarms at equal recall).
- No real gain: regularisation strength, YAMNet class scores as features, hard-negative
  weighting, noise augmentation, other fusion weights; an MLP helps a little only at very
  high recall and is 100× bigger, so it stays optional (`train.py --model mlp`).
- **Operating points** (cross-validated, current model): ≤1 everyday false alarm/h →
  recall 0.47 (thr 0.59) · ≤2/h → 0.54 (0.54) · **≤3/h → 0.60 (0.495, shipped)** ·
  ≤5/h → 0.67 (0.42). Change in the browser with `?threshold=` or
  `localStorage["firefly.scream_threshold"]`.
- The test scream (`app/public/parity/scream_test.wav`) triggers 1.8–1.9 s after onset at
  6 of 8 window alignments with this threshold (all 8 at 0.40); it is a borderline clip.

**What would move the numbers next:** team recordings of real screams near the phone
(`data/positive/team/<person>-<session>/`) and real walks for calibration. Re-run cv.py with
them: everything above is about acted, often distant internet screams.

To reproduce the current model:

```bash
ml/.venv/bin/python ml/embed.py --in ml/data --out ml/embeddings_v2.npz --augment 3
ml/.venv/bin/python ml/embed.py --in ml/data --out ml/embeddings_v2_off.npz --augment 3 --offset 3840
ml/.venv/bin/python ml/cv.py --augment --context 2                         # compare settings
ml/.venv/bin/python ml/cv.py --augment --context 2 --fa-budget 3 --export  # train, test once, write head
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
