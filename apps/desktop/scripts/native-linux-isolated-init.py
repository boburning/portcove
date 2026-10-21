#!/usr/bin/env python3
"""Fixed candidate-namespace init, not a host controller or native issuer.

The outer fixed guest controller owns the private FDs, read-only binding and
positive cgroup settlement. No command or environment is accepted from a
candidate. Pure inspection tests do not establish a functioning Linux host.
"""

import base64
import ctypes
import datetime
import hashlib
import http.client
import json
import os
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

MIB = 1024 * 1024
REQUEST_LIMIT = 2 * MIB
RESPONSE_LIMIT = 16 * MIB
SHA = re.compile(r"[a-f0-9]{64}\Z")
ORIGINAL_START = time.monotonic()


class RuntimeNotReady(RuntimeError):
    """A normal restart may temporarily have zero or two owned app images."""


def require(value, message):
    if not value:
        raise RuntimeError(message)


def decode(data):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "duplicate private driver key")
            result[key] = value
        return result

    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=pairs,
        parse_constant=lambda _: require(False, "nonfinite private driver data"),
    )


def body(value, maximum):
    require(isinstance(value, str) and len(value) <= 4 * ((maximum + 2) // 3), "private driver body exceeds bound")
    data = base64.b64decode(value, validate=True)
    require(len(data) <= maximum and base64.b64encode(data).decode("ascii") == value, "private driver base64 differs")
    return data


def inspect_request(raw):
    require(
        isinstance(raw, dict) and set(raw) == {"method", "path", "body_base64"}, "private driver request fields differ"
    )
    require(
        raw["method"] in ("GET", "POST", "DELETE")
        and isinstance(raw["path"], str)
        and len(raw["path"]) <= 2048
        and re.fullmatch(r"/(?:status|native-runtime|native-public-runtime|session(?:/[A-Za-z0-9._-]+)*)", raw["path"])
        and not any(part in (".", "..") for part in raw["path"].split("/")),
        "private driver route differs",
    )
    data = body(raw["body_base64"], REQUEST_LIMIT)
    require(raw["method"] == "POST" or not data, "private driver read/delete body refused")
    require(
        raw["path"] not in ("/native-runtime", "/native-public-runtime") or (raw["method"] == "GET" and not data),
        "native runtime observation is read-only",
    )
    return raw["method"], raw["path"], data


def inspect_binding(raw):
    public = isinstance(raw, dict) and raw.get("schema_version") == 2
    require(
        isinstance(raw, dict)
        and set(raw)
        == {
            "schema_version",
            "nonce",
            "qualification_uid",
            "qualification_gid",
            "port",
            "application_original",
            "application_sha256",
            "home",
            "environment",
            "tools",
            "timeout_seconds",
        }
        | ({"public"} if public else set()),
        "private native binding fields differ",
    )
    require(
        raw["schema_version"] in (1, 2)
        and isinstance(raw["nonce"], str)
        and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", raw["nonce"]),
        "private native nonce differs",
    )
    for key in ("qualification_uid", "qualification_gid"):
        require(type(raw[key]) is int and 1 <= raw[key] <= 4294967294, "ordinary native identity required")
    require(type(raw["port"]) is int and 1024 <= raw["port"] <= 65533, "private native port differs")
    require(
        type(raw["timeout_seconds"]) is int and 1 <= raw["timeout_seconds"] <= 1750, "original native deadline differs"
    )
    for key in ("application_original", "home"):
        require(
            isinstance(raw[key], str)
            and len(raw[key]) <= 2048
            and raw[key].startswith("/home/")
            and all(32 <= ord(value) < 127 for value in raw[key])
            and str(PurePosixPath(raw[key])) == raw[key]
            and ".." not in PurePosixPath(raw[key]).parts,
            "fixed guest path differs",
        )
    require(SHA.fullmatch(raw["application_sha256"]), "private application hash differs")
    expected = {
        "python": "/usr/bin/python3",
        "driver": "/native/runtime/tauri-driver",
        "webkit_driver": "/usr/bin/WebKitWebDriver",
        "xvfb": "/usr/bin/Xvfb",
    }
    require(isinstance(raw["tools"], dict) and set(raw["tools"]) == set(expected), "fixed native tool set differs")
    for name, filename in expected.items():
        value = raw["tools"][name]
        require(
            isinstance(value, dict)
            and set(value) == {"path", "sha256"}
            and value["path"] == filename
            and isinstance(value["sha256"], str)
            and SHA.fullmatch(value["sha256"]),
            "fixed native tool differs",
        )
    allowed = {
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "PORTCOVE_LIBRARY",
        "PORTCOVE_PREFERENCES",
        "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
        "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
        "PORTCOVE_APPLICATION_UPDATE_STAGING",
    }
    require(
        isinstance(raw["environment"], dict) and set(raw["environment"]) <= allowed,
        "private native environment differs",
    )
    for value in raw["environment"].values():
        require(
            isinstance(value, str)
            and value.startswith(raw["home"] + "/")
            and ".." not in PurePosixPath(value).parts
            and str(PurePosixPath(value)) == value
            and len(value) <= 2048,
            "private native data path escapes owned home",
        )
    if public:
        selected = raw["public"]
        require(
            isinstance(selected, dict)
            and set(selected)
            == {
                "invocation_id",
                "deadline_utc",
                "services_sha256",
                "fuse_sha256",
                "network_sha256",
                "fuse_policy_sha256",
                "network_policy_sha256",
            },
            "ordinary public namespace binding differs",
        )
        require(
            all(
                isinstance(selected[key], str) and SHA.fullmatch(selected[key])
                for key in selected
                if key != "deadline_utc"
            ),
            "ordinary public namespace pins differ",
        )
        require(
            raw["home"].endswith(f"/portcove-native/invocations/{selected['invocation_id']}/work/home/state")
            and raw["application_original"] == raw["home"][: -len("state")] + "installation/Portcove.AppImage",
            "ordinary public state/installation escaped shared bounded home",
        )
        require(isinstance(selected["deadline_utc"], str), "ordinary public deadline unavailable")
        parsed = datetime.datetime.fromisoformat(selected["deadline_utc"].replace("Z", "+00:00"))
        require(
            parsed.tzinfo == datetime.UTC
            and parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") == selected["deadline_utc"],
            "ordinary public deadline is not canonical UTC",
        )
    return raw


def read_regular(filename, maximum, mapped_identity=None, proc_image=False):
    require(not proc_image or re.fullmatch(r"/proc/[1-9][0-9]*/exe", str(filename)), "fixed live image path required")
    descriptor = os.open(filename, os.O_RDONLY | (0 if proc_image else os.O_NOFOLLOW) | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, "bounded native file required")
        if mapped_identity is not None:
            require(
                (os.major(before.st_dev), os.minor(before.st_dev), before.st_ino) == mapped_identity,
                "loaded native library mapping identity differs",
            )
        digest = hashlib.sha256()
        total = 0
        while True:
            data = os.read(descriptor, min(65536, maximum + 1 - total))
            if not data:
                break
            total += len(data)
            require(total <= maximum, "native file grew beyond bound")
            digest.update(data)
        after = os.fstat(descriptor)
        require(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            "native file changed during bounded read",
        )
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def bounded_text(filename, maximum):
    with open(filename, "rb") as source:
        data = source.read(maximum + 1)
    require(len(data) <= maximum, "native process observation exceeds bound")
    return data.decode("utf-8", errors="strict")


def inspect_process_stat(data, pid):
    end = data.rfind(")")
    require(end > 0 and data.startswith(str(pid) + " ("), "native process stat identity differs")
    fields = data[end + 2 :].split()
    require(
        len(fields) >= 20 and fields[1].isdigit() and fields[19].isdigit() and int(fields[19]) > 0,
        "native process generation is unavailable",
    )
    return {
        "pid": pid,
        "parent_pid": int(fields[1]),
        "creation_ticks": fields[19],
        "comm": data[data.index("(") + 1 : end],
    }


def inspect_loaded_webkit_maps(data):
    require(len(data.encode("utf-8")) <= MIB, "native mapping inventory exceeds bound")
    found = {}
    for line in data.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6 or not re.search(
            r"/lib(?:webkit2gtk-4\.1|javascriptcoregtk-4\.1|glib-2\.0)\.so\.", fields[5]
        ):
            continue
        filename = fields[5]
        require(
            filename.startswith("/")
            and not filename.endswith(" (deleted)")
            and not any(ord(value) < 33 or ord(value) > 126 or value == "\\" for value in filename),
            "loaded native library path is unavailable",
        )
        require(
            re.fullmatch(r"[a-fA-F0-9]+:[a-fA-F0-9]+", fields[3]) and fields[4].isdigit() and int(fields[4]) > 0,
            "loaded native mapping identity missing",
        )
        major, minor = fields[3].split(":")
        identity = (int(major, 16), int(minor, 16), int(fields[4]))
        require(filename not in found or found[filename] == identity, "loaded native library mapping conflicts")
        found[filename] = identity
        require(len(found) <= 8, "loaded native library count exceeds bound")
    require(any("/libwebkit2gtk-4.1.so." in filename for filename in found), "actual loaded WebKitGTK required")
    return sorted(found.items())


def process_creation_clock(ticks):
    frequency = os.sysconf("SC_CLK_TCK")
    require(type(frequency) is int and 0 < frequency <= 1000000, "native process clock frequency unavailable")
    realtime = time.time_ns()
    boottime = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    require(0 < int(ticks) * 1000000000 // frequency <= boottime < realtime, "native process creation clock differs")
    milliseconds = (realtime - boottime) // 1000000 + int(ticks) * 1000 // frequency
    return {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(milliseconds // 1000))
        + f".{milliseconds % 1000:03d}Z",
        "realtime_ns": str(realtime),
        "boottime_ns": str(boottime),
        "ticks_per_second": frequency,
    }


def candidate_launch_root(processes, pid, driver_pid):
    current, visited = pid, set()
    while current in processes and current not in visited:
        visited.add(current)
        process = processes[current]
        if process["parent_pid"] == driver_pid:
            return process
        current = process["parent_pid"]
    raise RuntimeError("candidate launch ancestry unavailable")


def inspect_public_runtime_mount(image, mountinfo, mounts):
    require(
        isinstance(image, str) and Path(image).name == "portcove-desktop" and not image.endswith(" (deleted)"),
        "ordinary public application image differs",
    )
    require(
        re.fullmatch(r"/tmp/\.mount_[A-Za-z0-9._-]{1,64}/(?:[^/]+/)*portcove-desktop", image)
        and ".." not in PurePosixPath(image).parts,
        "ordinary public image is outside a private AppImage mount",
    )
    require(
        isinstance(mountinfo, str) and len(mountinfo.encode("utf-8")) <= MIB,
        "ordinary public mount inventory exceeds bound",
    )
    selected = []
    for target, value in mounts.items():
        require(re.fullmatch(r"/tmp/\.mount_[A-Za-z0-9._-]{1,64}", target), "ordinary public mountpoint differs")
        if not image.startswith(target + "/"):
            continue
        mount = value["mount"]
        rows = [line.split() for line in mountinfo.splitlines() if line.split()[4] == target]
        require(len(rows) == 1, "ordinary public mounted image is absent or ambiguous")
        row = rows[0]
        separator = row.index("-")
        require(
            row[0] == mount["id"]
            and row[separator + 1] == mount["filesystem"] == "fuse.AppImage"
            and row[separator + 2] == mount["source"] == "/native/installation/Portcove.AppImage"
            and {"ro", "nosuid", "nodev"} <= set(row[5].split(",")),
            "ordinary public mount changed from retained broker result",
        )
        selected.append(json.loads(json.dumps(value)))
    if not selected:
        # The child writes mounted before handing the FUSE FD to AppImage,
        # but FD4 may be serviced before PID1 consumes that original event.
        # Absence never establishes package identity or a positive snapshot.
        raise RuntimeNotReady("original broker mount association is not yet consumed")
    require(len(selected) == 1, "one exact broker-mounted ordinary application is required")
    return selected[0]


def runtime_snapshot(driver_pid, qualification_uid, public_mounts=None):
    # This fixed observation is available only through the trusted parent's FD.
    # No caller PID, pathname or command is accepted, and inaccessible evidence
    # refuses rather than weakening the WebKit sandbox or requesting ptrace.
    pids = [int(item.name) for item in Path("/proc").iterdir() if item.name.isdigit()]
    require(len(pids) <= 64, "native process inventory exceeds shared task bound")
    processes = {pid: inspect_process_stat(bounded_text(f"/proc/{pid}/stat", 4096), pid) for pid in pids}
    selected = []
    for pid, process in processes.items():
        if process["comm"] != "portcove-desktop"[:15]:
            continue
        owner = 1 if public_mounts is not None else driver_pid
        ancestor, visited = process["parent_pid"], set()
        while ancestor != owner and ancestor in processes and ancestor not in visited:
            visited.add(ancestor)
            ancestor = processes[ancestor]["parent_pid"]
        if ancestor != owner:
            continue
        image = os.readlink(f"/proc/{pid}/exe")
        require(
            Path(image).name == "portcove-desktop" and not image.endswith(" (deleted)"),
            "actual candidate image differs",
        )
        status = bounded_text(f"/proc/{pid}/status", 32768)
        if public_mounts is not None:
            fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
            require(
                all(int(fields[name], 16) == 0 for name in ("CapEff", "CapPrm", "CapInh", "CapAmb"))
                and fields["NoNewPrivs"].strip() == "1",
                "ordinary application capabilities differ",
            )
        uid_rows = [line.split()[1:] for line in status.splitlines() if line.startswith("Uid:")]
        require(len(uid_rows) == 1 and uid_rows[0] == [str(qualification_uid)] * 4, "actual candidate account differs")
        maps = bounded_text(f"/proc/{pid}/maps", MIB)
        libraries = [
            {
                "path": filename,
                "device_major": identity[0],
                "device_minor": identity[1],
                "inode": str(identity[2]),
                "sha256": read_regular(f"/proc/{pid}/root{filename}", 256 * MIB, identity),
            }
            for filename, identity in inspect_loaded_webkit_maps(maps)
        ]
        executable_sha256 = read_regular(f"/proc/{pid}/exe", 256 * MIB, proc_image=True)
        require(
            inspect_process_stat(bounded_text(f"/proc/{pid}/stat", 4096), pid) == process
            and bounded_text(f"/proc/{pid}/maps", MIB) == maps
            and os.readlink(f"/proc/{pid}/exe") == image,
            "native process or mapping changed during observation",
        )
        if public_mounts is not None:
            namespace = os.stat(f"/proc/{pid}/ns/mnt")
            init_namespace = os.stat("/proc/1/ns/mnt")
            require(
                (namespace.st_dev, namespace.st_ino) == (init_namespace.st_dev, init_namespace.st_ino),
                "ordinary application left the broker-owned mount namespace",
            )
            mountinfo = bounded_text(f"/proc/{pid}/mountinfo", MIB)
            association = inspect_public_runtime_mount(image, mountinfo, public_mounts)
            require(
                bounded_text(f"/proc/{pid}/mountinfo", MIB) == mountinfo
                and inspect_process_stat(bounded_text(f"/proc/{pid}/stat", 4096), pid) == process,
                "ordinary public process/mount association changed",
            )
            selected.append(
                {
                    **process,
                    "uid": qualification_uid,
                    "image": image,
                    "image_sha256": executable_sha256,
                    "loaded_libraries": libraries,
                    "creation_clock": process_creation_clock(process["creation_ticks"]),
                    "opaque_mount": association,
                }
            )
            continue
        root = candidate_launch_root(processes, pid, driver_pid)
        ancestry, cursor = [], pid
        while True:
            ancestry.append(processes[cursor])
            if cursor == root["pid"]:
                break
            cursor = processes[cursor]["parent_pid"]
        root_pid = root["pid"]
        root_image = os.readlink(f"/proc/{root_pid}/exe")
        root_uid = [
            line.split()[1:]
            for line in bounded_text(f"/proc/{root_pid}/status", 32768).splitlines()
            if line.startswith("Uid:")
        ]
        require(
            len(root_uid) == 1 and root_uid[0] == [str(qualification_uid)] * 4, "candidate launch root account differs"
        )
        root_sha256 = read_regular(f"/proc/{root_pid}/exe", 512 * MIB, proc_image=True)
        require(
            not root_image.endswith(" (deleted)")
            and inspect_process_stat(bounded_text(f"/proc/{root_pid}/stat", 4096), root_pid) == root
            and os.readlink(f"/proc/{root_pid}/exe") == root_image,
            "candidate launch root changed during observation",
        )
        require(
            all(
                inspect_process_stat(bounded_text(f"/proc/{item['pid']}/stat", 4096), item["pid"]) == item
                for item in ancestry
            ),
            "candidate launch ancestry changed during observation",
        )
        selected.append(
            {
                **process,
                "uid": int(uid_rows[0][0]),
                "image": image,
                "image_sha256": executable_sha256,
                "loaded_libraries": libraries,
                "creation_clock": process_creation_clock(process["creation_ticks"]),
                "launch_ancestry": ancestry,
                "launch_root": {
                    **root,
                    "uid": qualification_uid,
                    "image": root_image,
                    "image_sha256": root_sha256,
                    "creation_clock": process_creation_clock(root["creation_ticks"]),
                },
            }
        )
    if public_mounts is not None and len(selected) != 1:
        raise RuntimeNotReady("one stable ordinary application image is not yet observable")
    require(len(selected) == 1, "one actual live candidate image required")
    boot = [line.split()[1] for line in bounded_text("/proc/stat", MIB).splitlines() if line.startswith("btime ")]
    require(len(boot) == 1 and boot[0].isdigit() and int(boot[0]) > 0, "native process clock origin unavailable")
    now = time.time_ns()
    return {
        "schema_version": 1,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now // 1000000000))
        + f".{now // 1000000 % 1000:03d}Z",
        "process": selected[0],
        "driver_pid": driver_pid,
        **(
            {"scope": "ordinary-public-broker-mounted-runtime", "namespace_owner_pid": 1}
            if public_mounts is not None
            else {}
        ),
        "kernel_release": os.uname().release,
        "architecture": os.uname().machine,
        "os_release": bounded_text("/etc/os-release", 16384),
        "clock_ticks_per_second": os.sysconf("SC_CLK_TCK"),
        "boot_time_epoch_seconds": int(boot[0]),
        "authority": "none",
    }


def namespace_process_identity(binding):
    process = inspect_process_stat(bounded_text("/proc/1/stat", 4096), 1)
    image = os.readlink("/proc/1/exe")
    digest = read_regular("/proc/1/exe", 128 * MIB, proc_image=True)
    require(digest == binding["tools"]["python"]["sha256"], "actual namespace init image differs")
    clock = process_creation_clock(process["creation_ticks"])
    require(
        inspect_process_stat(bounded_text("/proc/1/stat", 4096), 1) == process and os.readlink("/proc/1/exe") == image,
        "namespace init identity changed",
    )
    return {
        **process,
        "image": image,
        "image_sha256": digest,
        "started_at": clock["started_at"],
        "creation_clock": clock,
    }


def rewrite_session(data, binding):
    raw = decode(data)
    require(isinstance(raw, dict) and set(raw) == {"capabilities"}, "fixed native session required")
    capabilities = raw["capabilities"]
    require(
        isinstance(capabilities, dict)
        and set(capabilities) <= {"alwaysMatch", "firstMatch"}
        and capabilities.get("firstMatch", [{}]) == [{}],
        "fixed native capabilities required",
    )
    matched = capabilities.get("alwaysMatch")
    require(
        isinstance(matched, dict)
        and {"browserName", "tauri:options"} <= set(matched)
        and set(matched) <= {"browserName", "tauri:options", "se:remoteUrl"}
        and matched["browserName"] == "wry"
        and matched.get("se:remoteUrl", f"http://127.0.0.1:{binding['port']}") == f"http://127.0.0.1:{binding['port']}",
        "native browser identity differs",
    )
    options = matched["tauri:options"]
    require(
        isinstance(options, dict)
        and set(options) == {"application"}
        and options["application"] == binding["application_original"],
        "native session requested another executable",
    )
    # A mount alias changes only the launch path, never selected application
    # bytes or the product's trust/selection/configuration behavior.
    options["application"] = (
        "/native/installation/Portcove.AppImage" if binding["schema_version"] == 2 else "/native/application.AppImage"
    )
    return json.dumps(raw, separators=(",", ":")).encode("utf-8")


def authority_record(cookie):
    result = struct.pack(">H", 256)
    for value in (socket.gethostname().encode("utf-8"), b"99", b"MIT-MAGIC-COOKIE-1", cookie):
        result += struct.pack(">H", len(value)) + value
    return result


def run(binding):
    end = ORIGINAL_START + binding["timeout_seconds"]
    public = binding["schema_version"] == 2
    if public:
        remaining = (
            datetime.datetime.fromisoformat(binding["public"]["deadline_utc"].replace("Z", "+00:00")).timestamp()
            - time.time()
        )
        require(remaining > 0, "ordinary public deadline already expired")
        end = min(end, time.monotonic() + remaining)
    require(sys.platform == "linux" and os.getpid() == 1, "private candidate namespace PID1 required")
    require(
        os.getuid() == binding["qualification_uid"] and os.getgid() == binding["qualification_gid"],
        "private candidate identity differs",
    )
    # A candidate cannot inspect the init's inherited private descriptors or
    # ptrace its channel owner, including when Yama is unavailable.
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(4, 0, 0, 0, 0) == 0 and libc.prctl(3, 0, 0, 0, 0) == 0, "cannot protect native init descriptors")
    require(
        not any(Path(filename).exists() for filename in ("/init", "/mnt", "/run/WSL", "/run/user")),
        "candidate host mounts/control paths remain visible",
    )
    require(
        not any(
            key in os.environ
            for key in ("WSL_INTEROP", "WSLENV", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "LD_PRELOAD")
        ),
        "candidate inherited forbidden host configuration",
    )
    for value in binding["tools"].values():
        actual = Path(value["path"]).resolve(strict=True)
        require(read_regular(actual, 128 * MIB) == value["sha256"], "native qualified tool changed")
    require(Path(sys.executable).resolve() == Path("/usr/bin/python3").resolve(), "fixed native Python required")
    require(
        read_regular("/native/installation/Portcove.AppImage" if public else "/native/application.AppImage", 512 * MIB)
        == binding["application_sha256"],
        "native selected package changed",
    )
    require(time.monotonic() < end, "original native init lifetime exhausted before launch")
    nonce = binding["nonce"]
    transferred, sequence = 0, 0

    def send(value):
        nonlocal transferred
        packet = json.dumps({**value, "nonce": nonce}, separators=(",", ":")).encode("utf-8") + b"\n"
        transferred += len(packet)
        require(len(packet) <= 24 * MIB and transferred <= 128 * MIB, "private native channel bound exhausted")
        while packet:
            packet = packet[os.write(3, packet) :]

    auth = Path("/tmp/native-xauthority")
    descriptor = os.open(auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, authority_record(os.urandom(16)))
    finally:
        os.close(descriptor)
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": binding["home"],
        "DISPLAY": ":99",
        "GDK_BACKEND": "x11",
        "XAUTHORITY": str(auth),
        **binding["environment"],
    }
    if public:
        environment["FUSERMOUNT_PROG"] = "/native/fuse.py"
    else:
        environment["APPIMAGE_EXTRACT_AND_RUN"] = "1"
    children = []
    selector = selectors.DefaultSelector()
    services = worker = None
    try:
        if public:
            import types

            helper = os.stat("/native/fuse.py", follow_symlinks=False)
            require(
                stat.S_ISREG(helper.st_mode)
                and helper.st_nlink == 1
                and helper.st_uid == os.getuid()
                and helper.st_mode & 0o111
                and not helper.st_mode & 0o6000,
                "ordinary FUSE helper must be the appointed non-setuid executable source",
            )
            # Compile the exact bytes just hashed. The parent independently
            # binds this fixed read-only module to its clean controller source.
            with open("/native/public-services.py", "rb") as source:
                data = source.read(MIB + 1)
            require(
                len(data) <= MIB and hashlib.sha256(data).hexdigest() == binding["public"]["services_sha256"],
                "ordinary public services source differs",
            )
            module = types.ModuleType("fixed_native_public_services")
            exec(compile(data, "/native/public-services.py", "exec"), module.__dict__)
            services = module.PublicNativeServices(
                {**binding["public"], "nonce": binding["nonce"]}, selector, end, send
            )
            require(
                services.package_hashes[0] == binding["application_sha256"],
                "ordinary initial package differs from appointed FUSE pair",
            )
        send(
            {
                "kind": "namespace-ready",
                "pid": 1,
                "uid": os.getuid(),
                "process_identity": namespace_process_identity(binding),
            }
        )
        display = subprocess.Popen(
            ["/usr/bin/Xvfb", ":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-auth", str(auth)],
            env=environment,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
        children.append(display)
        ready = min(end, time.monotonic() + 10)
        while not Path("/tmp/.X11-unix/X99").exists():
            require(display.poll() is None and time.monotonic() < ready, "private X11 startup refused")
            time.sleep(0.05)
        driver = subprocess.Popen(
            [
                "/native/runtime/tauri-driver",
                "--port",
                str(binding["port"]),
                "--native-port",
                str(binding["port"] + 1),
                "--native-driver",
                "/usr/bin/WebKitWebDriver",
            ],
            env=environment,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
        children.append(driver)
        send({"kind": "driver-started", "pid": driver.pid})

        def forward_driver(method, route, content):
            connection = http.client.HTTPConnection(
                "127.0.0.1", binding["port"], timeout=max(0.01, min(30, end - time.monotonic()))
            )
            try:
                connection.request(method, route, content, {"Content-Type": "application/json", "Connection": "close"})
                response = connection.getresponse()
                result = response.read(RESPONSE_LIMIT + 1)
                require(
                    len(result) <= RESPONSE_LIMIT and 200 <= response.status <= 599,
                    "private driver response exceeded bound",
                )
                return response.status, result
            except ConnectionRefusedError:
                require(method == "GET" and route == "/status", "native driver connection outcome is ambiguous")
                return 503, b'{"value":{"error":"not-ready"}}'
            finally:
                connection.close()

        def respond_driver(current, response):
            status, result = response
            require(time.monotonic() < end, "original native init lifetime exhausted")
            send(
                {
                    "kind": "driver-response",
                    "sequence": current,
                    "response": {"status": status, "body_base64": base64.b64encode(result).decode("ascii")},
                }
            )

        if public:
            worker = module.FixedDriverHttpWorker(selector, end, forward_driver, respond_driver)
        selector.register(0, selectors.EVENT_READ)
        selector.register(4, selectors.EVENT_READ)
        buffer = b""
        while time.monotonic() < end:
            if services is not None:
                services.tick()
            require(display.poll() is None and driver.poll() is None, "native GUI process exited before settlement")
            for key, mask in selector.select(min(0.25, max(0, end - time.monotonic()))):
                if callable(key.data):
                    key.data(mask)
                    continue
                data = os.read(key.fd, 65536)
                if key.fd == 0:
                    require(not data, "private native lifecycle input is not a command surface")
                    return 0
                require(data, "private native command channel closed before teardown")
                buffer += data
                transferred += len(data)
                require(
                    len(buffer) <= 3 * MIB and transferred <= 128 * MIB, "private native command channel exceeded bound"
                )
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    packet = decode(line)
                    require(
                        isinstance(packet, dict)
                        and set(packet) == {"kind", "nonce", "sequence", "request"}
                        and packet["kind"] == "driver-request"
                        and packet["nonce"] == nonce
                        and type(packet["sequence"]) is int
                        and packet["sequence"] == sequence + 1
                        and sequence < 4096,
                        "private native command identity differs",
                    )
                    sequence += 1
                    method, route, content = inspect_request(packet["request"])
                    if route in ("/native-runtime", "/native-public-runtime"):
                        require(public == (route == "/native-public-runtime"), "runtime observation scope differs")
                        try:
                            snapshot = runtime_snapshot(
                                driver.pid, binding["qualification_uid"], services.mounts if public else None
                            )
                        except (RuntimeNotReady, FileNotFoundError, ProcessLookupError):
                            if not public:
                                raise
                            # Read-only observation may race ordinary exit and
                            # relaunch. Security/identity assertion failures are
                            # never converted to readiness or accepted reports.
                            respond_driver(sequence, (503, b'{"state":"runtime-not-ready","authority":"none"}'))
                            continue
                        result = json.dumps(
                            snapshot,
                            separators=(",", ":"),
                        ).encode("utf-8")
                        require(
                            len(result) <= RESPONSE_LIMIT and time.monotonic() < end,
                            "native observation exceeded original bound",
                        )
                        send(
                            {
                                "kind": "driver-response",
                                "sequence": sequence,
                                "response": {"status": 200, "body_base64": base64.b64encode(result).decode("ascii")},
                            }
                        )
                        continue
                    if method == "POST" and route == "/session":
                        require(
                            read_regular(
                                "/native/installation/Portcove.AppImage" if public else "/native/application.AppImage",
                                512 * MIB,
                            )
                            in (services.package_hashes if public else (binding["application_sha256"],)),
                            "native package changed before launch",
                        )
                        content = rewrite_session(content, binding)
                    if worker is None:
                        respond_driver(sequence, forward_driver(method, route, content))
                    else:
                        worker.submit(sequence, method, route, content)
        raise RuntimeError("original native init lifetime exhausted")
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
        try:
            if worker is not None:
                worker.close()
        finally:
            try:
                if services is not None:
                    settled = services.close()
                    send({"kind": "public-services-stopped", "mounts_empty_observed": settled, "authority": "none"})
                    require(settled, "ordinary FUSE mounts did not positively settle")
            finally:
                selector.close()
        # Exiting namespace PID1 lets the kernel tear down all descendants;
        # only the outer owner may attest positive held-cgroup emptiness.


def main():
    require(sys.argv[1:] == ["--binding", "/native/config.json"], "fixed private native entry required")
    with open("/native/config.json", "rb") as source:
        data = source.read(32769)
    require(len(data) <= 32768, "private native binding exceeds bound")
    binding = inspect_binding(decode(data))
    return run(binding)


if __name__ == "__main__":
    try:
        code = main()
    except BaseException:
        # Original bounded streams remain owned by the outer capture. No raw
        # candidate data or private auth cookie is turned into diagnostics.
        sys.stderr.write("fixed private native namespace refused; retain outer capture\n")
        sys.exit(1)
    else:
        sys.exit(code)
