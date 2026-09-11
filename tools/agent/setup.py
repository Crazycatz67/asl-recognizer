"""ONE-TIME SETUP - run once, then keep the IDs.

Creates (or updates) the `tooney` agent + its environment from the YAML files
next to this script, and writes the IDs to .ids.json (gitignored). Re-run after
editing a YAML file to publish a new agent version.

    pip install anthropic pyyaml
    python tools/agent/setup.py

Agents are persistent. Never create one per run - run.py reads the saved IDs.
"""

import json
import pathlib
import sys

import anthropic
import yaml

HERE = pathlib.Path(__file__).parent
IDS_FILE = HERE / ".ids.json"
AGENT_YAML = HERE / "tooney.agent.yaml"
ENV_YAML = HERE / "tooney.environment.yaml"


def main() -> int:
    client = anthropic.Anthropic()

    agent_cfg = yaml.safe_load(AGENT_YAML.read_text(encoding="utf-8"))
    env_cfg = yaml.safe_load(ENV_YAML.read_text(encoding="utf-8"))

    saved = json.loads(IDS_FILE.read_text(encoding="utf-8")) if IDS_FILE.exists() else {}

    # Environment: reuse if we already made one, else create.
    if saved.get("environment_id"):
        env_id = saved["environment_id"]
        print(f"reusing environment {env_id}")
    else:
        env = client.beta.environments.create(
            name=env_cfg["name"],
            config=env_cfg["config"],
        )
        env_id = env.id
        print(f"created environment {env_id}")

    # Agent: update in place so the ID stays stable across edits, else create.
    # `version` is deliberately omitted - this is a declarative apply of a
    # checked-in definition, so it should overwrite unconditionally.
    if saved.get("agent_id"):
        agent = client.beta.agents.update(
            agent_id=saved["agent_id"],
            name=agent_cfg["name"],
            model=agent_cfg["model"],
            system=agent_cfg["system"],
            tools=agent_cfg["tools"],
        )
        print(f"updated agent {agent.id} -> version {agent.version}")
    else:
        agent = client.beta.agents.create(
            name=agent_cfg["name"],
            model=agent_cfg["model"],
            system=agent_cfg["system"],
            tools=agent_cfg["tools"],
        )
        print(f"created agent {agent.id} version {agent.version}")

    IDS_FILE.write_text(
        json.dumps(
            {
                "agent_id": agent.id,
                "agent_version": agent.version,
                "environment_id": env_id,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"wrote {IDS_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
