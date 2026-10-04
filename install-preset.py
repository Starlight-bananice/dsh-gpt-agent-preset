#!/usr/bin/env python3
"""
Install the `gpt` Agent preset into a DSH 0.2.x profile.

WHY THIS SCRIPT EXISTS
----------------------
DSH 0.1.x discovered Agent presets by scanning `<dshHome>/.agent-presets/<id>/`
for an `agent.cordis.yml`. DSH 0.2.x retired that: `@deepseek-ai/dsh-agent-presets`
no longer ships, the registry "neither scans directories nor accepts preset
paths", and a preset is now a *bundle patch* — an `insert` of a
`@deepseek-ai/dsh-agent-preset` row into the profile's `cordis.patch.yml`
(patch entries carrying no `name` are appended to the top-level entry list).
A preset authored into the old directory is inert: it shows up nowhere.

This script converts the authored composition into that patch entry:

  * rows are copied verbatim, except platform-conditional `!!js` expressions,
    which are resolved to concrete booleans for the host running the script
    (an `insert` payload is plain YAML, so shipping the expression would make
    the whole patch fail to parse);
  * the `gpt-guardrails` row's relative `./` path is rewritten to the absolute
    path of the checked-in plugin file, because a profile patch row is not
    resolved from a preset directory;
  * the profile patch is backed up, the entry is appended under
    "custom Agent presets", and the result is re-parsed to prove it is valid.

Idempotent: re-running replaces the previously installed entry instead of
appending a second copy.

USAGE
-----
    python3 install-preset.py [--profile desktop] [--dry-run]

The running app picks the declaration up live — reopen Settings → Agent 预设
and the preset is on the roster. `~/.dsh/.agent-presets/` is NOT involved on
0.2.x, so nothing needs to be copied there.
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import sys
import time
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
COMPOSITION = HERE / "agent.cordis.yml"
GUARDRAILS = HERE / "gpt-guardrails.mjs"

PRESET_ID = "gpt"
PRESET_NAME = "GPT 执行优先"
PRESET_DESCRIPTION = (
    "为 OpenAI GPT 模型（ChatGPT / openai-codex 提供方）调优：规划类工具按轮次限额、"
    "重复调用即时打断、明确工具分工，避免 GPT 在 get_goal / todo_write 上空转而不落地实现。"
)
PRESET_ORDER = 50

MARKER_BEGIN = "# >>> gpt preset (installed by install-preset.py) >>>"
MARKER_END = "# <<< gpt preset <<<"


class JsExpr(str):
    """Marker for a resolved `!!js` expression (kept as a plain string)."""


def _js_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> JsExpr:
    return JsExpr(loader.construct_scalar(node))


def load_composition(path: Path) -> list:
    loader = yaml.SafeLoader
    loader.add_constructor("tag:yaml.org,2002:js", _js_constructor)
    with path.open(encoding="utf-8") as handle:
        rows = yaml.load(handle, Loader=loader)
    if not isinstance(rows, list) or not rows:
        raise SystemExit(f"{path}: expected a non-empty list of plugin rows")
    return rows


def evaluate_condition(expr: str) -> bool:
    """Evaluate a `!!js` condition for THIS host.

    The expressions shipped in this preset are platform tests written in
    JavaScript. Only the strict-equality operators are translated; anything
    else is rejected rather than guessed at, so an unrecognized condition can
    never be silently resolved to the wrong value (which would flip a tool row
    on or off without anyone noticing).
    """
    if "process.platform" not in expr:
        raise SystemExit(f"unsupported !!js condition: {expr!r} — resolve it by hand")
    allowed = re.fullmatch(
        r"\s*process\.platform\s*(===|!==|==|!=)\s*'([a-z0-9]+)'\s*", expr
    )
    if allowed is None:
        raise SystemExit(f"unsupported !!js condition: {expr!r} — resolve it by hand")
    operator, expected = allowed.groups()
    actual = sys.platform
    if actual.startswith("linux"):
        actual = "linux"
    if operator in ("===", "=="):
        return actual == expected
    return actual != expected


def resolve_rows(rows: list) -> list:
    """Copy rows, resolving platform conditions and repo-relative plugin paths."""
    resolved = []
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit(f"unexpected row shape: {row!r}")
        new_row = {}
        for key, value in row.items():
            if key == "name" and isinstance(value, str) and value.startswith("./"):
                target = (HERE / value[2:]).resolve()
                if not target.is_file():
                    raise SystemExit(f"plugin file referenced by row {row.get('id')!r} not found: {target}")
                new_row[key] = str(target)
            elif key == "disabled" and isinstance(value, JsExpr):
                new_row[key] = evaluate_condition(str(value))
            else:
                new_row[key] = value
        resolved.append(new_row)
    return resolved


def build_entry(rows: list) -> dict:
    return {
        "insert": [
            {
                "id": f"preset-{PRESET_ID}",
                "name": "@deepseek-ai/dsh-agent-preset",
                "config": {
                    "id": PRESET_ID,
                    "name": PRESET_NAME,
                    "description": PRESET_DESCRIPTION,
                    "order": PRESET_ORDER,
                    "plugins": rows,
                },
            }
        ]
    }


def strip_previous_block(text: str) -> str:
    """Drop a previously installed block so re-running stays idempotent."""
    pattern = re.compile(
        rf"\n?{re.escape(MARKER_BEGIN)}.*?{re.escape(MARKER_END)}\n?",
        re.DOTALL,
    )
    return pattern.sub("\n", text)


class PresetDumper(yaml.SafeDumper):
    """Indent block sequences under their key, matching the profile's style."""

    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow, False)


