"""Materialization contracts; no root, account, package install or candidate."""
import copy
import hashlib
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
    def test_public_acquisition_exact_inputs_and_changed_input_refusals(self):
        original_command = installation.command
        for alteration in (None, "source_tree", "harness_sha256"):
            with self.subTest(alteration=alteration), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                origin, destination = root / "origin", root / "destination"
                origin.mkdir()
                destination.mkdir()
                def git(*arguments, origin=origin):
                    return installation.git(["-C", str(origin), *arguments], lambda: None)
                git("init", "--quiet")
                harness = origin / "apps/desktop/scripts/desktop-test.mts"
                harness.parent.mkdir(parents=True)
                harness.write_text("inert reviewed harness")
                git("add", ".")
                git("-c", "user.name=Inert fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "inert source")
                selected = {**plan(), "source_commit": git("rev-parse", "HEAD"),
                            "source_tree": git("rev-parse", "HEAD^{tree}"),
                            "harness_sha256": hashlib.sha256(harness.read_bytes()).hexdigest()}
                if alteration:
                    selected[alteration] = "f" * len(selected[alteration])
                observed = []
                def local_transport(arguments, check, maximum_file_bytes=None, maximum_output_bytes=65536,
                                    observed=observed, destination=destination, origin=origin, selected=selected):
                    if "fetch" in arguments:
                        observed.append((arguments, maximum_file_bytes))
                        # Real Git mechanics using inert local objects only. The production
                        # invocation is captured separately; no provider success is inferred.
                        return original_command(["/usr/bin/git", "-c", "protocol.file.allow=always",
                            "-C", str(destination), "fetch", "--quiet", "--depth=1", "--no-tags",
                            str(origin), selected["source_commit"]], check, maximum_file_bytes)
                    return original_command(arguments, check, maximum_file_bytes, maximum_output_bytes)
                with patch.object(installation, "command", side_effect=local_transport):
                    if alteration:
                        with self.assertRaisesRegex(RuntimeError, "identity differs|harness differs"):
                            installation.acquire_public_checkout(destination, selected, lambda: None)
                    else:
                        installation.acquire_public_checkout(destination, selected, lambda: None)
                        self.assertEqual((destination / harness.relative_to(origin)).read_bytes(), harness.read_bytes())
                self.assertEqual(len(observed), 1)
                args, maximum = observed[0]
                self.assertEqual(args[-2:], ["https://github.com/boburning/portcove.git", selected["source_commit"]])
                self.assertEqual(maximum, 256 * 1024 ** 2)
                for fixed in ("http.followRedirects=false", "http.sslVerify=true", "credential.helper=",
                              "protocol.allow=never", "--no-recurse-submodules", "--no-tags", "--depth=1"):
                    self.assertIn(fixed, args)
                self.assertTrue(destination.exists(), "refusal must retain partial source")

    def test_source_tree_preflight_refuses_large_or_nonblob_contents(self):
        self.assertEqual(installation.inspect_source_tree("blob 1\nblob 2"), (2, 3))
        for inventory in ("", "commit 123", "blob 134217729", "blob 134217728\n" * 3,
                          "blob 1\n" * 32769):
            with self.subTest(inventory=inventory[:50]), self.assertRaises(RuntimeError):
                installation.inspect_source_tree(inventory)

    def test_source_acquisition_cannot_run_as_root_or_after_parent_expiry(self):
        with patch.object(installation, "fence") as fence, patch.object(installation.os, "getuid", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "non-root"):
                installation.acquire_source(plan())
            fence.assert_called_once()
        with patch.object(installation, "fence", side_effect=RuntimeError("original parent expired")), \
                patch.object(installation, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "parent expired"):
                installation.acquire_source(plan())
            command.assert_not_called()

    def test_missing_dependencies_refuse_before_privileged_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "native-source").mkdir()
            with patch.object(installation, "WORKSPACE", root), patch.object(installation, "fence"), \
                    patch.object(installation.os, "getuid", return_value=1001), \
                    patch.object(installation, "verify_installed_source"), \
                    patch.object(installation, "command") as command:
                with self.assertRaisesRegex(RuntimeError, "dependency root absent"):
                    installation.read_source_dependencies(plan())
                command.assert_not_called()
        caller = Path(__file__).with_name("release-hosted-native-installation.mts").read_text()
        self.assertLess(caller.index('"hosted-dependency-preflight"'), caller.index('"hosted-primitives"'))

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
