"""Materialization contracts; no root, account, package install or candidate."""
import copy
import hashlib
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
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
    def test_runtime_input_context_is_closed_and_cannot_select_paths_or_package_policy(self):
        raw = plan()
        runtime = {key: raw[key] for key in ("schema_version", "binding", "broker_uid", "broker_pid", "broker_identity", "deadline_ns", "context")}
        self.assertEqual(installation.inspect_runtime_inputs_plan(runtime), runtime)
        diagnostic = copy.deepcopy(runtime)
        diagnostic["context"]["GITHUB_WORKFLOW_REF"] = "boburning/portcove/.github/workflows/hosted-native-linux-readiness.yml@refs/heads/feature/534-runtime-fixture"
        self.assertEqual(installation.inspect_runtime_inputs_plan(diagnostic), diagnostic)
        for change in ({"destination": "/tmp/other"}, {"packages": ["other"]}, {"broker_uid": 0},
                       {"schema_version": True}, {"deadline_ns": "unbounded"}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                installation.inspect_runtime_inputs_plan({**runtime, **change})
        diagnostic["context"]["GITHUB_WORKFLOW_REF"] = "boburning/portcove/.github/workflows/ci.yml@refs/heads/main"
        with self.assertRaises(RuntimeError):
            installation.inspect_runtime_inputs_plan(diagnostic)

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


@contextmanager
def runtime_fixture(root, refuse=False):
    # Exercise an initially absent work parent. Ownership alone is controlled;
    # this fixture mocks the original-parent fence and grants no admission.
    wanted = {**plan(), "broker_uid": os.getuid(), "deadline_ns": str(time.monotonic_ns() + 30_000_000_000)}
    archive, profile = b"d" * 39592, b"p" * 1935 + b"\n"
    calls, sources = [], [b"fixed Ubuntu archive sources"]
    snapshot = {"packages": {"fixture": "1"}, "executables": {"fixture": "digest"}}
    def read(filename, maximum, owners, check):
        check()
        name = str(filename)
        data = (b'ID=ubuntu\nVERSION_ID="24.04"\n' if name == "/usr/lib/os-release"
                else sources[0] if name == "/etc/apt/sources.list.d/ubuntu.sources"
                else Path(filename).read_bytes())
        if len(data) > maximum:
            raise RuntimeError("fixture input exceeds bound")
        return data
    def invoke(arguments, check, **options):
        check()
        calls.append((arguments, options))
        directory = root / "work/hosted-linux-package-evidence"
        if "install" in arguments and refuse:
            (directory / "partial-package-effect").write_text("retained")
            raise RuntimeError("provider installation refused")
        if "download" in arguments:
            (directory / installation.PROFILE_DEB).write_bytes(archive)
        if arguments[0] == "/bin/bash":
            return profile
        return ""
    with patch.object(installation, "WORKSPACE", root), patch.object(installation, "fence"), \
            patch.object(installation.os, "getuid", return_value=0), \
            patch.object(installation, "read_regular", side_effect=read), \
            patch.object(installation, "command", side_effect=invoke), \
            patch.object(installation, "runtime_package_snapshot", return_value=snapshot) as observer, \
            patch.object(installation, "PROFILE_DEB_SHA256", hashlib.sha256(archive).hexdigest()), \
            patch.object(installation, "PROFILE_SHA256", hashlib.sha256(profile).hexdigest()):
        yield calls, sources, observer, wanted


@unittest.skipUnless(sys.platform == "linux", "actual Linux filesystem/command contracts")
class RuntimePackages(unittest.TestCase):
    def test_provider_partial_leaf_removed_between_scan_and_stat_is_not_reopened(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (_, _, _, wanted):
            scan = os.scandir
            command = installation.command
            vanished = []
            def invoke(arguments, check, **options):
                if "update" in arguments:
                    time.sleep(0.26)
                return command(arguments, check, **options)
            @contextmanager
            def changing_scan(directory):
                directory = Path(directory)
                if directory.name == "partial" and not vanished:
                    filename = directory / "provider-transient"
                    filename.write_bytes(b"partial")
                    with scan(directory) as entries:
                        removed = next(entry for entry in entries if entry.name == filename.name)
                    filename.unlink()
                    vanished.append(removed.path)
                    with scan(directory) as entries:
                        yield iter([removed, *entries])
                else:
                    with scan(directory) as entries:
                        yield entries
            with patch.object(installation.os, "scandir", side_effect=changing_scan), \
                    patch.object(installation, "command", side_effect=invoke):
                self.assertTrue(installation.prepare_runtime_packages(wanted)["prepared"])
            self.assertEqual(len(vanished), 1)
            self.assertFalse(Path(vanished[0]).exists())

    def test_apt_leaf_links_are_counted_without_following_and_special_files_refuse(self):
        for kind in ("link", "fifo"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (_, _, _, wanted):
                original = installation.command
                def invoke(arguments, check, kind=kind, original=original, **options):
                    directory = Path(temporary) / "work/hosted-linux-package-evidence"
                    if "update" in arguments:
                        entry = directory / "lists/partial/provider-input"
                        if kind == "link":
                            entry.symlink_to("/unavailable-provider-input")
                        else:
                            os.mkfifo(entry)
                        # Force this scan while the provider entry exists.
                        time.sleep(0.26)
                    return original(arguments, check, **options)
                with patch.object(installation, "command", side_effect=invoke):
                    if kind == "link":
                        self.assertTrue(installation.prepare_runtime_packages(wanted)["prepared"])
                    else:
                        with self.assertRaisesRegex(RuntimeError, "runtime input kind differs: lists/partial/provider-input mode=10000"):
                            installation.prepare_runtime_packages(wanted)
                        self.assertFalse((Path(temporary) / "work/hosted-linux-package-evidence/runtime.json").exists())

    def test_parent_and_root_refusal_precede_inputs_or_effects(self):
        with patch.object(installation, "fence", side_effect=RuntimeError("expired")), \
                patch.object(installation, "read_regular") as read:
            with self.assertRaisesRegex(RuntimeError, "expired"):
                installation.prepare_runtime_packages(plan())
            read.assert_not_called()
        with patch.object(installation, "fence"), patch.object(installation.os, "getuid", return_value=1001), \
                patch.object(installation, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "root-side"):
                installation.prepare_runtime_packages(plan())
            command.assert_not_called()

    def test_fixed_authenticated_inputs_retention_and_no_repeat(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (calls, _, _, wanted):
            self.assertFalse((Path(temporary) / "work").exists())
            result = installation.prepare_runtime_packages(wanted)
            self.assertTrue(result["prepared"])
            self.assertEqual(installation.read_runtime_packages(wanted), result)
            self.assertEqual([args[0] for args, _ in calls], ["/usr/bin/apt-get"] * 3 + ["/bin/bash"])
            for args, options in calls[:3]:
                self.assertIn("Acquire::Retries=0", args)
                self.assertIn("APT::Get::AllowUnauthenticated=false", args)
                self.assertIn("Acquire::AllowInsecureRepositories=false", args)
                self.assertIn("Dir::Etc::sourceparts=-", args)
                self.assertIn("Dir::Cache::pkgcache=", args)
                self.assertIn("Dir::Cache::srcpkgcache=", args)
                self.assertNotIn("GH_TOKEN", options["environment"])
                self.assertIn("Dir::State::lists=" + temporary + "/work/hosted-linux-package-evidence/lists/", args)
            self.assertIn("--no-remove", calls[1][0])
            self.assertEqual(calls[1][0][-len(installation.RUNTIME_PACKAGES):], list(installation.RUNTIME_PACKAGES))
            self.assertEqual(calls[2][1]["maximum_file_bytes"], 128 * 1024 ** 2)
            self.assertTrue(calls[3][1]["as_bytes"])
            before = len(calls)
            with self.assertRaisesRegex(RuntimeError, "retained runtime input"):
                installation.prepare_runtime_packages(wanted)
            self.assertEqual(len(calls), before)

    def test_oversize_profile_archive_refuses_before_extraction_despite_apt_scratch_cap(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (calls, _, _, wanted):
            command = installation.command
            def invoke(arguments, check, **options):
                result = command(arguments, check, **options)
                if "download" in arguments:
                    (Path(temporary) / "work/hosted-linux-package-evidence" / installation.PROFILE_DEB).write_bytes(b"x" * 39593)
                return result
            with patch.object(installation, "command", side_effect=invoke), \
                    self.assertRaisesRegex(RuntimeError, "input exceeds bound"):
                installation.prepare_runtime_packages(wanted)
            self.assertFalse(any(args[0] == "/bin/bash" for args, _ in calls))
            self.assertFalse((Path(temporary) / "work/hosted-linux-package-evidence/runtime.json").exists())

    def test_provider_refusal_retains_actual_partial_effect_and_intent(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary), True) as (calls, _, _, wanted):
            with self.assertRaisesRegex(RuntimeError, "provider installation refused"):
                installation.prepare_runtime_packages(wanted)
            directory = Path(temporary) / "work/hosted-linux-package-evidence"
            self.assertTrue((directory / "intent.json").is_file())
            self.assertEqual((directory / "partial-package-effect").read_text(), "retained")
            self.assertFalse((directory / "runtime.json").exists())
            self.assertEqual(len(calls), 2)
            with self.assertRaisesRegex(RuntimeError, "explicit recovery"):
                installation.prepare_runtime_packages(wanted)
            self.assertEqual(len(calls), 2)

    def test_linked_or_writable_work_parent_refuses_without_package_effects(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (calls, _, _, wanted):
            root = Path(temporary)
            (root / "outside").mkdir()
            (root / "work").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "work parent"):
                installation.prepare_runtime_packages(wanted)
            self.assertFalse((root / "outside/hosted-linux-package-evidence").exists())
            (root / "work").unlink()
            (root / "work").mkdir()
            (root / "work").chmod(0o777)
            with self.assertRaisesRegex(RuntimeError, "work parent"):
                installation.prepare_runtime_packages(wanted)
            self.assertEqual(calls, [])

    def test_changed_job_sources_profile_or_executable_readback_refuse(self):
        with tempfile.TemporaryDirectory() as temporary, runtime_fixture(Path(temporary)) as (_, sources, observer, wanted):
            installation.prepare_runtime_packages(wanted)
            with self.assertRaisesRegex(RuntimeError, "another original parent"):
                installation.read_runtime_packages({**wanted, "binding": "f" * 64})
            sources[0] += b"changed"
            with self.assertRaisesRegex(RuntimeError, "sources changed"):
                installation.read_runtime_packages(wanted)
            sources[0] = b"fixed Ubuntu archive sources"
            observer.return_value = {"packages": {}, "executables": {}}
            with self.assertRaisesRegex(RuntimeError, "packages or executable bytes changed"):
                installation.read_runtime_packages(wanted)
            profile = Path(temporary) / "work/hosted-linux-package-evidence/bwrap-userns-restrict.apparmor"
            profile.chmod(0o600)
            profile.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "profile input changed"):
                installation.read_runtime_packages(wanted)

    def test_package_inventory_refuses_missing_duplicate_or_unconfigured_rows(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "driver"
            executable.write_text("inert")
            executable.chmod(0o700)
            valid = [f"{name}\t1.0-1\tamd64\tii " for name in installation.RUNTIME_PACKAGES]
            with patch.object(installation, "RUNTIME_EXECUTABLES", (str(executable),)), \
                    patch.object(installation, "read_regular", return_value=b"inert"), \
                    patch.object(installation, "command", return_value="\n".join(valid)) as command:
                result = installation.runtime_package_snapshot(lambda: None)
                self.assertEqual(len(result["packages"]), len(installation.RUNTIME_PACKAGES))
                for rows in (valid[:-1], valid + valid[:1], [valid[0].replace("\tii ", "\tiU "), *valid[1:]]):
                    command.return_value = "\n".join(rows)
                    with self.assertRaisesRegex(RuntimeError, "inventory incomplete|readback differs"):
                        installation.runtime_package_snapshot(lambda: None)

    def test_fixed_profile_command_preserves_binary_and_trailing_newline(self):
        data = installation.command([sys.executable, "-I", "-S", "-c", "import sys;sys.stdout.buffer.write(b'\\x00profile\\n')"],
                                    lambda: None, maximum_output_bytes=9, as_bytes=True)
        self.assertEqual(data, b"\x00profile\n")

    def test_command_refusal_retains_exit_and_actual_bounded_output(self):
        with self.assertRaisesRegex(RuntimeError, "fixed installation command refused: exit=7") as captured:
            installation.command([sys.executable, "-I", "-S", "-c",
                                  "import sys;sys.stdout.write('partial');sys.stderr.write('reason');sys.exit(7)"],
                                 lambda: None)
        self.assertEqual(captured.exception.installation_stdout, b"partial")
        self.assertEqual(captured.exception.installation_stderr, b"reason")


@unittest.skipUnless(sys.platform == "linux", "actual Linux file/link custody contracts")
class DependencyGraph(unittest.TestCase):
    def test_frozen_install_controls_and_partial_refusal_retention(self):
        for outcome in ("success", "refusal", "vanished-leaf", "vanished-directory",
                        "missing-inventory-root", "inaccessible-directory"):
            refused = outcome == "refusal"
            scan_refused = outcome in ("missing-inventory-root", "inaccessible-directory")
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "native-source"
                (source / "apps/desktop").mkdir(parents=True)
                (source / "package.json").write_text('{"packageManager":"pnpm@12.16.1"}')
                (source / "apps/desktop/package.json").write_text('{}')
                workspace = b"packages: [apps/desktop]\n"
                (source / "pnpm-workspace.yaml").write_bytes(workspace)
                for filename in ("package.json", "apps/desktop/package.json", "pnpm-workspace.yaml"):
                    (source / filename).chmod(0o644)
                fixture_uid = os.getuid() or 1001
                executable = root / "pnpm"
                executable.write_bytes(b"inert executable fixture")
                executable.chmod(0o644)
                settings = {"pnpm": {"path": str(executable), "bytes": executable.stat().st_size,
                            "sha256": hashlib.sha256(executable.read_bytes()).hexdigest()},
                            "workspace_sha256": hashlib.sha256(workspace).hexdigest(), "patches": []}
                calls = []
                scan = os.scandir
                vanished = []
                @contextmanager
                def changing_entries(directory, outcome=outcome, scan=scan, vanished=vanished):
                    directory = Path(directory)
                    if outcome == "vanished-leaf" and directory.name == "native-dependency-home" and not vanished:
                        filename = directory / "package.json_pacquet-stage_inert"
                        filename.write_bytes(b"transient dependency staging bytes")
                        with scan(directory) as entries:
                            removed = next(entry for entry in entries if entry.name == filename.name)
                        filename.unlink()
                        vanished.append(removed.path)
                        with scan(directory) as entries:
                            yield iter([removed, *entries])
                    else:
                        with scan(directory) as entries:
                            yield entries
                staging_created = []
                def changing_scan(directory, outcome=outcome):
                    directory = Path(directory)
                    if directory.name == "native-dependency-home":
                        if outcome == "missing-inventory-root":
                            raise FileNotFoundError("inventory root disappeared")
                        if outcome in ("vanished-directory", "inaccessible-directory") and not staging_created:
                            staged = directory / "package_pacquet-stage_inert"
                            staged.mkdir()
                            staging_created.append(staged)
                    if staging_created and directory == staging_created[0]:
                        if outcome == "vanished-directory":
                            directory.rmdir()
                            vanished.append(str(directory))
                        elif outcome == "inaccessible-directory":
                            raise PermissionError("staging directory inaccessible")
                    # Open the real iterator eagerly, as os.scandir does, so the
                    # queued-directory race occurs between stat and opening it.
                    return changing_entries(directory) if outcome == "vanished-leaf" else scan(directory)
                def invoke(arguments, check, maximum_file_bytes=None, maximum_output_bytes=65536,
                           environment=None, calls=calls, source=source, refused=refused):
                    calls.append((arguments, environment, maximum_file_bytes))
                    check()
                    if "--version" in arguments:
                        return "12.16.1"
                    (source / "node_modules").mkdir()
                    (source / "apps/desktop/node_modules").mkdir()
                    if refused:
                        raise RuntimeError("provider refusal after partial progress")
                    return ""
                with patch.object(installation, "WORKSPACE", root), patch.object(installation, "fence"), \
                        patch.object(installation.os, "getuid", return_value=fixture_uid), \
                        patch.object(installation, "verify_installed_source"), \
                        patch.object(installation, "inspect_plan"), \
                        patch.object(installation.os, "scandir", side_effect=changing_scan), \
                        patch.object(installation, "command", side_effect=invoke):
                    fixture_plan = {**plan(), "broker_uid": fixture_uid}
                    if outcome == "missing-inventory-root":
                        with self.assertRaisesRegex(FileNotFoundError, "inventory root disappeared"):
                            installation.prepare_source_dependencies(fixture_plan, settings)
                    elif outcome == "inaccessible-directory":
                        with self.assertRaisesRegex(PermissionError, "staging directory inaccessible"):
                            installation.prepare_source_dependencies(fixture_plan, settings)
                    elif refused:
                        with self.assertRaisesRegex(RuntimeError, "partial progress"):
                            installation.prepare_source_dependencies(fixture_plan, settings)
                    else:
                        self.assertTrue(installation.prepare_source_dependencies(fixture_plan, settings)["dependencies_prepared"])
                    with self.assertRaisesRegex(RuntimeError, "retained dependency"):
                        installation.prepare_source_dependencies(fixture_plan, settings)
                self.assertTrue((root / "native-dependency-home/intent.json").is_file())
                self.assertEqual((source / "node_modules").is_dir(), not scan_refused)
                if outcome in ("vanished-leaf", "vanished-directory"):
                    self.assertEqual(len(vanished), 1)
                self.assertEqual(len(calls), 2)
                args, environment, maximum = calls[1]
                for flag in ("--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--pm-on-fail=error",
                             "--runtime-on-fail=error", "--package-import-method=copy", "--config.fetch-retries=0",
                             "--config.enable-global-virtual-store=false"):
                    self.assertIn(flag, args)
                self.assertEqual(maximum, 128 * 1024 ** 2)
                self.assertEqual(environment["HOME"], str(root / "native-dependency-home"))
                self.assertEqual(environment["COREPACK_ENABLE_NETWORK"], "0")
                self.assertFalse(any("TOKEN" in key or "AUTH" in key for key in environment))
                if outcome in ("vanished-leaf", "vanished-directory"):
                    self.assertFalse(Path(vanished[0]).exists())

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
