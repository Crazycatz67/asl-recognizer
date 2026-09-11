"""Start a tooney session against the ASL repo and stream it to the terminal.

    python tools/agent/run.py "sweep transition.js settle thresholds and recommend one"

Run tools/agent/setup.py once first. A session mounts the repo fresh from
GitHub, so push before running or the agent analyses stale code.

Flags:
    --budget-cents N   hard spend cap for the session (default 500 = $5.00)
    --no-smoke         skip the Node availability probe
    --branch NAME      branch to mount (default main)
"""

import argparse
import json
import os
import pathlib
import sys
import time

import anthropic

HERE = pathlib.Path(__file__).parent
IDS_FILE = HERE / ".ids.json"

REPO_URL = "https://github.com/Crazycatz67/asl-recognizer"
MOUNT_PATH = "/workspace/repo"

# The sandbox dependency that fails on first use, not at session creation:
# we need Node to run the project's real ES modules.
SMOKE_PROBE = (
    "Do not start the analysis task yet. Just report, in a few lines: "
    "the output of `node --version` (or that node is missing), and confirm you "
    f"can see {MOUNT_PATH}/js/transition.js and {MOUNT_PATH}/data/fs_sequences.json."
)


def stream_until_done(client, session_id: str) -> str | None:
    """Print agent output; return the stop_reason that ended the turn."""
    with client.beta.sessions.events.stream(session_id=session_id) as stream:
        for event in stream:
            if event.type == "agent.message":
                for block in event.content:
                    if block.type == "text":
                        print(block.text, end="", flush=True)
            elif event.type == "session.status_terminated":
                print("\n[session terminated]")
                return "terminated"
            elif event.type == "session.status_idle":
                reason = getattr(event.stop_reason, "type", None)
                # Idle alone is not "done" - it goes idle transiently whenever it
                # needs something from us. Only a non-requires_action reason ends it.
                if reason == "requires_action":
                    continue
                print(f"\n[idle: {reason}]")
                return reason
    return None


def send(client, session_id: str, text: str) -> None:
    client.beta.sessions.events.send(
        session_id=session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": text}]}],
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("task", help="what you want tooney to do")
    ap.add_argument("--budget-cents", type=int, default=500)
    ap.add_argument("--no-smoke", action="store_true")
    ap.add_argument("--branch", default="main")
    args = ap.parse_args()

    if not IDS_FILE.exists():
        print("No .ids.json - run tools/agent/setup.py first.", file=sys.stderr)
        return 1
    ids = json.loads(IDS_FILE.read_text(encoding="utf-8"))

    client = anthropic.Anthropic()

    repo = {
        "type": "github_repository",
        "url": REPO_URL,
        "mount_path": MOUNT_PATH,
        "branch": args.branch,
    }
    # Public repo needs no token; supply one if the repo is ever made private.
    if os.environ.get("GITHUB_TOKEN"):
        repo["authorization_token"] = os.environ["GITHUB_TOKEN"]

    session = client.beta.sessions.create(
        agent={"type": "agent", "id": ids["agent_id"], "version": ids["agent_version"]},
        environment_id=ids["environment_id"],
        title=args.task[:80],
        resources=[repo],
        # Hard dollar cap. amount is MINOR UNITS as an integer string: "500" = $5.00.
        budget={
            "type": "limit",
            "max_list_cost": {"amount": str(args.budget_cents), "currency": "USD"},
        },
    )
    print(f"session {session.id}")
    print(f"watch: https://platform.claude.com/workspaces/default/sessions/{session.id}\n")

    # Smoke test first - Node's absence would otherwise surface halfway through
    # a long task, after spending money on it.
    if not args.no_smoke:
        print("--- smoke test ---")
        send(client, session.id, SMOKE_PROBE)
        reason = stream_until_done(client, session.id)
        if reason in ("terminated", "retries_exhausted", "budget_reached"):
            print(f"\nSmoke test ended early ({reason}) - stopping.", file=sys.stderr)
            return 1
        ok = input("\nDid that look right? Continue with the real task? [y/N] ").strip().lower()
        if ok != "y":
            print("Stopped. Session left open for inspection.")
            return 0

    print("\n--- task ---")
    send(client, session.id, args.task)
    stream_until_done(client, session.id)

    # Output files land in /mnt/session/outputs/. Indexing lags idle by a second or two.
    out_dir = HERE / "outputs" / session.id
    for attempt in range(3):
        files = client.beta.files.list(scope_id=session.id, betas=["managed-agents-2026-04-01"])
        if files.data:
            out_dir.mkdir(parents=True, exist_ok=True)
            for f in files.data:
                client.beta.files.download(f.id).write_to_file(out_dir / f.filename)
                print(f"saved {out_dir / f.filename}")
            break
        if attempt < 2:
            time.sleep(2)
    else:
        print("(no output files)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
