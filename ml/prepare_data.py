"""Builds ml/data/{positive,negative}/ and ml/background/ from public datasets.

Sources (both openly licensed, attribution in ml/data/ATTRIBUTION.csv):
  * FSD50K (Freesound, CC0 / CC-BY / CC-BY-NC / Sampling+), via the Hugging Face mirror
    yanei/fsd50k (Opus) + labels/metadata from Zenodo record 4060432.
  * ESC-50 (CC-BY-NC, github.com/karolpiczak/ESC-50).

Labelling
  positive   FSD50K "Screaming" clips that the uploader's title/tags/description don't mark as
             playful (horror, fear, pain, "woman scream"…)
  negative   playful screams (kids, playground, fans, cheering, celebrations), plus everyday
             walk-home sounds: laughter, cheering, crowds, kids talking, sirens, horns,
             traffic, vehicles, footsteps, speech, whispering, music, phones, dogs, birds,
             wind, rain… and all of ESC-50 folds 1–4.
  excluded   Shout / Yell (ambiguous: a shouted "help!" is distress) and Gunshot / Explosion.
  background ESC-50 fold 5 + FSD50K *eval-split* negatives, concatenated into 16 kHz WAVs
             (≥ 60 min). Never used for training. This is a PROXY for real walk-home audio:
             replace or extend with team recordings (campus walk, hall, cafeteria).

Team recordings: drop files into ml/data/positive/team/ or ml/data/negative/team/ (and long
ordinary recordings into ml/background/) — embed.py picks up everything in those folders.

  python ml/prepare_data.py          # expects ml/raw/ (see README for the download commands)
"""
import csv
import io
import json
import random
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

from common import HARD_CATEGORIES, ROOT, load_audio, to_16k

RAW = ROOT / "raw"
DATA = ROOT / "data"
BACKGROUND = ROOT / "background"
SEED = 7

PLAYFUL = re.compile(
    r"\b(play|playing|playground|kid|kids|child|children|baby|toddler|son|daughter|school|fun|funny|joy|"
    r"happy|excite\w*|cheer\w*|hooray|celebrat\w*|party|concert|fan|fans|fangirl|goal|stadium|"
    r"sport\w*|game|roller ?coaster|ride|amusement|college|wedding|laugh\w*|giggl\w*|tickl\w*|surprise)\b",
    re.I,
)
DISTRESS = re.compile(
    r"\b(horror|fear\w*|scared|scary|terror\w*|terrif\w*|frighten\w*|panic\w*|pain|agony|anguish|help|"
    r"murder\w*|kill\w*|death|dying|die|victim|attack\w*|distress|afraid|hurt|torture\w*|anger|angry)\b",
    re.I,
)
EXCLUDE = {"Shout", "Yell", "Gunshot_and_gunfire", "Explosion"}

# FSD50K negative classes (things heard on a walk home) and how many dev clips to take from each.
NEG_CLASSES = {
    "Laughter": 120, "Giggle": 40, "Chuckle_and_chortle": 40, "Cheering": 100, "Applause": 60, "Crowd": 100,
    "Chatter": 60, "Child_speech_and_kid_speaking": 100, "Crying_and_sobbing": 60, "Speech": 120,
    "Female_speech_and_woman_speaking": 60, "Male_speech_and_man_speaking": 60, "Conversation": 60,
    "Whispering": 60, "Singing": 60, "Female_singing": 40, "Male_singing": 40, "Music": 100,
    "Siren": 77, "Vehicle_horn_and_car_horn_and_honking": 115, "Traffic_noise_and_roadway_noise": 152,
    "Car_passing_by": 60, "Motorcycle": 40, "Bus": 40, "Truck": 40, "Bicycle_bell": 30, "Skateboard": 30,
    "Screech": 60, "Squeak": 40, "Walk_and_footsteps": 120, "Run": 80, "Keys_jangling": 40,
    "Ringtone": 60, "Telephone": 40, "Alarm": 60, "Dog": 60, "Bark": 60, "Bird": 40, "Gull_and_seagull": 30,
    "Wind": 60, "Rain": 40, "Slam": 40, "Door": 40, "Whoosh_and_swoosh_and_swish": 40, "Gasp": 30,
    "Breathing": 40, "Cough": 30, "Sneeze": 20, "Subway_and_metro_and_underground": 40, "Train": 40,
}
BACKGROUND_MIN = 64  # minutes


def fsd_tables():
    info = {}
    for split in ("dev", "eval"):
        info.update(json.load(open(RAW / f"FSD50K.metadata/{split}_clips_info_FSD50K.json")))
    rows = {}
    for split in ("dev", "eval"):
        for r in csv.DictReader(open(RAW / f"FSD50K.ground_truth/{split}.csv")):
            r["labels"] = r["labels"].split(",")
            r["fsd_split"] = split
            rows[r["fname"]] = r
    return rows, info


def is_playful(meta):
    """Title + tags only (descriptions are long and noisy). Distress words win over playful ones."""
    text = " ".join([meta.get("title", ""), " ".join(meta.get("tags", []))]).replace("-", " ").replace("_", " ")
    return bool(PLAYFUL.search(text)) and not DISTRESS.search(text)


