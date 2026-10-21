#!/usr/bin/python3 -ISB
"""Fixed private-namespace FUSE transport; no host setup or candidate privilege.

The installed controller must independently bind this source and policy. Pure
inspection and controlled FD tests do not establish a functioning FUSE host.
"""

import array
import ctypes
import datetime
import hashlib
import json
import math
import os
import re
import selectors
import socket
import stat
import struct
import sys
import time

SHA = re.compile(r"[a-f0-9]{64}\Z")
ACTIVE = "/native/installation/Portcove.AppImage"
MAXIMUM = 8192
MOUNT_LIMIT = 8


def require(value, message):
    if not value:
        raise RuntimeError(message)


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate FUSE transport key")
            result[key] = value
        return result

    require(0 < len(data) <= MAXIMUM, "FUSE transport exceeds bound")
    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs)


def inspect_policy(raw):
    require(
        isinstance(raw, dict)
        and set(raw) == {"schema_version", "nonce", "uid", "gid", "packages", "deadline_utc", "python_sha256"}
        and raw["schema_version"] == 1,
        "FUSE policy fields differ",
    )
    require(isinstance(raw["nonce"], str) and SHA.fullmatch(raw["nonce"]), "FUSE policy nonce differs")
    require(
        isinstance(raw["python_sha256"], str) and SHA.fullmatch(raw["python_sha256"]), "FUSE Python identity differs"
    )
    for key in ("uid", "gid"):
        require(type(raw[key]) is int and 0 < raw[key] < 4294967295, "FUSE nonroot identity differs")
    packages = raw["packages"]
    require(isinstance(packages, list) and len(packages) == 2, "FUSE requires exact V0/V1 package pair")
    for package in packages:
        require(
            isinstance(package, dict)
            and set(package) == {"bytes", "sha256"}
            and type(package["bytes"]) is int
            and 0 < package["bytes"] <= 512 * 1024 * 1024
            and isinstance(package["sha256"], str)
            and SHA.fullmatch(package["sha256"]),
            "FUSE package identity differs",
        )
    require(packages[0]["sha256"] != packages[1]["sha256"], "FUSE requires distinct packages")
    require(
        isinstance(raw["deadline_utc"], str)
        and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", raw["deadline_utc"]),
        "FUSE original deadline differs",
    )
    return json.loads(json.dumps(raw))


def abstract_address(raw):
    policy = inspect_policy(raw)
    return "\0portcove-fuse-" + policy["nonce"]


def inspect_helper_arguments(argv):
    """Accept the maintained libfuse mount-helper surface, never mount(8)."""
    require(isinstance(argv, list) and len(argv) <= 6 and all(isinstance(v, str) for v in argv), "FUSE argv differs")
    require(all(len(value) <= 2048 and "\0" not in value for value in argv), "FUSE argv exceeds bound")
    if len(argv) == 4 and argv[:1] == ["-o"] and argv[2] == "--":
        options, mountpoint = argv[1], argv[3]
        selected = options.split(",")
        require(len(selected) <= 8 and len(set(selected)) == len(selected), "FUSE options repeat")
        allowed = {"ro", "nosuid", "nodev", "fsname=" + ACTIVE, "subtype=squashfuse", "subtype=AppImage"}
        require(
            set(selected) <= allowed and "ro" in selected and "fsname=" + ACTIVE in selected, "FUSE options widen scope"
        )
        require(sum(option.startswith("subtype=") for option in selected) <= 1, "FUSE subtype conflicts")
        action = "mount"
    elif len(argv) == 5 and argv[:4] in (["-u", "-q", "-z", "--"], ["--unmount", "--quiet", "--lazy", "--"]):
        mountpoint, action = argv[4], "unmount"
    else:
        raise RuntimeError("unsupported FUSE helper invocation")
    require(re.fullmatch(r"/tmp/\.mount_[A-Za-z0-9_-]{1,64}", mountpoint), "FUSE mountpoint escaped")
    return {"action": action, "mountpoint": mountpoint}


