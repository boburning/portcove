"""Inert failure/recovery contracts; no account, sudo, unit or namespace runs."""

import ast
import importlib.util
import io
import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).with_name("qualify-hosted-native-linux.py"))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class HostedReadiness(unittest.TestCase):
    def test_actual_inert_entry_executes_only_fixed_command_after_exact_release(self):
        invocation = "a" * 64
        creation = {"pid": 42, "creation_ticks": "123"}
        packet = {"invocation_id": invocation, "unit_invocation_id": "b" * 32,
                  "pid": 42, "creation": creation, "deadline_monotonic": 20}
        for condition in ("accepted", "wrong-retained", "wrong-generation", "changed-creation", "expired"):
            expected = dict(packet)
            current_packet = dict(packet)
            generation = "b" * 32
            current_creation = creation
            if condition == "wrong-retained":
                expected["pid"] = 43
            elif condition == "wrong-generation":
                generation = "c" * 32
            elif condition == "changed-creation":
                current_creation = {"pid": 42, "creation_ticks": "456"}
            elif condition == "expired":
                current_packet["deadline_monotonic"] = expected["deadline_monotonic"] = 9
            supervisor = {"observe_root_creation": Mock(side_effect=[creation, current_creation]),
                          "create_file": Mock(), "decode": json.loads,
                          "read_regular": Mock(return_value=json.dumps(expected).encode())}
            with self.subTest(condition=condition), \
                    patch.dict("sys.modules", {"pwd": SimpleNamespace(getpwnam=lambda _name: SimpleNamespace(pw_uid=1002, pw_gid=1002))}), \
                    patch.dict(readiness.os.environ, {"INVOCATION_ID": generation}, clear=True), \
                    patch.object(readiness.os, "getuid", return_value=1002, create=True), patch.object(readiness.os, "getgid", return_value=1002, create=True), \
                    patch.object(readiness.os, "getpid", return_value=42), patch.object(readiness.time, "monotonic", return_value=10), \
                    patch.object(readiness, "load_supervisor", return_value=supervisor), \
                    patch.object(readiness, "public_policy", return_value={"inert": True}), \
                    patch.object(readiness, "wait_release", return_value=json.dumps(current_packet).encode()), \
                    patch.object(readiness.os, "execve", create=True) as execute:
                if condition == "accepted":
                    readiness.inert_entry(invocation)
                    execute.assert_called_once()
                    executable, arguments, environment = execute.call_args.args
                    self.assertEqual(executable, "/usr/bin/bwrap")
                    self.assertEqual(arguments[0], executable)
                    self.assertIn(readiness.CHILD, arguments)
                    self.assertIn("--cap-drop", arguments)
                    self.assertEqual(environment, readiness.ENV)
                else:
                    with self.assertRaises(RuntimeError):
                        readiness.inert_entry(invocation)
                    execute.assert_not_called()
                supervisor["create_file"].assert_called_once()

    def test_kernel_readback_is_read_only_exact_pid_time_filtered_without_retry(self):
        probe = {"entry_pid": 42, "entry": {"pid": 42, "creation": {"pid": 42, "creation_ticks": "123"}}}
        reply = SimpleNamespace(returncode=1, stdout=b"", stderr=b"journal unavailable")
        with patch.object(readiness.subprocess, "run", return_value=reply) as run:
            observed = readiness.denial_observation(probe, 100, 120)
        self.assertEqual(observed["exit"], 1)
        self.assertEqual(observed["messages"], [])
        self.assertFalse(observed["automatic_retry"])
        self.assertIn("journal unavailable", observed["stderr"])
        arguments = run.call_args.args[0]
        self.assertIn("--since=@100", arguments)
        self.assertIn("--until=@120", arguments)
        pattern = next(value.removeprefix("--grep=") for value in arguments if value.startswith("--grep="))
        self.assertIsNotNone(readiness.re.search(pattern, 'audit: apparmor="DENIED" operation="userns_create" pid=42 comm="bwrap" requested="userns_create"'))
        for decoy in ('ppid=42 comm="bwrap"', 'pid=420 comm="bwrap"', 'pid=42 comm="other"',
                      'pid=42 somecomm="bwrap"'):
            self.assertIsNone(readiness.re.search(pattern, 'audit: apparmor="DENIED" ' + decoy))
        self.assertEqual(run.call_count, 1)
        with patch.object(readiness.subprocess, "run") as run, self.assertRaises(RuntimeError):
            readiness.denial_observation({**probe, "entry_pid": "42; arbitrary"}, 100, 120)
        run.assert_not_called()

    def test_partial_release_is_bounded_by_original_deadline_and_eof_is_refused(self):
        with patch.object(readiness.time, "monotonic", side_effect=[10, 11, 12]), \
                patch.object(readiness.select, "select", return_value=([7], [], [])) as selected, \
                patch.object(readiness.os, "read", side_effect=[b'{"x":', b'1}\n']):
            self.assertEqual(readiness.wait_release(7, 15), b'{"x":1}')
            self.assertEqual([call.args[3] for call in selected.call_args_list], [5, 4])
        for parts, reason in (([b""], "closed"), ([b"x\ny\n"], "framing"), ([b"x" * 2049], "bound")):
            with self.subTest(reason=reason), patch.object(readiness.time, "monotonic", return_value=10), \
                    patch.object(readiness.select, "select", return_value=([7], [], [])), \
                    patch.object(readiness.os, "read", side_effect=parts), self.assertRaisesRegex(RuntimeError, reason):
                readiness.wait_release(7, 15)
        with patch.object(readiness.time, "monotonic", return_value=15), \
                patch.object(readiness.os, "read") as read, self.assertRaisesRegex(RuntimeError, "expired"):
            readiness.wait_release(7, 15)
        read.assert_not_called()

    def test_release_checks_exact_retained_tuple_generation_creation_and_original_clock(self):
        expected = {"invocation_id": "a" * 64, "unit_invocation_id": "b" * 32,
                    "pid": 42, "creation": {"pid": 42, "creation_ticks": "123"}, "deadline_monotonic": 15}
        with patch.object(readiness.time, "monotonic", return_value=10):
            readiness.check_release(expected, expected, "b" * 32, 42, expected["creation"], 20)
            for field, value in (("pid", 43), ("unit_invocation_id", "c" * 32), ("creation", {}),
                                 ("deadline_monotonic", float("nan"))):
                changed = {**expected, field: value}
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    readiness.check_release(changed, expected, "b" * 32, 42, expected["creation"], 20)
        with patch.object(readiness.time, "monotonic", return_value=15), self.assertRaisesRegex(RuntimeError, "expired"):
            readiness.check_release(expected, expected, "b" * 32, 42, expected["creation"], 20)

    def test_release_rechecks_actual_unit_and_root_generation_before_admission(self):
        properties = {"MainPID": "42"}
        creation = {"pid": 42, "creation_ticks": "123"}
        supervisor = {"unit_properties": Mock(return_value=properties), "inspect_unit_properties": Mock(),
                      "inspect_unit_identity": Mock(), "observe_root_creation": Mock(return_value=creation)}
        group = SimpleNamespace(read=Mock(return_value="42\n"))
        entry = {"invocation_id": "a" * 64, "pid": 42, "creation": creation}
        with patch.object(readiness.time, "monotonic", return_value=10):
            binding = readiness.release_binding(supervisor, "owned.service", "b" * 32, group, entry, "a" * 64, 15)
            self.assertEqual(binding["pid"], 42)
            supervisor["inspect_unit_identity"].assert_called_once_with(properties, "owned.service", "b" * 32)
            supervisor["observe_root_creation"].return_value = {"pid": 42, "creation_ticks": "456"}
            with self.assertRaisesRegex(RuntimeError, "process generation"):
                readiness.release_binding(supervisor, "owned.service", "b" * 32, group, entry, "a" * 64, 15)

    def test_fast_namespace_refusal_preserves_original_held_cleanup_and_failed_result(self):
        invocation = "ab" * 32
        creation = {"pid": 42, "creation_ticks": "123"}
        active = {"ActiveState": "active", "MainPID": "42", "InvocationID": "b" * 32}
        with tempfile.TemporaryDirectory() as temporary:
            guest = Path(temporary)
            def launch(*_arguments, **_keywords):
                readiness.retain(guest / "invocations" / invocation / "capture/entry.json",
                                 {"invocation_id": invocation, "pid": 42, "creation": creation, "policy": {}})
                return process
            process = SimpleNamespace(stdin=io.BytesIO(), poll=Mock(side_effect=[None, 1]), returncode=1,
                                      communicate=Mock(return_value=(None, b"bwrap: setting up uid map: Permission denied")))
            group = SimpleNamespace(identity=(1, 2), path=Path("/sys/fs/cgroup/owned"),
                                    read=Mock(return_value="42\n"), empty=Mock(return_value=True),
                                    last_observation="removed-exact-held-cgroup", close=Mock())
            supervisor = {"unit_properties": Mock(side_effect=[{"LoadState": "not-found"}, active, active, {"settled": True}]),
                          "inspect_unit_properties": Mock(), "inspect_unit_identity": Mock(),
                          "HeldCgroup": Mock(return_value=group), "observe_root_creation": Mock(return_value=creation),
                          "control_environment": Mock(return_value={}), "settled_unit": lambda value: value.get("settled", False),
                          "systemctl": Mock(), "read_marker": lambda filename, _maximum: json.loads(filename.read_bytes())}
            with patch.dict("sys.modules", {"pwd": SimpleNamespace(getpwnam=lambda _name: SimpleNamespace(pw_uid=1002, pw_gid=1002))}), \
                    patch.object(readiness, "GUEST", guest), patch.object(readiness, "load_supervisor", return_value=supervisor), \
                    patch.object(readiness.os, "getuid", return_value=1002, create=True), patch.object(readiness.os, "getgid", return_value=1002, create=True), \
                    patch.object(readiness.os, "urandom", return_value=bytes.fromhex(invocation)), \
                    patch.object(readiness.subprocess, "Popen", side_effect=launch), patch("builtins.print"):
                self.assertEqual(readiness.probe(), 1)
            result = json.loads((guest / "invocations" / invocation / "capture/probe.json").read_bytes())
            self.assertFalse(result["passed"])
            self.assertIn("did not report readiness", result["failure"])
            self.assertIn("Permission denied", result["unit_stderr"])
            self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
            group.close.assert_called_once()
            supervisor["systemctl"].assert_not_called()
            self.assertTrue((guest / "invocations" / invocation / "capture/release.json").exists())

    def root_runner(self, child):
        # Execute the actual embedded function, not a second implementation.
        # Privileged outer setup and every OS/process/clock effect are inert.
        nodes = [node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.FunctionDef) and node.name == "run"]
        self.assertEqual(len(nodes), 1)
        scope = {
            "deadline": 20, "result": {}, "time": SimpleNamespace(monotonic=Mock(return_value=10)),
            "os": SimpleNamespace(killpg=Mock()), "signal": SimpleNamespace(SIGKILL=9),
            "subprocess": SimpleNamespace(Popen=Mock(return_value=child), DEVNULL=subprocess.DEVNULL,
                                          PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired),
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "actual-embedded-root-runner", "exec"), scope)
        return scope

    def test_actual_root_runner_uses_original_budget_and_one_owned_session(self):
        child = SimpleNamespace(pid=42, returncode=0, communicate=Mock(return_value=(b"observed", b"")))
        scope = self.root_runner(child)
        arguments = ["/usr/sbin/useradd", "fixed-inert-arguments"]
        self.assertEqual(scope["run"](arguments, 30), b"observed")
        child.communicate.assert_called_once_with(timeout=10)
        scope["subprocess"].Popen.assert_called_once_with(arguments, stdin=subprocess.DEVNULL,
                                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        scope["os"].killpg.assert_not_called()

    def test_actual_root_timeout_signals_original_group_and_preserves_original_failure(self):
        original = subprocess.TimeoutExpired(["/usr/sbin/useradd"], 10)
        child = SimpleNamespace(pid=42, returncode=None, communicate=Mock(side_effect=[original, (b"", b"")]))
        scope = self.root_runner(child)
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            scope["run"](["/usr/sbin/useradd"], 30)
        self.assertIs(caught.exception, original)
        scope["os"].killpg.assert_called_once_with(42, 9)
        self.assertEqual(scope["result"]["command_timeout"], {
            "executable": "/usr/sbin/useradd", "seconds": 10, "group_kill_sent": True, "child_reaped": True,
        })
        self.assertEqual(scope["subprocess"].Popen.call_count, 1)

    def test_actual_root_timeout_retains_unknown_kill_or_reap_without_retry(self):
        for fault in ("kill", "reap"):
            original = subprocess.TimeoutExpired(["/usr/sbin/useradd"], 10)
            child = SimpleNamespace(pid=42, returncode=None,
                                    communicate=Mock(side_effect=[original, RuntimeError("inert reap unavailable")]))
            scope = self.root_runner(child)
            if fault == "kill":
                scope["os"].killpg.side_effect = PermissionError("inert signal refused")
            with self.subTest(fault=fault), self.assertRaises(subprocess.TimeoutExpired) as caught:
                scope["run"](["/usr/sbin/useradd"], 30)
            self.assertIs(caught.exception, original)
            retained = scope["result"]["command_timeout"]
            self.assertFalse(retained["child_reaped"])
            self.assertEqual(retained["group_kill_sent"], fault != "kill")
            self.assertIn("settlement_error", retained)
            self.assertEqual(scope["subprocess"].Popen.call_count, 1)

    def test_actual_root_runner_refuses_late_success_without_signalling_a_finished_child(self):
        child = SimpleNamespace(pid=42, returncode=0, communicate=Mock(return_value=(b"observed", b"")))
        scope = self.root_runner(child)
        scope["time"].monotonic.side_effect = [10, 21]
        with self.assertRaisesRegex(AssertionError, "original setup deadline expired"):
            scope["run"](["/usr/sbin/useradd"], 30)
        scope["os"].killpg.assert_not_called()

    def test_actual_root_final_readback_cannot_promote_late_or_replace_prior_failure(self):
        nodes = [node for node in ast.parse(readiness.ROOT_SETUP).body if isinstance(node, ast.Try)]
        self.assertEqual(len(nodes), 1)
        for previous_failure in (None, "original useradd timeout"):
            result = {"completed": True, "failure": previous_failure, "stage": "useradd"}
            public = b"portcove-native:x:1002:1002::/home/portcove-native:/usr/sbin/nologin\n"
            info = SimpleNamespace(st_uid=1002, st_gid=1002, st_mode=stat.S_IFDIR | 0o700)
            scope = {"result": result, "deadline": 20, "time": SimpleNamespace(monotonic=lambda: 21),
                     "Path": Mock(return_value=SimpleNamespace(read_bytes=Mock(return_value=public), lstat=Mock(return_value=info))),
                     "stat": stat, "json": json, "print": Mock()}
            exec(compile(ast.Module(body=nodes[0].finalbody, type_ignores=[]), "actual-embedded-root-final-readback", "exec"), scope)
            self.assertFalse(result["completed"])
            self.assertEqual(result["failure"], previous_failure or "original setup readback deadline expired")
            self.assertEqual(result["readback"]["account"]["uid"], "1002")

    def test_setup_success_requires_actual_account_and_private_path_readback(self):
        setup = {
            "completed": True, "failure": None, "uid": 1002, "gid": 1002,
            "readback": {
                "account": {"uid": "1002", "gid": "1002", "home": "/home/portcove-native", "shell": "/usr/sbin/nologin"},
                "paths": {
                    "/home/portcove-native": {"directory": True, "uid": 1002, "gid": 1002, "mode": "0o40700"},
                    str(readiness.GUEST): {"directory": True, "uid": 1002, "gid": 1002, "mode": "0o40700"},
                    str(readiness.INSTALLED): {"directory": True, "uid": 0, "gid": 0, "mode": "0o40755"},
                },
            },
        }
        readiness.require_setup_readback(setup, 1001)
        for change in ("failed", "missing-readback", "wrong-account", "writable-path", "same-broker"):
            modified = json.loads(json.dumps(setup))
            broker = 1001
            if change == "failed":
                modified.update(completed=False, failure="original useradd timeout; partial effects possible")
            elif change == "missing-readback":
                modified["readback_error"] = "unavailable"
            elif change == "wrong-account":
                modified["readback"]["account"]["uid"] = "1003"
            elif change == "writable-path":
                modified["readback"]["paths"][str(readiness.GUEST)]["mode"] = "0o40777"
            else:
                broker = 1002
            original = json.dumps(modified)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                readiness.require_setup_readback(modified, broker)
            self.assertEqual(json.dumps(modified), original)

    def test_empty_checkout_creates_work_parent_but_retained_attempt_is_never_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertFalse((root / "work").exists())
            directory = readiness.begin_attempt(root, {"GITHUB_SHA": "a" * 40}, {"fixed": "b" * 64}, "c" * 40)
            original = (directory / "intent.json").read_bytes()
            self.assertEqual(json.loads(original)["GITHUB_SHA"], "a" * 40)
            self.assertFalse(json.loads(original)["automatic_retry"])
            with self.assertRaises(FileExistsError):
                readiness.begin_attempt(root, {"GITHUB_SHA": "d" * 40}, {}, "e" * 40)
            self.assertEqual((directory / "intent.json").read_bytes(), original)

    def test_existing_work_parent_is_preserved_without_reusing_an_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "work").mkdir()
            unrelated = root / "work/unrelated-evidence.json"
            unrelated.write_bytes(b"retain unrelated evidence")
            readiness.begin_attempt(root, {}, {}, "c" * 40)
            self.assertEqual(unrelated.read_bytes(), b"retain unrelated evidence")

    def setUp(self):
        self.group = SimpleNamespace(empty=Mock(return_value=True), last_observation="observed-unpopulated")
        self.supervisor = {
            "unit_properties": Mock(return_value={"generation": "old", "settled": False}),
            "inspect_unit_identity": Mock(),
            "systemctl": Mock(return_value=(1, b"ambiguous response")),
            "settled_unit": lambda value: value["settled"],
        }

    def test_wrong_generation_refuses_kill_even_when_held_cgroup_is_empty(self):
        self.supervisor["inspect_unit_identity"].side_effect = RuntimeError("generation changed")
        with self.assertRaisesRegex(RuntimeError, "generation changed"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.supervisor["systemctl"].assert_not_called()

    def test_positive_original_cgroup_and_settled_unit_need_no_signal(self):
        self.supervisor["unit_properties"].return_value = {"settled": True}
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["systemctl"].assert_not_called()

    def test_failed_kill_response_requires_actual_readback_to_resolve_effect(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": True}]
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["inspect_unit_identity"].assert_called_once()
        self.supervisor["systemctl"].assert_called_once_with("kill", "--signal=KILL", "--kill-whom=all", "owned.service")

    def test_deadline_never_turns_populated_cgroup_into_positive_settlement(self):
        self.group.empty.return_value = False
        with patch.object(readiness.time, "monotonic", side_effect=[10, 19, 19]), self.assertRaisesRegex(RuntimeError, "settlement remains unknown"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertIsNone(self.supervisor["COMMAND_DEADLINE"])

    def test_late_positive_readback_refuses_and_restores_original_command_deadline(self):
        clock = [10]
        self.supervisor["COMMAND_DEADLINE"] = 17
        def read(_unit):
            self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
            clock[0] = 18
            return {"settled": True}
        self.supervisor["unit_properties"].side_effect = read
        with patch.object(readiness.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaisesRegex(RuntimeError, "deadline expired"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
        self.supervisor["systemctl"].assert_not_called()

    def test_empty_cgroup_waits_for_later_unit_settlement_within_same_budget(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": False}, {"settled": True}]
        with patch.object(readiness.time, "sleep"):
            result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])

    def test_owner_host_wrong_workflow_and_repeated_attempt_refuse_before_setup(self):
        environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "boburning/portcove",
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "12345", "GITHUB_SHA": "a" * 40,
            "GITHUB_WORKFLOW_REF": "boburning/portcove/.github/workflows/hosted-native-linux-readiness.yml@refs/heads/main",
        }
        with patch.object(readiness.platform, "system", return_value="Linux"), patch.object(readiness.platform, "machine", return_value="x86_64"):
            self.assertEqual(readiness.hosted_context(environment)["GITHUB_SHA"], "a" * 40)
            for change in ({"GITHUB_ACTIONS": "false"}, {"GITHUB_RUN_ATTEMPT": "2"},
                           {"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_WORKFLOW_REF": "foreign/workflow"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    readiness.hosted_context({**environment, **change})


if __name__ == "__main__":
    unittest.main()
