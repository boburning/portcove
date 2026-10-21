"""Pure mount policy plus controlled local FD transfer; never a FUSE mount."""

import array
import datetime
import importlib.util
import math
import os
import socket
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("fuse", Path(__file__).with_name("native-linux-public-fuse.py"))
fuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fuse)


def policy():
    return {
        "schema_version": 1,
        "nonce": "a" * 64,
        "uid": 1002,
        "gid": 1002,
        "packages": [{"bytes": 100, "sha256": "b" * 64}, {"bytes": 200, "sha256": "c" * 64}],
        "python_sha256": "d" * 64,
        "deadline_utc": (datetime.datetime.now(datetime.UTC) + datetime.timedelta(seconds=30))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }


class FusePolicy(unittest.TestCase):
    def test_fixed_mount_options_have_no_caller_kernel_or_privilege_flags(self):
        original = [
            "-o",
            "ro,nosuid,nodev,fsname=" + fuse.ACTIVE + ",subtype=squashfuse",
            "--",
            "/tmp/.mount_Portco123abc",
        ]
        self.assertEqual(fuse.inspect_helper_arguments(original)["action"], "mount")
        self.assertEqual(fuse.inspect_helper_arguments(["-u", "-q", "-z", "--", original[-1]])["action"], "unmount")
        self.assertEqual(
            fuse.inspect_helper_arguments(["--unmount", "--quiet", "--lazy", "--", original[-1]])["action"], "unmount"
        )
        for options in (
            "rw",
            "ro,allow_other",
            "ro,suid",
            "ro,dev",
            "ro,fd=7",
            "ro,user_id=0",
            "ro,fsname=/etc/passwd",
            "ro,ro",
            "ro,subtype=AppImage,subtype=squashfuse",
        ):
            with self.subTest(options=options), self.assertRaises(RuntimeError):
                fuse.inspect_helper_arguments(["-o", options, "--", original[-1]])
        for target in (
            "/tmp/elsewhere",
            "/tmp/.mount_a/../b",
            "/proc/self/fd/7",
            "/tmp/.mount_",
            "/tmp/.mount_" + "x" * 65,
        ):
            with self.subTest(target=target), self.assertRaises(RuntimeError):
                fuse.inspect_helper_arguments([*original[:3], target])

    def test_policy_is_detached_exact_distinct_and_nonroot(self):
        raw = policy()
        detached = fuse.inspect_policy(raw)
        raw["packages"][0]["sha256"] = "e" * 64
        self.assertEqual(detached["packages"][0]["sha256"], "b" * 64)
        self.assertLess(len(fuse.abstract_address(detached).encode()), 108)
        for key, value in (
            ("uid", 0),
            ("gid", True),
            ("nonce", "a" * 65),
            ("python_sha256", ""),
            ("packages", [detached["packages"][0]] * 2),
        ):
            changed = {**detached, key: value}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                fuse.inspect_policy(changed)
        with self.assertRaises(RuntimeError):
            fuse.inspect_policy({**detached, "accepted": True})
        with self.assertRaises(RuntimeError):
            fuse.decode(b'{"a":1,"a":2}')

    def test_runtime_generation_survives_normal_daemon_reparenting_only(self):
        runtime = {"pid": 99, "creation_ticks": "100", "parent_pid": 2, "package": policy()["packages"][0]}
        self.assertTrue(fuse.same_runtime(runtime, {**runtime, "parent_pid": 1}))
        for changed in (
            {**runtime, "pid": 100},
            {**runtime, "creation_ticks": "101"},
            {**runtime, "package": policy()["packages"][1]},
            {"pid": 99},
        ):
            self.assertFalse(fuse.same_runtime(runtime, changed))

    @patch.multiple(fuse.os, O_PATH=0x200000, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, create=True)
    def test_inert_unmount_uses_original_held_mount_not_replaced_pathname(self):
        raw = policy()
        peer = {"pid": 99, "creation_ticks": "100", "package": raw["packages"][0]}
        target = "/tmp/.mount_Portco123abc"
        row = {
            "id": "55",
            "path": target,
            "filesystem": "fuse.AppImage",
            "source": fuse.ACTIVE,
            "options": ["ro", "nosuid", "nodev"],
        }
        for observed in ("55", "88"):
            broker = object.__new__(fuse.NativeFuseBroker)
            broker.policy, broker.deadline = raw, time.monotonic() + 30
            broker.refused = False
            broker.mounts = {target: {"runtime": peer, "mount": row}}
            events = []
            broker.emit = events.append
            channel = Mock()
            channel.send.return_value = 1
            channel.recvmsg.return_value = (
                fuse.json.dumps({"schema_version": 1, "argv": ["-u", "-q", "-z", "--", target]}).encode(),
                [],
                0,
                None,
            )
            unmount = Mock(return_value=0)
            # A different mount may now occupy the pathname. Only the held
            # original ID is removed; the later mount is never targeted.
            later = {**row, "id": "94"}
            with (
                patch.object(fuse, "assert_broker_boundary"),
                patch.object(fuse, "inspect_peer", return_value=peer),
                patch.object(fuse, "read_process_identity", return_value=peer),
                patch.object(fuse, "mount_rows", side_effect=[[row], [later]]),
                patch.object(fuse, "mount_descriptor", return_value={"mnt_id": observed, "ino": "777"}),
                patch.object(fuse.os, "open", return_value=17),
                patch.object(fuse.os, "close") as close,
                patch.object(fuse.ctypes, "CDLL", return_value=SimpleNamespace(umount2=unmount)),
            ):
                if observed == "55":
                    broker.handle(channel)
                    unmount.assert_called_once_with(b"/proc/self/fd/17", 2)
                    self.assertEqual(events[-1]["mount"]["id"], "55")
                    self.assertEqual(broker.mounts, {})
                else:
                    with self.assertRaisesRegex(RuntimeError, "not the original"):
                        broker.handle(channel)
                    unmount.assert_not_called()
                    self.assertIn(target, broker.mounts)
                close.assert_called_once_with(17)

    def test_original_deadlines_refuse_expired_nonfinite_or_invalid_dates(self):
        raw = policy()
        self.assertGreater(fuse.bounded_deadline(raw, time.monotonic() + 1), 0)
        for deadline in (time.monotonic() - 1, math.inf, math.nan):
            with self.subTest(deadline=deadline), self.assertRaises(RuntimeError):
                fuse.bounded_deadline(raw, deadline)
        for value in ("2026-02-30T00:00:00.000Z", "2020-01-01T00:00:00.000Z"):
            with self.subTest(value=value), self.assertRaises((RuntimeError, ValueError)):
                fuse.bounded_deadline({**raw, "deadline_utc": value}, time.monotonic() + 1)

    def test_imported_metadata_cannot_establish_the_privileged_broker_boundary(self):
        # In an ordinary test process, the actual kernel PID/capability checks
        # refuse before any device operation, mount syscall or namespace setup.
        with self.assertRaises(RuntimeError):
            fuse.NativeFuseBroker(policy(), (), time.monotonic() + 1, lambda _: None)

    @patch.multiple(fuse.os, O_PATH=0x200000, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, create=True)
    def test_inert_original_mount_intent_survives_lost_response_and_refuses_repeat(self):
        raw = policy()
        broker = object.__new__(fuse.NativeFuseBroker)
        broker.policy, broker.deadline = raw, time.monotonic() + 30
        broker.devices, broker.owned_devices = [7], {7}
        broker.mounts, broker.attempted = {}, set()
        broker.refused = broker.stopping = False
        events = []
        broker.emit = events.append
        peer = {"pid": 99, "parent_pid": 2, "creation_ticks": "100", "package": raw["packages"][0]}
        target = "/tmp/.mount_Portco123abc"
        channel = Mock()
        request = {"schema_version": 1, "argv": ["-o", "ro,fsname=" + fuse.ACTIVE, "--", target]}
        channel.recvmsg.return_value = (fuse.json.dumps(request).encode(), [], 0, None)
        row = {
            "id": "55",
            "path": target,
            "filesystem": "fuse.AppImage",
            "source": fuse.ACTIVE,
            "options": ["ro", "nosuid", "nodev"],
        }
        info = SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o700,
            st_uid=1002,
            st_gid=1002,
            st_dev=1,
            st_ino=2,
            st_nlink=2,
            st_size=0,
            st_mtime_ns=1,
            st_ctime_ns=1,
        )
        mount = Mock(return_value=0)
        with (
            patch.object(fuse, "assert_broker_boundary"),
            patch.object(fuse, "inspect_peer", return_value=peer),
            patch.object(fuse, "read_process_identity", return_value=peer),
            patch.object(fuse, "mount_rows", side_effect=[[], [row]]),
            patch.object(fuse.os, "open", return_value=17),
            patch.object(fuse.os, "close"),
            patch.object(fuse.os, "fstat", return_value=info),
            patch.object(fuse.os, "stat", return_value=info),
            patch.object(fuse.os, "listdir", return_value=[]),
            patch.object(fuse.ctypes, "CDLL", return_value=SimpleNamespace(mount=mount)),
            patch.object(fuse, "send_descriptor", side_effect=RuntimeError("lost descriptor response")),
        ):
            with self.assertRaisesRegex(RuntimeError, "lost descriptor response"):
                broker.handle(channel)
            self.assertEqual([event["stage"] for event in events], ["intent", "mounted"])
            self.assertEqual(broker.mounts[target]["mount"], row)
            with self.assertRaisesRegex(RuntimeError, "cannot repeat"):
                broker.handle(channel)
            self.assertEqual(mount.call_count, 1)
            self.assertEqual(mount.call_args.args[3], 1 | 2 | 4)
            self.assertIn(b"user_id=1002,group_id=1002", mount.call_args.args[4])

    @patch.multiple(fuse.os, O_PATH=0x200000, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, create=True)
    def test_inert_late_intent_refuses_before_any_mount_syscall(self):
        raw = policy()
        broker = object.__new__(fuse.NativeFuseBroker)
        broker.policy, broker.deadline = raw, time.monotonic() + 30
        broker.devices, broker.owned_devices = [7], {7}
        broker.mounts, broker.attempted = {}, set()
        broker.refused = broker.stopping = False
        broker.emit = lambda _: setattr(broker, "deadline", time.monotonic() - 1)
        peer = {"pid": 99, "creation_ticks": "100", "package": raw["packages"][0]}
        channel = Mock()
        channel.recvmsg.return_value = (
            fuse.json.dumps(
                {"schema_version": 1, "argv": ["-o", "ro,fsname=" + fuse.ACTIVE, "--", "/tmp/.mount_test"]}
            ).encode(),
            [],
            0,
            None,
        )
        info = SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o700,
            st_uid=1002,
            st_gid=1002,
            st_dev=1,
            st_ino=2,
            st_nlink=2,
            st_size=0,
            st_mtime_ns=1,
            st_ctime_ns=1,
        )
        with (
            patch.object(fuse, "assert_broker_boundary"),
            patch.object(fuse, "inspect_peer", return_value=peer),
            patch.object(fuse, "read_process_identity", return_value=peer),
            patch.object(fuse, "mount_rows", return_value=[]),
            patch.object(fuse.os, "open", return_value=17),
            patch.object(fuse.os, "close"),
            patch.object(fuse.os, "fstat", return_value=info),
            patch.object(fuse.os, "stat", return_value=info),
            patch.object(fuse.os, "listdir", return_value=[]),
            patch.object(fuse.ctypes, "CDLL") as system,
        ):
            with self.assertRaisesRegex(RuntimeError, "lifetime exhausted"):
                broker.handle(channel)
            system.assert_not_called()


