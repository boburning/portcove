import contextlib
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "native_transfer", Path(__file__).with_name("native-qualification-linux-transfer.py")
)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
ID = "a" * 64


class TransferTests(unittest.TestCase):
    def test_strict_header_no_caller_path_or_unbounded_payload(self):
        valid = {"schema_version": 1, "invocation_id": ID, "entry": "plan", "bytes": 4, "sha256": "b" * 64}
        self.assertEqual(transfer.inspect_header(valid, ID), valid)
        predecessor = {**valid, "entry": "predecessor", "bytes": 512 * transfer.MIB}
        self.assertEqual(transfer.inspect_header(predecessor, ID), predecessor)
        with self.assertRaises(RuntimeError):
            transfer.inspect_header({**predecessor, "bytes": 512 * transfer.MIB + 1}, ID)
        for changed in (
            {**valid, "entry": "../controller/source"},
            {**valid, "path": "/tmp/other"},
            {**valid, "bytes": 128 * 1024 + 1},
            {**valid, "bytes": True},
            {**valid, "invocation_id": "c" * 64},
            {**valid, "sha256": "unknown"},
        ):
            with self.assertRaises(RuntimeError):
                transfer.inspect_header(changed, ID)

    def stage(self, root, payload, declared=None, suffix=b"", expected_header=True):
        raw = json.dumps(
            {
                "schema_version": 1,
                "invocation_id": ID,
                "entry": "plan",
                "bytes": len(payload),
                "sha256": declared or hashlib.sha256(payload).hexdigest(),
            },
            separators=(",", ":"),
        ).encode()
        # Portable transfer test checks actual file/stream effects. Platform
        # ownership/namespace/task assertions remain separately unobserved.
        with (
            patch.object(transfer, "owned", lambda filename, directory=False: filename.lstat()),
            patch.object(transfer.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True),
            patch.object(transfer.os, "fchmod", (os.fchmod if os.name != "nt" else lambda fd, mode: None), create=True),
            patch.object(transfer, "sync_directory", lambda _: None),
            patch.object(transfer.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(raw + b"\n" + payload + suffix))),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            transfer.stage(root, ID, hashlib.sha256(raw).hexdigest() if expected_header else "f" * 64)

    def test_complete_exact_bytes_are_published_once_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "invocations").mkdir()
            self.stage(root, b'{"inert":true}')
            target = root / "invocations" / ID / "plan.json"
            self.assertEqual(target.read_bytes(), b'{"inert":true}')
            self.assertEqual(target.stat().st_nlink, 1)
            self.assertFalse(Path(str(target) + ".partial").exists())
            with self.assertRaises(RuntimeError):
                self.stage(root, b'{"inert":false}')
            self.assertEqual(target.read_bytes(), b'{"inert":true}')

    def test_changed_digest_and_trailing_bytes_preserve_only_original_partial(self):
        for declared, suffix in (("f" * 64, b""), (None, b"extra")):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "invocations").mkdir()
                with self.assertRaises(RuntimeError):
                    self.stage(root, b"data", declared, suffix)
                target = root / "invocations" / ID / "plan.json"
                self.assertFalse(target.exists())
                self.assertEqual(Path(str(target) + ".partial").read_bytes(), b"data")
                with self.assertRaises(FileExistsError):
                    self.stage(root, b"data")

    def test_wrong_header_refuses_before_attempt_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "invocations").mkdir()
            with self.assertRaises(RuntimeError):
                self.stage(root, b"data", expected_header=False)
            self.assertEqual(list((root / "invocations").iterdir()), [])

    def test_retained_capture_export_is_exact_binary_and_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / "invocations" / ID / "capture"
            capture.mkdir(parents=True)
            original = b"binary\x00\nnon-json\xff"
            (capture / "outer-stdout.log").write_bytes(original)
            (capture / "result.json").write_bytes(b'{"authority":"none"}')
            output = io.BytesIO()

            def portable_owned(filename, directory=False):
                if directory or os.name != "nt":
                    return filename.lstat()
                # Windows Python path ctime is creation time while fstat ctime
                # is change time. Model Linux's matching handle semantics only
                # in this portable fixture; production still compares all fields.
                fd = os.open(filename, os.O_RDONLY)
                try:
                    return os.fstat(fd)
                finally:
                    os.close(fd)

            with (
                patch.object(transfer, "owned", portable_owned),
                patch.object(transfer.os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True),
                patch.object(transfer.os, "O_NONBLOCK", getattr(os, "O_NONBLOCK", 0), create=True),
                patch.object(transfer.sys, "stdout", SimpleNamespace(buffer=output)),
            ):
                transfer.export_capture(root, ID)
            output.seek(0)
            first = json.loads(output.readline())
            self.assertEqual(first["path"], "outer-stdout.log")
            self.assertEqual(output.read(first["bytes"]), original)
            self.assertEqual(first["sha256"], hashlib.sha256(original).hexdigest())
            second = json.loads(output.readline())
            self.assertEqual(output.read(second["bytes"]), b'{"authority":"none"}')
            final = json.loads(output.readline())
            self.assertEqual(
                final, {"schema_version": 1, "invocation_id": ID, "complete": True, "count": 2, "authority": "none"}
            )
            self.assertEqual(output.read(), b"")
            self.assertEqual((capture / "outer-stdout.log").read_bytes(), original)

    def test_actual_outer_lock_and_atomic_marker_alias_are_retained_without_hidden_path_widening(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / "invocations" / ID / "capture"
            capture.mkdir(parents=True)
            lock = capture / ".outer.lock"
            lock.write_bytes(b"")
            marker = capture / "unit-binding.json"
            marker.write_bytes(b'{"inert":true}')
            os.link(marker, capture / (".outer-json-" + "a" * 32))
            with patch.object(transfer, "owned", lambda filename, directory=False: filename.lstat()):
                self.assertEqual(
                    [item[0] for item in transfer.capture_files(root, ID)],
                    [".outer-json-" + "a" * 32, "unit-binding.json"],
                )
                self.assertTrue(lock.exists())
                lock.write_bytes(b"unexpected")
                with self.assertRaisesRegex(RuntimeError, "outer lock differs"):
                    transfer.capture_files(root, ID)
                lock.write_bytes(b"")
                (capture / ".other").write_bytes(b"")
                with self.assertRaisesRegex(RuntimeError, "capture path differs"):
                    transfer.capture_files(root, ID)


if __name__ == "__main__":
    unittest.main()
