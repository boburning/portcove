"""Fixed, credential-free native namespace network preparation and TLS policy.

This module does not grant native qualification or appoint its own origins. The
fixed parent must derive the two base URLs from authenticated compiled public
inputs and resolve their addresses outside the candidate namespace. No proxy,
TLS termination, host interface, host firewall or candidate-supplied route exists.
Importing this file performs no namespace or network operation.
"""

import base64
import contextlib
import ctypes
import hashlib
import ipaddress
import json
import os
import re
import selectors
import socket
import stat
import struct
import sys
import time
from urllib.parse import urlsplit

MAX_HELLO = 65536
CHUNK = 16384
MAX_FRAME = 100000
MAX_STREAMS = 64
MAX_CONCURRENT = 8
MAX_DOWNLOAD = 1024 * 1024 * 1024
MAX_UPLOAD = 16 * 1024 * 1024
SETUP_CAPS = (1 << 10) | (1 << 12)  # NET_BIND_SERVICE, NET_ADMIN; private namespace only.
REDIRECT_HOST = "release-assets.githubusercontent.com"
ARTIFACT_HOST = "github.com"
METADATA_BASE = "https://boburning.github.io/portcove/application/metadata/"
TARGETS_BASE = "https://boburning.github.io/portcove/application/targets/"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def exact(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields), "public relay fields differ")


def hostname(value):
    require(
        isinstance(value, str)
        and len(value) <= 253
        and re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value)
        and "." in value
        and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in value.split(".")),
        "canonical public relay hostname required",
    )
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise RuntimeError("DNS public relay hostname required")


def public_ipv4(value):
    # Match the maintained application's IPv4 destination guard, not Python's
    # release-dependent is_global classification. IPv6-only routes refuse here.
    require(isinstance(value, str), "public relay IPv4 required")
    address = ipaddress.IPv4Address(value)
    require(str(address) == value, "canonical public relay IPv4 required")
    a, b, c, _ = address.packed
    require(
        not (
            a in (0, 10, 127)
            or a >= 224
            or (a == 100 and 64 <= b <= 127)
            or (a == 169 and b == 254)
            or (a == 172 and 16 <= b <= 31)
            or (a == 192 and ((b == 0 and c in (0, 2)) or b == 168 or (b == 88 and c == 99)))
            or (a == 198 and (18 <= b <= 19 or (b == 51 and c == 100)))
            or (a == 203 and b == 0 and c == 113)
        ),
        "non-public relay address refused",
    )
    return value


def base_url(value):
    require(isinstance(value, str) and len(value) <= 2048 and value.isascii(), "public relay base URL required")
    parsed = urlsplit(value)
    require(
        parsed.scheme == "https"
        and parsed.netloc == parsed.hostname
        and not parsed.query
        and not parsed.fragment
        and parsed.path.startswith("/")
        and parsed.path.endswith("/")
        and not any(part in (".", "..") for part in parsed.path.split("/"))
        and "%" not in parsed.path
        and "\\" not in value
        and not any(ord(char) <= 32 or ord(char) == 127 for char in value),
        "fixed anonymous HTTPS base required",
    )
    return hostname(parsed.hostname), parsed.path


def inspect_policy(raw):
    exact(raw, ("schema_version", "nonce", "metadata_base_url", "targets_base_url", "addresses"))
    require(type(raw["schema_version"]) is int and raw["schema_version"] == 1, "public relay schema differs")
    require(
        isinstance(raw["nonce"], str) and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", raw["nonce"]),
        "private relay nonce differs",
    )
    metadata, metadata_path = base_url(raw["metadata_base_url"])
    targets, targets_path = base_url(raw["targets_base_url"])
    require(
        raw["metadata_base_url"] == METADATA_BASE and raw["targets_base_url"] == TARGETS_BASE,
        "maintained application origins required",
    )
    require(
        metadata != targets or not (metadata_path.startswith(targets_path) or targets_path.startswith(metadata_path)),
        "metadata and target base prefixes overlap",
    )
    names = sorted({metadata, targets, ARTIFACT_HOST, REDIRECT_HOST})
    require(isinstance(raw["addresses"], dict) and sorted(raw["addresses"]) == names, "fixed relay origin set differs")
    for name in names:
        values = raw["addresses"][name]
        require(
            isinstance(values, list)
            and 1 <= len(values) <= 8
            and all(isinstance(value, str) for value in values)
            and values == sorted(set(values)),
            "bounded unique relay address set required",
        )
        for value in values:
            public_ipv4(value)
    # Detach caller mutation; all consumers revalidate their received policy.
    return json.loads(json.dumps(raw, allow_nan=False))