@unittest.skipUnless(sys.platform == "linux", "requires actual Linux Unix descriptor transport")
class ActualUnixDescriptors(unittest.TestCase):
    def test_actual_held_path_fd_retains_kernel_mount_and_inode_generation(self):
        with tempfile.TemporaryDirectory() as root:
            held = os.open(root, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                original = fuse.mount_descriptor(held)
                moved = root + "-moved"
                os.rename(root, moved)
                try:
                    os.mkdir(root)
                    self.assertEqual(fuse.mount_descriptor(held), original)
                    self.assertNotEqual(str(os.stat(root).st_ino), original["ino"])
                finally:
                    os.rmdir(root)
                    os.rename(moved, root)
            finally:
                os.close(held)

    def test_libfuse_one_byte_scm_rights_transports_real_original_file(self):
        with tempfile.TemporaryFile() as source:
            source.write(b"owned-original-descriptor")
            source.flush()
            source.seek(0)
            first, second = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            with first, second:
                first.settimeout(1)
                second.settimeout(1)
                fuse.send_descriptor(first, source.fileno())
                actual = fuse.receive_descriptor(second)
                try:
                    self.assertFalse(os.get_inheritable(actual))
                    self.assertEqual(os.read(actual, 100), b"owned-original-descriptor")
                finally:
                    os.close(actual)

    def test_extra_or_changed_descriptor_response_refuses_without_leaking_fds(self):
        with tempfile.TemporaryFile() as source:
            for payload, count in ((b"X", 1), (b"\0", 2), (b"\0", 4)):
                first, second = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                with first, second:
                    before = len(os.listdir("/proc/self/fd"))
                    first.sendmsg(
                        [payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [source.fileno()] * count))]
                    )
                    with self.assertRaises(RuntimeError):
                        fuse.receive_descriptor(second)
                    self.assertEqual(len(os.listdir("/proc/self/fd")), before)
                    os.fstat(source.fileno())


if __name__ == "__main__":
    unittest.main(verbosity=2)
