#!/usr/bin/python3
"""Fixed public Git object acquisition, with limits before Git parses a pack.

No candidate checkout, hooks, credentials, arbitrary remote or command route.
The caller's existing resource supervisor owns the whole subprocess tree.
"""

import hashlib
import json
import math
import os
import re
import resource
import signal
import stat
import sys
import time


def main():
    if len(sys.argv) != 2 or os.getuid() == 0:
        raise ValueError("fixed ordinary source acquisition required")
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or not 0 < info.st_size <= 32768
        ):
            raise ValueError("source request custody differs")
        raw = os.read(fd, 32769)
        if len(raw) != info.st_size:
            raise ValueError("source request bytes changed")
    finally:
        os.close(fd)
    value = json.loads(raw)
    if (
        set(value)
        != {"schema_version", "repository", "home", "oids", "phase", "git_sha256", "timeout_ms", "expires_at"}
        or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
    ):
        raise ValueError("fixed source request fields differ")
    for name in ("repository", "home"):
        text = value[name]
        if (
            not isinstance(text, str)
            or not text.startswith("/")
            or os.path.normpath(text) != text
            or "\x00" in text
            or "\n" in text
            or "\r" in text
        ):
            raise ValueError("fixed source path required")
    phase, objects = value["phase"], value["oids"]
    counts = {
        "commits": (1, 3),
        "blobs": (1, 256),
        "init": (0, 0),
        "commit": (1, 1),
        "refs": (0, 0),
        "history": (2, 2),
        "peel": (1, 1),
        "tree": (0, 0),
        "sizes": (0, 0),
    }
    if (
        phase not in counts
        or not isinstance(objects, list)
        or not counts[phase][0] <= len(objects) <= counts[phase][1]
        or (phase != "history" and len(set(objects)) != len(objects))
        or any(not isinstance(oid, str) or re.fullmatch(r"[a-f0-9]{40}", oid) is None for oid in objects)
    ):
        raise ValueError("bounded exact source objects required")
    if (
        type(value["timeout_ms"]) is not int
        or not 1 <= value["timeout_ms"] <= 30000
        or type(value["expires_at"]) is not int
    ):
        raise ValueError("source deadline differs")
    remaining = min(value["timeout_ms"], value["expires_at"] - int(time.time() * 1000))
    if remaining < 1:
        raise ValueError("source deadline exhausted before Git")
    with open("/usr/bin/git", "rb") as binary:
        if hashlib.file_digest(binary, "sha256").hexdigest() != value["git_sha256"]:
            raise ValueError("fixed source Git changed")
    # These apply before Git/index-pack touches untrusted compressed data.
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
    file_limit = (64 if phase == "commits" else 256) * 1024**2
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    cpu = math.ceil(remaining / 1000) + 1
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    signal.alarm(max(1, math.ceil(remaining / 1000)))
    args = [
        "/usr/bin/git",
        "--no-optional-locks",
        "--no-replace-objects",
        "-C",
        value["home"],
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always" if phase in ("commits", "blobs") else "protocol.https.allow=never",
        "-c",
        "protocol.version=2",
        "-c",
        "http.followRedirects=false",
        "-c",
        "http.lowSpeedLimit=1",
        "-c",
        "http.lowSpeedTime=15",
        "-c",
        "pack.threads=1",
        "-c",
        "fetch.unpackLimit=0",
        "-c",
        "fetch.writeCommitGraph=false",
    ]
    if phase in ("commits", "blobs"):
        args.extend(
            [
                "--git-dir",
                value["repository"],
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--filter=tree:0" if phase == "commits" else "--filter=blob:none",
            ]
        )
        if phase == "commits":
            args.append("--depth=1601")
        args.extend(["https://github.com/boburning/portcove.git", *objects])
    elif phase == "init":
        args.extend(["init", "--bare", "--quiet", "--template=", value["repository"]])
    else:
        operations = {
            "commit": ["cat-file", "commit", *objects],
            "refs": ["for-each-ref", "--format=%(refname)"],
            "history": ["rev-list", "--max-count=1601", *objects[:1], *[f"^{oid}" for oid in objects[1:]]],
            "peel": ["rev-parse", "--verify", *[f"{oid}^{{commit}}" for oid in objects]],
            "tree": ["hash-object", "-w", "-t", "tree", "--stdin"],
            "sizes": ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        }
        args.extend(["--git-dir", value["repository"], *operations[phase]])
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": value["home"],
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
    }
    os.execve(args[0], args, environment)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("fixed bounded semantic source Git refused; retain source evidence", file=sys.stderr)
        sys.exit(2)
