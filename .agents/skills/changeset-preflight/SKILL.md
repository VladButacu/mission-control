---
name: changeset-preflight
description: Use before opening any pull request into main in a repo whose changeset-check workflow requires a .changeset note. Checks that the diff against the base carries a changeset, and with --fix writes an empty one for docs or tooling changes, so the gate does not fail after the PR is opened.
status: candidate
side-effects: repo-write
version: 0.1.0
---

# Changeset preflight

## Contract

Inputs: `--repo` (worktree to check, default the current directory), `--base` (ref to compare with, default `origin/main`), `--fix` (optional flag).

Outputs: one line on stdout when a changeset is present. Without `--fix`, one line on stderr when none is present.

Side effects: with `--fix` and no changeset in the diff, writes one file, `.changeset/preflight-<hex>.md`, with empty front matter. Nothing is staged, committed or pushed. No git config is read or changed, and there is no network access.

Exit behavior: 0 when a changeset is present, or when `--fix` wrote one. 1 when none is present and `--fix` was not given. A failing `git diff` (for example a missing base ref) exits with its message.

## Example

```
python3 .agents/skills/changeset-preflight/scripts/changeset_preflight.py --base origin/main
python3 .agents/skills/changeset-preflight/scripts/changeset_preflight.py --base origin/main --fix
```

## Rules the script does not decide

- The gate counts any added or modified `.changeset/*.md` except `README.md`. A deleted changeset does not count.
- An empty changeset satisfies the gate and publishes nothing. Use `--fix` only for docs and tooling changes.
- A user-facing change needs a real note written with `npm run changeset`. Judging whether a change is user-facing is the agent's call, not the script's.

## Provenance

Extracted 2026-11-22. A branch opened from the conductor without this check failed the changeset gate on PR 12, after PRs 9 and 10 had also needed an empty changeset.
