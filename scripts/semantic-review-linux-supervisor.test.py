"""Inert model/parser tests only: no namespace, systemd, auth or provider calls."""

import errno
import importlib.util
import io
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "supervisor", Path(__file__).with_name("semantic-review-linux-supervisor.py")
)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


def request():
    return {
        "schema_version": 1,
        "mode": "fixture",
        "run_root": "/home/reviewer/run",
        "runtime_sha256": dict.fromkeys(supervisor.RUNTIME, "a" * 64),
        "tools_sha256": dict.fromkeys(supervisor.TOOLS, "b" * 64),
        "inputs_sha256": dict.fromkeys(
            (*supervisor.INPUT_SMALL, "reader-index.json", "objects/" + "c" * 40 + ".data"), "d" * 64
        ),
        "timeout_seconds": 30,
        "auth_cache": None,
    }


class SupervisorContract(unittest.TestCase):
    def test_current_codex_bound_does_not_expand_other_runtime_or_writable_storage(self):
        # Scale only the byte unit: exercise actual bounded regular-file reads
        # without allocating a production-sized executable in this inert test.
        with tempfile.TemporaryDirectory() as directory, patch.object(supervisor, "MIB", 1):
            executable = Path(directory) / "binary"
            executable.write_bytes(b"x" * 300)
            self.assertEqual(supervisor.read_runtime(executable, "codex"), b"x" * 300)
            with self.assertRaises(supervisor.Refusal):
                supervisor.read_runtime(executable, "node")
            executable.write_bytes(b"x" * 321)
            with self.assertRaises(supervisor.Refusal):
                supervisor.read_runtime(executable, "codex")
            with self.assertRaises(supervisor.Refusal):
                supervisor.read_runtime(executable, "candidate-selected-runtime")
        self.assertEqual(supervisor.STORAGE_BYTES, 512 * 1024 * 1024)

    def test_fixed_request_no_command_or_credential_discovery(self):
        self.assertEqual(supervisor.inspect_request(request())["mode"], "fixture")
        for key, value in (("command", ["sh"]), ("backend", "other"), ("environment", {"TOKEN": "x"})):
            invalid = request()
            invalid[key] = value
            with self.subTest(key=key), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_request(invalid)
        for key, value in (
            ("mode", "login"),
            ("timeout_seconds", 1201),
            ("timeout_seconds", True),
            ("auth_cache", "/home/reviewer/auth.json"),
            ("run_root", "/home/../secret"),
        ):
            invalid = request()
            invalid[key] = value
            with self.subTest(key=key), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_request(invalid)

    def test_codex_requires_explicit_dedicated_chatgpt_cache(self):
        value = request()
        value["mode"] = "codex"
        with self.assertRaises(supervisor.Refusal):
            supervisor.inspect_request(value)
        value["auth_cache"] = "/home/reviewer/dedicated/auth.json"
        self.assertEqual(supervisor.inspect_request(value)["mode"], "codex")
        for mode in ("fixture", "codex-fixture"):
            value["mode"] = mode
            with self.assertRaises(supervisor.Refusal):
                supervisor.inspect_request(value)

    def test_auth_parser_refuses_api_keys_and_incomplete_refresh_without_logging_values(self):
        import json

        value = {
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": None,
            "tokens": {"id_token": "inert-id", "access_token": "inert-access", "refresh_token": "inert-refresh"},
        }
        data = json.dumps(value).encode()
        self.assertEqual(supervisor.inspect_auth(data), data)
        for changed in (
            {**value, "auth_mode": "api_key"},
            {**value, "OPENAI_API_KEY": "inert-never-an-actual-key"},
            {**value, "tokens": {"id_token": "inert-id"}},
        ):
            with self.assertRaises(supervisor.Refusal) as failure:
                supervisor.inspect_auth(json.dumps(changed).encode())
            self.assertNotIn("inert-never-an-actual-key", str(failure.exception))

    def test_unmanifested_paths_and_duplicate_json_refuse(self):
        for name in ("../auth.json", "objects/run.sh", "objects/" + "c" * 40 + ".exe"):
            value = request()
            value["inputs_sha256"][name] = "e" * 64
            with self.subTest(name=name), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_request(value)
        for data in (b'{"mode":1,"mode":2}', b'{"x":NaN}', b"\xff"):
            with self.assertRaises(supervisor.Refusal):
                supervisor.decode_json(data)

    def test_connect_exact_provider_hosts_and_tls_port_only(self):
        for host in supervisor.HOSTS:
            self.assertEqual(
                supervisor.connect_target(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode()), host
            )
        for target in (
            "api.openai.com:443",
            "chatgpt.com.evil.test:443",
            "127.0.0.1:443",
            "chatgpt.com:80",
            "CHATGPT.COM:443",
            "user@chatgpt.com:443",
        ):
            with self.subTest(target=target), self.assertRaises(supervisor.Refusal):
                supervisor.connect_target(f"CONNECT {target} HTTP/1.1\r\n\r\n".encode())
        for value in (
            b"GET https://chatgpt.com HTTP/1.1\r\n\r\n",
            b"x" * 4097,
            b"CONNECT chatgpt.com:443 HTTP/1.1\r\n folded: header\r\n\r\n",
        ):
            with self.assertRaises(supervisor.Refusal):
                supervisor.connect_target(value)

    def test_one_total_storage_mount_and_no_alternate_writable_root(self):
        mounts = (
            "1 0 0:1 / / ro - tmpfs tmpfs ro\n"
            "2 1 0:2 / /w rw - tmpfs tmpfs rw,size=524288k\n"
            "3 1 0:3 / /proc ro - proc proc rw\n"
            "4 1 0:4 / /dev/null rw - devtmpfs devtmpfs rw\n"
        )
        self.assertEqual(supervisor.inspect_mounts(mounts), ["/dev/null", "/w"])
        for changed in (
            mounts.replace("/ ro - tmpfs", "/ rw - tmpfs"),
            mounts.replace("524288k", "1048576k"),
            mounts + "5 1 0:5 / /dev/shm rw - tmpfs tmpfs rw\n",
            mounts.replace("/proc ro", "/proc rw"),
        ):
            with self.assertRaises(supervisor.Refusal):
                supervisor.inspect_mounts(changed)

    def test_fixed_unit_and_bwrap_arguments_preserve_limits_and_isolation(self):
        with patch.object(Path, "exists", return_value=True):
            command = supervisor.unit_command(
                request(), Path("/home/reviewer/run"), "portcove-semantic-fixed.service", Path("/trusted/supervisor.py")
            )
        self.assertIn("--property=MemoryMax=1073741824", command)
        self.assertIn("--property=MemorySwapMax=0", command)
        self.assertIn("--property=TasksMax=64", command)
        self.assertIn("--property=KillMode=control-group", command)
        self.assertEqual(command.count("--size"), 1)
        for required in ("--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--clearenv"):
            self.assertIn(required, command)
        self.assertNotIn("--share-net", command)
        self.assertNotIn("--bind", command)
        self.assertNotIn("/mnt", command)
        self.assertEqual(command[-3:], ["/supervisor.py", "--inside", "fixture"])

    def test_actual_unit_limits_cannot_be_unknown_unlimited_or_wrong(self):
        properties = {
            "LoadState": "loaded",
            "ActiveState": "active",
            "MemoryMax": "1073741824",
            "MemorySwapMax": "0",
            "TasksMax": "64",
        }
        supervisor.inspect_unit_properties(properties)
        for key in properties:
            invalid = dict(properties, **{key: "unknown"})
            with self.subTest(key=key), self.assertRaises(supervisor.Refusal):
                supervisor.inspect_unit_properties(invalid)

    def test_capture_flood_retains_exact_prefix_and_refuses(self):
        output = io.BytesIO()
        totals = {"stdout": 0, "stderr": 0}
        supervisor.capture_piece(output, totals, "stderr", b"a" * (supervisor.STDERR_BYTES - 1))
        with self.assertRaises(supervisor.Refusal):
            supervisor.capture_piece(output, totals, "stderr", b"BC")
        self.assertEqual(len(output.getvalue()), supervisor.STDERR_BYTES)
        self.assertTrue(output.getvalue().endswith(b"B"))

    def test_auth_refresh_requires_every_positive_settlement_fact(self):
        result = {
            "failure": None,
            "capture_complete": True,
            "cgroup_empty": True,
            "unit_settled": True,
            "network_settled": True,
            "network_refused": False,
            "forced_termination": False,
            "cleanup_errors": [],
        }
        self.assertTrue(supervisor.auth_refresh_allowed(result, [10]))
        for key, value in (
            ("failure", "unknown"),
            ("capture_complete", False),
            ("cgroup_empty", False),
            ("unit_settled", False),
            ("network_settled", False),
            ("network_refused", True),
            ("forced_termination", True),
            ("cleanup_errors", ["unknown"]),
        ):
            with self.subTest(key=key):
                self.assertFalse(supervisor.auth_refresh_allowed(dict(result, **{key: value}), [10]))
        self.assertFalse(supervisor.auth_refresh_allowed(result, []))
        self.assertFalse(supervisor.auth_refresh_allowed(result, [10, 11]))

    def test_codex_command_is_fixed_safe_reader_and_disabled_shell(self):
        command = supervisor.codex_arguments("f" * 64, "codex")
        self.assertEqual(command[0], "/runtime/codex")
        self.assertIn("features.shell_tool=false", command)
        self.assertIn("features.plugins=false", command)
        self.assertIn("features.code_mode=false", command)
        self.assertIn("features.code_mode_host=false", command)
        self.assertIn('forced_login_method="chatgpt"', command)
        self.assertIn('cli_auth_credentials_store="file"', command)
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ignore-rules", command)
        self.assertIn("--output-schema", command)
        self.assertTrue(
            any(
                "release-semantic-reader-server.mts" in part and "reader-index.json" in part and "f" * 64 in part
                for part in command
            )
        )

    def removed_group(self):
        group = supervisor.HeldCgroup.__new__(supervisor.HeldCgroup)
        group.directory = 17
        group.path = Path(
            "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/portcove-semantic-fixed.service"
        )
        group.identity = (12, 34)
        group.last_observation = None
        group.read = Mock(side_effect=OSError(errno.ENODEV, "inert removed cgroup"))
        return group

    def test_exact_held_kernel_removal_is_positive_even_if_path_is_recreated(self):
        group = self.removed_group()
        info = SimpleNamespace(st_dev=12, st_ino=34, st_mode=stat.S_IFDIR | 0o755)
        with (
            patch.object(supervisor.os, "fstat", return_value=info),
            patch.object(supervisor, "filesystem_kind", return_value=0x63677270),
            patch.object(supervisor.os, "readlink", return_value=str(group.path) + " (deleted)"),
            patch.object(Path, "exists", side_effect=AssertionError("must not infer removal from pathname")),
        ):
            self.assertTrue(group.empty())
            self.assertEqual(group.last_observation, "removed-exact-held-cgroup")

    def test_missing_unreadable_renamed_or_wrong_held_identity_never_proves_removal(self):
        group = self.removed_group()
        good = SimpleNamespace(st_dev=12, st_ino=34, st_mode=stat.S_IFDIR | 0o755)
        for link, info, kind in (
            (str(group.path), good, 0x63677270),
            (str(group.path) + "-different (deleted)", good, 0x63677270),
            (str(group.path) + " (deleted)", SimpleNamespace(st_dev=12, st_ino=35, st_mode=stat.S_IFDIR), 0x63677270),
            (str(group.path) + " (deleted)", good, 0x01021994),
        ):
            with (
                self.subTest(link=link, kind=kind),
                patch.object(supervisor.os, "fstat", return_value=info),
                patch.object(supervisor, "filesystem_kind", return_value=kind),
                patch.object(supervisor.os, "readlink", return_value=link),
                self.assertRaises(supervisor.Refusal),
            ):
                group.empty()
        group.read.side_effect = PermissionError(errno.EACCES, "inert access denial")
        with (
            patch.object(supervisor.os, "readlink", side_effect=AssertionError("must preserve permission error")),
            self.assertRaises(PermissionError),
        ):
            group.empty()

    def test_observed_populated_remains_live_and_exited_wrapper_does_not_exempt_cleanup(self):
        group = self.removed_group()
        group.read.side_effect = lambda name: "populated 1\nfrozen 0\n" if name == "cgroup.events" else "1234\n"
        self.assertFalse(group.empty())
        self.assertTrue(supervisor.needs_unit_kill(group))
        self.assertTrue(supervisor.needs_unit_kill(None))
        group.read.side_effect = lambda name: "populated 0\nfrozen 0\n" if name == "cgroup.events" else ""
        self.assertTrue(group.empty())
        self.assertEqual(group.last_observation, "observed-unpopulated")
        self.assertFalse(supervisor.needs_unit_kill(group))

    def test_capture_polls_control_completion_once_more_after_both_pipe_eofs(self):
        selector = Mock()
        selector.get_map.return_value = {}
        process = SimpleNamespace(stdout=Mock(), stderr=Mock(), wait=Mock())
        tick = Mock()
        with (
            tempfile.TemporaryFile() as first,
            tempfile.TemporaryFile() as second,
            patch.object(supervisor.selectors, "DefaultSelector", return_value=selector),
            patch.object(supervisor.os, "set_blocking"),
        ):
            complete, totals = supervisor.drain_capture(
                process, {"stdout": first, "stderr": second}, supervisor.time.monotonic() + 1, tick
            )
        self.assertTrue(complete)
        self.assertEqual(totals, {"stdout": 0, "stderr": 0})
        tick.assert_called_once()


if __name__ == "__main__":
    unittest.main()
