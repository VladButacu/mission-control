"""Tests for changeset_preflight against throwaway git repositories."""

from __future__ import annotations

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import changeset_preflight  # noqa: E402

GIT_IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *GIT_IDENTITY, *args], check=True, capture_output=True)


def _commit(repo: Path, rel: str, text: str = "x\n") -> None:
    target = repo / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    _git(repo, "add", rel)
    _git(repo, "commit", "-q", "-m", f"add {rel}")


def _run(repo: Path, *extra: str) -> tuple[int, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = changeset_preflight.main(["--repo", str(repo), "--base", "main", *extra])
    return code, out.getvalue() + err.getvalue()


class ChangesetPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        _commit(self.repo, "app.txt", "base\n")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _branch(self) -> None:
        _git(self.repo, "checkout", "-q", "-b", "feature")

    def test_changeset_in_diff_passes(self) -> None:
        self._branch()
        _commit(self.repo, ".changeset/brave-dogs.md", "---\n'pkg': patch\n---\n\nFix.\n")
        code, message = _run(self.repo)
        self.assertEqual(code, 0)
        self.assertIn("changeset present", message)

    def test_docs_only_diff_fails_without_fix(self) -> None:
        self._branch()
        _commit(self.repo, "docs/note.md", "text\n")
        code, message = _run(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("--fix", message)
        self.assertFalse((self.repo / ".changeset").exists())

    def test_changeset_directory_readme_does_not_count(self) -> None:
        self._branch()
        _commit(self.repo, ".changeset/README.md", "# Changesets\n")
        code, _ = _run(self.repo)
        self.assertEqual(code, 1)

    def test_deleted_changeset_does_not_count(self) -> None:
        _commit(self.repo, ".changeset/old-note.md", "---\n'pkg': patch\n---\n")
        self._branch()
        _git(self.repo, "rm", "-q", ".changeset/old-note.md")
        _git(self.repo, "commit", "-q", "-m", "remove old note")
        code, _ = _run(self.repo)
        self.assertEqual(code, 1)

    def test_fix_writes_empty_changeset_that_then_passes(self) -> None:
        self._branch()
        _commit(self.repo, "docs/note.md", "text\n")
        code, _ = _run(self.repo, "--fix")
        self.assertEqual(code, 0)
        written = list((self.repo / ".changeset").glob("preflight-*.md"))
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0].read_text(encoding="utf-8"), "---\n---\n")
        _git(self.repo, "add", ".changeset")
        _git(self.repo, "commit", "-q", "-m", "add empty changeset")
        code, _ = _run(self.repo)
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
