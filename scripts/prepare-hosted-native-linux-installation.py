"""Fixed disposable-host materialization. No guest code runs with root authority.

The authenticated original parent supplies pins; this JSON never grants authority.
The existing account/profile setup must already have completed for this same job.
Partial roots and the first intent are retained; no reuse, deletion or retry.
"""
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path, PurePosixPath

try:
    import pwd
except ModuleNotFoundError:
    pwd = None

ROOT = Path("/home/portcove-native/portcove-native")
WORKSPACE = Path("/home/runner/work/portcove/portcove")
DEPENDENCIES = ("node_modules", "apps/desktop/node_modules")
MAX_FILES = 100000
MAX_BYTES = 2 * 1024 ** 3
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1",
       "GIT_NO_REPLACE_OBJECTS": "1", "GIT_OPTIONAL_LOCKS": "0"}


def need(value, message):
    if not value:
        raise RuntimeError(message)


def inspect_plan(raw):
    need(isinstance(raw, dict) and set(raw) == {
        "schema_version", "binding", "source_commit", "source_tree", "harness_sha256",
        "broker_uid", "broker_pid", "broker_identity", "deadline_ns", "tools", "context",
    }, "fixed installation plan differs")
    need(type(raw["schema_version"]) is int and raw["schema_version"] == 1, "installation schema differs")
    for name, size in (("binding", 64), ("source_commit", 40), ("source_tree", 40), ("harness_sha256", 64)):
        need(isinstance(raw[name], str) and re.fullmatch(rf"[a-f0-9]{{{size}}}", raw[name]), "installation pin differs")
    for name in ("broker_uid", "broker_pid"):
        need(type(raw[name]) is int and 0 < raw[name] < 2 ** 32, "installation broker differs")
    need(isinstance(raw["broker_identity"], str) and re.fullmatch(
        r"linux:[a-f0-9-]{36}:[1-9][0-9]*:[1-9][0-9]*", raw["broker_identity"]), "broker generation absent")
    need(isinstance(raw["deadline_ns"], str) and re.fullmatch(r"[1-9][0-9]{0,19}", raw["deadline_ns"]), "original installation deadline absent")
    need(isinstance(raw["tools"], dict) and set(raw["tools"]) == {"node", "driver"}, "fixed installation tools differ")
    for value in raw["tools"].values():
        need(isinstance(value, dict) and set(value) == {"path", "bytes", "sha256"}, "installation tool identity differs")
        need(isinstance(value["path"], str) and value["path"].startswith("/home/runner/")
             and str(PurePosixPath(value["path"])) == value["path"] and ".." not in PurePosixPath(value["path"]).parts,
             "installation tool path differs")
        need(type(value["bytes"]) is int and 0 < value["bytes"] <= 128 * 1024 ** 2
             and isinstance(value["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "installation tool bound differs")
    need(isinstance(raw["context"], dict) and set(raw["context"]) == {
        "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF"}, "setup correlation differs")
    need(re.fullmatch(r"[a-f0-9]{40}", raw["context"]["GITHUB_SHA"])
         and re.fullmatch(r"[1-9][0-9]*", raw["context"]["GITHUB_RUN_ID"])
         and raw["context"]["GITHUB_RUN_ATTEMPT"] == "1"
         and re.fullmatch(r"boburning/portcove/\.github/workflows/application-update-production.yml@refs/tags/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}", raw["context"]["GITHUB_WORKFLOW_REF"]), "original setup job differs")
    return raw


def generation(pid):
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
    need(len(fields) >= 20 and fields[0] != "Z", "installation parent is not live")
    return f"linux:{boot}:{pid}:{fields[19]}"


def fence(plan):
    need(time.monotonic_ns() < int(plan["deadline_ns"]), "original installation deadline exhausted")
    need(generation(plan["broker_pid"]) == plan["broker_identity"], "original installation parent changed")
    need(Path(f"/proc/{plan['broker_pid']}").stat().st_uid == plan["broker_uid"], "installation parent owner changed")


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_mode


def read_regular(filename, maximum, owners, check):
    check()
    filename = Path(filename)
    need(filename.resolve(strict=True) == filename, "linked installation input refused")
    with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        before = os.fstat(source.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_uid in owners and not before.st_mode & 0o022
             and 0 <= before.st_size <= maximum, "installation file custody/bound differs")
        output = bytearray()
        while len(output) <= maximum:
            check()
            part = source.read(min(131072, maximum + 1 - len(output)))
            if not part:
                break
            output.extend(part)
        need(len(output) == before.st_size and identity(before) == identity(os.fstat(source.fileno()))
             == identity(filename.lstat()), "installation input changed")
    check()
    return bytes(output)


def dependency_snapshot(source, owners, check):
    """Preflight the complete supported graph; do not follow links recursively."""
    source = Path(source)
    records, total = [], 0
    for relative in DEPENDENCIES:
        directory = source / relative
        need(directory.is_dir() and not directory.is_symlink(), "fixed dependency root absent or linked")
        pending = [directory]
        while pending:
            check()
            current = pending.pop()
            info = current.lstat()
            need(info.st_uid in owners and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), "dependency writer differs")
            name = str(current.relative_to(source))
            need(len(name.encode()) <= 4096 and len(records) < MAX_FILES, "dependency inventory exceeds bound")
            if stat.S_ISLNK(info.st_mode):
                resolved = current.resolve(strict=True)
                need(resolved.is_relative_to(source) and resolved != source, "dependency link escapes source")
                records.append((name, "link", str(resolved.relative_to(source))))
            elif stat.S_ISDIR(info.st_mode):
                records.append((name, "directory", None))
                # A directory-list allocation itself has a finite entry bound.
                with os.scandir(current) as entries:
                    for entry in entries:
                        need(len(pending) + len(records) < MAX_FILES, "dependency directory exceeds bound")
                        pending.append(Path(entry.path))
            else:
                data = read_regular(current, 128 * 1024 ** 2, owners, check)
                total += len(data)
                need(total <= MAX_BYTES, "dependency bytes exceed bound")
                records.append((name, "file", (len(data), hashlib.sha256(data).hexdigest(), info.st_mode & 0o111)))
    return records, total


def copy_dependencies(source, target, records, owners, uid, gid, check):
    for name, kind, value in sorted(records, key=lambda row: (len(Path(row[0]).parts), row[0])):
        check()
        destination = target / name
        need(destination.is_relative_to(target), "dependency destination escapes installation")
        if kind == "directory":
            destination.mkdir(mode=0o700)
            os.chown(destination, uid, gid)
        elif kind == "link":
            need((source / name).resolve(strict=True) == source / value, "dependency link changed after preflight")
            # Rewrite even absolute internal source links into the new private root.
            destination.symlink_to(os.path.relpath(target / value, destination.parent))
            os.chown(destination, uid, gid, follow_symlinks=False)
        else:
            data = read_regular(source / name, 128 * 1024 ** 2, owners, check)
            need((len(data), hashlib.sha256(data).hexdigest()) == value[:2], "dependency changed after preflight")
            with destination.open("xb") as output:
                output.write(data)
            destination.chmod(0o700 if value[2] else 0o600)
            os.chown(destination, uid, gid)
    for name, kind, value in records:
        check()
        if kind == "link":
            need((source / name).resolve(strict=True) == source / value, "source dependency graph changed")
            need((target / name).resolve(strict=True) == target / value, "installed dependency graph differs")


def command(arguments, check, maximum_file_bytes=None, maximum_output_bytes=65536):
    check()
    if maximum_file_bytes is not None:
        arguments = ["/usr/bin/prlimit", f"--fsize={maximum_file_bytes}", "--", *arguments]
    child = subprocess.Popen(arguments, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    selector, output, settled = selectors.DefaultSelector(), {"out": bytearray(), "err": bytearray()}, False
    try:
        for name, stream in (("out", child.stdout), ("err", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            check()
            for event, _ in selector.select(0.05):
                part = os.read(event.fd, 8192)
                if not part:
                    selector.unregister(event.fileobj)
                else:
                    output[event.data].extend(part)
                    need(len(output[event.data]) <= maximum_output_bytes, "installation command output exceeds bound")
        code = child.wait(timeout=1)
        settled = True
        need(code == 0, "fixed installation command refused")
        check()
        return bytes(output["out"]).decode("utf-8").strip()
    finally:
        selector.close()
        if not settled:
            # This original unreaped child still owns its process-group generation.
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()


def git(arguments, check, maximum_output_bytes=65536):
    arguments = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                    "-c", "uploadpack.packObjectsHook=", "-c", "protocol.allow=never",
                    "-c", f"safe.directory={WORKSPACE / 'native-source'}",
                    "-c", f"safe.directory={ROOT / 'controller'}",
                    "-c", "protocol.file.allow=always", *arguments]
    if maximum_output_bytes == 65536:
        return command(arguments, check)
    return command(arguments, check, maximum_output_bytes=maximum_output_bytes)


def inspect_source_tree(inventory):
    rows = inventory.splitlines()
    need(0 < len(rows) <= 32768, "source tree entry count exceeds bound")
    total = 0
    for row in rows:
        need(re.fullmatch(r"blob [0-9]{1,12}", row), "source tree object kind/size differs")
        size = int(row.split()[1])
        need(size <= 128 * 1024 ** 2, "source tree file exceeds bound")
        total += size
        need(total <= 256 * 1024 ** 2, "source tree bytes exceed bound")
    return len(rows), total


def acquire_source(plan):
    """One public, exact-revision acquisition as the original unprivileged broker.

    This does not install dependencies, execute repository code, or grant native
    acceptance. A retained intent or partial checkout requires explicit recovery.
    """
    def check():
        fence(plan)
    check()
    need(sys.platform == "linux" and os.getuid() == plan["broker_uid"] != 0,
         "original non-root source broker required")
    need(0 < int(plan["deadline_ns"]) - time.monotonic_ns() <= 90_000_000_000,
         "source acquisition allocation exceeds bound")
    need(WORKSPACE.resolve(strict=True) == WORKSPACE and WORKSPACE.stat().st_uid == os.getuid()
         and not WORKSPACE.stat().st_mode & 0o022, "source workspace custody differs")
    source = WORKSPACE / "native-source"
    intent = WORKSPACE / "native-source-intent.json"
    need(not os.path.lexists(source) and not os.path.lexists(intent),
         "retained source acquisition requires recovery, never reuse")
    with intent.open("x", encoding="utf-8") as output:
        os.chmod(intent, 0o600)
        json.dump({"binding": plan["binding"], "source_commit": plan["source_commit"],
                   "source_tree": plan["source_tree"], "automatic_retry": False,
                   "authority": "none"}, output)
        output.flush()
        os.fsync(output.fileno())
    check()
    source.mkdir(mode=0o700)
    acquire_public_checkout(source, plan, check)
    check()
    return {"source_commit": plan["source_commit"], "source_tree": plan["source_tree"],
            "binding": plan["binding"], "acquired": True, "dependencies_prepared": False,
            "native_acceptance": "not-established", "authority": "none"}


def acquire_public_checkout(source, plan, check):
    original_check = check
    last_inventory = 0
    def bounded_check():
        nonlocal last_inventory
        original_check()
        if time.monotonic_ns() - last_inventory < 250_000_000:
            return
        last_inventory = time.monotonic_ns()
        pending, entries, total = [source], 0, 0
        while pending:
            original_check()
            current = pending.pop()
            with os.scandir(current) as children:
                for child in children:
                    entries += 1
                    need(entries <= 32768, "source acquisition inventory exceeds bound")
                    info = child.stat(follow_symlinks=False)
                    total += info.st_size
                    need(total <= 512 * 1024 ** 2, "source acquisition bytes exceed bound")
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(child.path))
    check = bounded_check
    git(["init", "--quiet", "--template=", str(source)], check)
    # Fixed public origin only. No URL/config from candidate or ambient Git state;
    # no credentials, redirects, hooks, submodules, LFS/filter or lazy fetching.
    command(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
             "-c", "credential.helper=", "-c", "http.followRedirects=false",
             "-c", "http.sslVerify=true", "-c", "http.lowSpeedLimit=1024",
             "-c", "http.lowSpeedTime=15", "-c", "fetch.recurseSubmodules=false",
             "-c", "fetch.unpackLimit=1", "-c", "gc.auto=0",
             "-C", str(source), "fetch", "--quiet", "--depth=1", "--no-tags",
             "--no-recurse-submodules", "https://github.com/boburning/portcove.git",
             plan["source_commit"]], check, maximum_file_bytes=256 * 1024 ** 2)
    need(git(["-C", str(source), "rev-parse", "FETCH_HEAD"], check) == plan["source_commit"]
         and git(["-C", str(source), "rev-parse", "FETCH_HEAD^{tree}"], check) == plan["source_tree"],
         "acquired independent native identity differs")
    inspect_source_tree(git(["-C", str(source), "ls-tree", "-r",
                             "--format=%(objecttype) %(objectsize)", "FETCH_HEAD"],
                            check, maximum_output_bytes=1024 ** 2))
    command(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-c", "protocol.allow=never", "-c", "core.autocrlf=false", "-c", "core.symlinks=true",
             "-C", str(source), "checkout", "--quiet", "--detach", plan["source_commit"]],
            check, maximum_file_bytes=128 * 1024 ** 2)
    verify_installed_source(source, plan, check)
    harness = read_regular(source / "apps/desktop/scripts/desktop-test.mts", 1024 ** 2,
                           (os.getuid(),), check)
    need(hashlib.sha256(harness).hexdigest() == plan["harness_sha256"],
         "acquired independent native harness differs")
    last_inventory = 0
    check()


def read_source_dependencies(plan):
    """Refuse known missing prerequisites before any privileged account effects."""
    def check():
        fence(plan)
    check()
    need(os.getuid() == plan["broker_uid"] != 0, "original dependency broker required")
    source = WORKSPACE / "native-source"
    verify_installed_source(source, plan, check)
    records, total = dependency_snapshot(source, (0, os.getuid()), check)
    check()
    return {"binding": plan["binding"], "dependencies_prepared": True,
            "entries": len(records), "bytes": total, "authority": "none"}


def verify_installed_source(destination, plan, check):
    need(git(["-C", str(destination), "rev-parse", "HEAD"], check) == plan["source_commit"]
         and git(["-C", str(destination), "rev-parse", "HEAD^{tree}"], check) == plan["source_tree"],
         "installed native source identity differs")
    # Rebuild only this fresh clone's index from pinned objects. No working file
    # changes: this removes cached stat, assume-unchanged and skip-worktree masks
    # before comparing all installed tracked bytes. Guest code is still inert.
    git(["-C", str(destination), "read-tree", "--empty"], check)
    git(["-C", str(destination), "-c", "core.sparseCheckout=false", "read-tree", "HEAD"], check)
    git(["-C", str(destination), "update-index", "--refresh"], check)
    git(["-C", str(destination), "diff-files", "--exit-code", "--no-ext-diff", "--no-textconv"], check)


def install(plan):
    def check():
        fence(plan)
    check()
    need(0 < int(plan["deadline_ns"]) - time.monotonic_ns() <= 120_000_000_000, "installation allocation exceeds bound")
    need(sys.platform == "linux" and os.getuid() == 0 and pwd is not None, "fixed root-side Linux materializer required")
    account = pwd.getpwnam("portcove-native")
    need(account.pw_uid > 0 and account.pw_uid != plan["broker_uid"] and account.pw_gid > 0
         and account.pw_dir == "/home/portcove-native" and account.pw_shell == "/usr/sbin/nologin",
         "prepared separate qualification account missing")
    need(not any(os.path.lexists(ROOT / name) for name in ("controller", "tools", "hosted-install-intent.json")),
         "retained installation requires explicit recovery, never reuse")
    for directory in (Path(account.pw_dir), ROOT):
        info = directory.lstat()
        need(directory.resolve(strict=True) == directory and stat.S_ISDIR(info.st_mode)
             and info.st_uid == account.pw_uid and not info.st_mode & 0o077,
             "prepared private installation ancestry differs")
    need(command(["/usr/bin/passwd", "-S", "portcove-native"], check).split()[1] == "L", "qualification account is not locked")
    source = WORKSPACE / "native-source"
    need(source.resolve(strict=True) == source and (source / ".git").is_dir()
         and not (source / ".git").is_symlink(), "independent native checkout required")
    need(not any(os.path.lexists(source / name) for name in
                 (".git/commondir", ".git/objects/info/alternates", ".git/shallow.lock")),
         "external or incomplete source Git storage refused")
    need(git(["-C", str(source), "rev-parse", "HEAD"], check) == plan["source_commit"]
         and git(["-C", str(source), "rev-parse", "HEAD^{tree}"], check) == plan["source_tree"]
         and not git(["-C", str(source), "status", "--porcelain", "--untracked-files=no"], check), "native checkout differs from independent pins")
    owners = (0, plan["broker_uid"])
    harness = read_regular(source / "apps/desktop/scripts/desktop-test.mts", 1024 ** 2, owners, check)
    need(hashlib.sha256(harness).hexdigest() == plan["harness_sha256"], "independent native harness differs")
    intent = Path("/opt/portcove-native-readiness/profile-intent.json")
    setup = json.loads(read_regular(intent, 524288, (0,), check))
    need(all(setup["context"].get(key) == value for key, value in plan["context"].items()), "root setup belongs to another original job")
    for filename in ("/usr/bin/WebKitWebDriver", "/usr/bin/Xvfb"):
        read_regular(Path(filename).resolve(strict=True), 128 * 1024 ** 2, (0,), check)
    records, total = dependency_snapshot(source, owners, check)
    tools = {}
    for name, wanted in plan["tools"].items():
        data = read_regular(wanted["path"], 128 * 1024 ** 2, owners, check)
        need(len(data) == wanted["bytes"] and hashlib.sha256(data).hexdigest() == wanted["sha256"], "admitted tool bytes changed")
        tools[name] = data
    check()
    # First exclusive mutation; every later partial effect remains under this intent.
    with (ROOT / "hosted-install-intent.json").open("xb") as output:
        output.write(json.dumps(plan, separators=(",", ":")).encode())
    destination = ROOT / "controller"
    git(["clone", "--quiet", "--no-local", "--no-hardlinks", "--depth=1", "--no-checkout", "--template=", str(source), str(destination)], check)
    need(not (destination / ".git/objects/info/alternates").exists(), "shared Git objects refused")
    git(["-C", str(destination), "checkout", "--quiet", "--detach", plan["source_commit"]], check)
    for directory, folders, files in os.walk(destination, followlinks=False):
        check()
        os.chown(directory, account.pw_uid, account.pw_gid)
        for name in files + folders:
            check()
            os.chown(Path(directory) / name, account.pw_uid, account.pw_gid, follow_symlinks=False)
    copy_dependencies(source, destination, records, owners, account.pw_uid, account.pw_gid, check)
    tool_directory = ROOT / "tools"
    tool_directory.mkdir(mode=0o755)
    for name, data in tools.items():
        check()
        filename = tool_directory / ("node" if name == "node" else "tauri-driver")
        with filename.open("xb") as output:
            output.write(data)
        filename.chmod(0o555)
    check()
    verify_installed_source(destination, plan, check)
    need(git(["-C", str(source), "rev-parse", "HEAD"], check) == plan["source_commit"]
         and git(["-C", str(source), "rev-parse", "HEAD^{tree}"], check) == plan["source_tree"]
         and not git(["-C", str(source), "status", "--porcelain", "--untracked-files=no"], check), "native source changed during installation")
    need(hashlib.sha256(read_regular(destination / "apps/desktop/scripts/desktop-test.mts", 1024 ** 2,
                                    (0, account.pw_uid), check)).hexdigest() == plan["harness_sha256"], "installed native harness differs")
    installed_records, installed_total = dependency_snapshot(destination, (0, account.pw_uid), check)
    need(sorted(installed_records) == sorted(records) and installed_total == total,
         "installed dependency graph/bytes differ")
    final_records, final_total = dependency_snapshot(source, owners, check)
    need(sorted(final_records) == sorted(records) and final_total == total,
         "source dependency graph/bytes changed")
    for name, wanted in plan["tools"].items():
        filename = tool_directory / ("node" if name == "node" else "tauri-driver")
        observed = read_regular(filename, 128 * 1024 ** 2, (0,), check)
        need(len(observed) == wanted["bytes"] and hashlib.sha256(observed).hexdigest() == wanted["sha256"],
             "installed tool bytes differ")
    check()
    return {"schema_version": 1, "binding": plan["binding"], "source_commit": plan["source_commit"],
            "source_tree": plan["source_tree"], "uid": account.pw_uid, "gid": account.pw_gid,
            "dependency_files": len(records), "dependency_bytes": total, "children_settled": True,
            "installed": True, "native_acceptance": "not-established", "authority": "none"}


if __name__ == "__main__":
    try:
        need(len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 8192, "one bounded fixed installation plan required")
        result = install(inspect_plan(json.loads(sys.argv[1])))
    except BaseException as error:
        print(json.dumps({"installed": False, "failure": str(error)[:1024], "partial_effects_retained": True,
                          "automatic_retry": False, "authority": "none"}))
        sys.exit(1)
    print(json.dumps(result, separators=(",", ":")))
