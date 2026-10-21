#!/usr/bin/env python3
"""Fixed native guest lifetime supervisor, never a native issuer or scheduler.

Only staged fixed controller inputs are consumed. No host setup, credentials,
network proxy, service installation or candidate-selected command is supported.
The held cgroup primitives below match the maintained semantic supervisor.
Pure tests do not establish available WSL/systemd or native qualification.
"""

import contextlib
import ctypes
import errno
import hashlib
import json
import os
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path

MIB = 1024 * 1024
MEMORY_BYTES = 1024 * MIB
STDOUT_BYTES = 4 * MIB
STDERR_BYTES = 4 * MIB
TASKS_MAX = 64
COMMAND_DEADLINE = None
SHA = re.compile(r"[a-f0-9]{64}\Z")
TOOLS = {"systemctl": "/usr/bin/systemctl", "systemd_run": "/usr/bin/systemd-run", "python": "/usr/bin/python3"}


class Refusal(Exception):
    """Fixed nonsecret diagnostics only."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def decode(data):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "duplicate native supervisor JSON key")
            result[key] = value
        return result

    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=pairs,
        parse_constant=lambda _: require(False, "nonfinite native supervisor JSON"),
    )


def control_environment():
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": str(Path.home()),
        "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus",
    }


def systemctl(*args):
    timeout = 10 if COMMAND_DEADLINE is None else min(10, COMMAND_DEADLINE - time.monotonic())
    require(timeout > 0, "native systemd observation deadline expired")
    result = subprocess.run(
        [TOOLS["systemctl"], "--user", "--no-pager", *args],
        env=control_environment(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    require(len(result.stdout) <= 32768 and len(result.stderr) <= 4096, "systemd response exceeded bound")
    return result.returncode, result.stdout


def unit_properties(unit):
    code, data = systemctl(
        "show",
        unit,
        "--property=LoadState,ActiveState,SubState,ControlGroup,MainPID,MemoryMax,MemorySwapMax,TasksMax,Result,InvocationID",
    )
    require(code == 0, "cannot read exact owned native unit")
    result = {}
    for line in data.decode("ascii").splitlines():
        key, separator, value = line.partition("=")
        require(separator and key not in result, "duplicate or invalid systemd property")
        result[key] = value
    return result


def inspect_unit_properties(properties):
    require(
        properties.get("LoadState") == "loaded"
        and properties.get("ActiveState") == "active"
        and properties.get("MemoryMax") == str(MEMORY_BYTES)
        and properties.get("MemorySwapMax") == "0"
        and properties.get("TasksMax") == "64",
        "native unit resource limits differ",
    )


class HeldCgroup:
    def __init__(self, unit, peer_pid):
        properties = unit_properties(unit)
        inspect_unit_properties(properties)
        group = properties.get("ControlGroup", "")
        require(
            group.startswith("/user.slice/") and ".." not in group.split("/") and group.endswith("/" + unit),
            "exact owned user cgroup required",
        )
        self.path = Path("/sys/fs/cgroup") / group.lstrip("/")
        # Pin this exact kernel object, not just a potentially reused pathname.
        self.directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.files = {}
        self.identity = None
        self.last_observation = None
        try:
            info = os.fstat(self.directory)
            require(
                stat.S_ISDIR(info.st_mode) and filesystem_kind(self.directory) == 0x63677270,
                "held directory is not cgroup v2",
            )
            self.identity = (info.st_dev, info.st_ino)
            require(
                os.readlink(f"/proc/self/fd/{self.directory}") == str(self.path), "initial held cgroup path differs"
            )
            for name in ("cgroup.events", "cgroup.procs", "memory.max", "memory.swap.max", "pids.max"):
                self.files[name] = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.directory)
            require(
                self.read("memory.max").strip() == str(MEMORY_BYTES)
                and self.read("memory.swap.max").strip() == "0"
                and self.read("pids.max").strip() == "64",
                "actual cgroup resource limits differ",
            )
            require(str(peer_pid) in self.read("cgroup.procs").splitlines(), "entry peer is outside exact cgroup")
        except BaseException:
            self.close()
            raise

    def read(self, name):
        data = os.pread(self.files[name], 4097, 0)
        require(len(data) <= 4096, "cgroup observation exceeds bound")
        return data.decode("ascii")

    def empty(self):
        self.last_observation = None
        try:
            events = dict(line.split() for line in self.read("cgroup.events").splitlines())
            empty = events.get("populated") == "0" and self.read("cgroup.procs").strip() == ""
            if empty:
                self.last_observation = "observed-unpopulated"
            return empty
        except OSError as error:
            if error.errno not in (errno.ENODEV, errno.ENOENT, errno.ESTALE):
                raise
            info = os.fstat(self.directory)
            require(
                (info.st_dev, info.st_ino) == self.identity
                and stat.S_ISDIR(info.st_mode)
                and filesystem_kind(self.directory) == 0x63677270,
                "held cgroup identity changed",
            )
            # cgroup2's kernfs syscall table has no rename operation. The exact
            # old path plus d_path's '(deleted)' annotation therefore identifies
            # successful removal of this held object, not a similarly named new
            # object. cgroup_destroy_locked() permits removal only after no live
            # tasks/children and disables new migration before kernfs removal.
            # nlink is deliberately NOT used: kernfs getattr reports subdirs+2.
            # Sources: kernel/cgroup/cgroup.c cgroup_destroy_locked/cgroup_kf_syscall_ops;
            # fs/d_path.c d_path; fs/kernfs/inode.c kernfs_refresh_inode (Linux v6.6).
            require(
                os.readlink(f"/proc/self/fd/{self.directory}") == str(self.path) + " (deleted)",
                "exact held cgroup removal is unproven",
            )
            self.last_observation = "removed-exact-held-cgroup"
            return True

    def close(self):
        for fd in self.files.values():
            os.close(fd)
        self.files = {}
        os.close(self.directory)


def filesystem_kind(fd):
    class StatFS(ctypes.Structure):
        _fields_ = [("kind", ctypes.c_long), ("rest", ctypes.c_byte * 248)]

    filesystem = StatFS()
    require(
        ctypes.CDLL(None, use_errno=True).fstatfs(fd, ctypes.byref(filesystem)) == 0,
        "held filesystem identity is unavailable",
    )
    return filesystem.kind


def read_regular(filename, maximum, private=True, marker=False, allow_empty=False):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode)
            and before.st_nlink in ((1, 2) if marker else (1,))
            and (0 if allow_empty else 1) <= before.st_size <= maximum,
            "native input is not a bounded single-link regular file",
        )
        require(
            not before.st_mode & 0o022 and (not private or before.st_uid == os.getuid() and not before.st_mode & 0o077),
            "native input ownership differs",
        )
        chunks, total = [], 0
        while True:
            data = os.read(fd, min(65536, maximum + 1 - total))
            if not data:
                break
            total += len(data)
            require(total <= maximum, "native input grew beyond bound")
            chunks.append(data)
        after = os.fstat(fd)
        require(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "native input changed during read",
        )
        return b"".join(chunks)
    finally:
        os.close(fd)


def owned_directory(filename):
    value = Path(filename)
    require(value.is_absolute() and ".." not in value.parts, "native directory must be absolute")
    for part in (value, *value.parents):
        info = part.lstat()
        require(
            stat.S_ISDIR(info.st_mode)
            and not stat.S_ISLNK(info.st_mode)
            and info.st_uid in (0, os.getuid())
            and not info.st_mode & 0o022,
            "native directory ancestry is writable or linked",
        )
    require(
        value.stat().st_uid == os.getuid() and not value.stat().st_mode & 0o077,
        "native directory must be private to qualification account",
    )
    return value


def create_file(filename, data):
    # Publish complete JSON atomically without replacing an earlier marker.
    # Retain the private temp alias: unlinking after publication changes ctime
    # while a concurrent reader is checking the completed marker identity.
    filename = Path(filename)
    temporary = filename.parent / (".outer-json-" + os.urandom(16).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(data)
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    os.link(temporary, filename, follow_symlinks=False)
    directory = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def read_marker(filename, maximum):
    return decode(read_regular(filename, maximum, marker=True))


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def needs_unit_kill(group):
    try:
        return group is None or not group.empty()
    except Exception:
        return True


def drain_capture(process, outputs, deadline, on_tick):
    selector = selectors.DefaultSelector()
    totals = {"stdout": 0, "stderr": 0}
    try:
        for name in totals:
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            require(time.monotonic() < deadline, "native original lifetime exceeded")
            on_tick()
            for event, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                data = os.read(event.fd, 65536)
                if not data:
                    selector.unregister(event.fileobj)
                    continue
                name = event.data
                limit = STDOUT_BYTES if name == "stdout" else STDERR_BYTES
                outputs[name].write(data[: max(0, limit - totals[name])])
                totals[name] += len(data)
                require(totals[name] <= limit, "native direct capture exceeded bound")
        on_tick()
        process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return totals
    finally:
        selector.close()
        for output in outputs.values():
            output.flush()
            os.fsync(output.fileno())


def inspect_unit_identity(properties, unit, invocation_id):
    require(properties.get("InvocationID") == invocation_id, "owned native unit invocation changed")
    group = properties.get("ControlGroup", "")
    require(
        group.endswith("/" + unit)
        and group.startswith(f"/user.slice/user-{os.getuid()}.slice/")
        and ".." not in group.split("/"),
        "owned native cgroup route differs",
    )
    return properties


def inspect_request(raw, invocation):
    require(
        isinstance(raw, dict)
        and set(raw)
        == {
            "schema_version",
            "invocation_id",
            "stage_request_sha256",
            "qualification_uid",
            "qualification_gid",
            "controller",
            "plan_sha256",
            "supervisor_sha256",
            "support_sha256",
            "driver_sha256",
            "tools_sha256",
            "timeout_seconds",
            "deadline_utc",
        },
        "fixed native outer request fields differ",
    )
    require(
        raw["schema_version"] == 1 and raw["invocation_id"] == invocation and SHA.fullmatch(invocation),
        "native invocation differs",
    )
    for name in ("stage_request_sha256", "plan_sha256", "supervisor_sha256", "support_sha256", "driver_sha256"):
        require(isinstance(raw[name], str) and SHA.fullmatch(raw[name]), "native source/input pin differs")
    for name in ("qualification_uid", "qualification_gid"):
        require(type(raw[name]) is int and 1 <= raw[name] <= 4294967294, "nonroot native identity required")
    require(
        isinstance(raw["controller"], dict)
        and set(raw["controller"]) == {"source_commit", "source_tree"}
        and all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value) for value in raw["controller"].values()
        ),
        "native controller identity differs",
    )
    require(
        isinstance(raw["tools_sha256"], dict)
        and set(raw["tools_sha256"]) == {"python", "bwrap", "systemd_run", "systemctl", "node", "git"}
        and all(isinstance(value, str) and SHA.fullmatch(value) for value in raw["tools_sha256"].values()),
        "native tool pin inventory differs",
    )
    require(
        type(raw["timeout_seconds"]) is int and 1 <= raw["timeout_seconds"] <= 1800,
        "native lifetime exceeds fixed bound",
    )
    require(
        isinstance(raw["deadline_utc"], str)
        and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", raw["deadline_utc"]),
        "native original UTC deadline differs",
    )
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(raw["deadline_utc"].replace("Z", "+00:00"))
    except ValueError as error:
        raise Refusal("native original UTC deadline differs") from error
    require(
        parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") == raw["deadline_utc"],
        "native original UTC deadline is not canonical",
    )
    return raw


def remaining_deadline(request):
    from datetime import datetime

    until = datetime.fromisoformat(request["deadline_utc"].replace("Z", "+00:00")).timestamp()
    remaining = min(request["timeout_seconds"], until - time.time())
    require(remaining > 0, "native original deadline expired")
    return time.monotonic() + remaining


def paths():
    filename = Path(__file__).absolute()
    require(
        filename.name == "native-qualification-linux-supervisor.py"
        and filename.parent.name == "scripts"
        and filename.parent.parent.name == "controller",
        "fixed native supervisor location required",
    )
    root = filename.parent.parent.parent
    require(
        re.fullmatch(r"/home/[a-z][a-z0-9_-]{0,31}/portcove-native", str(root)),
        "fixed native qualification home required",
    )
    return root


def load_attempt(root, invocation, request_sha):
    require(SHA.fullmatch(invocation) and SHA.fullmatch(request_sha), "native exact invocation/request required")
    owned_directory(root)
    attempt = owned_directory(root / "invocations" / invocation)
    owned_directory(attempt / "capture")
    data = read_regular(attempt / "request.json", 128 * 1024)
    require(hashlib.sha256(data).hexdigest() == request_sha, "staged native request bytes differ")
    request = inspect_request(decode(data), invocation)
    require(
        os.getuid() == request["qualification_uid"] and os.getgid() == request["qualification_gid"],
        "native qualification account differs",
    )
    plan = read_regular(attempt / "plan.json", 128 * 1024)
    require(hashlib.sha256(plan).hexdigest() == request["plan_sha256"], "staged native plan bytes differ")
    return attempt, request


def fixed_tool_paths(root):
    return {**TOOLS, "bwrap": "/usr/bin/bwrap", "node": str(root / "tools/node"), "git": "/usr/bin/git"}


def verify_sources(root, request, deadline):
    require(time.monotonic() < deadline, "native original deadline expired")
    controller = root / "controller"
    for filename, expected in (
        (Path(__file__), request["supervisor_sha256"]),
        (controller / "scripts/semantic-review-linux-supervisor.py", request["support_sha256"]),
        (controller / "scripts/release-native-linux-driver.mts", request["driver_sha256"]),
    ):
        require(
            hashlib.sha256(read_regular(filename, MIB, False)).hexdigest() == expected,
            "native fixed controller source changed",
        )
    for name, filename in fixed_tool_paths(root).items():
        filename = Path(filename).resolve(strict=True)
        for parent in (filename, *filename.parents):
            info = parent.lstat()
            require(info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022, "native tool ancestry differs")
        require(
            hashlib.sha256(read_regular(filename, 256 * MIB, False)).hexdigest() == request["tools_sha256"][name],
            "native qualified tool changed",
        )
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(root),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    for arguments, expected in (
        (["rev-parse", "HEAD"], request["controller"]["source_commit"]),
        (["rev-parse", "HEAD^{tree}"], request["controller"]["source_tree"]),
        (["status", "--porcelain", "--untracked-files=all"], ""),
    ):
        require(time.monotonic() < deadline, "native original deadline expired")
        reply = subprocess.run(
            ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *arguments],
            cwd=controller,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=min(10, max(0.01, deadline - time.monotonic())),
            check=False,
        )
        require(
            reply.returncode == 0
            and len(reply.stdout) <= 65536
            and len(reply.stderr) <= 4096
            and reply.stdout.decode("utf-8").strip() == expected,
            "native installed controller Git identity differs",
        )
    require(time.monotonic() < deadline, "native original deadline expired")


def unit_command(root, attempt, request, request_sha, nonce, seconds):
    bootstrap = globals().get("_native_bootstrap_argv")
    require(callable(bootstrap), "fixed pre-execution source bootstrap is required")
    return [
        TOOLS["systemd_run"],
        "--user",
        "--quiet",
        "--pipe",
        "--wait",
        "--service-type=exec",
        "--unit=portcove-native-" + request["invocation_id"] + ".service",
        "--property=MemoryMax=" + str(MEMORY_BYTES),
        "--property=MemorySwapMax=0",
        "--property=TasksMax=64",
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=5s",
        "--property=RuntimeMaxSec=" + str(seconds),
        "--property=NoNewPrivileges=yes",
        "--property=UMask=0077",
        "--property=RestrictSUIDSGID=yes",
        "--",
        *bootstrap(
            [
                "--mode",
                "unit-entry",
                "--invocation",
                request["invocation_id"],
                "--request-sha256",
                request_sha,
                "--nonce",
                nonce,
            ]
        ),
    ]


def read_packet(peer, maximum=8192):
    data = b""
    while b"\n" not in data:
        value = peer.recv(min(4096, maximum + 1 - len(data)))
        require(value, "native control peer closed before fixed packet")
        data += value
        require(len(data) <= maximum, "native control packet exceeds bound")
    require(data.endswith(b"\n") and data.count(b"\n") == 1, "native control packet framing differs")
    return decode(data[:-1])


def verify_bounded_home(attempt):
    home = owned_directory(attempt / "work/home")
    descriptor = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(filesystem_kind(descriptor) == 0x01021994, "native home is not a bounded tmpfs")
        sizes = os.fstatvfs(descriptor)
        require(0 < sizes.f_blocks * sizes.f_frsize <= 512 * MIB, "native home filesystem exceeds fixed writable bound")
        mount_fd = os.open("/proc/self/mountinfo", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            mounts = os.read(mount_fd, MIB + 1)
            require(len(mounts) <= MIB and not os.read(mount_fd, 1), "native mount observation exceeds bound")
        finally:
            os.close(mount_fd)
        matches = []
        for line in mounts.decode("utf-8").splitlines():
            parts = line.split()
            if len(parts) >= 10 and parts[4] == str(home):
                separator = parts.index("-")
                matches.append(parts[separator + 1])
        require(matches == ["tmpfs"], "native home is not an exact dedicated tmpfs mount")
    finally:
        os.close(descriptor)


def socket_route(root, invocation, request_sha):
    require(
        re.fullmatch(r"/home/[a-z][a-z0-9_-]{0,31}/portcove-native", root.as_posix())
        and SHA.fullmatch(invocation)
        and SHA.fullmatch(request_sha),
        "native short socket identity differs",
    )
    identity = {"schema_version": 1, "invocation_id": invocation, "request_sha256": request_sha}
    short = hashlib.sha256(encode(identity)).hexdigest()[:32]
    route = root / ".s" / (short + ".s")
    # Linux sockaddr_un.sun_path has108 bytes including the trailing NUL.
    require(len(os.fsencode(route.as_posix())) <= 107, "native Unix socket path exceeds kernel bound")
    return route


def inspect_socket_claim(raw, root, invocation, request_sha):
    expected = {
        "schema_version": 1,
        "invocation_id": invocation,
        "request_sha256": request_sha,
        "socket": socket_route(root, invocation, request_sha).as_posix(),
    }
    require(raw == expected, "native short socket collision or retained identity differs")
    return expected


def prepare_socket_route(root, invocation, request_sha, create=False):
    route = socket_route(root, invocation, request_sha)
    if create:
        route.parent.mkdir(mode=0o700, exist_ok=True)
    owned_directory(route.parent)
    claim = route.with_suffix(".json")
    expected = {
        "schema_version": 1,
        "invocation_id": invocation,
        "request_sha256": request_sha,
        "socket": route.as_posix(),
    }
    if create:
        # A colliding digest or retained route is never silently reused/removed.
        # CreateNew's atomic publication preserves the exact original identity.
        create_file(claim, encode(expected))
    inspect_socket_claim(read_marker(claim, 16384), root, invocation, request_sha)
    return route


def entry(root, invocation, request_sha, nonce):
    attempt, request = load_attempt(root, invocation, request_sha)
    deadline = remaining_deadline(request)
    verify_sources(root, request, deadline)
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(min(20, max(0.01, deadline - time.monotonic())))
    try:
        peer.connect(str(prepare_socket_route(root, invocation, request_sha)))
        peer.sendall(
            encode(
                {
                    "schema_version": 1,
                    "kind": "native-driver-ready",
                    "nonce": nonce,
                    "invocation_id": invocation,
                    "plan_sha256": request["plan_sha256"],
                }
            )
            + b"\n"
        )
        binding = read_packet(peer)
        require(
            isinstance(binding, dict)
            and set(binding) == {"schema_version", "kind", "nonce", "invocation_id", "unit", "deadline_utc"}
            and binding["schema_version"] == 1
            and binding["kind"] == "native-driver-admitted"
            and binding["nonce"] == nonce
            and binding["invocation_id"] == invocation
            and binding["deadline_utc"] == request["deadline_utc"],
            "native outer admission packet differs",
        )
        retained = read_marker(attempt / "capture/unit-binding.json", 16384)
        require(binding == retained, "native unit binding bytes differ")
    finally:
        peer.close()
    verify_sources(root, request, deadline)
    environment = control_environment()
    os.execve("/usr/bin/bwrap", bounded_driver_command(root, attempt, request), environment)


def bounded_driver_command(root, attempt, request):
    home = attempt / "work/home"
    return [
        "/usr/bin/bwrap",
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--uid",
        str(request["qualification_uid"]),
        "--gid",
        str(request["qualification_gid"]),
        "--cap-drop",
        "ALL",
        "--bind",
        "/",
        "/",
        "--size",
        str(512 * MIB),
        "--tmpfs",
        str(home),
        "--chdir",
        str(home),
        "--setenv",
        "HOME",
        str(home),
        "--setenv",
        "TMPDIR",
        str(home),
        "--",
        str(root / "tools/node"),
        str(root / "controller/scripts/release-native-linux-driver.mts"),
        "--plan",
        str(attempt / "plan.json"),
        "--plan-sha256",
        request["plan_sha256"],
        "--unit-binding",
        str(attempt / "capture/unit-binding.json"),
    ]


def settled_unit(properties):
    return properties.get("LoadState") == "not-found" or (
        properties.get("ActiveState") in ("inactive", "failed") and properties.get("MainPID") == "0"
    )


def utc_now():
    now = time.time_ns()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now // 1000000000)) + f".{now // 1000000 % 1000:03d}Z"


def supervise(root, invocation, request_sha):
    import fcntl

    global COMMAND_DEADLINE
    attempt, request = load_attempt(root, invocation, request_sha)
    deadline = remaining_deadline(request)
    COMMAND_DEADLINE = deadline
    verify_sources(root, request, deadline)
    capture = attempt / "capture"
    lock = os.open(capture / ".outer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(lock)
        raise
    unit = f"portcove-native-{invocation}.service"
    listener = peer = process = group = None
    outputs = {}
    binding = None
    intent_created = False
    result = {
        "schema_version": 1,
        "started_at": utc_now(),
        "completed_at": None,
        "invocation_id": invocation,
        "request_sha256": request_sha,
        "stage_request_sha256": request["stage_request_sha256"],
        "unit": unit,
        "unit_invocation_id": None,
        "cgroup_identity": None,
        "capture_complete": False,
        "capture_bytes": None,
        "capture_sha256": None,
        "cgroup_empty": False,
        "cgroup_settlement": None,
        "unit_settled": False,
        "forced_termination": False,
        "exit_code": None,
        "failure": None,
        "cleanup_errors": [],
        "authority": "none",
        "scope": "native-guest-lifetime-only",
    }
    try:
        require(not (capture / "outer-intent.json").exists(), "retained native intent refuses repeat execution")
        require(sys.platform == "linux" and os.getuid() > 0, "rootless Linux native supervisor required")
        require(Path("/sys/fs/cgroup/cgroup.controllers").is_file(), "native cgroup v2 unavailable")
        bus = Path(f"/run/user/{os.getuid()}/bus")
        require(bus.is_socket() and bus.stat().st_uid == os.getuid(), "native user bus unavailable")
        code, state = systemctl("show", "default.target", "--property=LoadState", "--value")
        require(code == 0 and state.strip() == b"loaded", "native user manager unavailable")
        require(unit_properties(unit).get("LoadState") == "not-found", "native unit already exists")
        create_file(
            capture / "outer-intent.json",
            encode(
                {
                    "schema_version": 1,
                    "invocation_id": invocation,
                    "request_sha256": request_sha,
                    "plan_sha256": request["plan_sha256"],
                    "unit": unit,
                    "deadline_utc": request["deadline_utc"],
                }
            ),
        )
        intent_created = True
        nonce = os.urandom(32).hex()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        route = prepare_socket_route(root, invocation, request_sha, create=True)
        listener.bind(str(route))
        os.chmod(route, 0o600)
        listener.listen(1)
        listener.setblocking(False)
        for name in ("stdout", "stderr"):
            fd = os.open(
                capture / ("outer-" + name + ".log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            outputs[name] = os.fdopen(fd, "wb")
        require(time.monotonic() < deadline, "native original deadline expired")
        process = subprocess.Popen(
            unit_command(root, attempt, request, request_sha, nonce, max(1, int(deadline - time.monotonic()))),
            env=control_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
        readiness_deadline = min(deadline, time.monotonic() + 20)

        def tick():
            nonlocal peer, group, binding
            if binding is not None:
                return
            require(time.monotonic() < readiness_deadline, "native driver readiness exceeded original bound")
            if group is None:
                # Hold the actual newly-created service before waiting for the
                # entry handshake. A hung entry must still be killable as this
                # exact unit generation, even if it never connects its socket.
                properties = unit_properties(unit)
                if properties.get("LoadState") != "loaded" or properties.get("ActiveState") != "active":
                    return
                inspect_unit_properties(properties)
                require(
                    properties.get("MainPID", "").isdigit()
                    and int(properties["MainPID"]) > 0
                    and re.fullmatch(r"[a-f0-9]{32}", properties.get("InvocationID", "")),
                    "native started service identity differs",
                )
                group = HeldCgroup(unit, int(properties["MainPID"]))
                result["unit_invocation_id"] = properties["InvocationID"]
                result["cgroup_identity"] = {
                    "device": group.identity[0],
                    "inode": group.identity[1],
                    "path": str(group.path),
                }
            try:
                peer, _ = listener.accept()
            except BlockingIOError:
                return
            peer.settimeout(max(0.01, readiness_deadline - time.monotonic()))
            pid, uid, _gid = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(uid == request["qualification_uid"], "native readiness peer account differs")
            packet = read_packet(peer)
            require(
                packet
                == {
                    "schema_version": 1,
                    "kind": "native-driver-ready",
                    "nonce": nonce,
                    "invocation_id": invocation,
                    "plan_sha256": request["plan_sha256"],
                },
                "native fixed readiness packet differs",
            )
            properties = unit_properties(unit)
            inspect_unit_properties(properties)
            require(
                properties.get("MainPID") == str(pid)
                and re.fullmatch(r"[a-f0-9]{32}", properties.get("InvocationID", "")),
                "native readiness kernel PID/unit differs",
            )
            inspect_unit_identity(properties, unit, result["unit_invocation_id"])
            require(str(pid) in group.read("cgroup.procs").splitlines(), "native peer left held cgroup")
            binding = {
                "schema_version": 1,
                "kind": "native-driver-admitted",
                "nonce": nonce,
                "invocation_id": invocation,
                "unit": {
                    "name": unit,
                    "invocation_id": properties["InvocationID"],
                    "control_group": properties["ControlGroup"],
                },
                "deadline_utc": request["deadline_utc"],
            }
            create_file(capture / "unit-binding.json", encode(binding))
            require(time.monotonic() < readiness_deadline, "native readiness deadline expired")
            peer.sendall(encode(binding) + b"\n")
            peer.close()
            peer = None
            listener.close()

        result["capture_bytes"] = drain_capture(process, outputs, deadline, tick)
        result["capture_complete"] = True
        result["exit_code"] = process.returncode
        require(binding is not None and process.returncode == 0, "native fixed driver did not complete successfully")
    except Exception as error:
        result["failure"] = str(error) if isinstance(error, Refusal) else "native guest operation refused"
    finally:
        COMMAND_DEADLINE = min(deadline + 15, time.monotonic() + 15)
        if process is not None:
            if needs_unit_kill(group):
                result["forced_termination"] = True
                try:
                    properties = unit_properties(unit)
                    require(result["unit_invocation_id"] is not None, "native unit identity was never pinned")
                    inspect_unit_identity(properties, unit, result["unit_invocation_id"])
                    systemctl("kill", unit, "--kill-whom=all", "--signal=SIGKILL")
                except Exception:
                    result["cleanup_errors"].append("exact native unit kill unconfirmed")
            if process.poll() is None:
                result["forced_termination"] = True
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                try:
                    process.wait(timeout=max(0.01, min(5, COMMAND_DEADLINE - time.monotonic())))
                except subprocess.TimeoutExpired:
                    result["cleanup_errors"].append("owned native wrapper process group unsettled")
            try:
                if group is not None:
                    until = min(COMMAND_DEADLINE, time.monotonic() + 10)
                    while not group.empty() and time.monotonic() < until:
                        time.sleep(0.05)
                    result["cgroup_empty"] = group.empty()
                    result["cgroup_settlement"] = group.last_observation
                properties = unit_properties(unit)
                if properties.get("LoadState") != "not-found":
                    inspect_unit_identity(properties, unit, result["unit_invocation_id"])
                result["unit_settled"] = settled_unit(properties)
            except Exception:
                result["cleanup_errors"].append("positive native unit/cgroup settlement unavailable")
        if peer is not None:
            peer.close()
        if listener is not None:
            listener.close()
        for output in outputs.values():
            output.close()
        if outputs:
            try:
                result["capture_sha256"] = {
                    name: hashlib.sha256(
                        read_regular(
                            capture / ("outer-" + name + ".log"),
                            STDOUT_BYTES if name == "stdout" else STDERR_BYTES,
                            allow_empty=True,
                        )
                    ).hexdigest()
                    for name in outputs
                }
            except Exception:
                result["failure"] = result["failure"] or "native retained direct stream custody refused"
        if group is not None:
            group.close()
        try:
            load_attempt(root, invocation, request_sha)
            verify_sources(root, request, deadline)
        except Exception:
            result["failure"] = result["failure"] or "native post-settlement source custody refused"
        # A refusal before CreateNew intent must never overwrite prior capture.
        if intent_created:
            result["completed_at"] = utc_now()
            create_file(capture / "outer-isolation.json", encode(result))
        os.close(lock)
    return result


def readback(root, invocation, request_sha):
    attempt, request = load_attempt(root, invocation, request_sha)
    capture = attempt / "capture"
    intent = read_marker(capture / "outer-intent.json", 16384)
    require(
        intent
        == {
            "schema_version": 1,
            "invocation_id": invocation,
            "request_sha256": request_sha,
            "plan_sha256": request["plan_sha256"],
            "unit": f"portcove-native-{invocation}.service",
            "deadline_utc": request["deadline_utc"],
        },
        "native retained intent differs",
    )
    filename = capture / "outer-settlement.json"
    if not filename.exists():
        filename = capture / "outer-isolation.json"
    if filename.exists():
        result = read_marker(filename, 32768)
        require(
            result.get("invocation_id") == invocation
            and result.get("request_sha256") == request_sha
            and result.get("unit") == intent["unit"],
            "native retained settlement differs",
        )
        if result.get("capture_complete"):
            require(
                isinstance(result.get("capture_sha256"), dict)
                and set(result["capture_sha256"]) == {"stdout", "stderr"},
                "native direct stream digests absent",
            )
            for name, expected in result["capture_sha256"].items():
                require(
                    hashlib.sha256(
                        read_regular(
                            capture / ("outer-" + name + ".log"),
                            STDOUT_BYTES if name == "stdout" else STDERR_BYTES,
                            allow_empty=True,
                        )
                    ).hexdigest()
                    == expected,
                    "native retained direct stream bytes changed",
                )
        return result
    return {
        "schema_version": 1,
        "invocation_id": invocation,
        "request_sha256": request_sha,
        "cgroup_empty": False,
        "unit_settled": False,
        "failure": "native settlement remains unknown",
        "authority": "none",
        "scope": "native-guest-lifetime-only",
    }


def settle(root, invocation, request_sha):
    global COMMAND_DEADLINE
    COMMAND_DEADLINE = time.monotonic() + 15
    attempt, _request = load_attempt(root, invocation, request_sha)
    prior = readback(root, invocation, request_sha)
    if prior.get("cgroup_empty") and prior.get("unit_settled"):
        return prior
    binding = read_marker(attempt / "capture/unit-binding.json", 16384)
    require(
        binding.get("invocation_id") == invocation and isinstance(binding.get("unit"), dict),
        "native original unit binding absent",
    )
    unit = binding["unit"]["name"]
    require(unit == f"portcove-native-{invocation}.service", "native exact unit name differs")
    properties = unit_properties(unit)
    inspect_unit_identity(properties, unit, binding["unit"]["invocation_id"])
    require(
        properties.get("ControlGroup") == binding["unit"]["control_group"]
        and properties.get("MainPID", "").isdigit()
        and int(properties["MainPID"]) > 0,
        "native live original unit cannot be held",
    )
    group = HeldCgroup(unit, int(properties["MainPID"]))
    try:
        systemctl("kill", unit, "--kill-whom=all", "--signal=SIGKILL")
        until = min(COMMAND_DEADLINE, time.monotonic() + 10)
        while not group.empty() and time.monotonic() < until:
            time.sleep(0.05)
        properties = unit_properties(unit)
        if properties.get("LoadState") != "not-found":
            inspect_unit_identity(properties, unit, binding["unit"]["invocation_id"])
        result = {
            **prior,
            "forced_termination": True,
            "cgroup_empty": group.empty(),
            "cgroup_settlement": group.last_observation,
            "unit_settled": settled_unit(properties),
        }
        create_file(attempt / "capture/outer-settlement.json", encode(result))
        return result
    finally:
        group.close()


def main(arguments):
    require(len(arguments) in (6, 8), "fixed native supervisor arguments required")
    expected = ["--mode", "--invocation", "--request-sha256"]
    require(arguments[::2][:3] == expected, "fixed native supervisor argument names differ")
    mode, invocation, request_sha = arguments[1], arguments[3], arguments[5]
    require(mode in ("run", "readback", "settle", "unit-entry"), "fixed native supervisor mode differs")
    require((mode == "unit-entry") == (len(arguments) == 8), "fixed native entry arguments differ")
    root = paths()
    if mode == "unit-entry":
        require(arguments[6] == "--nonce" and SHA.fullmatch(arguments[7]), "native readiness nonce absent")
        entry(root, invocation, request_sha, arguments[7])
        return 1
    require(len(arguments) == 6, "native lifecycle has extra arguments")
    result = {"run": supervise, "readback": readback, "settle": settle}[mode](root, invocation, request_sha)
    print(encode(result).decode("utf-8"), flush=True)
    return (
        0
        if result.get("capture_complete")
        and result.get("cgroup_empty")
        and result.get("unit_settled")
        and result.get("exit_code") == 0
        and not result.get("forced_termination")
        and not result.get("failure")
        and not result.get("cleanup_errors")
        else 1
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print("native guest supervisor refused; retain exact capture", file=sys.stderr)
        raise SystemExit(1) from None