def send_descriptor(connection, descriptor):
    require(type(descriptor) is int and descriptor >= 0, "FUSE descriptor missing")
    require(
        connection.sendmsg([b"\0"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [descriptor]))]) == 1,
        "FUSE descriptor send failed",
    )


def receive_descriptor(connection):
    data, ancillary, flags, _ = connection.recvmsg(1, socket.CMSG_SPACE(array.array("i").itemsize * 2))
    descriptors = []
    try:
        for level, kind, value in ancillary:
            require(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS, "FUSE unexpected control message")
            numbers = array.array("i")
            numbers.frombytes(value)
            descriptors.extend(numbers)
        require(data == b"\0" and flags == 0 and len(descriptors) == 1, "FUSE descriptor response differs")
        result = descriptors.pop()
        os.set_inheritable(result, False)
        return result
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def read_process_identity(pid, policy):
    """Bracket the actual libfuse parent runtime, not caller-provided SHA/PID."""
    require(type(pid) is int and pid > 1, "FUSE peer PID differs")
    directory = f"/proc/{pid}"
    before = process_generation(pid)
    parent = before[1]
    status = read_proc(directory + "/status").decode("ascii")
    uid_line = next((line for line in status.splitlines() if line.startswith("Uid:")), "")
    require(uid_line.split()[1:] == [str(policy["uid"])] * 4, "FUSE peer account differs")
    command = read_proc(directory + "/cmdline", 4096)
    require(0 < len(command) <= 4096 and command.split(b"\0", 1)[0] == ACTIVE.encode(), "FUSE runtime command differs")
    # proc exe is the kernel-owned process image link. Arbitrary symlinks are
    # not accepted for policy, package data, capture or mountpoint paths.
    descriptor = os.open(directory + "/exe", os.O_RDONLY | os.O_NONBLOCK)
    try:
        first = os.fstat(descriptor)
        require(
            stat.S_ISREG(first.st_mode) and first.st_uid == policy["uid"] and first.st_nlink == 1,
            "FUSE runtime image differs",
        )
        require(0 < first.st_size <= 512 * 1024 * 1024, "FUSE runtime image exceeds bound")
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            require(size <= first.st_size, "FUSE runtime image grew")
            digest.update(chunk)
        last = os.fstat(descriptor)
        require(
            (first.st_dev, first.st_ino, first.st_size, first.st_mtime_ns, first.st_ctime_ns)
            == (last.st_dev, last.st_ino, last.st_size, last.st_mtime_ns, last.st_ctime_ns),
            "FUSE runtime image changed",
        )
        identity = {"bytes": size, "sha256": digest.hexdigest()}
        require(identity in policy["packages"], "FUSE runtime is not exact V0/V1")
    finally:
        os.close(descriptor)
    after_generation = process_generation(pid)
    require(
        (after_generation[0], after_generation[2]) == (before[0], before[2])
        and read_proc(directory + "/cmdline", 4096) == command,
        "FUSE runtime process changed",
    )
    require(stable_file(os.stat(directory + "/exe")) == stable_file(first), "FUSE runtime executed another image")
    return {"pid": pid, "parent_pid": parent, "creation_ticks": before[2], "package": identity}


def read_proc(path, maximum=65536):
    with open(path, "rb") as source:
        data = source.read(maximum + 1)
    require(0 < len(data) <= maximum, "FUSE kernel observation exceeds bound")
    return data


def process_generation(pid):
    raw = read_proc(f"/proc/{pid}/stat").decode("ascii")
    fields = raw[raw.rfind(")") + 2 :].split()
    require(len(fields) >= 20 and raw.split(" ", 1)[0] == str(pid), "FUSE process stat incomplete")
    return pid, int(fields[1]), fields[19]