def hosts_file(raw):
    policy = inspect_policy(raw)
    lines = ["127.0.0.1 localhost", "::1 localhost"]
    for name, values in sorted(policy["addresses"].items()):
        lines.extend(f"{value} {name}" for value in values)
    return "\n".join(lines) + "\n"


def client_hello_server_name(data):
    """Return canonical SNI, or None for an incomplete bounded ClientHello.

    Parse actual TLS records, including a handshake split across records. The
    original bytes are forwarded unchanged only after this check. ECH, duplicate
    extensions/names, non-TLS protocols and absent SNI refuse before a socket opens.
    """
    require(isinstance(data, bytes) and len(data) <= MAX_HELLO, "bounded TLS ClientHello required")
    handshake = bytearray()
    offset = 0
    while True:
        if len(data) - offset < 5:
            return None
        kind, major, minor, length = struct.unpack_from("!BBBH", data, offset)
        require(kind == 22 and major == 3 and 1 <= minor <= 3 and 0 < length <= 16384, "TLS handshake record required")
        if len(data) - offset - 5 < length:
            return None
        handshake.extend(data[offset + 5 : offset + 5 + length])
        offset += 5 + length
        if len(handshake) < 4:
            continue
        require(handshake[0] == 1, "first TLS handshake must be ClientHello")
        size = int.from_bytes(handshake[1:4], "big")
        require(40 <= size <= MAX_HELLO - 20, "TLS ClientHello size differs")
        if len(handshake) >= size + 4:
            require(len(handshake) == size + 4, "unexpected plaintext handshake after ClientHello")
            break
    hello = bytes(handshake[4:])
    require(hello[:2] == b"\x03\x03", "modern TLS ClientHello required")
    position = 34

    def take(size):
        nonlocal position
        require(size >= 0 and position + size <= len(hello), "truncated TLS ClientHello")
        value = hello[position : position + size]
        position += size
        return value

    session_size = take(1)[0]
    require(session_size <= 32, "TLS session identity too large")
    take(session_size)
    cipher_size = int.from_bytes(take(2), "big")
    require(cipher_size >= 2 and cipher_size % 2 == 0, "TLS cipher inventory differs")
    take(cipher_size)
    compression = take(take(1)[0])
    require(compression == b"\0", "TLS compression refused")
    extension_size = int.from_bytes(take(2), "big")
    require(position + extension_size == len(hello), "TLS extension inventory differs")
    seen = set()
    server_name = None
    while position < len(hello):
        kind, size = struct.unpack("!HH", take(4))
        require(kind not in seen and kind != 0xFE0D, "duplicate TLS extension or encrypted ClientHello refused")
        seen.add(kind)
        extension = take(size)
        if kind == 0:
            require(
                len(extension) >= 6 and int.from_bytes(extension[:2], "big") == len(extension) - 2,
                "TLS SNI size differs",
            )
            require(
                extension[2] == 0 and int.from_bytes(extension[3:5], "big") == len(extension) - 5,
                "one DNS SNI required",
            )
            try:
                server_name = hostname(extension[5:].decode("ascii"))
            except UnicodeError as error:
                raise RuntimeError("ASCII TLS SNI required") from error
    require(server_name is not None, "TLS SNI required")
    return server_name


def inspect_open(raw, policy):
    exact(raw, ("address", "hello_base64"))
    address = public_ipv4(raw["address"])
    encoded = raw["hello_base64"]
    require(isinstance(encoded, str) and len(encoded) <= 4 * ((MAX_HELLO + 2) // 3), "bounded relay hello required")
    hello = base64.b64decode(encoded, validate=True)
    require(base64.b64encode(hello).decode("ascii") == encoded, "canonical relay hello required")
    name = client_hello_server_name(hello)
    require(name in policy["addresses"] and address in policy["addresses"][name], "TLS origin/address not appointed")
    return address, hello


def capability_status():
    with open("/proc/self/status", encoding="ascii") as source:
        fields = dict(line.rstrip().split(":", 1) for line in source if ":" in line)
    return {name: int(fields[name].strip(), 16) for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")}, int(
        fields["NoNewPrivs"].strip()
    )


def make_nondumpable():
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(4, 0, 0, 0, 0) == 0 and libc.prctl(3, 0, 0, 0, 0) == 0, "native init must be nondumpable")


def drop_setup_capabilities():
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, "native no-new-privileges setup failed")
    require(libc.prctl(47, 4, 0, 0, 0) == 0, "native ambient capability clear failed")
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    data = (ctypes.c_uint32 * 6)(0, 0, 0, 0, 0, 0)
    require(libc.capset(ctypes.byref(header), ctypes.byref(data)) == 0, "native setup capability drop failed")
    caps, no_new_privileges = capability_status()
    require(set(caps.values()) == {0} and no_new_privileges == 1, "native setup capabilities remain")
    make_nondumpable()
    return {**caps, "NoNewPrivs": no_new_privileges}


