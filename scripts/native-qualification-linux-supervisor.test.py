"""Inert native lifetime tests; no WSL, systemd, namespace or native invocation."""

import errno
import importlib.util
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "native_supervisor", Path(__file__).with_name("native-qualification-linux-supervisor.py")
)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class NativeLifetime(unittest.TestCase):
    def setUp(self):
        supervisor.COMMAND_DEADLINE = None
        selected = patch.object(supervisor.os, "getuid", return_value=1002, create=True)
        selected.start()
        self.addCleanup(selected.stop)
        for name in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"):
            if not hasattr(supervisor.os, name):
                selected_flag = patch.object(supervisor.os, name, 0, create=True)
                selected_flag.start()
                self.addCleanup(selected_flag.stop)

    def test_json_refuses_duplicates_nonfinite_and_invalid_utf8(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b"\xff"):
            with self.subTest(raw=raw), self.assertRaises((ValueError, supervisor.Refusal)):
                supervisor.decode(raw)

    def test_original_unit_root_creation_is_bounded_and_generation_bracketed(self):
        def packet(pid=123, ticks="456"):
            return f"{pid} (fixed unit ) name) S {'0 ' * 18}{ticks} 0 0\n".encode()

        self.assertEqual(supervisor.inspect_root_creation(packet(), 123), {"pid": 123, "creation_ticks": "456"})
        for raw in (packet(124), packet(ticks="0"), packet(ticks="-1"), b"x" * 16385, b"123 no-comm"):
            with self.assertRaises(supervisor.Refusal):
                supervisor.inspect_root_creation(raw, 123)
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=1002, st_dev=1, st_ino=2)
        for second, changed in ((packet(), False), (packet(ticks="457"), True)):
            with (
                patch.object(Path, "lstat", return_value=info),
                patch.object(supervisor.os, "open", return_value=42),
                patch.object(supervisor.os, "fstat", return_value=info),
                patch.object(supervisor.os, "read", side_effect=[packet(), second]),
                patch.object(supervisor.os, "lseek"),
                patch.object(supervisor.os, "close") as close,
            ):
                if changed:
                    with self.assertRaises(supervisor.Refusal):
                        supervisor.observe_root_creation(123)
                else:
                    self.assertEqual(supervisor.observe_root_creation(123)["creation_ticks"], "456")
                close.assert_called_once_with(42)

    def test_scrubbed_control_environment_has_no_inherited_windows_or_secrets(self):
        with patch.dict(supervisor.os.environ, {"WSL_INTEROP": "inert", "GH_TOKEN": "inert", "NODE_OPTIONS": "inert"}):
            environment = supervisor.control_environment()
        self.assertEqual(environment["PATH"], "/usr/bin:/bin")
        for key in ("GH_TOKEN", "WSL_INTEROP", "NODE_OPTIONS", "PYTHONPATH", "HTTP_PROXY"):
            self.assertNotIn(key, environment)

    def test_exited_local_wrapper_does_not_exempt_live_group(self):
        group = Mock()
        group.empty.return_value = False
        self.assertTrue(supervisor.needs_unit_kill(group))
        group.empty.side_effect = OSError("inert unavailable")
        self.assertTrue(supervisor.needs_unit_kill(group))
        self.assertTrue(supervisor.needs_unit_kill(None))
        group.empty.side_effect = None
        group.empty.return_value = True
        self.assertFalse(supervisor.needs_unit_kill(group))

    def test_exact_held_cgroup_gc_is_positive_only_for_same_deleted_kernel_object(self):
        group = object.__new__(supervisor.HeldCgroup)
        group.path = Path("/sys/fs/cgroup/user.slice/owned.service")
        group.directory = 12
        group.identity = (42, 99)
        group.last_observation = None
        group.read = Mock(side_effect=OSError(errno.ENODEV, "inert removed"))
        info = SimpleNamespace(st_dev=42, st_ino=99, st_mode=stat.S_IFDIR)
        with (
            patch.object(supervisor.os, "fstat", return_value=info),
            patch.object(supervisor, "filesystem_kind", return_value=0x63677270),
            patch.object(supervisor.os, "readlink", return_value=str(group.path) + " (deleted)"),
        ):
            self.assertTrue(group.empty())
            self.assertEqual(group.last_observation, "removed-exact-held-cgroup")
        for observed in (str(group.path), str(group.path) + "-new (deleted)"):
            with (
                patch.object(supervisor.os, "fstat", return_value=info),
                patch.object(supervisor, "filesystem_kind", return_value=0x63677270),
                patch.object(supervisor.os, "readlink", return_value=observed),
                self.assertRaises(supervisor.Refusal),
            ):
                group.empty()
        info.st_ino = 100
        with patch.object(supervisor.os, "fstat", return_value=info), self.assertRaises(supervisor.Refusal):
            group.empty()

    def test_unit_resources_and_invocation_are_checked_independently(self):
        properties = {
            "LoadState": "loaded",
            "ActiveState": "active",
            "MemoryMax": str(supervisor.MEMORY_BYTES),
            "MemorySwapMax": "0",
            "TasksMax": "64",
        }
        supervisor.inspect_unit_properties(properties)
        for key, value in (
            ("MemoryMax", "max"),
            ("MemorySwapMax", "max"),
            ("TasksMax", "65"),
            ("ActiveState", "inactive"),
        ):
            with self.subTest(key=key), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_unit_properties({**properties, key: value})
        unit = "portcove-native-" + "a" * 64 + ".service"
        properties.update(
            InvocationID="b" * 32,
            ControlGroup=f"/user.slice/user-{supervisor.os.getuid()}.slice/user@x.service/app.slice/{unit}",
        )
        supervisor.inspect_unit_identity(properties, unit, "b" * 32)
        with self.assertRaises(supervisor.Refusal):
            supervisor.inspect_unit_identity(properties, unit, "c" * 32)

    def test_fixed_request_refuses_commands_root_account_and_expanded_tools(self):
        request = {
            "schema_version": 1,
            "invocation_id": "a" * 64,
            "stage_request_sha256": "b" * 64,
            "qualification_uid": 1002,
            "qualification_gid": 1002,
            "controller": {"source_commit": "c" * 40, "source_tree": "d" * 40},
            "plan_sha256": "e" * 64,
            "supervisor_sha256": "f" * 64,
            "support_sha256": "0" * 64,
            "driver_sha256": "1" * 64,
            "tools_sha256": dict.fromkeys(("python", "bwrap", "systemd_run", "systemctl", "node", "git"), "2" * 64),
            "timeout_seconds": 1800,
            "deadline_utc": "2026-10-20T23:30:00.000Z",
        }
        self.assertEqual(supervisor.inspect_request(request, "a" * 64), request)
        for changed in (
            {**request, "command": ["sh"]},
            {**request, "qualification_uid": 0},
            {**request, "timeout_seconds": 1801},
            {**request, "timeout_seconds": True},
            {**request, "deadline_utc": "2026-10-20T23:30:00Z"},
            {**request, "deadline_utc": "2026-02-30T23:30:00.000Z"},
            {**request, "tools_sha256": {**request["tools_sha256"], "shell": "3" * 64}},
        ):
            with self.subTest(changed=changed), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_request(changed, "a" * 64)

    def test_original_utc_and_monotonic_bound_cannot_restart_lifetime(self):
        from datetime import datetime

        until = datetime.fromisoformat("2026-10-20T23:30:00+00:00").timestamp()
        request = {"timeout_seconds": 1800, "deadline_utc": "2026-10-20T23:30:00.000Z"}
        with (
            patch.object(supervisor.time, "time", return_value=until - 12),
            patch.object(supervisor.time, "monotonic", return_value=100),
        ):
            self.assertEqual(supervisor.remaining_deadline(request), 112)
        with patch.object(supervisor.time, "time", return_value=until), self.assertRaises(supervisor.Refusal):
            supervisor.remaining_deadline(request)

    def test_unit_command_has_fixed_source_only_and_one_total_group_limit(self):
        root = Path("/home/qualification/portcove-native")
        request = {"invocation_id": "a" * 64}
        with patch.object(
            supervisor,
            "_native_bootstrap_argv",
            lambda args: ["/usr/bin/python3", "-c", "inert-fixed-bootstrap", *args],
            create=True,
        ):
            command = supervisor.unit_command(root, root / "invocations" / ("a" * 64), request, "b" * 64, "c" * 64, 120)
        self.assertEqual(command[0], "/usr/bin/systemd-run")
        for value in (
            "--user",
            "--property=TasksMax=64",
            "--property=MemorySwapMax=0",
            "--property=KillMode=control-group",
            "--property=RuntimeMaxSec=120",
            "unit-entry",
        ):
            self.assertIn(value, command)
        self.assertIn("inert-fixed-bootstrap", command)
        with self.assertRaises(supervisor.Refusal):
            supervisor.unit_command(root, root / "invocations" / ("a" * 64), request, "b" * 64, "c" * 64, 120)
        self.assertNotIn("/bin/sh", command)
        self.assertNotIn("--scope", command)

    def test_disk_backed_home_is_refused_before_guest_driver(self):
        with (
            patch.object(
                supervisor, "owned_directory", return_value=Path("/home/q/portcove-native/invocations/x/work/home")
            ),
            patch.object(supervisor.os, "open", return_value=12),
            patch.object(supervisor.os, "close"),
            patch.object(supervisor, "filesystem_kind", return_value=0xEF53),
            self.assertRaises(supervisor.Refusal),
        ):
            supervisor.verify_bounded_home(Path("/home/q/portcove-native/invocations/x"))

    def test_repeat_run_cannot_launch_or_overwrite_retained_intent(self):
        invocation, request_sha = "a" * 64, "b" * 64
        request = {"stage_request_sha256": "c" * 64}
        with tempfile.TemporaryDirectory() as directory:
            attempt = Path(directory)
            capture = attempt / "capture"
            capture.mkdir()
            (capture / "outer-intent.json").write_bytes(b"original-intent")
            fcntl = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=Mock())
            with (
                patch.dict(sys.modules, {"fcntl": fcntl}),
                patch.object(supervisor, "load_attempt", return_value=(attempt, request)),
                patch.object(supervisor, "remaining_deadline", return_value=supervisor.time.monotonic() + 60),
                patch.object(supervisor, "verify_sources"),
                patch.object(supervisor.subprocess, "Popen") as launch,
                patch.object(supervisor, "create_file") as retain,
            ):
                result = supervisor.supervise(Path(directory), invocation, request_sha)
            self.assertIn("refuses repeat", result["failure"])
            launch.assert_not_called()
            retain.assert_not_called()
            self.assertEqual((capture / "outer-intent.json").read_bytes(), b"original-intent")

    def test_settle_changed_original_invocation_refuses_before_any_kill(self):
        invocation, request_sha = "a" * 64, "b" * 64
        unit = "portcove-native-" + invocation + ".service"
        binding = {
            "invocation_id": invocation,
            "unit": {
                "name": unit,
                "invocation_id": "c" * 32,
                "control_group": "/user.slice/user-1002.slice/app.slice/" + unit,
            },
        }
        with (
            patch.object(supervisor, "load_attempt", return_value=(Path("/inert"), {})),
            patch.object(supervisor, "readback", return_value={"cgroup_empty": False}),
            patch.object(supervisor, "read_marker", return_value=binding),
            patch.object(supervisor, "unit_properties", return_value={"InvocationID": "d" * 32}),
            patch.object(supervisor, "systemctl") as action,
            self.assertRaises(supervisor.Refusal),
        ):
            supervisor.settle(Path("/inert"), invocation, request_sha)
        action.assert_not_called()

    def test_maximum_username_uses_kernel_bounded_identity_bound_socket_route(self):
        root = Path("/home/" + "q" * 32 + "/portcove-native")
        invocation, request_sha = "a" * 64, "b" * 64
        route = supervisor.socket_route(root, invocation, request_sha)
        self.assertLessEqual(len(route.as_posix().encode("utf-8")), 107)
        old = root / "invocations" / invocation / "capture/outer-ready.sock"
        self.assertGreater(len(old.as_posix().encode("utf-8")), 107)
        self.assertEqual(route.parent, root / ".s")
        self.assertEqual(route, supervisor.socket_route(root, invocation, request_sha))
        self.assertNotEqual(route, supervisor.socket_route(root, "c" * 64, request_sha))
        self.assertNotEqual(route, supervisor.socket_route(root, invocation, "d" * 64))
        claim = {
            "schema_version": 1,
            "invocation_id": invocation,
            "request_sha256": request_sha,
            "socket": route.as_posix(),
        }
        supervisor.inspect_socket_claim(claim, root, invocation, request_sha)
        for changed in (
            {**claim, "invocation_id": "c" * 64},
            {**claim, "request_sha256": "d" * 64},
            {**claim, "socket": route.as_posix() + "-other"},
        ):
            with self.subTest(changed=changed), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_socket_claim(changed, root, invocation, request_sha)
        with self.assertRaises(supervisor.Refusal):
            supervisor.socket_route(Path("/home/" + "q" * 33 + "/portcove-native"), invocation, request_sha)

    def test_shared_home_mount_owner_is_fixed_and_enclosed_by_existing_unit(self):
        root = Path("/home/qualification/portcove-native")
        attempt = root / "invocations" / ("a" * 64)
        command = supervisor.bounded_driver_command(
            root, attempt, {"qualification_uid": 1002, "qualification_gid": 1002, "plan_sha256": "b" * 64}
        )
        self.assertEqual(command[0], "/usr/bin/bwrap")
        at = command.index("--size")
        self.assertEqual(
            command[at : at + 4], ["--size", str(512 * 1024 * 1024), "--tmpfs", str(attempt / "work/home")]
        )
        self.assertEqual(command.count("--tmpfs"), 1)
        at = command.index("--dev-bind")
        self.assertEqual(command[at - 3 : at + 3], ["--bind", "/", "/", "--dev-bind", "/dev/null", "/dev/null"])
        self.assertEqual(command.count("--dev-bind"), 1)
        self.assertNotIn("--dev", command)
        self.assertIn("--unshare-user", command)
        self.assertNotIn("--unshare-pid", command)
        self.assertNotIn("--unshare-net", command)
        self.assertEqual(command[command.index("--") + 1], str(root / "tools/node"))
        self.assertEqual(command[-2:], ["--unit-binding", str(attempt / "capture/unit-binding.json")])

    def test_atomic_json_publication_keeps_complete_first_record_and_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "record.json"
            # Windows lacks directory fsync; inert publication still exercises
            # actual tempfile writes+link and rejects overwriting final bytes.
            original_open = supervisor.os.open

            def selected_open(path, flags, *args):
                if Path(path) == Path(directory):
                    return original_open(filename, supervisor.os.O_RDWR)
                return original_open(path, flags, *args)

            with patch.object(supervisor.os, "open", side_effect=selected_open):
                supervisor.create_file(filename, supervisor.encode({"first": True}))
            self.assertEqual(supervisor.decode(filename.read_bytes()), {"first": True})
            with self.assertRaises(FileExistsError), patch.object(supervisor.os, "open", side_effect=selected_open):
                supervisor.create_file(filename, supervisor.encode({"first": False}))
            self.assertEqual(supervisor.decode(filename.read_bytes()), {"first": True})


if __name__ == "__main__":
    unittest.main()