def stable_file(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_gid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def same_runtime(first, second):
    # An AppImage FUSE daemon can legitimately be reparented to PID1 after
    # AppRun exits. Its PID generation and exact opaque image must not change.
    return all(
        key in first and key in second and first[key] == second[key] for key in ("pid", "creation_ticks", "package")
    )


def helper(raw_policy, argv, environment):
    """Unprivileged FUSERMOUNT_PROG shim; the candidate receives no capability."""
    policy = inspect_policy(raw_policy)
    request = inspect_helper_arguments(argv)
    remaining = float(environment["PORTCOVE_NATIVE_FUSE_REMAINING_SECONDS"])
    require(0 < remaining <= 1800, "FUSE original lifetime exhausted")
    original = None
    if request["action"] == "mount":
        communication = environment.get("_FUSE_COMMFD", "")
        require(
            re.fullmatch(r"[1-9][0-9]{0,2}", communication) and 2 < int(communication) < 256,
            "FUSE communication FD differs",
        )
        original = socket.socket(fileno=os.dup(int(communication)))
        try:
            require(
                original.family == socket.AF_UNIX and original.type in (socket.SOCK_STREAM, socket.SOCK_SEQPACKET),
                "FUSE original communication socket differs",
            )
            peer = struct.unpack(
                "3i", original.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            )
            require(
                peer == (os.getppid(), policy["uid"], policy["gid"]),
                "FUSE communication is not the original runtime peer",
            )
            original.settimeout(min(remaining, 10))
        except BaseException:
            original.close()
            raise
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
            channel.settimeout(min(remaining, 10))
            channel.connect(abstract_address(policy))
            encoded = json.dumps({"schema_version": 1, "argv": argv}, separators=(",", ":")).encode()
            require(channel.send(encoded) == len(encoded), "FUSE request send incomplete")
            if request["action"] == "mount":
                descriptor = receive_descriptor(channel)
                try:
                    send_descriptor(original, descriptor)
                finally:
                    os.close(descriptor)
            else:
                require(channel.recv(2) == b"\0", "FUSE unmount acknowledgement differs")
    finally:
        if original is not None:
            original.close()
    return 0


def inspect_peer(connection, raw_policy):
    policy = inspect_policy(raw_policy)
    pid, uid, gid = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    )
    require(uid == policy["uid"] and gid == policy["gid"], "FUSE helper peer differs")
    current = process_generation(pid)
    command = read_proc(f"/proc/{pid}/cmdline", 4096).split(b"\0")
    require(command[:3] == [b"/usr/bin/python3", b"-ISB", b"/native/fuse.py"], "FUSE shim command differs")
    with open(f"/proc/{pid}/exe", "rb") as source:
        identity = os.fstat(source.fileno())
        require(
            stat.S_ISREG(identity.st_mode) and 0 < identity.st_size <= 128 * 1024 * 1024,
            "FUSE shim interpreter differs",
        )
        data = source.read(identity.st_size + 1)
        require(
            len(data) == identity.st_size and hashlib.sha256(data).hexdigest() == policy["python_sha256"],
            "FUSE shim interpreter changed",
        )
        after = os.fstat(source.fileno())
        require(
            (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns, identity.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "FUSE shim interpreter changed",
        )
    runtime = read_process_identity(current[1], policy)
    require(process_generation(pid) == current, "FUSE shim process changed")
    return runtime


def bounded_deadline(raw_policy, monotonic_deadline):
    """Every exchange intersects UTC and the inherited monotonic deadline."""
    require(
        type(monotonic_deadline) in (float, int) and math.isfinite(monotonic_deadline),
        "FUSE inherited deadline differs",
    )
    policy = inspect_policy(raw_policy)
    parsed = datetime.datetime.strptime(policy["deadline_utc"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.UTC)
    require(
        parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") == policy["deadline_utc"],
        "FUSE original deadline is not canonical",
    )
    remaining = min(parsed.timestamp() - time.time(), monotonic_deadline - time.monotonic())
    require(0 < remaining <= 1800, "FUSE original lifetime exhausted")
    return remaining


def assert_broker_boundary(policy):
    require(sys.platform == "linux" and os.getppid() == 1, "FUSE broker must be the fixed private PID1 child")
    import fcntl

    require(os.getuid() == policy["uid"] and os.getgid() == policy["gid"], "FUSE broker account differs")
    for name, expected in (("uid", policy["uid"]), ("gid", policy["gid"])):
        rows = [line.split() for line in read_proc(f"/proc/self/{name}_map").decode("ascii").splitlines()]
        require(rows == [[str(expected), str(expected), "1"]], "FUSE broker mapping includes another account")
    current = os.stat("/proc/self/ns/user")
    with open("/proc/self/ns/mnt", "rb") as namespace:
        owner = fcntl.ioctl(namespace.fileno(), 0xB701)  # NS_GET_USERNS
    try:
        observed = os.fstat(owner)
        require(
            (current.st_dev, current.st_ino) == (observed.st_dev, observed.st_ino), "FUSE mount namespace owner differs"
        )
    finally:
        os.close(owner)
    fields = dict(
        line.split(":", 1) for line in read_proc("/proc/self/status").decode("ascii").splitlines() if ":" in line
    )
    require(
        all(int(fields[name], 16) == 1 << 21 for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")),
        "FUSE broker requires only private SYS_ADMIN",
    )
    require(fields["NoNewPrivs"].strip() == "1", "FUSE broker no-new-privileges differs")
    require(ctypes.CDLL(None, use_errno=True).prctl(3, 0, 0, 0, 0) == 0, "FUSE broker must remain nondumpable")


def retain_setup_capabilities(mask):
    """Remove existing private setup capabilities; never raise candidate rights."""
    require(type(mask) is int and mask in (0, 0x1400, 1 << 21), "FUSE setup capability selection differs")
    fields = dict(
        line.split(":", 1) for line in read_proc("/proc/self/status").decode("ascii").splitlines() if ":" in line
    )
    previous = int(fields["CapEff"], 16)
    require(previous & ~0x201400 == 0 and previous & mask == mask, "FUSE setup cannot raise capabilities")
    require(
        all(int(fields[name], 16) == previous for name in ("CapPrm", "CapInh", "CapAmb")),
        "FUSE original setup masks differ",
    )

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]

    libc = ctypes.CDLL(None, use_errno=True)
    for bit in range(32):
        if (previous & ~mask) & (1 << bit):
            require(libc.prctl(47, 3, bit, 0, 0) == 0, "FUSE ambient capability removal refused")
    header, values = Header(0x20080522, 0), (Data * 2)(Data(mask, mask, mask), Data(0, 0, 0))
    require(libc.capset(ctypes.byref(header), values) == 0, "FUSE setup capability removal refused")
    require(libc.prctl(38, 1, 0, 0, 0) == 0 and libc.prctl(4, 0, 0, 0, 0) == 0, "FUSE setup process protection refused")
    after = dict(
        line.split(":", 1) for line in read_proc("/proc/self/status").decode("ascii").splitlines() if ":" in line
    )
    require(
        all(int(after[name], 16) == mask for name in ("CapEff", "CapPrm", "CapInh", "CapAmb"))
        and after["NoNewPrivs"].strip() == "1",
        "FUSE setup capability readback differs",
    )


def mount_rows():
    rows = []
    for line in read_proc("/proc/self/mountinfo", 1024 * 1024).decode("ascii").splitlines():
        fields = line.split()
        separator = fields.index("-")
        require(len(fields) > separator + 3, "FUSE mount observation incomplete")
        rows.append(
            {
                "id": fields[0],
                "path": fields[4],
                "options": fields[5].split(","),
                "filesystem": fields[separator + 1],
                "source": fields[separator + 2],
            }
        )
    return rows


def mount_descriptor(descriptor):
    require(type(descriptor) is int and descriptor >= 0, "FUSE held mount descriptor differs")
    lines = read_proc(f"/proc/self/fdinfo/{descriptor}").decode("ascii").splitlines()
    values = {}
    for name in ("mnt_id", "ino"):
        selected = [line.split(":", 1)[1].strip() for line in lines if line.startswith(name + ":")]
        require(
            len(selected) == 1 and re.fullmatch(r"[1-9][0-9]{0,19}", selected[0]),
            "FUSE mount descriptor generation incomplete",
        )
        values[name] = selected[0]
    return values


class NativeFuseBroker:
    """One original-namespace lifetime; failed or ambiguous effects never retry.

    The caller supplies only its own preopened character-device FDs. Each
    authorized readonly mount hands its narrow FUSE session FD to the actual
    libfuse runtime through the shim. Caller-selected FDs, syscall arguments,
    capabilities and arbitrary mount options are never accepted.
    """

    def __init__(self, raw_policy, fuse_descriptors, monotonic_deadline, emit):
        self.policy = inspect_policy(raw_policy)
        bounded_deadline(self.policy, monotonic_deadline)
        assert_broker_boundary(self.policy)
        require(
            isinstance(fuse_descriptors, tuple)
            and len(fuse_descriptors) == MOUNT_LIMIT
            and len(set(fuse_descriptors)) == MOUNT_LIMIT,
            "FUSE preopened device inventory differs",
        )
        for descriptor in fuse_descriptors:
            info = os.fstat(descriptor)
            require(
                stat.S_ISCHR(info.st_mode) and os.major(info.st_rdev) == 10 and os.minor(info.st_rdev) == 229,
                "FUSE original device differs",
            )
            os.set_inheritable(descriptor, False)
        self.devices = list(fuse_descriptors)
        self.owned_devices = set(fuse_descriptors)
        self.deadline = monotonic_deadline
        self.emit = emit
        self.mounts = {}
        self.attempted = set()
        self.refused = False
        self.stopping = False
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.listener.bind(abstract_address(self.policy))
        self.listener.listen(1)

    def handle(self, channel):
        require(not self.refused, "FUSE broker already refused")
        channel.settimeout(min(2, bounded_deadline(self.policy, self.deadline)))
        peer = inspect_peer(channel, self.policy)
        data, controls, flags, _ = channel.recvmsg(MAXIMUM + 1, 0)
        require(not controls and flags == 0, "FUSE request cannot supply descriptors")
        request = decode(data)
        require(
            isinstance(request, dict) and set(request) == {"schema_version", "argv"} and request["schema_version"] == 1,
            "FUSE request fields differ",
        )
        selected = inspect_helper_arguments(request["argv"])
        target, action = selected["mountpoint"], selected["action"]
        bounded_deadline(self.policy, self.deadline)
        assert_broker_boundary(self.policy)
        require(same_runtime(read_process_identity(peer["pid"], self.policy), peer), "FUSE original runtime changed")
        effect = {
            "kind": "native-private-fuse",
            "action": action,
            "mountpoint": target,
            "runtime": peer,
            "authority": "none",
        }
        if action == "unmount":
            original = self.mounts.get(target)
            require(original and same_runtime(original["runtime"], peer), "FUSE unmount does not own original mount")
            require(
                [row for row in mount_rows() if row["id"] == original["mount"]["id"]] == [original["mount"]],
                "FUSE original mount changed",
            )
            held = os.open(target, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                generation = mount_descriptor(held)
                require(
                    generation["mnt_id"] == original["mount"]["id"], "FUSE unmount target is not the original mount"
                )
                self.emit({**effect, "stage": "intent", "mount_descriptor": generation})
                bounded_deadline(self.policy, self.deadline)
                require(mount_descriptor(held) == generation, "FUSE original held mount changed")
                result = ctypes.CDLL(None, use_errno=True).umount2(f"/proc/self/fd/{held}".encode(), 2)
                require(result == 0, "FUSE original unmount refused")
                require(mount_descriptor(held) == generation, "FUSE original held mount changed during readback")
                require(
                    not any(row["id"] == original["mount"]["id"] for row in mount_rows()),
                    "FUSE original unmount remains ambiguous",
                )
                self.emit({**effect, "stage": "unmounted", "mount": original["mount"], "mount_descriptor": generation})
                del self.mounts[target]
                require(channel.send(b"\0") == 1, "FUSE unmount response lost")
            finally:
                os.close(held)
            return
        require(
            not self.stopping and target not in self.attempted and len(self.attempted) < MOUNT_LIMIT,
            "FUSE mount attempt cannot repeat or start during settlement",
        )
        require(len(self.mounts) < 2, "FUSE concurrent mount limit reached")
        require(not any(row["path"] == target for row in mount_rows()), "FUSE mountpoint already mounted")
        directory = os.open(target, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            identity = os.fstat(directory)
            require(
                stat.S_ISDIR(identity.st_mode) and identity.st_uid == self.policy["uid"],
                "FUSE mountpoint ownership differs",
            )
            require(not os.listdir(target), "FUSE mountpoint is not empty")
            require(
                stable_file(os.stat(target, follow_symlinks=False)) == stable_file(identity), "FUSE mountpoint changed"
            )
            self.attempted.add(target)
            descriptor = self.devices.pop(0)
            self.emit({**effect, "stage": "intent"})
            options = (
                f"fd={descriptor},rootmode=40000,user_id={self.policy['uid']},group_id={self.policy['gid']}".encode()
            )
            bounded_deadline(self.policy, self.deadline)
            result = ctypes.CDLL(None, use_errno=True).mount(
                ACTIVE.encode(), f"/proc/self/fd/{directory}".encode(), b"fuse.AppImage", 1 | 2 | 4, options
            )
            require(result == 0, "FUSE readonly mount refused")
            rows = [row for row in mount_rows() if row["path"] == target]
            require(
                len(rows) == 1
                and rows[0]["filesystem"] == "fuse.AppImage"
                and rows[0]["source"] == ACTIVE
                and {"ro", "nosuid", "nodev"} <= set(rows[0]["options"]),
                "FUSE mount result ambiguous",
            )
            self.mounts[target] = {"runtime": peer, "mount": rows[0]}
            self.emit({**effect, "stage": "mounted", "mount": rows[0]})
            send_descriptor(channel, descriptor)
            os.close(descriptor)
            self.owned_devices.remove(descriptor)
        finally:
            os.close(directory)

    def run(self, stop_descriptor):
        require(stat.S_ISFIFO(os.fstat(stop_descriptor).st_mode), "FUSE private settlement pipe differs")
        selection = selectors.DefaultSelector()
        selection.register(self.listener, selectors.EVENT_READ, "request")
        selection.register(stop_descriptor, selectors.EVENT_READ, "stop")
        settle_deadline = None
        try:
            while True:
                if self.stopping and not self.mounts:
                    self.emit(
                        {"kind": "native-private-fuse", "stage": "settled", "mounts_empty": True, "authority": "none"}
                    )
                    return
                remaining = bounded_deadline(self.policy, self.deadline)
                if settle_deadline is not None:
                    require(time.monotonic() < settle_deadline, "FUSE original mounts did not settle")
                    remaining = min(remaining, settle_deadline - time.monotonic())
                for key, _ in selection.select(min(0.5, remaining)):
                    if key.data == "stop":
                        require(os.read(stop_descriptor, 2) == b"\0", "FUSE settlement signal missing or changed")
                        selection.unregister(stop_descriptor)
                        self.stopping = True
                        settle_deadline = time.monotonic() + min(5, remaining)
                    else:
                        channel, _ = self.listener.accept()
                        with channel:
                            self.handle(channel)
        except BaseException as failure:
            self.refused = True
            self.emit(
                {
                    "kind": "native-private-fuse",
                    "stage": "refused",
                    "failure": str(failure)[:2048],
                    "attempted_mountpoints": sorted(self.attempted),
                    "known_remaining_mounts": list(self.mounts.values()),
                    "authority": "none",
                }
            )
            raise
        finally:
            selection.close()
            self.listener.close()
            for descriptor in self.owned_devices:
                os.close(descriptor)


def shim_main():
    descriptor = os.open("/native/fuse.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= MAXIMUM,
            "FUSE fixed policy file differs",
        )
        data = os.read(descriptor, MAXIMUM + 1)
        require(
            len(data) == before.st_size and stable_file(os.fstat(descriptor)) == stable_file(before),
            "FUSE fixed policy changed",
        )
    finally:
        os.close(descriptor)
    return helper(decode(data), sys.argv[1:], os.environ)


if __name__ == "__main__":
    raise SystemExit(shim_main())
