#!/usr/bin/env python3
"""Check that a branch carries a changeset note, the same gate as changeset-check.yml.

Exit 0 when the diff against the base adds or modifies a .changeset/*.md note
(README.md excluded). With --fix, write an empty changeset when none is present,
the way `npm run changeset -- --empty` does. Exit 1 otherwise.
"""

from __future__ import annotations

import argparse
import secrets
import subprocess
import sys
from pathlib import Path

CHANGESET_DIR = ".changeset"
EXCLUDED_NAMES = frozenset({"README.md"})
EMPTY_CHANGESET = "---\n---\n"


def changed_files(repo: Path, base: str) -> list[str]:
    """Return paths added or modified between the merge base and HEAD."""
    result = subprocess.run(
        ["git", "-C", str(repo), "diff", "--name-only", "--diff-filter=AM", f"{base}...HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"git diff against {base} failed: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def has_changeset(files: list[str]) -> bool:
    """True when the diff touches a changeset note other than the directory README."""
    return any(
        file.startswith(f"{CHANGESET_DIR}/")
        and file.endswith(".md")
        and Path(file).name not in EXCLUDED_NAMES
        for file in files
    )


def write_empty_changeset(repo: Path) -> Path:
    """Write an empty changeset with a random name and return its path."""
    path = repo / CHANGESET_DIR / f"preflight-{secrets.token_hex(4)}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(EMPTY_CHANGESET, encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".", help="worktree to check (default: current directory)")
    parser.add_argument("--base", default="origin/main", help="base ref the branch is compared with")
    parser.add_argument(
        "--fix",
        action="store_true",
        help="when no changeset is present, write an empty one (docs and tooling changes only)",
    )
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    if has_changeset(changed_files(repo, args.base)):
        print(f"changeset present in the diff against {args.base}")
        return 0

    if not args.fix:
        print(
            f"no changeset in the diff against {args.base}. Add a note with "
            "`npm run changeset`, or rerun with --fix for a docs or tooling change.",
            file=sys.stderr,
        )
        return 1

    path = write_empty_changeset(repo)
    print(f"wrote empty changeset {path.relative_to(repo)}; git add and commit it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
