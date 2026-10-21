"""Fixed private PID1 services for an ordinary AppImage updater journey.

Only the trusted init calls this module. Candidate code receives neither the
setup capabilities nor control pipes. Source preparation is not host evidence.
"""

import contextlib
import hashlib
import importlib.util
import json
import os
import queue
import selectors
import stat
import threading
import time


def require(value, message):
    if not value:
        raise RuntimeError(message)


def read_fixed(filename, expected, maximum):
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum,
            "public setup file differs",
        )
        data = bytearray()
        while True:
            part = os.read(descriptor, min(65536, maximum + 1 - len(data)))
            if not part:
                break
            data.extend(part)
            require(len(data) <= maximum, "public setup file grew")
        after = os.fstat(descriptor)
        require(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "public setup file changed",
        )
        require(hashlib.sha256(data).hexdigest() == expected, "public setup source identity differs")
        return bytes(data)
    finally:
        os.close(descriptor)


def load_fixed(filename, expected):
    data = read_fixed(filename, expected, 1024 * 1024)
    spec = importlib.util.spec_from_loader("native_" + expected, loader=None)
    module = importlib.util.module_from_spec(spec)
    # Compile the bytes just inspected, never reopen a substitutable pathname.
    exec(compile(data, filename, "exec"), module.__dict__)
    return module


def close_except(keep):
    for name in os.listdir("/proc/self/fd"):
        if name.isdigit() and int(name) > 2 and int(name) not in keep:
            with contextlib.suppress(OSError):
                os.close(int(name))


class FixedDriverHttpWorker:
    """One fixed init-owned HTTP operation; the main loop keeps relaying TLS.

    The caller has already admitted the maintained Selenium request. A second
    request while one is unresolved refuses instead of creating a retry queue.
    Only the selector owner emits the result onto the original capture channel.
    """

    def __init__(self, selection, end, perform, respond):
        require(time.monotonic() < end, "original HTTP worker lifetime expired")
        self.selection, self.end = selection, end
        self.perform, self.respond = perform, respond
        self.reader, self.writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        self.results = queue.Queue(maxsize=1)
        self.thread, self.closed = None, False
        selection.register(self.reader, selectors.EVENT_READ, self.read_result)

    def submit(self, sequence, method, route, content):
        require(
            not self.closed and self.thread is None and time.monotonic() < self.end,
            "HTTP operation is unresolved or expired",
        )

        def execute():
            try:
                result = (self.perform(method, route, content), None)
            except BaseException as failure:
                result = (None, failure)
            self.results.put_nowait((sequence, result))
            # At most one unresolved result exists; the fixed one-byte wakeup
            # cannot accumulate a caller-controlled queue or response content.
            os.write(self.writer, b"\0")

        self.thread = threading.Thread(target=execute, daemon=True, name="fixed-native-driver-http")
        self.thread.start()

    def read_result(self, _mask):
        require(os.read(self.reader, 2) == b"\0", "HTTP result wakeup differs")
        sequence, (result, failure) = self.results.get_nowait()
        require(self.thread is not None, "HTTP result has no owned operation")
        self.thread.join(timeout=max(0, min(1, self.end - time.monotonic())))
        require(not self.thread.is_alive(), "HTTP result worker remains live")
        self.thread = None
        require(time.monotonic() < self.end, "HTTP result arrived after original lifetime")
        if failure is not None:
            self.closed = True
            raise failure
        self.respond(sequence, result)

    def close(self):
        self.closed = True
        if self.thread is not None:
            self.thread.join(timeout=max(0, min(5, self.end - time.monotonic())))
            require(not self.thread.is_alive(), "HTTP operation remains ambiguous at teardown")
            self.thread = None
        self.selection.unregister(self.reader)
        os.close(self.reader)
        os.close(self.writer)