def prepare_namespace_listeners(raw):
    """Only PID1 in a rootless, exclusively owned user+network namespace.

    Deliberately unavailable as a command-line mode. The maintained init calls
    this before any child, keeps returned sockets private and records the returned
    post-drop capability proof in its ordinary process snapshot. Actual bwrap,
    nonroot ambient caps and namespace ioctls still require host qualification.
    """
    import fcntl  # Linux-only; pure policy inspection also runs on Windows.

    policy = inspect_policy(raw)
    require(os.getpid() == 1 and os.getuid() > 0 and os.getgid() > 0, "ordinary private namespace PID1 required")
    make_nondumpable()
    for filename, expected in (("uid_map", os.getuid()), ("gid_map", os.getgid())):
        with open(f"/proc/self/{filename}", encoding="ascii") as source:
            mapping = [line.split() for line in source if line.strip()]
        require(
            len(mapping) == 1
            and len(mapping[0]) == 3
            and all(value.isdecimal() for value in mapping[0])
            and int(mapping[0][0]) == expected
            and int(mapping[0][1]) > 0
            and int(mapping[0][2]) == 1,
            "single ordinary host identity mapping required",
        )
    user_fd = os.open("/proc/self/ns/user", os.O_RDONLY)
    net_fd = os.open("/proc/self/ns/net", os.O_RDONLY)
    owner_fd = -1
    try:
        owner_fd = fcntl.ioctl(net_fd, 0xB701)  # NS_GET_USERNS; owning namespace, not a namespace-name guess.
        own, actual = os.fstat(user_fd), os.fstat(owner_fd)
        require((own.st_dev, own.st_ino) == (actual.st_dev, actual.st_ino), "network namespace owner differs")
    finally:
        for descriptor in (owner_fd, net_fd, user_fd):
            if descriptor >= 0:
                os.close(descriptor)
    require(socket.if_nameindex() == [(1, "lo")], "isolated loopback-only network namespace required")
    caps, _ = capability_status()
    require(set(caps.values()) == {SETUP_CAPS}, "exact transient namespace network capabilities required")
    listeners = {}
    control = None
    try:
        control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        flags = fcntl.ioctl(control.fileno(), 0x8913, struct.pack("16sH14s", b"lo", 0, b""))
        current = struct.unpack_from("H", flags, 16)[0]
        require(current & 8, "private loopback interface required")
        fcntl.ioctl(control.fileno(), 0x8914, struct.pack("16sH14s", b"lo", current | 1, b""))
        addresses = sorted({address for values in policy["addresses"].values() for address in values})
        for index, address in enumerate(addresses):
            label = f"lo:p{index}".encode("ascii")
            for operation, value in ((0x8916, address), (0x891C, "255.255.255.255")):
                request = struct.pack("16sH2s4s8s", label, socket.AF_INET, b"\0\0", socket.inet_aton(value), b"")
                fcntl.ioctl(control.fileno(), operation, request)
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                listener.set_inheritable(False)
                listener.bind((address, 443))
                listener.listen(MAX_CONCURRENT)
                listener.setblocking(False)
                listeners[address] = listener
            except BaseException:
                listener.close()
                raise
        proof = drop_setup_capabilities()
        return listeners, proof
    except BaseException:
        for listener in listeners.values():
            listener.close()
        # A failed setup may terminate init, but must never start any child with
        # capabilities merely because preparation failed partway through.
        drop_setup_capabilities()
        raise
    finally:
        if control is not None:
            control.close()


def decode_frame(data):
    require(len(data) <= MAX_FRAME, "public relay frame exceeds bound")

    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "duplicate public relay key")
            result[key] = value
        return result

    return json.loads(
        data.decode("ascii"),
        object_pairs_hook=pairs,
        parse_constant=lambda _: require(False, "nonfinite public relay frame"),
    )


