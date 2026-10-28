import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory(prefix="agent-config-test-")
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.codex = self.root / "codex config"
        self.claude = self.root / "claude config"
        self.pi = self.root / "pi agent"

    def run_install(self, *options, repo=REPO):
        return subprocess.run(
            [
                "/bin/bash", str(repo / "install.sh"),
                "--codex-dir", str(self.codex),
                "--claude-dir", str(self.claude),
                "--pi-dir", str(self.pi), *options,
            ],
            capture_output=True, text=True,
        )

    def assert_link(self, path, source):
        self.assertTrue(path.is_symlink(), str(path))
        self.assertEqual(path.readlink(), source)
        self.assertEqual(path.resolve(), source.resolve())

    def skill_names(self):
        return sorted(p.name for p in (REPO / "skills").iterdir() if p.is_dir())

    def test_default_installs_all_clients_and_can_repeat(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for config, filename in [
            (self.codex, "AGENTS.md"),
            (self.claude, "CLAUDE.md"),
            (self.pi, "AGENTS.md"),
        ]:
            self.assert_link(config / filename, REPO / "AGENTS.md")
            for name in self.skill_names():
                self.assert_link(config / "skills" / name, REPO / "skills" / name)
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_single_client_does_not_install_the_other(self):
        for client, config, other, filename in [
            ("codex", self.codex, self.claude, "AGENTS.md"),
            ("claude", self.claude, self.codex, "CLAUDE.md"),
            ("pi", self.pi, self.codex, "AGENTS.md"),
        ]:
            with self.subTest(client=client):
                result = self.run_install("--target", client)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_link(config / filename, REPO / "AGENTS.md")
                self.assert_link(config / "skills/implementation-handoff", REPO / "skills/implementation-handoff")
                self.assertFalse(other.exists())
                others = [c for c in (self.codex, self.claude, self.pi) if c != config]
                for other_config in others:
                    self.assertFalse(other_config.exists())
                shutil.rmtree(config)

    def test_custom_codex_skills_directory_keeps_claude_separate(self):
        skills = self.root / "agents skills"
        result = self.run_install("--skills-dir", str(skills))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_link(skills / "deevid-tracking-doc", REPO / "skills/deevid-tracking-doc")
        self.assert_link(self.claude / "skills/deevid-tracking-doc", REPO / "skills/deevid-tracking-doc")
        self.assert_link(self.pi / "skills/deevid-tracking-doc", REPO / "skills/deevid-tracking-doc")
        self.assertFalse((self.codex / "skills").exists())

    def test_claude_conflicts_preserve_existing_items_before_any_install(self):
        for kind in ["file", "directory", "wrong-link", "broken-link"]:
            with self.subTest(kind=kind):
                self.claude = self.root / f"claude {kind}"
                conflict = self.claude / "skills/implementation-handoff"
                conflict.parent.mkdir(parents=True)
                if kind == "file":
                    conflict.write_text("keep existing content")
                elif kind == "directory":
                    conflict.mkdir()
                    (conflict / "keep.txt").write_text("keep existing content")
                else:
                    source = REPO / "skills/deevid-tracking-doc" if kind == "wrong-link" else self.root / "missing"
                    conflict.symlink_to(source, target_is_directory=True)
                result = self.run_install()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(str(conflict), result.stderr)
                self.assertFalse(self.codex.exists())
                self.assertFalse((self.claude / "CLAUDE.md").exists())
                self.assertFalse((self.pi / "AGENTS.md").exists())
                if kind == "file":
                    self.assertEqual(conflict.read_text(), "keep existing content")
                elif kind == "directory":
                    self.assertEqual((conflict / "keep.txt").read_text(), "keep existing content")
                else:
                    self.assertEqual(conflict.readlink(), source)
                shutil.rmtree(self.claude)

    def test_existing_indirect_rules_link_remains_usable(self):
        self.codex.mkdir()
        self.claude.mkdir()
        (self.codex / "AGENTS.md").symlink_to(REPO / "AGENTS.md")
        (self.claude / "CLAUDE.md").symlink_to(self.codex / "AGENTS.md")
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.claude / "CLAUDE.md").resolve(), REPO / "AGENTS.md")
        self.assert_link(self.pi / "AGENTS.md", REPO / "AGENTS.md")

    def test_invalid_options_do_not_create_directories(self):
        for options in [
            ("--target", "unknown"), ("--target",),
            ("--claude-dir", "relative"), ("--claude-dir",),
            ("--codex-dir", "relative"), ("--skills-dir", "relative"),
            ("--pi-dir", "relative"), ("--pi-dir",),
            ("--unknown",),
        ]:
            with self.subTest(options=options):
                result = self.run_install(*options)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.codex.exists())
                self.assertFalse(self.claude.exists())
                self.assertFalse(self.pi.exists())

    def test_missing_skill_entry_stops_before_install(self):
        repo = self.root / "incomplete repository"
        shutil.copytree(REPO, repo, ignore=shutil.ignore_patterns(".git"))
        (repo / "skills/implementation-handoff/SKILL.md").unlink()
        result = self.run_install(repo=repo)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SKILL.md", result.stderr)
        self.assertFalse(self.codex.exists())
        self.assertFalse(self.claude.exists())
        self.assertFalse(self.pi.exists())


if __name__ == "__main__":
    unittest.main()
