#!/usr/bin/env python3
"""Fixed, rootless semantic-review boundary; never an issuer or authorizer.

Invoke with --request ABSOLUTE_JSON. The admitted parent owns request, tools,
frozen files and any separately provisioned dedicated ChatGPT auth cache. This
module neither discovers credentials nor provisions systemd/WSL. Missing user
bus, delegated controllers, namespace support or positive settlement refuses.
The internal entry is not a caller-selected command. Synthetic tests of these
functions do not qualify a real Linux host, Codex flags, login or inference.
"""

import array
import base64
import ctypes
import errno
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

MIB = 1024 * 1024
STORAGE_BYTES = 512 * MIB
MEMORY_BYTES = 1024 * MIB
AUTH_BYTES = 64 * 1024
STDOUT_BYTES = 16 * MIB
STDERR_BYTES = MIB
HOSTS = frozenset(("chatgpt.com", "auth.openai.com"))
TOOLS = {"python": "/usr/bin/python3", "bwrap": "/usr/bin/bwrap",
         "systemd_run": "/usr/bin/systemd-run", "systemctl": "/usr/bin/systemctl"}
RUNTIME = ("node", "codex", "release-semantic-reader-server.mts",
           "release-semantic-reader-core.mts", "runtime-values.mts")
INPUT_SMALL = ("manifest.json", "instructions.txt", "result-schema.json", "reader-launch.json")
SHA = re.compile(r"[a-f0-9]{64}\Z")


