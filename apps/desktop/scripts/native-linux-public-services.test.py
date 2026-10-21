"""Controlled services tests: no namespace, capabilities, FUSE or native app."""

import hashlib
import importlib.util
import json
import os
import selectors
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("services", Path(__file__).with_name("native-linux-public-services.py"))
services = importlib.util.module_from_spec(spec)
spec.loader.exec_module(services)


class Contracts(unittest.TestCase):
    def test_non_pid1_refuses_before_loading_or_forking(self):
        with patch.object(services.os, "getpid", return_value=2), patch.object(services, "load_fixed") as load:
            with self.assertRaisesRegex(RuntimeError, "private PID1"):
                services.PublicNativeServices({}, None, time.monotonic() + 1, lambda _: None)
            load.assert_not_called()


@unittest.skipUnless(os.name == "posix", "actual POSIX file/pipe/thread behavior is required on Linux CI")
class PosixContracts(unittest.TestCase):
    def test_settlement_written_between_eagain_and_waitpid_is_drained_before_exit_verdict(self):
        for report in (True, False):
            with self.subTest(actual_settlement_packet=report), selectors.DefaultSelector() as selection:
                reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
                stop_read, stop_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
                service = object.__new__(services.PublicNativeServices)
                service.end, service.emit, service.selection = time.monotonic() + 2, lambda _: None, selection
                service.pid, service.stop, service.events = 42, stop_write, reader
                service.network, service.relay = None, None
                service.buffer, service.total = b"", 0
                service.settled, service.ready = False, True
                selection.register(reader, selectors.EVENT_READ, service.read_events)

                def observe_exit(pid, flags, report=report, writer=writer):
                    self.assertEqual((pid, flags), (42, os.WNOHANG))
                    # The first nonblocking read already observed EAGAIN.
                    # Now the child writes its original packet and exits.
                    if report:
                        os.write(
                            writer,
                            json.dumps(
                                {
                                    "kind": "native-private-fuse",
                                    "stage": "settled",
                                    "mounts_empty": True,
                                    "authority": "none",
                                }
                            ).encode()
                            + b"\n",
                        )
                    return 42, 0

                try:
                    with (
                        patch.object(services.os, "waitpid", side_effect=observe_exit),
                        patch.object(services.os, "kill") as kill,
                    ):
                        if report:
                            self.assertTrue(service.close())
                        else:
                            with self.assertRaisesRegex(RuntimeError, "without positive settlement"):
                                service.close()
                        kill.assert_not_called()
                    self.assertIsNone(service.events)
                    with self.assertRaises(OSError):
                        os.fstat(reader)
                finally:
                    os.close(writer)
                    os.close(stop_read)

    def test_fixed_module_executes_only_captured_hash_verified_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "fixed.py"
            original = b"ANSWER = 42\n"
            filename.write_bytes(original)
            expected = hashlib.sha256(original).hexdigest()
            read = services.read_fixed

            def capture_then_replace(*args):
                captured = read(*args)
                filename.write_bytes(b"ANSWER = 99\n")
                return captured

            with patch.object(services, "read_fixed", side_effect=capture_then_replace):
                module = services.load_fixed(str(filename), expected)
            self.assertEqual(module.ANSWER, 42)
            with self.assertRaisesRegex(RuntimeError, "identity differs"):
                read(str(filename), expected, 1024)
            alias = Path(directory) / "alias.py"
            os.link(filename, alias)
            with self.assertRaisesRegex(RuntimeError, "file differs"):
                read(str(filename), hashlib.sha256(filename.read_bytes()).hexdigest(), 1024)

    def test_owned_http_worker_does_not_block_selector_and_refuses_parallel_request(self):
        entered, release = threading.Event(), threading.Event()
        calls, responses, unrelated = [], [], []

        def perform(*arguments):
            calls.append(arguments)
            entered.set()
            if not release.wait(2):
                raise RuntimeError("fixture did not release HTTP request")
            return {"status": 200, "body": b"actual controlled result"}

        with selectors.DefaultSelector() as selection:
            worker = services.FixedDriverHttpWorker(
                selection, time.monotonic() + 5, perform, lambda *args: responses.append(args)
            )
            reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
            selection.register(reader, selectors.EVENT_READ, lambda _: unrelated.append(os.read(reader, 1)))
            try:
                worker.submit(1, "GET", "/status", b"")
                self.assertTrue(entered.wait(1))
                with self.assertRaisesRegex(RuntimeError, "unresolved"):
                    worker.submit(2, "GET", "/status", b"")
                os.write(writer, b"x")
                for key, mask in selection.select(1):
                    key.data(mask)
                self.assertEqual(unrelated, [b"x"])
                self.assertEqual(responses, [])
                release.set()
                for key, mask in selection.select(1):
                    key.data(mask)
                self.assertEqual(len(calls), 1)
                self.assertEqual(responses, [(1, {"status": 200, "body": b"actual controlled result"})])
            finally:
                release.set()
                worker.close()
                selection.unregister(reader)
                os.close(reader)
                os.close(writer)

    def test_late_http_result_never_emits_positive_response(self):
        responses = []
        with selectors.DefaultSelector() as selection:
            worker = services.FixedDriverHttpWorker(
                selection, time.monotonic() + 5, lambda *_: {"status": 200}, lambda *args: responses.append(args)
            )
            try:
                worker.submit(1, "GET", "/status", b"")
                worker.end = time.monotonic() - 1
                for key, mask in selection.select(1):
                    with self.assertRaisesRegex(RuntimeError, "original lifetime"):
                        key.data(mask)
                self.assertEqual(responses, [])
            finally:
                worker.close()


if __name__ == "__main__":
    unittest.main()
