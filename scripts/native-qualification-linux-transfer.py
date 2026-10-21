#!/usr/bin/env python3
"""Fixed binary custody transfer, never a native grant or candidate command.

The installed Windows parent owns the retained attempt/counters. This helper
creates only exact invocation inputs, or reads the bounded retained capture.
Incomplete transfers remain .partial; repeats never overwrite or relaunch.
"""

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

MIB = 1024 * 1024
SHA = re.compile(r"[a-f0-9]{64}\Z")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate native transfer field")
            result[key] = value
        return result

    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=pairs,
        parse_constant=lambda _: require(False, "nonfinite native transfer value"),
    )


def owned(filename, directory=False):
    info = filename.lstat()
    require(
        not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),
        "native transfer path kind differs",
    )
    require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "native transfer custody differs")
    return info


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def root_path():
    source = Path(__file__).absolute()
    require(
        source.name == "native-qualification-linux-transfer.py"
        and source.parent.name == "scripts"
        and source.parent.parent.name == "controller",
        "fixed native transfer source differs",
    )
    root = source.parent.parent.parent
    require(
        re.fullmatch(r"/home/[a-z][a-z0-9_-]{0,31}/portcove-native", str(root)) and os.getuid() > 0,
        "fixed nonroot transfer home differs",
    )
    current = root
    while current != current.parent:
        info = current.lstat()
        require(
            stat.S_ISDIR(info.st_mode)
            and not stat.S_ISLNK(info.st_mode)
            and info.st_uid in (0, os.getuid())
            and not info.st_mode & 0o022,
            "native transfer ancestry permits replacement",
        )
        current = current.parent
    owned(root, True)
    owned(root / "invocations", True)
    return root


def inspect_header(raw, invocation):
    require(
        isinstance(raw, dict)
        and set(raw) == {"schema_version", "invocation_id", "entry", "bytes", "sha256"}
        and raw["schema_version"] == 1
        and raw["invocation_id"] == invocation
        and raw["entry"] in ("request", "plan", "application", "candidate", "predecessor", "parked_capture"),
        "fixed native transfer header differs",
    )
    limit = (
        512 * MIB
        if raw["entry"] in ("application", "candidate", "predecessor")
        else 272 * MIB
        if raw["entry"] == "parked_capture"
        else 128 * 1024
    )
    require(
        type(raw["bytes"]) is int
        and 0 < raw["bytes"] <= limit
        and isinstance(raw["sha256"], str)
        and SHA.fullmatch(raw["sha256"]),
        "native transfer size/hash differs",
    )
    return raw


def make_directory(filename):
    try:
        filename.mkdir(mode=0o700)
    except FileExistsError:
        owned(filename, True)


def sync_directory(filename):
    directory = os.open(filename, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def stage(root, invocation, header_sha):
    line = sys.stdin.buffer.readline(16385)
    require(
        line.endswith(b"\n") and len(line) <= 16384 and hashlib.sha256(line[:-1]).hexdigest() == header_sha,
        "native transfer header identity differs",
    )
    header = inspect_header(decode(line[:-1]), invocation)
    attempt = root / "invocations" / invocation
    make_directory(attempt)
    for leaf in ("capture", "install", "work", "packages", "inputs"):
        make_directory(attempt / leaf)
    make_directory(attempt / "work/home")
    filename = (
        attempt
        / (
            {
                "request": "request.json",
                "plan": "plan.json",
                "application": "install/Portcove.AppImage",
                "candidate": "packages/Candidate.AppImage",
                "predecessor": "packages/Predecessor.AppImage",
                "parked_capture": "inputs/parked-public-capture.wire",
            }[header["entry"]]
        )
    )
    partial = Path(str(filename) + ".partial")
    # A retained partial, destination or receipt is a HOLD, never a retry hint.
    require(not filename.exists() and not filename.is_symlink(), "native transfer destination retained")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    digest = hashlib.sha256()
    count = 0
    try:
        while count < header["bytes"]:
            data = sys.stdin.buffer.read(min(65536, header["bytes"] - count))
            require(data, "native input transfer ended early; preserve partial")
            digest.update(data)
            count += len(data)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                require(written > 0, "native input write refused")
                view = view[written:]
        require(not sys.stdin.buffer.read(1), "native transfer has trailing bytes; preserve partial")
        require(digest.hexdigest() == header["sha256"], "native input digest differs; preserve partial")
        os.fchmod(fd, 0o500 if header["entry"] in ("application", "candidate", "predecessor") else 0o400)
        os.fsync(fd)
    finally:
        os.close(fd)
    # link is a no-replacement publication; removing only this successful owned
    # staging alias leaves the final regular input with exactly one link.
    os.link(partial, filename, follow_symlinks=False)
    partial.unlink()
    sync_directory(filename.parent)
    print(
        json.dumps(
            {
                "schema_version": 1,
                "invocation_id": invocation,
                "entry": header["entry"],
                "bytes": count,
                "sha256": digest.hexdigest(),
                "staged": True,
                "authority": "none",
            },
            separators=(",", ":"),
        )
    )


def capture_files(root, invocation):
    capture = root / "invocations" / invocation / "capture"
    owned(capture, True)
    result = []
    total = 0
    directory_count = 0
    for current, directories, files in os.walk(capture, followlinks=False):
        directory_count += len(directories)
        require(directory_count <= 512, "native capture directory inventory exceeds bound")
        require(len(result) + len(directories) + len(files) <= 512, "native retained capture inventory exceeds bound")
        for name in directories:
            filename = Path(current) / name
            require(
                re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) and len(filename.relative_to(capture).parts) <= 8,
                "native capture directory differs",
            )
            owned(filename, True)
        for name in files:
            filename = Path(current) / name
            relative = filename.relative_to(capture).as_posix()
            if relative == ".outer.lock":
                info = owned(filename)
                require(info.st_nlink == 1 and info.st_size == 0, "native outer lock differs")
                continue
            require(
                len(relative) <= 512
                and len(Path(relative).parts) <= 8
                and all(
                    re.fullmatch(r"(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.outer-json-[a-f0-9]{32})", part)
                    for part in Path(relative).parts
                ),
                "native capture path differs",
            )
            info = owned(filename)
            # Original marker hard-link pairs are identity-bound by the outer
            # reader; binary export retains their bytes without appointing them.
            require(info.st_nlink in (1, 2) and info.st_size <= 32 * MIB, "native capture entry exceeds bound")
            total += info.st_size
            require(total <= 256 * MIB and len(result) < 512, "native retained capture bytes exceed bound")
            result.append((relative, filename, info))
    return sorted(result, key=lambda entry: entry[0])