class Refusal(Exception):
    """Intentionally fixed diagnostics: never interpolate auth/HTTP/event data."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def decode_json(data):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite JSON")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Refusal("invalid bounded UTF8 JSON") from error


def read_regular(path, limit, owner=None):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
                "not a bounded single-link regular file")
        if owner is not None:
            require(before.st_uid == owner and before.st_mode & 0o077 == 0,
                    "dedicated private file ownership differs")
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            require(total <= limit, "file grew beyond bound")
            chunks.append(chunk)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "file changed during bounded read")
        return b"".join(chunks)
    finally:
        os.close(fd)


def private_directory(path):
    path = Path(path)
    require(path.is_absolute() and str(path) == str(path.absolute()), "absolute canonical path required")
    require(not str(path).startswith(("/mnt/", "/media/")), "Windows/removable mount is not reviewer storage")
    for part in (path, *path.parents):
        info = part.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "linked directory refused")
        require(info.st_uid in (0, os.getuid()) and info.st_mode & 0o022 == 0,
                "directory is writable by another principal")
    require(path.stat().st_uid == os.getuid(), "owned directory required")
    return path


def inspect_request(value):
    require(isinstance(value, dict) and set(value) == {
        "schema_version", "mode", "run_root", "runtime_sha256", "tools_sha256",
        "inputs_sha256", "timeout_seconds", "auth_cache"}, "fixed request fields required")
    require(value["schema_version"] == 1 and value["mode"] in ("fixture", "codex-fixture", "codex"),
            "fixed supervisor mode required")
    require(type(value["timeout_seconds"]) is int and 1 <= value["timeout_seconds"] <= 1200,
            "finite runtime deadline required")
    require(isinstance(value["run_root"], str) and value["run_root"].startswith("/") and
            ".." not in Path(value["run_root"]).parts, "absolute run root required")
    for key, names in (("tools_sha256", set(TOOLS)), ("runtime_sha256", set(RUNTIME))):
        hashes = value[key]
        require(isinstance(hashes, dict) and set(hashes) == names and
                all(isinstance(h, str) and SHA.fullmatch(h) for h in hashes.values()),
                "complete fixed tool hashes required")
    hashes = value["inputs_sha256"]
    require(isinstance(hashes, dict) and 5 <= len(hashes) <= 20005, "bounded complete input manifest required")
    require(set(INPUT_SMALL).union({"reader-index.json"}) <= set(hashes), "fixed reader inputs missing")
    for name, digest in hashes.items():
        require(name in INPUT_SMALL or name == "reader-index.json" or
                re.fullmatch(r"objects/[a-f0-9]{40}\.data", name), "noninert input path refused")
        require(isinstance(digest, str) and SHA.fullmatch(digest), "input hash required")
    auth = value["auth_cache"]
    require(auth is None or isinstance(auth, str) and auth.startswith("/") and
            Path(auth).name == "auth.json" and ".." not in Path(auth).parts,
            "dedicated auth.json path required")
    require(value["mode"] == "codex" or auth is None, "credential-free fixture required")
    require(value["mode"] != "codex" or auth is not None, "dedicated sign-in is not provisioned")
    return value


def inspect_auth(data):
    require(0 < len(data) <= AUTH_BYTES, "auth record outside finite bound")
    value = decode_json(data)
    require(isinstance(value, dict) and value.get("auth_mode") == "chatgpt" and
            value.get("OPENAI_API_KEY") is None and isinstance(value.get("tokens"), dict),
            "dedicated ChatGPT login required; API-key metering refused")
    tokens = value["tokens"]
    require(all(isinstance(tokens.get(key), str) and 0 < len(tokens[key]) <= 32768
                for key in ("id_token", "access_token", "refresh_token")), "incomplete ChatGPT session")
    return data


def create_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(data)
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def inspect_files(request):
    root = private_directory(request["run_root"])
    require(len(os.fsencode(root / "transport/control.sock")) < 104, "owned Unix socket path is too long")
    require(read_regular(root / ".portcove-semantic-review-owned", 128).strip(), "owned marker missing")
    for name in ("runtime", "inputs", "capture"):
        private_directory(root / name)
    require(set(os.listdir(root / "runtime")) == set(RUNTIME), "unmanifested runtime entry refused")
    require(not any((root / "capture" / name).exists() for name in
                    ("stdout.jsonl", "stderr.log", "isolation.json", "linux-intent.json")),
            "prior evidence exists; no implicit retry")
    observed = {}
    for name, digest in request["runtime_sha256"].items():
        if name in ("node", "codex"):
            require((root / "runtime" / name).stat().st_mode & 0o100, "fixed runtime is not executable")
        data = read_regular(root / "runtime" / name, 256 * MIB)
        require(hashlib.sha256(data).hexdigest() == digest, "fixed runtime hash differs")
        observed["runtime/" + name] = digest
    count, total, raw_total = 0, 0, 0
    for directory, directories, files in os.walk(root / "inputs", followlinks=False):
        count += len(files) + len(directories)
        require(count <= 20010, "input entry bound exceeded")
        for name in directories:
            info = (Path(directory) / name).lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "linked input directory")
        for name in files:
            file = Path(directory) / name
            relative = file.relative_to(root / "inputs").as_posix()
            require(relative in request["inputs_sha256"], "unmanifested input refused")
            limit = 288 * MIB if relative == "reader-index.json" else 16 * MIB
            if relative in ("instructions.txt", "result-schema.json"):
                limit = 64 * 1024
            if relative == "reader-launch.json":
                limit = 4096
            data = read_regular(file, limit)
            total += len(data)
            if relative.startswith("objects/"):
                raw_total += len(data)
            require(total <= 512 * MIB and raw_total <= 192 * MIB, "complete input byte bound exceeded")
            digest = hashlib.sha256(data).hexdigest()
            require(digest == request["inputs_sha256"][relative], "frozen input hash differs")
            observed["inputs/" + relative] = digest
    require({key.removeprefix("inputs/") for key in observed if key.startswith("inputs/")} ==
            set(request["inputs_sha256"]), "manifest input missing")
    launch = decode_json(read_regular(root / "inputs/reader-launch.json", 4096))
    require(isinstance(launch, dict) and set(launch) == {"schema_version", "index_sha256"} and
            launch["schema_version"] == 1 and launch["index_sha256"] ==
            request["inputs_sha256"]["reader-index.json"], "fixed reader launch hash differs")
    return root, observed


def verify_tools(request):
    require(sys.platform == "linux" and os.geteuid() != 0, "ordinary Linux user required")
    for name, path in TOOLS.items():
        actual = Path(path).resolve(strict=True)
        require(actual.stat().st_uid == 0 and actual.stat().st_mode & 0o022 == 0,
                "root-owned fixed system tool required")
        require(hashlib.sha256(read_regular(actual, 64 * MIB)).hexdigest() ==
                request["tools_sha256"][name], "qualified system tool hash differs")
    require(Path(sys.executable).resolve() == Path(TOOLS["python"]).resolve(), "fixed Python interpreter required")


def control_environment():
    # No inherited Python, Git, proxy, credential or caller executable search paths.
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(Path.home()),
            "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"}


def systemctl(*args):
    result = subprocess.run([TOOLS["systemctl"], "--user", "--no-pager", *args],
                            env=control_environment(), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
    require(len(result.stdout) <= 32768 and len(result.stderr) <= 4096, "systemd response exceeded bound")
    return result.returncode, result.stdout


def unit_properties(unit):
    code, data = systemctl("show", unit, "--property=LoadState,ActiveState,SubState,ControlGroup,MainPID,MemoryMax,MemorySwapMax,TasksMax,Result")
    require(code == 0, "cannot read exact owned unit")
    result = {}
    for line in data.decode("ascii").splitlines():
        key, _, value = line.partition("=")
        require(key not in result, "duplicate systemd property")
        result[key] = value
    return result


def bwrap_command(request, root, supervisor):
    command = [TOOLS["bwrap"], "--die-with-parent", "--new-session", "--unshare-user",
               "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
               "--unshare-cgroup", "--disable-userns", "--cap-drop", "ALL", "--clearenv",
               "--ro-bind", "/usr", "/usr", "--tmpfs", "/usr/local", "--remount-ro", "/usr/local"]
    for directory in ("/lib", "/lib64"):
        if Path(directory).exists():
            command += ["--ro-bind", directory, directory]
    command += ["--dir", "/etc/ssl/certs", "--ro-bind",
                "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-certificates.crt",
                "--proc", "/proc", "--remount-ro", "/proc", "--tmpfs", "/dev"]
    for device in ("null", "zero", "urandom"):
        command += ["--dev-bind", "/dev/" + device, "/dev/" + device]
    command += ["--dir", "/dev/shm", "--remount-ro", "/dev",
                "--size", str(STORAGE_BYTES), "--perms", "0700", "--tmpfs", "/w",
                "--ro-bind", str(root / "runtime"), "/runtime", "--ro-bind", str(root / "inputs"), "/inputs",
                "--ro-bind", str(root / "transport"), "/transport", "--ro-bind", str(supervisor), "/supervisor.py",
                "--symlink", "/w/home", "/home", "--symlink", "/w/tmp", "/tmp",
                "--symlink", "/w/run", "/run", "--dir", "/var", "--symlink", "/w/tmp", "/var/tmp",
                "--remount-ro", "/", "--chdir", "/w", "--setenv", "HOME", "/w/home",
                "--setenv", "CODEX_HOME", "/w/home/.codex", "--setenv", "TMPDIR", "/w/tmp",
                "--setenv", "XDG_CACHE_HOME", "/w/home/.cache", "--setenv", "XDG_CONFIG_HOME", "/w/home/.config",
                "--setenv", "XDG_DATA_HOME", "/w/home/.local/share", "--setenv", "XDG_RUNTIME_DIR", "/w/run",
                "--setenv", "PATH", "/runtime:/usr/bin", "--setenv", "LANG", "C.UTF-8",
                "--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
                "--setenv", "HTTPS_PROXY", "http://127.0.0.1:37861", "--setenv", "HTTP_PROXY", "http://127.0.0.1:37861",
                "--setenv", "ALL_PROXY", "http://127.0.0.1:37861", "--setenv", "NO_PROXY", "",
                "--", "/usr/bin/python3", "-I", "-S", "-B", "/supervisor.py", "--inside", request["mode"]]
    return command


def unit_command(request, root, unit, supervisor):
    return [TOOLS["systemd_run"], "--user", "--quiet", "--pipe", "--wait", "--service-type=exec",
            "--unit=" + unit, "--property=MemoryMax=" + str(MEMORY_BYTES), "--property=MemorySwapMax=0",
            "--property=TasksMax=64", "--property=KillMode=control-group", "--property=TimeoutStopSec=5s",
            "--property=RuntimeMaxSec=" + str(request["timeout_seconds"]), "--property=NoNewPrivileges=yes",
            "--property=UMask=0077", "--property=RestrictSUIDSGID=yes", "--", *bwrap_command(request, root, supervisor)]


def connect_target(header):
    require(len(header) <= 4096 and header.endswith(b"\r\n\r\n"), "bounded CONNECT header required")
    try:
        lines = header.decode("ascii").split("\r\n")
    except UnicodeError as error:
        raise Refusal("ASCII CONNECT required") from error
    match = re.fullmatch(r"CONNECT ([a-z.]+):443 HTTP/1\.[01]", lines[0])
    require(match is not None and match[1] in HOSTS, "provider host is not allowlisted")
    require(all(line and ":" in line and not line[0].isspace() for line in lines[1:-2]),
            "folded or malformed proxy header refused")
    return match[1]


def forward(left, right, stopped, account):
    selector = selectors.DefaultSelector()
    try:
        for current, other in ((left, right), (right, left)):
            current.settimeout(5)
            selector.register(current, selectors.EVENT_READ, other)
        while not stopped.is_set():
            ready = selector.select(1)
            if not ready:
                continue
            for event, _ in ready:
                data = event.fileobj.recv(65536)
                if not data:
                    return
                account(len(data))
                event.data.sendall(data)
    finally:
        selector.close()


class ProviderTunnel:
    """Credentialless parent-side CONNECT only. No model/auth body inspection."""
    def __init__(self, path):
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(path))
        os.chmod(path, 0o600)
        self.listener.listen(4)
        self.listener.settimeout(0.2)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.sockets = set()
        self.workers = []
        self.connections = 0
        self.bytes = 0
        self.failure = False
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def account(self, count):
        with self.lock:
            self.bytes += count
            require(self.bytes <= 128 * MIB, "provider tunnel byte bound exceeded")

    def accept(self):
        while not self.stop.is_set():
            try:
                peer, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self.lock:
                self.connections += 1
                active = len(self.sockets)
                if self.connections > 128 or active >= 8:
                    peer.close()
                    self.failure = True
                    continue
                self.sockets.add(peer)
            worker = threading.Thread(target=self.handle, args=(peer,), daemon=True)
            self.workers.append(worker)
            worker.start()

    def handle(self, peer):
        remote = None
        try:
            peer.settimeout(5)
            header = bytearray()
            while not header.endswith(b"\r\n\r\n"):
                require(len(header) < 4096, "CONNECT header exceeded bound")
                data = peer.recv(1)
                require(data, "CONNECT ended prematurely")
                header.extend(data)
            host = connect_target(bytes(header))
            # Refuse private/reserved resolver results; use the exact observed
            # numeric address, preserving the TLS client's original hostname.
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            require(0 < len(addresses) <= 16 and
                    all(ipaddress.ip_address(item[4][0]).is_global for item in addresses),
                    "provider DNS observation refused")
            family, kind, protocol, _, address = addresses[0]
            remote = socket.socket(family, kind, protocol)
            with self.lock:
                self.sockets.add(remote)
            remote.settimeout(10)
            remote.connect(address)
            peer.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            forward(peer, remote, self.stop, self.account)
        except Exception:
            # Do not retain URLs, headers, TLS bytes or tokens in diagnostics.
            self.failure = True
        finally:
            with self.lock:
                for current in (peer, remote):
                    if current is not None:
                        self.sockets.discard(current)
                        current.close()

    def close(self):
        self.stop.set()
        self.listener.close()
        with self.lock:
            for current in self.sockets:
                try:
                    current.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                current.close()
        self.thread.join(2)
        deadline = time.monotonic() + 10
        for worker in self.workers:
            worker.join(max(0, deadline - time.monotonic()))
        return not self.thread.is_alive() and all(not worker.is_alive() for worker in self.workers)


class HeldCgroup:
    def __init__(self, unit, peer_pid):
        properties = unit_properties(unit)
        inspect_unit_properties(properties)
        group = properties.get("ControlGroup", "")
        require(group.startswith("/user.slice/") and ".." not in group.split("/") and
                group.endswith("/" + unit), "exact owned user cgroup required")
        self.path = Path("/sys/fs/cgroup") / group.lstrip("/")
        # Pin this exact kernel object, not just a potentially reused pathname.
        self.directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.files = {}
        self.identity = None
        self.last_observation = None
        try:
            info = os.fstat(self.directory)
            require(stat.S_ISDIR(info.st_mode) and filesystem_kind(self.directory) == 0x63677270,
                    "held directory is not cgroup v2")
            self.identity = (info.st_dev, info.st_ino)
            require(os.readlink(f"/proc/self/fd/{self.directory}") == str(self.path),
                    "initial held cgroup path differs")
            for name in ("cgroup.events", "cgroup.procs", "memory.max", "memory.swap.max", "pids.max"):
                self.files[name] = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.directory)
            require(self.read("memory.max").strip() == str(MEMORY_BYTES) and
                    self.read("memory.swap.max").strip() == "0" and self.read("pids.max").strip() == "64",
                    "actual cgroup resource limits differ")
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
            require((info.st_dev, info.st_ino) == self.identity and stat.S_ISDIR(info.st_mode) and
                    filesystem_kind(self.directory) == 0x63677270,
                    "held cgroup identity changed")
            # cgroup2's kernfs syscall table has no rename operation. The exact
            # old path plus d_path's '(deleted)' annotation therefore identifies
            # successful removal of this held object, not a similarly named new
            # object. cgroup_destroy_locked() permits removal only after no live
            # tasks/children and disables new migration before kernfs removal.
            # nlink is deliberately NOT used: kernfs getattr reports subdirs+2.
            # Sources: kernel/cgroup/cgroup.c cgroup_destroy_locked/cgroup_kf_syscall_ops;
            # fs/d_path.c d_path; fs/kernfs/inode.c kernfs_refresh_inode (Linux v6.6).
            require(os.readlink(f"/proc/self/fd/{self.directory}") == str(self.path) + " (deleted)",
                    "exact held cgroup removal is unproven")
            self.last_observation = "removed-exact-held-cgroup"
            return True

    def close(self):
        for fd in self.files.values():
            os.close(fd)
        self.files = {}
        os.close(self.directory)


def recv_control(peer, maximum=4096):
    data, ancillary, flags, _ = peer.recvmsg(maximum + 1, socket.CMSG_SPACE(8 * array.array("i").itemsize),
                                            getattr(socket, "MSG_CMSG_CLOEXEC", 0))
    descriptors = []
    for level, kind, content in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            values = array.array("i")
            values.frombytes(content[:len(content) - len(content) % values.itemsize])
            descriptors.extend(values)
    try:
        for fd in descriptors:
            os.set_inheritable(fd, False)
        require(data and len(data) <= maximum and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC),
                "control packet truncated or exceeded bound")
        require(len(descriptors) <= 1, "extra auth descriptor refused")
        return decode_json(data), descriptors
    except BaseException:
        for fd in descriptors:
            os.close(fd)
        raise


def filesystem_kind(fd):
    class StatFS(ctypes.Structure):
        _fields_ = [("kind", ctypes.c_long), ("rest", ctypes.c_byte * 248)]
    filesystem = StatFS()
    require(ctypes.CDLL(None, use_errno=True).fstatfs(fd, ctypes.byref(filesystem)) == 0,
            "held filesystem identity is unavailable")
    return filesystem.kind


def receive_auth_descriptor(fd):
    import fcntl
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= AUTH_BYTES,
            "auth handoff is not a bounded regular file")
    require(info.st_uid == os.getuid() and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY,
            "auth handoff must be owned and read-only")
    require(filesystem_kind(fd) == 0x01021994, "auth handoff is outside the bounded tmpfs")
    data = os.pread(fd, AUTH_BYTES + 1, 0)
    after = os.fstat(fd)
    require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "auth descriptor changed after settlement")
    return inspect_auth(data)


def persist_auth(path, data, original):
    path = Path(path)
    parent = private_directory(path.parent)
    require(read_regular(path, AUTH_BYTES, os.getuid()) == original, "dedicated auth cache changed concurrently")
    temporary = parent / (".auth-refresh-" + uuid.uuid4().hex)
    create_file(temporary, inspect_auth(data))
    # The supervisor holds the dedicated lock for this whole invocation. The
    # same-owner dedicated sign-in operation must use that lock as well.
    os.replace(temporary, path)
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def inspect_unit_properties(properties):
    require(properties.get("LoadState") == "loaded" and properties.get("ActiveState") == "active" and
            properties.get("MemoryMax") == str(MEMORY_BYTES) and
            properties.get("MemorySwapMax") == "0" and properties.get("TasksMax") == "64",
            "unit resource controller properties differ")


def capture_piece(output, totals, name, data):
    limit = STDOUT_BYTES if name == "stdout" else STDERR_BYTES
    remaining = limit - totals[name]
    output.write(data[:remaining])
    totals[name] += len(data)
    require(totals[name] <= limit, "direct event capture exceeded bound")


def auth_refresh_allowed(result, descriptors):
    return (result["failure"] is None and result["capture_complete"] and result["cgroup_empty"] and
            result["unit_settled"] and result["network_settled"] and not result["network_refused"] and
            not result["forced_termination"] and not result["cleanup_errors"] and len(descriptors) == 1)


def needs_unit_kill(group):
    # No wrapper process argument: an exited local wrapper cannot exempt live
    # tasks in its actual service cgroup from forced cleanup.
    try:
        return group is None or not group.empty()
    except Exception:
        return True


def drain_capture(process, outputs, deadline, on_tick):
    selector = selectors.DefaultSelector()
    totals = {"stdout": 0, "stderr": 0}
    complete = False
    try:
        for name in totals:
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            require(time.monotonic() < deadline, "reviewer deadline exceeded")
            on_tick()
            for event, _ in selector.select(0.1):
                data = os.read(event.fd, 65536)
                if not data:
                    selector.unregister(event.fileobj)
                    continue
                name = event.data
                capture_piece(outputs[name], totals, name, data)
        # A seqpacket completion is queued before the entry exits/closes its
        # pipes. Poll once more after EOF instead of depending on pipe readiness
        # to trigger the final control read.
        on_tick()
        process.wait(timeout=max(0.01, deadline - time.monotonic()))
        complete = True
    finally:
        selector.close()
        for output in outputs.values():
            output.flush()
            os.fsync(output.fileno())
    return complete, totals


def namespace_identity(pid="self"):
    return {name: os.readlink(f"/proc/{pid}/ns/{name}") for name in
            ("user", "pid", "net", "mnt", "ipc", "uts", "cgroup")}


def inspect_mounts(text):
    writable, work = [], False
    for line in text.splitlines():
        fields = line.split()
        separator = fields.index("-")
        target, options, kind = fields[4], fields[5].split(","), fields[separator + 1]
        if "rw" in options:
            writable.append(target)
            require(target == "/w" or target in ("/dev/null", "/dev/zero", "/dev/urandom"),
                    "alternate writable mount refused")
        if target == "/w":
            require(kind == "tmpfs" and "rw" in options, "one writable tmpfs required")
            super_options = fields[separator + 3].split(",")
            require("size=524288k" in super_options or "size=536870912" in super_options,
                    "tmpfs hard size differs")
            work = True
    require(work and "/w" in writable, "bounded writable storage absent")
    return sorted(writable)


def codex_arguments(index_hash, mode):
    command = ["/runtime/codex", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
               "--sandbox", "read-only", "--skip-git-repo-check", "--json", "--model", "gpt-6.1-sol",
               "--config", 'model_reasoning_effort="high"', "--cd", "/w/work"]
    disabled = ("shell_tool", "view_image", "browser_use", "browser_use_external", "in_app_browser",
                "code_mode_host", "multi_agent", "multi_agent_v2", "unified_exec", "skill_search",
                "skill_mcp_dependency_install", "remote_plugin", "unbounded_connection_retries", "apps", "plugins")
    for name in disabled:
        command += ["--config", "features." + name + "=false"]
    command += ["--config", 'web_search="disabled"', "--config", "project_doc_max_bytes=0",
                "--config", 'cli_auth_credentials_store="file"', "--config",
                'mcp_servers.portcove_frozen_bundle.command="/runtime/node"', "--config",
                "mcp_servers.portcove_frozen_bundle.args=" + json.dumps([
                    "--preserve-symlinks", "--preserve-symlinks-main", "/runtime/release-semantic-reader-server.mts",
                    "/inputs/reader-index.json", index_hash]), "--config",
                'mcp_servers.portcove_frozen_bundle.enabled_tools=["list","read","read_text","net_diff","search"]', "--config",
                "mcp_servers.portcove_frozen_bundle.startup_timeout_sec=15", "--config",
                "mcp_servers.portcove_frozen_bundle.tool_timeout_sec=30"]
    if mode == "codex":
        command += ["--output-schema", "/inputs/result-schema.json"]
    return command + ["-"]


class InsideRelay:
    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 37861))
        self.listener.listen(4)
        self.listener.settimeout(0.2)
        self.stop = threading.Event()
        self.sockets = set()
        self.workers = []
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stop.is_set():
            try:
                peer, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if len(self.sockets) >= 8:
                peer.close()
                continue
            self.sockets.add(peer)
            worker = threading.Thread(target=self.handle, args=(peer,), daemon=True)
            self.workers.append(worker)
            worker.start()

    def handle(self, peer):
        remote = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sockets.add(remote)
        try:
            remote.settimeout(5)
            remote.connect("/transport/provider.sock")
            forward(peer, remote, self.stop, lambda _: None)
        except Exception:
            pass
        finally:
            for current in (peer, remote):
                self.sockets.discard(current)
                current.close()

    def close(self):
        self.stop.set()
        self.listener.close()
        for current in list(self.sockets):
            try:
                current.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            current.close()
        self.thread.join(2)
        for worker in self.workers:
            worker.join(2)
        require(not self.thread.is_alive() and all(not worker.is_alive() for worker in self.workers),
                "inside tunnel did not settle")


def inside(mode):
    require(mode in ("fixture", "codex-fixture", "codex"), "fixed entry mode required")
    require(os.getcwd() == "/w" and os.environ.get("CODEX_HOME") == "/w/home/.codex",
            "fixed private entry environment differs")
    writable = inspect_mounts(read_regular("/proc/self/mountinfo", MIB).decode("ascii"))
    for name in ("home", "home/.codex", "home/.cache", "home/.config", "home/.local/share", "work", "tmp", "run"):
        Path("/w", name).mkdir(mode=0o700, parents=True, exist_ok=True)
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    peer.settimeout(30)
    peer.connect("/transport/control.sock")
    peer.send(json.dumps({"type": "ready", "namespaces": namespace_identity(), "writable_mounts": writable}).encode())
    start, descriptors = recv_control(peer, AUTH_BYTES * 2)
    for fd in descriptors:
        os.close(fd)
    require(not descriptors and isinstance(start, dict) and set(start) == {"type", "auth"} and
            start["type"] == "start", "trusted parent start handshake missing")
    if mode == "codex":
        require(isinstance(start["auth"], str), "dedicated session seed missing")
        try:
            seed = base64.b64decode(start["auth"], validate=True)
        except ValueError as error:
            raise Refusal("invalid bounded session seed") from error
        create_file("/w/home/.codex/auth.json", inspect_auth(seed))
    else:
        require(start["auth"] is None, "fixture must remain credential free")
    relay = InsideRelay()
    code, descriptor = 1, None
    try:
        if mode == "fixture":
            # Deliberately not a semantic-review transcript or inference result.
            for path in ("/", "/dev/shm", "/runtime", "/inputs", "/usr/local"):
                try:
                    create_file(Path(path) / ".portcove-write-probe", b"inert")
                except OSError:
                    continue
                raise Refusal("read-only path unexpectedly writable")
            create_file("/w/tmp/inert", b"inert")
            require(os.statvfs("/w").f_blocks * os.statvfs("/w").f_frsize == STORAGE_BYTES,
                    "actual tmpfs capacity differs")
            print(json.dumps({"scope": "inert-linux-boundary-fixture", "storage_bytes": STORAGE_BYTES,
                              "writable_mounts": writable, "namespaces": namespace_identity()}), flush=True)
            code = 0
        else:
            version = subprocess.run(["/runtime/codex", "--version"], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
            require(version.returncode == 0 and version.stdout.strip() == b"codex-cli 0.162.0" and
                    len(version.stderr) <= 4096, "pinned CLI version differs")
            launch = decode_json(read_regular("/inputs/reader-launch.json", 4096))
            require(isinstance(launch, dict) and SHA.fullmatch(launch.get("index_sha256", "")),
                    "fixed reader hash missing")
            prompt = read_regular("/inputs/instructions.txt", MIB) if mode == "codex" else (
                b"This is an inert credential-free startup fixture, not a review. Do not use shell, files, "
                b"network or other tools. Reply exactly with the JSON object {\"fixture\":\"inert\"}.")
            result = subprocess.run(codex_arguments(launch["index_sha256"], mode), input=prompt, check=False)
            code = result.returncode
            if mode == "codex" and code == 0:
                descriptor = os.open("/w/home/.codex/auth.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                info = os.fstat(descriptor)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= AUTH_BYTES,
                        "session refresh descriptor refused")
        packet = json.dumps({"type": "done", "exit_code": code, "auth_descriptor": descriptor is not None}).encode()
        rights = [] if descriptor is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [descriptor]))]
        peer.sendmsg([packet], rights)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        relay.close()
        peer.close()
    return code


def supervise(request):
    import fcntl
    verify_tools(request)
    root, observed = inspect_files(request)
    lock_fd = os.open(root / ".linux-supervisor.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    auth_lock = None
    auth_seed = None
    process = peer = listener = tunnel = group = None
    auth_descriptors = []
    outputs = {}
    unit = "portcove-semantic-" + uuid.uuid4().hex + ".service"
    result = {"schema_version": 1, "mode": request["mode"], "unit": unit,
              "scope": "held-linux-semantic-runtime-preparation", "authority": "none",
              "storage_bytes": STORAGE_BYTES, "memory_bytes": MEMORY_BYTES, "swap_bytes": 0, "tasks_max": 64,
              "cgroup_verified": False, "namespaces_verified": False, "capture_complete": False,
              "cgroup_empty": False, "unit_settled": False, "network_settled": False,
              "cgroup_settlement": None,
              "network_refused": False,
              "forced_termination": False, "auth_refreshed": False, "exit_code": None,
              "failure": None, "cleanup_errors": []}
    try:
        require(Path("/sys/fs/cgroup/cgroup.controllers").is_file(), "cgroup v2 is unavailable")
        bus = Path(f"/run/user/{os.getuid()}/bus")
        require(bus.is_socket() and bus.stat().st_uid == os.getuid(), "systemd user bus unavailable")
        code, state = systemctl("show", "default.target", "--property=LoadState", "--value")
        require(code == 0 and state.strip() == b"loaded", "systemd user manager is unavailable")
        if request["auth_cache"]:
            auth_parent = private_directory(Path(request["auth_cache"]).parent)
            auth_lock = os.open(auth_parent / ".portcove-reviewer-auth.lock",
                                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fcntl.flock(auth_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Do not read credentials until the actual cgroup/namespace handshake.
        create_file(root / "capture/linux-intent.json", json.dumps({"schema_version": 1, "unit": unit,
                    "mode": request["mode"], "supervisor_sha256": hashlib.sha256(
                        read_regular(Path(__file__).resolve(), 256 * 1024)).hexdigest()}).encode())
        (root / "transport").mkdir(mode=0o700)
        tunnel = ProviderTunnel(root / "transport/provider.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        listener.bind(str(root / "transport/control.sock"))
        os.chmod(root / "transport/control.sock", 0o600)
        listener.listen(1)
        listener.setblocking(False)
        for name, filename in (("stdout", "stdout.jsonl"), ("stderr", "stderr.log")):
            fd = os.open(root / "capture" / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            outputs[name] = os.fdopen(fd, "wb")
        process = subprocess.Popen(unit_command(request, root, unit, Path(__file__).resolve()),
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=control_environment(), start_new_session=True, close_fds=True)
        deadline = time.monotonic() + request["timeout_seconds"]
        stage = "ready"

        def tick():
            nonlocal peer, group, auth_seed, stage
            if peer is None:
                try:
                    peer, _ = listener.accept()
                except BlockingIOError:
                    return
                peer.setblocking(False)
                listener.close()
            try:
                packet, descriptors = recv_control(peer)
            except BlockingIOError:
                return
            auth_descriptors.extend(descriptors)
            require(isinstance(packet, dict), "fixed entry packet required")
            if stage == "ready":
                require(set(packet) == {"type", "namespaces", "writable_mounts"} and
                        packet["type"] == "ready" and not descriptors, "fixed entry readiness differs")
                pid, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                require(uid == os.getuid() and pid > 1, "entry peer identity differs")
                actual = namespace_identity(pid)
                require(packet["namespaces"] == actual and all(value != namespace_identity()[name]
                        for name, value in actual.items()), "actual private namespaces differ")
                mount_bytes = read_regular(f"/proc/{pid}/mountinfo", MIB)
                require(inspect_mounts(mount_bytes.decode("ascii")) == packet["writable_mounts"],
                        "actual writable mount inventory differs")
                group = HeldCgroup(unit, pid)
                result["cgroup_verified"] = True
                result["namespaces_verified"] = True
                if request["auth_cache"]:
                    auth_seed = inspect_auth(read_regular(request["auth_cache"], AUTH_BYTES, os.getuid()))
                peer.send(json.dumps({"type": "start", "auth": None if auth_seed is None else
                                      base64.b64encode(auth_seed).decode("ascii")}).encode())
                stage = "done"
            else:
                require(stage == "done" and set(packet) == {"type", "exit_code", "auth_descriptor"} and
                        packet["type"] == "done" and type(packet["exit_code"]) is int and
                        packet["auth_descriptor"] is (len(descriptors) == 1) and
                        (not descriptors or request["mode"] == "codex" and packet["exit_code"] == 0),
                        "fixed entry completion differs")
                result["exit_code"] = packet["exit_code"]
                stage = "complete"
                peer.close()
                peer = None

        result["capture_complete"], totals = drain_capture(process, outputs, deadline,
                                                         lambda: tick() if stage != "complete" else None)
        result["capture_bytes"] = totals
        require(stage == "complete" and process.returncode == 0 and result["exit_code"] == 0,
                "fixed reviewer did not complete successfully")
    except Exception as error:
        result["failure"] = str(error) if isinstance(error, Refusal) else "supervisor operation refused"
        if process is not None and process.poll() is None:
            result["forced_termination"] = True
    finally:
        if process is not None:
            # The wrapper can terminate before a surviving service descendant.
            # Kill based on the actual owned cgroup, not wrapper liveness alone.
            if needs_unit_kill(group):
                result["forced_termination"] = True
                try:
                    systemctl("kill", unit, "--kill-whom=all", "--signal=SIGKILL")
                except Exception:
                    result["cleanup_errors"].append("owned unit kill could not be confirmed")
            if process.poll() is None:
                result["forced_termination"] = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    result["cleanup_errors"].append("owned supervisor process group did not settle")
            try:
                if group is not None:
                    until = time.monotonic() + 10
                    while not group.empty() and time.monotonic() < until:
                        time.sleep(0.05)
                    result["cgroup_empty"] = group.empty()
                    result["cgroup_settlement"] = group.last_observation
                properties = unit_properties(unit)
                result["unit_settled"] = (properties.get("LoadState") == "not-found" or
                    properties.get("ActiveState") in ("inactive", "failed") and properties.get("MainPID") == "0")
            except Exception:
                result["cleanup_errors"].append("positive cgroup/unit settlement unavailable")
        if peer is not None:
            peer.close()
        if listener is not None:
            listener.close()
        if tunnel is not None:
            result["network_settled"] = tunnel.close()
            result["network_refused"] = tunnel.failure
        for output in outputs.values():
            output.close()
        try:
            # Verify immutable custody again before accepting direct capture or
            # persisting a refresh. No imported event file can substitute.
            for name, digest in observed.items():
                require(hashlib.sha256(read_regular(root / name, 288 * MIB)).hexdigest() == digest,
                        "frozen runtime/input changed during attempt")
            if request["mode"] == "codex" and result["failure"] is None:
                require(auth_refresh_allowed(result, auth_descriptors),
                        "credential refresh requires positive complete settlement")
                refreshed = receive_auth_descriptor(auth_descriptors[0])
                persist_auth(request["auth_cache"], refreshed, auth_seed)
                result["auth_refreshed"] = True
        except Exception as error:
            result["failure"] = str(error) if isinstance(error, Refusal) else "post-settlement custody refused"
        for fd in auth_descriptors:
            os.close(fd)
        if group is not None:
            group.close()
        if auth_lock is not None:
            os.close(auth_lock)
        create_file(root / "capture/isolation.json", json.dumps(result, separators=(",", ":")).encode())
        os.close(lock_fd)
    require(result["failure"] is None and result["capture_complete"] and result["cgroup_empty"] and
            result["unit_settled"] and result["network_settled"] and not result["network_refused"] and not result["forced_termination"] and
            not result["cleanup_errors"], "Linux boundary refused; retain owned capture and intent")
    return result


def main(argv):
    if len(argv) == 2 and argv[0] == "--inside":
        return inside(argv[1])
    require(len(argv) == 2 and argv[0] == "--request" and Path(argv[1]).is_absolute(),
            "usage: semantic-review-linux-supervisor.py --request ABSOLUTE_JSON")
    request = inspect_request(decode_json(read_regular(argv[1], MIB)))
    def interrupted(_number, _frame):
        raise Refusal("parent cancellation; owned unit requires settlement")
    prior = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGINT)}
    try:
        supervise(request)
    finally:
        for number, handler in prior.items():
            signal.signal(number, handler)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refusal as refusal:
        print(str(refusal), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Linux boundary refused; retain original owned evidence", file=sys.stderr)
        sys.exit(1)
