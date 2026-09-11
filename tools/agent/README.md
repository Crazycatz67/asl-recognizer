# tooney — the project's tuning/analysis agent

A [Claude Managed Agent](https://platform.claude.com) that runs sweeps, dataset
audits, and regression investigations against this repo in a hosted sandbox.
Anthropic runs the agent loop and the container; we just supply the config.

## What it's for

Open-ended work where you want judgment, not a fixed script:

- *"Sweep the `transition.js` settle thresholds and recommend one, with the tradeoff."*
- *"Audit the train/test split in `dataset.json` for group leakage."*
- *"Letter R regressed — find what changed."*

**What it is not for:** fixed, deterministic checks (does `sw.js` `CORE` match
the file tree, did `VERSION` get bumped, is the deployed site up). Those are a
free GitHub Action running Node — don't pay an agent to do them.

**What it structurally cannot do:** anything involving the live camera loop, or
any real-device matrix. The sandbox is one Linux container with no webcam. That
remains a human job.

## Setup (once)

```sh
pip install anthropic pyyaml
export ANTHROPIC_API_KEY=sk-ant-...      # or: ant auth login
python tools/agent/setup.py
```

Writes `.ids.json` (gitignored) with the agent + environment IDs. Agents are
persistent — created once, referenced by ID forever after. Re-run `setup.py`
after editing either YAML file to publish a new agent version in place.

## Running it

```sh
python tools/agent/run.py "sweep transition.js settle thresholds and recommend one"
```

- **Push first.** The session mounts the repo fresh from GitHub, so unpushed
  commits are invisible to it — it would analyse stale code and you'd never know.
- Every run is capped at **$5.00** by default (`--budget-cents`). At the cap the
  session pauses rather than dying; raise or remove the budget to resume.
- It runs a **smoke test first** (is Node in the sandbox? is the repo mounted?)
  and asks before spending money on the real task. `--no-smoke` skips it.
- Reports are written to `/mnt/session/outputs/` in the sandbox and downloaded
  to `tools/agent/outputs/<session-id>/`.

## The system prompt is the important part

`tooney.agent.yaml` carries the context this project paid for in blood. Most
critically: **`data/fs_sequences.json` uses MediaPipe Holistic landmarks while
the classifier is trained on HandLandmarker landmarks.** They are not
interchangeable, absolute accuracy off that replay is meaningless, and only
relative comparisons are valid. Without that in the prompt the agent will
confidently report "5% accuracy, your recognizer is broken" and send you chasing
a bug that does not exist.

It also records the disproven paths (the `refine.js` tie-breaker; retraining the
kNN on Kaggle landmarks) so they don't get re-explored, and the compute
discipline needed because the kNN is brute-force over ~29k vectors.

Edit that file when the project's hard-won knowledge changes.
