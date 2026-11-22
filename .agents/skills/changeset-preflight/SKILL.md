---
name: changeset-preflight
description: Use before opening a pull request into main in a repo whose changeset-check workflow requires a .changeset note. Checks the diff against the base for a changeset and, with --fix, writes an empty one for docs or tooling changes.
status: candidate
side-effects: repo-write
---

# Changeset preflight

Run from the repo root:

```
python3 .agents/skills/changeset-preflight/scripts/changeset_preflight.py --base origin/main [--fix]
```

Exit 0 when the diff has a changeset, or when `--fix` wrote one. Exit 1 when none is present and `--fix` was not given. With `--fix`, the script writes `.changeset/preflight-<hex>.md` with empty front matter and stages or commits nothing.

Use `--fix` only for docs and tooling changes. A user-facing change needs a real note from `npm run changeset`.