def plan(rows, info):
    """→ dict fname → (role, category). role ∈ positive | negative | background."""
    rng = random.Random(SEED)
    chosen = {}
    for fname, r in rows.items():
        labels = set(r["labels"])
        if "Screaming" in labels:
            if is_playful(info[fname]):
                role = "negative" if r["fsd_split"] == "dev" else "background"
                chosen[fname] = (role, "playful_scream")
            else:
                chosen[fname] = ("positive", "scream")
    for cls, cap in NEG_CLASSES.items():
        for split, role, n in (("dev", "negative", cap), ("eval", "background", max(10, cap // 2))):
            pool = [
                f for f, r in rows.items()
                if r["fsd_split"] == split and cls in r["labels"] and f not in chosen
                and not (set(r["labels"]) & (EXCLUDE | {"Screaming"}))
            ]
            for f in rng.sample(sorted(pool), min(n, len(pool))):
                chosen[f] = (role, cls)
    return chosen


def extract_fsd(chosen, info):
    out_rows = []
    by_name = dict(chosen)
    bg_audio = []
    files = sorted((RAW / "fsd50k").glob("*.parquet"))
    if not files:
        raise SystemExit("ml/raw/fsd50k/*.parquet missing — see ml/README.md for the download command")
    for pf in files:
        t = pq.read_table(pf)
        names = t.column("name").to_pylist()
        idx = [i for i, n in enumerate(names) if Path(n).stem.rsplit("_", 1)[0] in by_name]
        if not idx:
            continue
        audio = t.column("audio")
        for i in idx:
            fname = Path(names[i]).stem.rsplit("_", 1)[0]
            role, cat = by_name[fname]
            raw = audio[i].as_py()
            raw = raw["bytes"] if isinstance(raw, dict) else raw
            meta = info[fname]
            lic = meta["license"].rstrip("/").split("/")[-2] if "creativecommons" in meta["license"] else meta["license"]
            attribution = {
                "file": "", "source": "FSD50K", "freesound_id": fname, "title": meta["title"],
                "uploader": meta["uploader"], "license": lic, "url": f"https://freesound.org/s/{fname}/",
                "role": role, "category": cat, "group": f"fsd_uploader:{meta['uploader']}",
            }
            if role == "background":
                x, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
                bg_audio.append((cat, to_16k(x.mean(axis=1), sr)))
                attribution["file"] = "background/*"
            else:
                path = DATA / role / "fsd50k" / f"{fname}.ogg"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                attribution["file"] = str(path.relative_to(ROOT))
            out_rows.append(attribution)
        print(f"  {pf.name}: {len(idx)} clips")
    return out_rows, bg_audio


def extract_esc50():
    esc = RAW / "ESC-50-master"
    rows, bg = [], []
    for r in csv.DictReader(open(esc / "meta/esc50.csv")):
        src = esc / "audio" / r["filename"]
        group = f"esc50_src:{r['src_file']}"
        row = {"source": "ESC-50", "freesound_id": r["src_file"], "title": r["category"], "uploader": "",
               "license": "CC-BY-NC", "url": f"https://freesound.org/s/{r['src_file']}/",
               "category": f"esc50:{r['category']}", "group": group}
        if r["fold"] == "5":
            x, sr = load_audio(src)
            bg.append((row["category"], to_16k(x, sr)))
            rows.append({**row, "file": "background/*", "role": "background"})
        else:
            dst = DATA / "negative" / "esc50" / r["filename"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            rows.append({**row, "file": str(dst.relative_to(ROOT)), "role": "negative"})
    return rows, bg


def write_background(chunks, minutes_per_file=8):
    """Shuffle background clips and concatenate into ~8-minute 16 kHz WAVs, kept in two sets:
    public_walk_*.wav (everyday walk-home sounds) and public_hard_*.wav (crowds, cheering,
    laughter, playful screams… see common.HARD_CATEGORIES), so false alarms can be reported per set."""
    rng = random.Random(SEED)
    rng.shuffle(chunks)
    BACKGROUND.mkdir(exist_ok=True)
    for old in BACKGROUND.glob("public_*.wav"):
        old.unlink()
    per_file = minutes_per_file * 60 * 16000
    total = 0
    for kind in ("walk", "hard"):
        sel = [x for cat, x in chunks if (cat in HARD_CATEGORIES) == (kind == "hard")]
        buf, n_file = [], 0
        for x in sel:
            buf.append(x)
            total += len(x)
            if sum(map(len, buf)) >= per_file:
                sf.write(BACKGROUND / f"public_{kind}_{n_file:02d}.wav", np.concatenate(buf), 16000, subtype="PCM_16")
                buf, n_file = [], n_file + 1
        if buf:
            sf.write(BACKGROUND / f"public_{kind}_{n_file:02d}.wav", np.concatenate(buf), 16000, subtype="PCM_16")
    return total / 16000 / 60


def main():
    for sub in ("positive/fsd50k", "negative/fsd50k", "negative/esc50"):
        shutil.rmtree(DATA / sub, ignore_errors=True)
    (DATA / "positive" / "team").mkdir(parents=True, exist_ok=True)
    (DATA / "negative" / "team").mkdir(parents=True, exist_ok=True)

    rows, info = fsd_tables()
    chosen = plan(rows, info)
    print("FSD50K plan:", Counter(r for r, _ in chosen.values()))
    fsd_rows, fsd_bg = extract_fsd(chosen, info)
    esc_rows, esc_bg = extract_esc50()

    bg = fsd_bg + esc_bg
    minutes = sum(len(x) for _, x in bg) / 16000 / 60
    if minutes < BACKGROUND_MIN:
        print(f"warning: only {minutes:.1f} min of background audio")
    minutes = write_background(bg)

    all_rows = fsd_rows + esc_rows
    with open(DATA / "ATTRIBUTION.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["file", "role", "category", "group", "source", "freesound_id", "title", "uploader", "license", "url"])
        w.writeheader()
        w.writerows(all_rows)

    counts = Counter((r["role"], r["source"]) for r in all_rows)
    print("clips:", dict(counts))
    print(f"background: {minutes:.1f} min in {BACKGROUND}")
    cats = defaultdict(int)
    for r in all_rows:
        if r["role"] == "negative":
            cats[r["category"]] += 1
    print("negative categories:", len(cats))


if __name__ == "__main__":
    main()