def export_capture(root, invocation):
    files = capture_files(root, invocation)
    # Stream one bounded header then exact bytes per entry. The receiving parent
    # checks each digest and the final inventory before any native report join.
    for relative, filename, before in files:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            actual = os.fstat(fd)
            require(
                (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns)
                == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns),
                "native capture changed before export",
            )
            pieces = []
            count = 0
            while count <= before.st_size:
                part = os.read(fd, min(65536, before.st_size + 1 - count))
                if not part:
                    break
                pieces.append(part)
                count += len(part)
            data = b"".join(pieces)
            after = os.fstat(fd)
            require(
                len(data) == before.st_size and identity(actual) == identity(after),
                "native capture changed during export",
            )
        finally:
            os.close(fd)
        header = {
            "schema_version": 1,
            "invocation_id": invocation,
            "path": relative,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        sys.stdout.buffer.write(json.dumps(header, separators=(",", ":")).encode() + b"\n")
        sys.stdout.buffer.write(data)
    require(
        [(entry[0], identity(entry[2])) for entry in capture_files(root, invocation)]
        == [(entry[0], identity(entry[2])) for entry in files],
        "native capture inventory changed during export",
    )
    sys.stdout.buffer.write(
        json.dumps(
            {
                "schema_version": 1,
                "invocation_id": invocation,
                "complete": True,
                "count": len(files),
                "authority": "none",
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )
    sys.stdout.buffer.flush()


def observe_host(invocation):
    def read_root_file(filename, maximum):
        actual = Path(filename).resolve(strict=True)
        fd = os.open(actual, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            require(
                stat.S_ISREG(before.st_mode)
                and before.st_uid == 0
                and not before.st_mode & 0o022
                and 0 < before.st_size <= maximum,
                "fixed guest host file custody differs",
            )
            data = os.read(fd, maximum + 1)
            require(
                len(data) == before.st_size and identity(os.fstat(fd)) == identity(before), "guest host file changed"
            )
            return data
        finally:
            os.close(fd)

    machine = read_root_file("/etc/machine-id", 256).decode("ascii").strip()
    require(re.fullmatch(r"[a-f0-9]{32}", machine), "guest machine identity unavailable")
    return {
        "schema_version": 1,
        "invocation_id": invocation,
        "qualification_uid": os.getuid(),
        "qualification_gid": os.getgid(),
        "machine_id_sha256": hashlib.sha256(machine.encode("ascii")).hexdigest(),
        "os_release": read_root_file("/etc/os-release", 16384).decode("utf-8"),
        "kernel_release": os.uname().release,
        "architecture": os.uname().machine,
        "authority": "none",
    }


def main(arguments):
    require(
        len(arguments) in (4, 6)
        and arguments[0] == "--mode"
        and arguments[2] == "--invocation"
        and SHA.fullmatch(arguments[3]),
        "fixed native transfer arguments differ",
    )
    mode, invocation = arguments[1], arguments[3]
    root = root_path()
    if mode == "host":
        require(len(arguments) == 4, "fixed native host arguments differ")
        print(json.dumps(observe_host(invocation), separators=(",", ":")))
    elif mode == "stage":
        require(
            len(arguments) == 6 and arguments[4] == "--header-sha256" and SHA.fullmatch(arguments[5]),
            "fixed native stage header missing",
        )
        stage(root, invocation, arguments[5])
    else:
        require(mode == "capture" and len(arguments) == 4, "fixed native transfer mode differs")
        export_capture(root, invocation)


if __name__ == "__main__":
    main(sys.argv[1:])
