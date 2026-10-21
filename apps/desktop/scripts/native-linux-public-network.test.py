"""Inert capability models and controlled FD/socket tests, never host setup."""

import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import selectors
import socket
import ssl
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, mock_open, patch

spec = importlib.util.spec_from_file_location("network", Path(__file__).with_name("native-linux-public-network.py"))
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


def policy():
    return {
        "schema_version": 1,
        "nonce": "11111111-2222-3333-4444-555555555555",
        "metadata_base_url": network.METADATA_BASE,
        "targets_base_url": network.TARGETS_BASE,
        "addresses": {
            "boburning.github.io": ["185.199.108.153"],
            "github.com": ["140.82.112.3"],
            "release-assets.githubusercontent.com": ["185.199.108.133"],
        },
    }


def actual_hello(name="boburning.github.io"):
    context = ssl.create_default_context()
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    client = context.wrap_bio(incoming, outgoing, server_side=False, server_hostname=name)
    with contextlib.suppress(ssl.SSLWantReadError):
        client.do_handshake()
    return outgoing.read()


def frame(kind, stream_id, body, sequence=1):
    return (
        json.dumps(
            {"nonce": policy()["nonce"], "sequence": sequence, "kind": kind, "id": stream_id, "body": body}
        ).encode("ascii")
        + b"\n"
    )


def hello_body(hello=None):
    return {
        "address": "185.199.108.153",
        "hello_base64": base64.b64encode(actual_hello() if hello is None else hello).decode("ascii"),
    }