class PublicNativeServices:
    def __init__(self, binding, selection, end, emit):
        require(
            os.getpid() == 1 and os.getuid() > 0 and end > time.monotonic(),
            "public setup requires original private PID1",
        )
        self.end, self.emit, self.selection = end, emit, selection
        self.pid, self.stop, self.events = None, None, None
        self.network, self.relay = None, None
        self.buffer, self.total = b"", 0
        self.mounts = {}
        self.settled, self.ready = False, False
        try:
            fuse = load_fixed("/native/fuse.py", binding["fuse_sha256"])
            network = load_fixed("/native/public-network.py", binding["network_sha256"])
            fuse_policy = fuse.inspect_policy(
                json.loads(read_fixed("/native/fuse.json", binding["fuse_policy_sha256"], 32768))
            )
            policy = network.inspect_policy(
                json.loads(read_fixed("/native/public-network.json", binding["network_policy_sha256"], 32768))
            )
            require(
                fuse_policy["uid"] == os.getuid() and fuse_policy["gid"] == os.getgid(), "public setup account differs"
            )
            require(
                fuse_policy["nonce"] == binding["invocation_id"] and policy["nonce"] == binding["nonce"],
                "public setup invocation differs",
            )
            require(fuse_policy["deadline_utc"] == binding["deadline_utc"], "public setup deadline differs")
            self.package_hashes = tuple(package["sha256"] for package in fuse_policy["packages"])
            caps, _ = network.capability_status()
            require(set(caps.values()) == {0x201400}, "public setup capability mask differs")
            devices = tuple(range(7, 15))
            events_read, events_write = os.pipe2(os.O_CLOEXEC)
            stop_read, stop_write = os.pipe2(os.O_CLOEXEC)
            self.events, self.stop = events_read, stop_write
            pid = os.fork()
            if pid == 0:
                try:
                    close_except(set(devices) | {events_write, stop_read})
                    fuse.retain_setup_capabilities(1 << 21)

                    def child_emit(value):
                        packet = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
                        require(len(packet) <= 4096, "FUSE event exceeds atomic private-pipe bound")
                        require(os.write(events_write, packet) == len(packet), "FUSE event capture incomplete")

                    broker = fuse.NativeFuseBroker(fuse_policy, devices, end, child_emit)
                    child_emit(
                        {"kind": "native-private-fuse", "stage": "ready", "pid": os.getpid(), "authority": "none"}
                    )
                    broker.run(stop_read)
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            self.pid = pid
            os.close(events_write)
            os.close(stop_read)
            for descriptor in devices:
                os.close(descriptor)
            os.set_blocking(events_read, False)
            selection.register(events_read, selectors.EVENT_READ, self.read_events)
            ready_end = min(end, time.monotonic() + 5)
            while not self.ready:
                require(time.monotonic() < ready_end, "FUSE broker startup did not settle")
                for key, mask in selection.select(min(0.05, ready_end - time.monotonic())):
                    require(callable(key.data), "public setup selector entry differs")
                    key.data(mask)
                self.check_child()
            # The privileged broker child alone keeps SYS_ADMIN. PID1 removes
            # it before the maintained network setup and drops all remaining
            # setup capabilities before any GUI or application process exists.
            fuse.retain_setup_capabilities(0x1400)
            listeners, proof = network.prepare_namespace_listeners(policy)
            self.network = network
            self.relay = network.PublicNetworkRelay(policy, selection, 5, 6, end, listeners)
            self.emit({"kind": "public-setup-ready", "capabilities": proof, "authority": "none"})
        except BaseException:
            self.close()
            raise

    def read_events(self, _mask, finished=False):
        part = os.read(self.events, 65536)
        if not part and finished:
            return False
        require(part, "FUSE broker capture ended before settlement")
        self.total += len(part)
        self.buffer += part
        require(self.total <= 1024 * 1024 and len(self.buffer) <= 65536, "FUSE broker capture exceeds bound")
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            value = json.loads(line)
            require(isinstance(value, dict) and value.get("kind") == "native-private-fuse", "FUSE broker event differs")
            if value.get("stage") == "ready":
                require(not self.ready and value.get("pid") == self.pid, "FUSE broker ready identity differs")
                self.ready = True
            if value.get("stage") == "settled":
                require(value.get("mounts_empty") is True, "FUSE broker settlement differs")
                self.settled = True
            if value.get("stage") == "mounted":
                target = value.get("mountpoint")
                require(
                    isinstance(target, str) and target not in self.mounts and len(self.mounts) < 2,
                    "FUSE mounted event identity differs",
                )
                self.mounts[target] = json.loads(json.dumps(value))
            if value.get("stage") == "unmounted":
                target = value.get("mountpoint")
                require(
                    target in self.mounts and self.mounts[target]["mount"] == value.get("mount"),
                    "FUSE unmounted event identity differs",
                )
                del self.mounts[target]
            self.emit(value)
        return True

    def check_child(self):
        if self.pid is not None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pid = None
                # waitpid can observe a successful exit immediately after the
                # previous nonblocking read saw EAGAIN. Drain the original
                # owned pipe before judging the actual settlement packet.
                while True:
                    try:
                        if not self.read_events(0, finished=True):
                            break
                    except BlockingIOError:
                        break
                require(
                    self.settled and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0,
                    "FUSE broker exited without positive settlement",
                )

    def tick(self):
        require(time.monotonic() < self.end, "original public setup lifetime expired")
        self.check_child()
        require(self.pid is not None, "FUSE broker unavailable before teardown")
        self.relay.tick()

    def close(self):
        completed = False
        try:
            if self.relay is not None:
                self.relay.close()
            if self.stop is not None:
                with contextlib.suppress(OSError):
                    os.write(self.stop, b"\0")
                os.close(self.stop)
                self.stop = None
            until = min(self.end, time.monotonic() + 5)
            while self.pid is not None and time.monotonic() < until:
                with contextlib.suppress(BlockingIOError):
                    self.read_events(0, finished=True)
                self.check_child()
                time.sleep(0.01)
            completed = self.pid is None
        finally:
            if self.stop is not None:
                os.close(self.stop)
                self.stop = None
            if self.pid is not None:
                os.kill(self.pid, 9)
                os.waitpid(self.pid, 0)
                self.pid = None
            if self.events is not None:
                with contextlib.suppress(KeyError):
                    self.selection.unregister(self.events)
                os.close(self.events)
                self.events = None
        # The caller retains whether normal broker settlement was observed;
        # process exit/kill is never promoted to mounts-empty or cgroup proof.
        return self.settled and completed
