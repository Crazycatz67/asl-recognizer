#!/usr/bin/env python3
"""
Import the Google "ASL Fingerspelling Recognition" competition data into the
formats this project uses.

  https://www.kaggle.com/competitions/asl-fingerspelling

You run this ONCE, locally. It is deliberately not a browser tool — parquet in
the browser is a dependency headache and this is a one-off.

    pip install pandas pyarrow
    # download + unzip the competition data somewhere, then:
    python tools/import_kaggle.py --data /path/to/asl-fingerspelling --n 300

Outputs (written into ./data/):
  fs_sequences.json   ~N sequences: {phrase, participant, frames:[[ [x,y,z]x21 ]...]}
                      -> the CONTINUOUS test set for js/decode.js and js/transition.js
                         (replay these instead of standing at a webcam)

Per-letter harvest for retraining (backlog B3, milestone M3) is a separate pass
and is left as a TODO at the bottom — it needs DTW alignment of the classifier's
predictions to the known phrase, which is easier to iterate on once the test set
above exists.
"""
import argparse, json, os, sys

HAND = [f"{ax}_right_hand_{i}" for ax in "xyz" for i in range(21)]
HAND_L = [f"{ax}_left_hand_{i}" for ax in "xyz" for i in range(21)]


def load_seq(pq, row):
    """Return frames [[ [x,y,z] x21 ] ...] for one sequence, or None."""
    import pandas as pd  # noqa
    df = pq[pq.index == row.sequence_id] if pq.index.name == "sequence_id" else pq.loc[[row.sequence_id]]
    if df.empty:
        return None
    # prefer whichever hand is populated in more frames
    r_ok = df[HAND].notna().all(axis=1).sum()
    l_ok = df[HAND_L].notna().all(axis=1).sum()
    cols = HAND if r_ok >= l_ok else HAND_L
    sub = df[cols].dropna()
    if len(sub) < 8:
        return None
    frames = []
    for _, fr in sub.iterrows():
        xs = fr[cols[0:21]].tolist()
        ys = fr[cols[21:42]].tolist()
        zs = fr[cols[42:63]].tolist()
        frames.append([[round(xs[i], 4), round(ys[i], 4), round(zs[i], 4)] for i in range(21)])
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="unzipped competition folder (has train.csv + train_landmarks/)")
    ap.add_argument("--n", type=int, default=300, help="how many sequences to keep")
    ap.add_argument("--max-frames", type=int, default=180, help="cap frames per sequence")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "fs_sequences.json"))
    args = ap.parse_args()

    try:
        import pandas as pd
    except ImportError:
        sys.exit("pip install pandas pyarrow")

    train_csv = os.path.join(args.data, "train.csv")
    if not os.path.exists(train_csv):
        sys.exit(f"no train.csv under {args.data}")
    meta = pd.read_csv(train_csv)
    # spread the pick across participants and phrase lengths
    meta = meta.sample(frac=1, random_state=7).sort_values("participant_id")
    picked, out, seen_pq = [], [], {}
    for _, row in meta.iterrows():
        if len(out) >= args.n:
            break
        pqpath = os.path.join(args.data, "train_landmarks", f"{row.file_id}.parquet")
        if not os.path.exists(pqpath):
            continue
        if pqpath not in seen_pq:
            seen_pq[pqpath] = pd.read_parquet(pqpath)
        pq = seen_pq[pqpath]
        try:
            frames = load_seq(pq, row)
        except Exception as e:
            print("skip", row.sequence_id, e)
            continue
        if not frames:
            continue
        if len(frames) > args.max_frames:
            step = len(frames) / args.max_frames
            frames = [frames[int(i * step)] for i in range(args.max_frames)]
        out.append({
            "phrase": str(row.phrase),
            "participant": int(row.participant_id),
            "frames": frames,
        })
        if len(out) % 25 == 0:
            print(f"  {len(out)}/{args.n}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"count": len(out), "source": "kaggle asl-fingerspelling", "sequences": out}, f)
    mb = os.path.getsize(args.out) / 1e6
    print(f"wrote {args.out}  ({len(out)} sequences, {mb:.1f} MB)")
    print("\nnext: load it in a lab page and replay each sequence through")
    print("js/transition.js -> js/decode.js, compare .text to .phrase (word accuracy).")


if __name__ == "__main__":
    main()

# TODO (B3 harvest pass, milestone M3):
#   for each sequence: run js/knn over every frame (or a JS port), DTW-align the
#   confident predictions to `phrase`, keep frames where prediction == aligned
#   letter at conf >= 0.8 -> append {label, v} rows to data/dataset.json with
#   group key = participant_id (so a signer can't straddle train/test). Then
#   retrain heads + re-export data/confusion.json.