def _represent_str(dumper: PresetDumper, data: str):
    """Render multi-line prose as a block scalar instead of an escaped one-liner."""
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


PresetDumper.add_representer(str, _represent_str)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", default="desktop", help="profile name under <dshHome>/profiles (default: desktop)")
    parser.add_argument("--dsh-home", default=os.environ.get("DSH_HOME") or str(Path.home() / ".dsh"))
    parser.add_argument("--dry-run", action="store_true", help="print the entry without touching the profile")
    args = parser.parse_args()

    if not COMPOSITION.is_file():
        raise SystemExit(f"missing composition: {COMPOSITION}")
    if not GUARDRAILS.is_file():
        raise SystemExit(f"missing guard plugin: {GUARDRAILS}")

    rows = resolve_rows(load_composition(COMPOSITION))
    entry = build_entry(rows)
    block = (
        f"{MARKER_BEGIN}\n"
        f"# Generated from {COMPOSITION} — edit there, then re-run install-preset.py.\n"
        + yaml.dump([entry], Dumper=PresetDumper, allow_unicode=True, sort_keys=False, default_flow_style=False, width=1000)
        + f"{MARKER_END}\n"
    )

    if args.dry_run:
        print(block)
        return 0

    patch = Path(args.dsh_home) / "profiles" / args.profile / "cordis.patch.yml"
    if not patch.is_file():
        raise SystemExit(f"no such profile patch: {patch}")

    original = patch.read_text(encoding="utf-8")
    stripped = strip_previous_block(original).rstrip("\n")
    updated = f"{stripped}\n\n{block}"

    # Prove the patch parses BEFORE writing: a malformed profile patch would
    # break the whole app boot, not just this preset.
    loader = yaml.SafeLoader
    loader.add_constructor("tag:yaml.org,2002:js", _js_constructor)
    try:
        parsed = yaml.load(updated, Loader=loader)
    except yaml.YAMLError as error:
        raise SystemExit(f"refusing to write: patched profile does not parse: {error}") from error
    if not isinstance(parsed, list):
        raise SystemExit("refusing to write: profile patch must stay a top-level list")

    backup = patch.with_name(f"{patch.name}.bak-gpt-preset-{int(time.time())}")
    shutil.copy2(patch, backup)
    patch.write_text(updated, encoding="utf-8")

    print(f"installed preset {PRESET_ID!r} into {patch}")
    print(f"backup: {backup}")
    print(f"rows declared: {len(rows)} | patch entries now: {len(parsed)}")
    print("the registry picks this up live — reopen Settings → Agent 预设 (no restart needed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
