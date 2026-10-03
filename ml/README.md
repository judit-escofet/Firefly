# Guardian ML (P2)

Trains the scream classifier that runs in the phone browser, and measures it honestly.

```
YAMNet (frozen, 1024-d embedding per 0.96 s window)  →  logistic regression  →  scream_head.json
```

The browser computes `sqrt(sigmoid(w · embedding + b) × YAMNet scream score)` per window (see
"Results" for why the fusion) and starts the countdown when **2 of the last 3 windows** reach
the threshold. Python uses the same resampler
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

| | Fused classifier (thr 0.33) | YAMNet-only (thr 0.5) | Target |
| --- | --- | --- | --- |
| Recall (test clips) | **0.59** | 0.29 | ≥ 0.85 (G3) ❌ |
| Precision (test clips) | 0.63 | 0.85 | |
| False alarms / h, all background | **6.1** | 0.37 | ≤ 1 (G4) ❌ |
| … everyday sounds only | 3.6 | 0.48 | |
| … crowds / cheering / playful screams | 15.3 | 0.0 | |

What we learned (all decisions made on the validation split, never on test or background):

1. **Plain logistic regression, threshold picked for 90 % recall**: test recall 0.90 ✅, but
   68.7 false alarms/h on the background ❌❌. Unusable: a countdown every ~50 s.
2. Hard-negative weighting, stricter positive-window selection and a small MLP did not improve
   the recall ↔ false-alarm trade-off on validation.
3. **Fusing with YAMNet's own scream score** (geometric mean) halved everyday false alarms at
   the same recall. That's the exported model; threshold = best validation recall with
   ≤ 1 false alarm/h on validation everyday sounds.
4. Distress screams vs playful screams/cheering are hard to tell apart from 1 s of audio.
   Most remaining false alarms are crowds, cheering, kids and laughter.

**What would move the numbers:** the FSD50K screams are acted, film-style, often distant or
clipped. G6 is about a real scream *near the phone*, which should be louder and cleaner.
Team recordings (`data/positive/team/`) and 60 min of real walk audio (`background/`) are
the highest-value next step: rerun embed → train → false_alarms and the numbers update.

**Choosing the operating point** is a team call: `val_tradeoff_curve` in `metrics.json` lists
recall vs everyday false alarms per threshold. Try another threshold without retraining:
`?threshold=0.25` in the URL or `localStorage["firefly.scream_threshold"]`, or retrain with
`train.py --fa-budget 3`. Every alert still has the 10 s cancel window.

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