class FramedPipe:
    """Dedicated private FD pair; bounded, nonblocking, sequenced JSON lines."""

    def __init__(self, selector, reader, writer, nonce, receive, active):
        require(reader != writer, "separate private relay descriptors required")
        self.selector, self.reader, self.writer = selector, reader, writer
        self.nonce, self.receive, self.active = nonce, receive, active
        self.incoming, self.outgoing = bytearray(), bytearray()
        self.read_sequence = self.write_sequence = 0
        self.writing = False
        os.set_blocking(reader, False)
        os.set_blocking(writer, False)
        selector.register(reader, selectors.EVENT_READ, self.read)

    def read(self, _):
        self.active()
        data = os.read(self.reader, CHUNK)
        require(data, "private public-relay controller disconnected")
        self.incoming.extend(data)
        # Bound the first line before parsing, including a fragmented oversized
        # line. A read may also contain the start of the next complete frame.
        while b"\n" in self.incoming:
            end = self.incoming.index(10)
            require(end <= MAX_FRAME, "public relay frame exceeds bound")
            raw = decode_frame(bytes(self.incoming[:end]))
            del self.incoming[: end + 1]
            require(
                isinstance(raw, dict) and {"nonce", "sequence", "kind", "id", "body"} == set(raw),
                "public relay envelope differs",
            )
            self.read_sequence += 1
            require(
                raw["nonce"] == self.nonce
                and type(raw["sequence"]) is int
                and raw["sequence"] == self.read_sequence
                and self.read_sequence <= 262144
                and type(raw["id"]) is int
                and 1 <= raw["id"] <= MAX_STREAMS,
                "public relay nonce/sequence/stream differs",
            )
            self.active()
            self.receive(raw["kind"], raw["id"], raw["body"])
        require(len(self.incoming) <= MAX_FRAME, "public relay frame exceeds bound")

    def send(self, kind, stream_id, body):
        self.active()
        self.write_sequence += 1
        require(self.write_sequence <= 262144, "public relay frame count exhausted")
        data = json.dumps(
            {"nonce": self.nonce, "sequence": self.write_sequence, "kind": kind, "id": stream_id, "body": body},
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
        require(
            len(data) <= MAX_FRAME and len(self.outgoing) + len(data) + 1 <= 1024 * 1024,
            "public relay output queue exceeds bound",
        )
        self.outgoing.extend(data + b"\n")
        if not self.writing:
            self.selector.register(self.writer, selectors.EVENT_WRITE, self.write)
            self.writing = True

    def write(self, _):
        self.active()
        try:
            size = os.write(self.writer, self.outgoing[:CHUNK])
        except BlockingIOError:
            return
        require(size > 0, "public relay write disconnected")
        del self.outgoing[:size]
        if not self.outgoing:
            self.selector.unregister(self.writer)
            self.writing = False

    def close(self):
        for descriptor in (self.reader, self.writer):
            with contextlib.suppress(KeyError):
                self.selector.unregister(descriptor)
        self.incoming.clear()
        self.outgoing.clear()


class PublicNetworkRelay:
    """Selector-owned opaque TLS forwarding over the fixed FD protocol.

    Guest init supplies only its already prepared private listeners. Outer parent
    supplies no listeners and opens pinned public IPv4:443 after verifying SNI.
    Each direction has one 16KiB credit per stream; no unbounded socket/pipe queue.
    No thread, fork, DNS lookup, credential, HTTP parsing or TLS terminator exists.
    """

    def __init__(self, raw_policy, selector, reader, writer, deadline, listeners=None):
        require(
            isinstance(deadline, (int, float)) and time.monotonic() < deadline <= time.monotonic() + 1750,
            "original public relay deadline required",
        )
        self.policy = inspect_policy(raw_policy)
        self.selector, self.deadline = selector, deadline
        self.guest = listeners is not None
        self.listeners = {} if listeners is None else dict(listeners)
        self.streams, self.used = {}, set()
        self.uploaded = self.downloaded = 0
        self.pipe = FramedPipe(selector, reader, writer, self.policy["nonce"], self.receive, self.active)
        expected = {address for values in self.policy["addresses"].values() for address in values}
        require(not self.guest or set(self.listeners) == expected, "private relay listener inventory differs")
        for address, listener in self.listeners.items():
            require(listener.getsockname() == (address, 443), "private relay listener address differs")
            listener.set_inheritable(False)
            selector.register(listener, selectors.EVENT_READ, lambda _, value=listener: self.accept(value))

    def active(self):
        require(time.monotonic() < self.deadline, "original public relay deadline exhausted")

    def charge(self, size, upload):
        if upload:
            self.uploaded += size
        else:
            self.downloaded += size
        require(self.uploaded <= MAX_UPLOAD and self.downloaded <= MAX_DOWNLOAD, "public relay byte budget exhausted")

    def stream(self, stream_id, connection, address, state):
        require(
            len(self.streams) < MAX_CONCURRENT and stream_id not in self.used and len(self.used) < MAX_STREAMS,
            "public relay connection budget exhausted",
        )
        connection.setblocking(False)
        connection.set_inheritable(False)
        value = {
            "id": stream_id,
            "socket": connection,
            "address": address,
            "state": state,
            "hello": bytearray(),
            "write": bytearray(),
            "ack": None,
            "waiting": False,
            "local_end": False,
            "peer_end": False,
            "shutdown": False,
            "started": time.monotonic(),
            "last": time.monotonic(),
            "registered": False,
        }
        self.streams[stream_id] = value
        self.used.add(stream_id)
        self.watch(value)
        return value

    def watch(self, value):
        mask = 0
        if value["state"] == "connecting" or value["write"]:
            mask |= selectors.EVENT_WRITE
        if value["state"] in ("hello", "open") and not value["waiting"] and not value["local_end"]:
            mask |= selectors.EVENT_READ
        connection = value["socket"]
        if mask:

            def callback(events):
                return self.socket_ready(value, events)

            if value["registered"]:
                self.selector.modify(connection, mask, callback)
            else:
                self.selector.register(connection, mask, callback)
                value["registered"] = True
        elif value["registered"]:
            self.selector.unregister(connection)
            value["registered"] = False

    def accept(self, listener):
        self.active()
        connection, _ = listener.accept()
        try:
            self.stream(len(self.used) + 1, connection, listener.getsockname()[0], "hello")
        except BaseException:
            connection.close()
            raise

    def remove(self, value, notify=False):
        if value["id"] not in self.streams:
            return
        if notify:
            self.pipe.send("cancel", value["id"], {})
        if value["registered"]:
            self.selector.unregister(value["socket"])
        value["socket"].close()
        del self.streams[value["id"]]

    def settle(self, value):
        if value["peer_end"] and not value["write"] and not value["shutdown"]:
            value["socket"].shutdown(socket.SHUT_WR)
            value["shutdown"] = True
        if value["local_end"] and value["peer_end"] and not value["write"] and not value["waiting"]:
            self.remove(value)
        else:
            self.watch(value)

    def socket_ready(self, value, events):
        self.active()
        try:
            connection = value["socket"]
            if value["state"] == "connecting":
                require(
                    connection.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0, "public relay connection failed"
                )
                value["state"] = "opening"
            if events & selectors.EVENT_WRITE and value["write"]:
                sent = connection.send(value["write"][:CHUNK])
                require(sent > 0, "public relay socket write ended")
                del value["write"][:sent]
                value["last"] = time.monotonic()
                if not value["write"] and value["ack"]:
                    kind, value["ack"] = value["ack"], None
                    if kind == "opened":
                        value["state"] = "open"
                    self.pipe.send(kind, value["id"], {})
            if events & selectors.EVENT_READ and not value["waiting"] and not value["local_end"]:
                data = connection.recv(CHUNK)
                if not data:
                    require(value["state"] != "hello", "TLS client disconnected before ClientHello")
                    value["local_end"] = True
                    self.pipe.send("end", value["id"], {})
                else:
                    value["last"] = time.monotonic()
                    self.charge(len(data), self.guest)
                    if value["state"] == "hello":
                        value["hello"].extend(data)
                        name = client_hello_server_name(bytes(value["hello"]))
                        if name is not None:
                            require(
                                name in self.policy["addresses"] and value["address"] in self.policy["addresses"][name],
                                "candidate TLS origin differs",
                            )
                            self.pipe.send(
                                "open",
                                value["id"],
                                {
                                    "address": value["address"],
                                    "hello_base64": base64.b64encode(value["hello"]).decode("ascii"),
                                },
                            )
                            value["hello"].clear()
                            value["state"] = "opening"
                    else:
                        value["waiting"] = True
                        self.pipe.send("data", value["id"], {"base64": base64.b64encode(data).decode("ascii")})
            self.active()
            self.settle(value)
        except BlockingIOError:
            self.watch(value)
        except (OSError, RuntimeError, ValueError):
            self.remove(value, notify=True)

    def receive(self, kind, stream_id, body):
        self.active()
        if kind == "open":
            require(
                not self.guest and stream_id not in self.used and stream_id == len(self.used) + 1,
                "unexpected public relay open",
            )
            require(len(self.streams) < MAX_CONCURRENT, "public relay active stream limit reached")
            address, hello = inspect_open(body, self.policy)
            self.charge(len(hello), True)
            connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                import errno

                connection.setblocking(False)
                result = connection.connect_ex((address, 443))
                require(
                    result in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY), "public relay connect refused"
                )
                value = self.stream(stream_id, connection, address, "connecting")
                value["write"].extend(hello)
                value["ack"] = "opened"
                self.watch(value)
            except BaseException:
                connection.close()
                raise
            return
        require(kind in ("opened", "data", "ack", "end", "cancel"), "public relay operation differs")
        value = self.streams.get(stream_id)
        if value is None and kind == "cancel" and stream_id in self.used:
            exact(body, ())
            return
        require(value is not None, "unknown public relay stream")
        value["last"] = time.monotonic()
        if kind == "data":
            exact(body, ("base64",))
            require(
                value["state"] == "open" and not value["write"] and not value["peer_end"],
                "public relay credit/order differs",
            )
            encoded = body["base64"]
            require(
                isinstance(encoded, str) and 0 < len(encoded) <= 4 * ((CHUNK + 2) // 3), "bounded relay data required"
            )
            data = base64.b64decode(encoded, validate=True)
            require(
                0 < len(data) <= CHUNK and base64.b64encode(data).decode("ascii") == encoded,
                "canonical relay data required",
            )
            self.charge(len(data), not self.guest)
            value["write"].extend(data)
            value["ack"] = "ack"
        else:
            exact(body, ())
            if kind == "opened":
                require(self.guest and value["state"] == "opening", "unexpected relay opened")
                value["state"] = "open"
            elif kind == "ack":
                require(value["waiting"], "unexpected public relay acknowledgement")
                value["waiting"] = False
            elif kind == "end":
                require(value["state"] == "open" and not value["peer_end"], "unexpected public relay end")
                value["peer_end"] = True
            else:
                self.remove(value)
                return
        self.settle(value)

    def tick(self):
        self.active()
        for value in list(self.streams.values()):
            if time.monotonic() - value["last"] > 30 or (
                value["state"] != "open" and time.monotonic() - value["started"] > 15
            ):
                self.remove(value, notify=True)

    def close(self):
        for value in list(self.streams.values()):
            self.remove(value)
        for listener in self.listeners.values():
            self.selector.unregister(listener)
            listener.close()
        self.pipe.close()


def read_policy(filename, expected_sha256):
    require(
        isinstance(expected_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", expected_sha256),
        "pinned public relay policy required",
    )
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        require(
            stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 16384, "bounded regular public relay policy required"
        )
        data = bytearray()
        while len(data) <= 16384:
            chunk = os.read(descriptor, min(4096, 16385 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)

        def identity(value):
            return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

        require(
            identity(before) == identity(after) and len(data) == before.st_size and len(data) <= 16384,
            "public relay policy changed during read",
        )
        require(hashlib.sha256(data).hexdigest() == expected_sha256, "public relay policy hash differs")
        return inspect_policy(decode_frame(bytes(data)))
    finally:
        os.close(descriptor)


def outer_main(arguments):
    require(len(arguments) == 4 and arguments[0] == "--outer", "fixed outer relay arguments required")
    require(re.fullmatch(r"[1-9][0-9]{0,6}", arguments[3]) is not None, "original remaining relay budget required")
    milliseconds = int(arguments[3])
    require(milliseconds <= 1750000, "public relay budget exceeds native phase")
    deadline = time.monotonic() + milliseconds / 1000
    policy = read_policy(arguments[1], arguments[2])
    with selectors.DefaultSelector() as selector:
        relay = PublicNetworkRelay(policy, selector, 0, 1, deadline)
        try:
            while True:
                relay.tick()
                for key, mask in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                    key.data(mask)
                relay.active()
        finally:
            relay.close()


if __name__ == "__main__":
    try:
        outer_main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError) as error:
        print(f"fixed public relay refused: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
