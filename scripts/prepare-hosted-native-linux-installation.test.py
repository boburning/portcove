"""Materialization contracts; no root, account, package install or candidate."""
import copy
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installation", Path(__file__).with_name("prepare-hosted-native-linux-installation.py"))
installation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installation)


def plan():
    tool = {"path": "/home/runner/private/bin/node", "bytes": 1, "sha256": "a" * 64}
    return {"schema_version": 1, "binding": "a" * 64, "source_commit": "b" * 40,
            "source_tree": "c" * 40, "harness_sha256": "d" * 64,
            "broker_uid": 1001, "broker_pid": 123,
            "broker_identity": "linux:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:123:999",
            "deadline_ns": str(time.monotonic_ns() + 1000000000), "tools": {"node": tool, "driver": dict(tool)},
            "context": {"GITHUB_SHA": "e" * 40, "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
                        "GITHUB_WORKFLOW_REF": "boburning/portcove/.github/workflows/application-update-production.yml@refs/tags/portcove-production-controller-fixture"}}


class Installation(unittest.TestCase):
    def test_closed_plan_refuses_supplied_destination_and_source_aliases(self):
        valid = plan()
        self.assertEqual(installation.inspect_plan(valid), valid)
        for change in ({"schema_version": True}, {"destination": "/tmp/replacement"},
                       {"source_commit": "main"}, {"broker_uid": 0}, {"deadline_ns": "unbounded"}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                installation.inspect_plan({**valid, **change})
        for path in ("/tmp/node", "/home/runner/../other/node", "relative/node"):
            altered = copy.deepcopy(valid)
            altered["tools"]["node"]["path"] = path
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                installation.inspect_plan(altered)

    def test_original_deadline_and_parent_generation_refuse_before_effects(self):
        expired = {**plan(), "deadline_ns": "1"}
        with patch.object(installation, "generation") as generation:
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                installation.fence(expired)
            generation.assert_not_called()
        with patch.object(installation, "generation", return_value="different generation"), \
                self.assertRaisesRegex(RuntimeError, "parent changed"):
            installation.fence(plan())

    def test_git_has_no_network_lazy_fetch_hooks_or_shared_clone(self):
        calls = []
        with patch.object(installation, "command", side_effect=lambda arguments, check: calls.append(arguments)):
            installation.git(["status"], lambda: None)
        self.assertIn("protocol.allow=never", calls[0])
        self.assertIn("protocol.file.allow=always", calls[0])
        self.assertIn("uploadpack.packObjectsHook=", calls[0])
        self.assertEqual(installation.ENV["GIT_NO_LAZY_FETCH"], "1")
        self.assertNotIn("GH_TOKEN", installation.ENV)


@unittest.skipUnless(sys.platform == "linux", "actual Linux file/link custody contracts")
class DependencyGraph(unittest.TestCase):
    def test_installed_worktree_checks_refuse_actual_git_index_masks(self):
        for mask in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(mask=mask), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                def git(*arguments, root=root):
                    return installation.git(["-C", str(root), *arguments], lambda: None)
                git("init", "--quiet")
                (root / "inert.py").write_text("original bytes")
                git("add", "inert.py")
                git("-c", "user.name=Inert fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "inert initial source")
                pins = {"source_commit": git("rev-parse", "HEAD"), "source_tree": git("rev-parse", "HEAD^{tree}")}
                installation.verify_installed_source(root, pins, lambda: None)
                git("update-index", mask, "inert.py")
                (root / "inert.py").write_text("modified bytes")
                self.assertEqual(git("status", "--porcelain", "--untracked-files=no"), "")
                with self.assertRaisesRegex(RuntimeError, "command refused"):
                    installation.verify_installed_source(root, pins, lambda: None)

    def fixture(self, root):
        source, target = root / "source", root / "target"
        source.mkdir()
        (source / "node_modules/package").mkdir(parents=True)
        (source / "apps/desktop/node_modules").mkdir(parents=True)
        (target / "apps/desktop").mkdir(parents=True)
        (source / "node_modules/package/index.js").write_text("public dependency")
        (source / "apps/desktop/node_modules/package").symlink_to("../../../node_modules/package")
        return source, target

    def test_complete_graph_is_rebased_without_external_or_hard_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = self.fixture(Path(temporary))
            records, total = installation.dependency_snapshot(source, (os.getuid(),), lambda: None)
            installation.copy_dependencies(source, target, records, (os.getuid(),), os.getuid(), os.getgid(), lambda: None)
            self.assertEqual(total, len("public dependency"))
            self.assertEqual((target / "apps/desktop/node_modules/package").resolve(), target / "node_modules/package")
            self.assertEqual((target / "node_modules/package/index.js").read_text(), "public dependency")
            self.assertEqual((target / "node_modules/package/index.js").stat().st_nlink, 1)
            self.assertNotEqual((target / "node_modules/package/index.js").stat().st_ino,
                                (source / "node_modules/package/index.js").stat().st_ino)

    def test_escape_cycle_changed_link_and_changed_bytes_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = self.fixture(Path(temporary))
            outside = Path(temporary) / "outside"
            outside.write_text("outside")
            link = source / "node_modules/escape"
            link.symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                installation.dependency_snapshot(source, (os.getuid(),), lambda: None)
            self.assertFalse((target / "node_modules").exists())
            link.unlink()
            link.symlink_to("escape")
            with self.assertRaises((RuntimeError, OSError)):
                installation.dependency_snapshot(source, (os.getuid(),), lambda: None)
            link.unlink()
            records, _ = installation.dependency_snapshot(source, (os.getuid(),), lambda: None)
            (source / "node_modules/package/index.js").write_text("changed")
            with self.assertRaisesRegex(RuntimeError, "changed after preflight"):
                installation.copy_dependencies(source, target, records, (os.getuid(),), os.getuid(), os.getgid(), lambda: None)
            self.assertFalse((target / "node_modules/package/index.js").exists())

    def test_file_count_byte_and_foreign_writer_bounds(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, _ = self.fixture(Path(temporary))
            for field, value in (("MAX_FILES", 1), ("MAX_BYTES", 1)):
                with self.subTest(field=field), patch.object(installation, field, value), self.assertRaisesRegex(RuntimeError, "bound"):
                    installation.dependency_snapshot(source, (os.getuid(),), lambda: None)
            (source / "node_modules/package/index.js").chmod(0o666)
            with self.assertRaisesRegex(RuntimeError, "writer|custody"):
                installation.dependency_snapshot(source, (os.getuid(),), lambda: None)


if __name__ == "__main__":
    unittest.main()