class PolicyAndTls(unittest.TestCase):
    def test_fixed_origins_and_detached_hosts(self):
        raw = policy()
        inspected = network.inspect_policy(raw)
        raw["addresses"]["github.com"].append("140.82.112.4")
        self.assertEqual(inspected["addresses"]["github.com"], ["140.82.112.3"])
        hosts = network.hosts_file(inspected)
        self.assertIn("185.199.108.153 boburning.github.io\n", hosts)
        self.assertIn("127.0.0.1 localhost\n", hosts)
        self.assertNotIn("127.0.0.1 boburning.github.io", hosts)
        for changes in (
            {"command": "sh"},
            {"schema_version": True},
            {"metadata_base_url": "https://other.example/metadata/"},
            {"targets_base_url": "https://boburning.github.io/portcove/application/metadata/"},
        ):
            with self.subTest(changes=changes), self.assertRaises((RuntimeError, ValueError)):
                network.inspect_policy({**policy(), **changes})
        for name in ("candidate.example", "proxy.example"):
            raw = policy()
            raw["addresses"][name] = ["8.8.8.8"]
            with self.assertRaises(RuntimeError):
                network.inspect_policy(raw)

    def test_all_application_refused_ip_classes_remain_refused(self):
        for address in (
            "0.1.2.3",
            "10.0.0.1",
            "100.64.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.1.1.1",
            "255.255.255.255",
            "::1",
            "2001:4860:4860::8888",
            "01.2.3.4",
        ):
            raw = policy()
            raw["addresses"]["github.com"] = [address]
            with self.subTest(address=address), self.assertRaises((RuntimeError, ValueError)):
                network.inspect_policy(raw)
        for values in ([], ["140.82.112.3"] * 2, [f"140.82.112.{index}" for index in range(10, 19)]):
            raw = policy()
            raw["addresses"]["github.com"] = values
            with self.assertRaises(RuntimeError):
                network.inspect_policy(raw)

    def test_actual_tls_hello_and_every_prefix_fragment(self):
        hello = actual_hello()
        self.assertEqual(network.client_hello_server_name(hello), "boburning.github.io")
        for end in range(len(hello)):
            self.assertIsNone(network.client_hello_server_name(hello[:end]))
        handshake = hello[5:]
        records = b"".join(
            b"\x16\x03\x03" + len(handshake[index : index + 17]).to_bytes(2, "big") + handshake[index : index + 17]
            for index in range(0, len(handshake), 17)
        )
        self.assertEqual(network.client_hello_server_name(records), "boburning.github.io")
        self.assertEqual(network.inspect_open(hello_body(hello), network.inspect_policy(policy()))[1], hello)

    def test_sni_and_pinned_address_must_both_match_before_network(self):
        for hello in (
            actual_hello("candidate.example"),
            b"CONNECT github.com:443 HTTP/1.1\r\n",
            b"GET / HTTP/1.1\r\n",
            b"\x16\x03\x03\xff\xff",
            b"x" * (network.MAX_HELLO + 1),
        ):
            with self.subTest(prefix=hello[:8]), self.assertRaises((RuntimeError, ValueError)):
                network.inspect_open(hello_body(hello), policy())
        raw = hello_body()
        raw["address"] = "140.82.112.3"
        with self.assertRaises(RuntimeError):
            network.inspect_open(raw, policy())
        raw = hello_body()
        raw["hello_base64"] += "\n"
        with self.assertRaises(ValueError):
            network.inspect_open(raw, policy())

    def test_duplicate_sni_ech_and_missing_sni_refuse(self):
        # Construct a valid bounded TLS1.3-compatible ClientHello around exact
        # extensions so refusal isn't accidentally caused by a length mismatch.
        name = b"boburning.github.io"
        sni = b"\0" + len(name).to_bytes(2, "big") + name
        extension = b"\0\0" + (len(sni) + 2).to_bytes(2, "big") + len(sni).to_bytes(2, "big") + sni
        for extensions in (b"", extension * 2, extension + b"\xfe\x0d\0\0"):
            body = b"\x03\x03" + b"r" * 32 + b"\0\0\2\x13\x01\1\0" + len(extensions).to_bytes(2, "big") + extensions
            handshake = b"\1" + len(body).to_bytes(3, "big") + body
            record = b"\x16\x03\x03" + len(handshake).to_bytes(2, "big") + handshake
            with self.assertRaises(RuntimeError):
                network.client_hello_server_name(record)

    def test_policy_file_hash_and_bounded_custody(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "policy.json"
            data = json.dumps(policy()).encode("ascii")
            filename.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            self.assertEqual(network.read_policy(filename, digest), policy())
            filename.write_bytes(data + b" ")
            with self.assertRaisesRegex(RuntimeError, "hash differs"):
                network.read_policy(filename, digest)
            filename.write_bytes(b" " * 16385)
            with self.assertRaisesRegex(RuntimeError, "bounded regular"):
                network.read_policy(filename, digest)
        with self.assertRaises(RuntimeError):
            network.decode_frame(b'{"nonce":"one","nonce":"two"}')
        with self.assertRaises(RuntimeError):
            network.outer_main(["--namespace", "arbitrary"])


class InertNamespaceSetup(unittest.TestCase):
    def namespace(self, caps=network.SETUP_CAPS, owner_matches=True):
        ioctl = Mock(
            side_effect=lambda descriptor, operation, *args: (
                12 if operation == 0xB701 else (struct.pack("16sH14s", b"lo", 8, b"") if operation == 0x8913 else b"")
            )
        )
        values = [SimpleNamespace(st_dev=1, st_ino=2), SimpleNamespace(st_dev=1, st_ino=2 if owner_matches else 3)]
        return (
            patch.dict(sys.modules, {"fcntl": SimpleNamespace(ioctl=ioctl)}),
            patch.object(network.os, "getpid", return_value=1),
            patch.object(network.os, "getuid", return_value=1000, create=True),
            patch.object(network.os, "getgid", return_value=1000, create=True),
            patch.object(network, "make_nondumpable"),
            patch("builtins.open", mock_open(read_data="1000 1000 1\n")),
            patch.object(network.os, "open", side_effect=[10, 11]),
            patch.object(network.os, "close"),
            patch.object(network.os, "fstat", side_effect=values),
            patch.object(network.socket, "if_nameindex", return_value=[(1, "lo")]),
            patch.object(
                network,
                "capability_status",
                return_value=({name: caps for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")}, 1),
            ),
        ), ioctl

    def test_absent_or_excess_caps_and_wrong_net_owner_never_open_socket(self):
        from contextlib import ExitStack

        for caps, owner in ((0, True), (network.SETUP_CAPS | 1, True), (network.SETUP_CAPS, False)):
            contexts, _ = self.namespace(caps, owner)
            with ExitStack() as stack:
                for context in contexts:
                    stack.enter_context(context)
                socket_factory = stack.enter_context(patch.object(network.socket, "socket"))
                with self.assertRaises(RuntimeError):
                    network.prepare_namespace_listeners(policy())
                socket_factory.assert_not_called()

    def test_listener_setup_drops_caps_before_return_and_failure_also_drops(self):
        from contextlib import ExitStack

        for fail in (False, True):
            contexts, ioctl = self.namespace()
            with ExitStack() as stack:
                for context in contexts:
                    stack.enter_context(context)
                control, *listeners = [Mock() for _ in range(4)]
                control.fileno.return_value = 9
                if fail:
                    listeners[0].bind.side_effect = OSError("controlled bind failure")
                stack.enter_context(patch.object(network.socket, "socket", side_effect=[control, *listeners]))
                proof = {name: 0 for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")}
                proof["NoNewPrivs"] = 1
                drop = stack.enter_context(patch.object(network, "drop_setup_capabilities", return_value=proof))
                if fail:
                    with self.assertRaises(OSError):
                        network.prepare_namespace_listeners(policy())
                    listeners[0].close.assert_called_once()
                else:
                    result, actual = network.prepare_namespace_listeners(policy())
                    self.assertEqual(len(result), 3)
                    self.assertEqual(actual, proof)
                    self.assertEqual(ioctl.call_args.args[1], 0x891C)
                drop.assert_called_once()
                control.close.assert_called_once()

    def test_positive_post_drop_all_four_masks_and_no_new_privileges(self):
        libc = Mock()
        libc.prctl.side_effect = [0, 0, 0, 0]
        libc.capset.return_value = 0
        for mask, no_new_privileges in ((0, 1), (1, 1), (0, 0)):
            libc.prctl.side_effect = [0, 0, 0, 0]
            with (
                patch.object(network.ctypes, "CDLL", return_value=libc),
                patch.object(
                    network,
                    "capability_status",
                    return_value=({name: mask for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")}, no_new_privileges),
                ),
            ):
                if mask == 0 and no_new_privileges == 1:
                    self.assertEqual(network.drop_setup_capabilities()["NoNewPrivs"], 1)
                else:
                    with self.assertRaisesRegex(RuntimeError, "capabilities remain"):
                        network.drop_setup_capabilities()


@unittest.skipUnless(os.name == "posix", "actual private pipe selector is qualified on ordinary Linux CI")
class ControlledPrivateRelay(unittest.TestCase):
    def setUp(self):
        self.selector = selectors.DefaultSelector()
        self.reader, self.input = os.pipe()
        self.output, self.writer = os.pipe()
        os.set_blocking(self.output, False)
        self.relay = network.PublicNetworkRelay(policy(), self.selector, self.reader, self.writer, time.monotonic() + 5)
        self.buffer = bytearray()

    def tearDown(self):
        self.relay.close()
        self.selector.close()
        for descriptor in (self.reader, self.writer, self.input, self.output):
            os.close(descriptor)

    def pump(self, until):
        deadline = time.monotonic() + 2
        while not until():
            self.assertLess(time.monotonic(), deadline, "controlled FD relay did not settle")
            self.relay.tick()
            for key, mask in self.selector.select(0.01):
                key.data(mask)

    def read_frames(self):
        with contextlib.suppress(BlockingIOError):
            self.buffer.extend(os.read(self.output, 100000))
        result = []
        while b"\n" in self.buffer:
            end = self.buffer.index(10)
            result.append(json.loads(self.buffer[:end]))
            del self.buffer[: end + 1]
        return result

    def test_real_socket_bytes_credit_halfclose_and_pinned_address(self):
        upstream, remote = socket.socketpair()
        remote.setblocking(False)
        destinations = []

        class ControlledSocket:
            def __getattr__(self, name):
                return getattr(upstream, name)

            def connect_ex(self, target):
                destinations.append(target)
                return 0

        try:
            hello = actual_hello()
            with patch.object(network.socket, "socket", return_value=ControlledSocket()):
                os.write(self.input, frame("open", 1, hello_body(hello)))
                self.pump(lambda: bool(destinations))
            received = bytearray()
            frames = []

            def complete():
                with contextlib.suppress(BlockingIOError):
                    received.extend(remote.recv(65536))
                frames.extend(self.read_frames())
                return len(received) == len(hello) and any(value["kind"] == "opened" for value in frames)

            self.pump(complete)
            self.assertEqual(destinations, [("185.199.108.153", 443)])
            self.assertEqual(bytes(received), hello)
            remote.sendall(b"r" * (network.CHUNK * 2))
            frames.clear()
            self.pump(
                lambda: bool(frames.extend(self.read_frames()) or any(value["kind"] == "data" for value in frames))
            )
            data = [value for value in frames if value["kind"] == "data"]
            self.assertEqual(len(data), 1)
            self.assertEqual(base64.b64decode(data[0]["body"]["base64"]), b"r" * network.CHUNK)
            for _ in range(3):
                for key, mask in self.selector.select(0.01):
                    key.data(mask)
            self.assertFalse(self.read_frames(), "second socket chunk must await private credit")
            os.write(self.input, frame("ack", 1, {}, 2))
            frames.clear()
            self.pump(
                lambda: bool(frames.extend(self.read_frames()) or any(value["kind"] == "data" for value in frames))
            )
            self.assertEqual(base64.b64decode(frames[-1]["body"]["base64"]), b"r" * network.CHUNK)
            os.write(
                self.input,
                frame("ack", 1, {}, 3)
                + frame("data", 1, {"base64": base64.b64encode(b"opaque-client-TLS-bytes").decode("ascii")}, 4),
            )
            received.clear()
            frames.clear()

            def upload_complete():
                with contextlib.suppress(BlockingIOError):
                    received.extend(remote.recv(65536))
                frames.extend(self.read_frames())
                return bytes(received) == b"opaque-client-TLS-bytes" and any(value["kind"] == "ack" for value in frames)

            self.pump(upload_complete)
            remote.shutdown(socket.SHUT_WR)
            os.write(self.input, frame("end", 1, {}, 5))
            self.pump(lambda: not self.relay.streams)
            self.assertEqual(self.relay.uploaded, len(hello) + len(b"opaque-client-TLS-bytes"))
        finally:
            remote.close()
            upstream.close()

    def test_bad_nonce_sequence_and_unappointed_sni_open_zero_sockets(self):
        for data in (
            frame("open", 1, hello_body(actual_hello("candidate.example"))),
            frame("open", 1, hello_body(), 3),
            frame("open", 1, hello_body()).replace(policy()["nonce"].encode(), b"00000000-0000-0000-0000-000000000000"),
        ):
            self.relay.pipe.read_sequence = 0
            with patch.object(network.socket, "socket") as socket_factory:
                os.write(self.input, data)
                with self.assertRaises(RuntimeError):
                    self.relay.pipe.read(0)
                socket_factory.assert_not_called()

    def test_actual_guest_and_outer_fd_flow_preserves_tls_bytes(self):
        # Only this test replaces the public listener/connect destinations with
        # owned local endpoints. The fixed CLI has no such transport injection.
        raw = policy()
        for name in raw["addresses"]:
            raw["addresses"][name] = ["185.199.108.153"]
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.setblocking(False)
        upstream, remote = socket.socketpair()
        remote.setblocking(False)
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(listener.getsockname())
        client.setblocking(False)
        guest_reader, outer_writer = os.pipe()
        outer_reader, guest_writer = os.pipe()

        class ControlledListener:
            def __getattr__(self, name):
                return getattr(listener, name)

            def getsockname(self):
                return ("185.199.108.153", 443)

        class ControlledSocket:
            def __getattr__(self, name):
                return getattr(upstream, name)

            def connect_ex(self, target):
                if target != ("185.199.108.153", 443):
                    raise AssertionError("fixed outer destination changed")
                return 0

        guest = outer = None
        try:
            guest = network.PublicNetworkRelay(
                raw,
                self.selector,
                guest_reader,
                guest_writer,
                time.monotonic() + 5,
                {"185.199.108.153": ControlledListener()},
            )
            outer = network.PublicNetworkRelay(raw, self.selector, outer_reader, outer_writer, time.monotonic() + 5)
            hello = actual_hello()
            received = bytearray()

            def connected():
                with contextlib.suppress(BlockingIOError):
                    received.extend(remote.recv(65536))
                return bytes(received) == hello and guest.streams.get(1, {}).get("state") == "open"

            # Fragment the actual TLS ClientHello across independent client writes.
            client.sendall(hello[:17])
            for _ in range(4):
                for key, mask in self.selector.select(0.01):
                    key.data(mask)
            self.assertFalse(outer.used, "incomplete ClientHello cannot open an outer socket")
            client.sendall(hello[17:])
            with patch.object(network.socket, "socket", return_value=ControlledSocket()):
                self.pump(connected)
            reply = b"opaque-end-to-end-server-TLS" * 2000
            remote.sendall(reply)
            returned = bytearray()

            def delivered():
                with contextlib.suppress(BlockingIOError):
                    returned.extend(client.recv(65536))
                return bytes(returned) == reply

            self.pump(delivered)
            self.assertEqual(bytes(received), hello)
            self.assertEqual(guest.downloaded, outer.downloaded)
            client.shutdown(socket.SHUT_WR)
            remote.shutdown(socket.SHUT_WR)
            self.pump(lambda: not guest.streams and not outer.streams)
        finally:
            if guest is not None:
                guest.close()
            if outer is not None:
                outer.close()
            listener.close()
            client.close()
            upstream.close()
            remote.close()
            for descriptor in (guest_reader, guest_writer, outer_reader, outer_writer):
                os.close(descriptor)

    def test_expired_phase_and_oversize_line_refuse_before_open(self):
        self.relay.deadline = time.monotonic() - 1
        with (
            patch.object(network.socket, "socket") as socket_factory,
            self.assertRaisesRegex(RuntimeError, "deadline exhausted"),
        ):
            self.relay.receive("open", 1, hello_body())
        socket_factory.assert_not_called()
        self.relay.deadline = time.monotonic() + 5
        self.relay.pipe.incoming.extend(b"x" * (network.MAX_FRAME + 1))
        os.write(self.input, b"y")
        with self.assertRaisesRegex(RuntimeError, "frame exceeds bound"):
            self.relay.pipe.read(0)
        with self.assertRaisesRegex(RuntimeError, "byte budget"):
            self.relay.charge(network.MAX_DOWNLOAD + 1, False)


if __name__ == "__main__":
    unittest.main()
