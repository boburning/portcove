"""Fixed disposable-host materialization. No guest code runs with root authority.

The authenticated original parent supplies pins; this JSON never grants authority.
Fixed runtime inputs precede account/profile setup; materialization requires it.
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
RUNTIME_PACKAGES = ("bubblewrap", "libwebkit2gtk-4.1-0", "webkit2gtk-driver", "xvfb",
                    "x11-xkb-utils", "dbus-user-session", "dbus-x11", "at-spi2-core",
                    "libfuse2t64", "libayatana-appindicator3-1")
RUNTIME_EXECUTABLES = ("/usr/bin/bwrap", "/usr/bin/WebKitWebDriver", "/usr/bin/Xvfb",
                       "/usr/bin/xkbcomp", "/usr/bin/dbus-run-session")
PROFILE_VERSION = "4.0.1really4.0.1-0ubuntu0.24.04.9"
PROFILE_DEB = f"apparmor-profiles_{PROFILE_VERSION}_all.deb"
PROFILE_DEB_SHA256 = "90b02aa006eea7702cd4e851343e469e41365dda42145a3cb035de1d6c773b8c"
PROFILE_SHA256 = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
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


def inspect_runtime_inputs_plan(raw):
    """Correlation for fixed package preparation; never execution authority."""
    need(isinstance(raw, dict) and set(raw) == {"schema_version", "binding", "broker_uid", "broker_pid",
         "broker_identity", "deadline_ns", "context"}, "runtime input plan differs")
    need(type(raw["schema_version"]) is int and raw["schema_version"] == 1
         and isinstance(raw["binding"], str) and re.fullmatch(r"[a-f0-9]{64}", raw["binding"]), "runtime input binding differs")
    for name in ("broker_uid", "broker_pid"):
        need(type(raw[name]) is int and 0 < raw[name] < 2 ** 32, "runtime input broker differs")
    need(isinstance(raw["broker_identity"], str) and re.fullmatch(r"linux:[a-f0-9-]{36}:[1-9][0-9]*:[1-9][0-9]*", raw["broker_identity"])
         and isinstance(raw["deadline_ns"], str) and re.fullmatch(r"[1-9][0-9]{0,19}", raw["deadline_ns"]), "runtime input fence differs")
    context = raw["context"]
    need(isinstance(context, dict) and set(context) == {"GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF"}
         and all(isinstance(value, str) for value in context.values()), "runtime input context differs")
    workflow = r"boburning/portcove/\.github/workflows/(application-update-production.yml@refs/tags/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}|hosted-native-linux-readiness.yml@refs/heads/(main|feature/534-[a-z0-9-]+))"
    need(re.fullmatch(r"[a-f0-9]{40}", context["GITHUB_SHA"]) and re.fullmatch(r"[1-9][0-9]*", context["GITHUB_RUN_ID"])
         and context["GITHUB_RUN_ATTEMPT"] == "1" and re.fullmatch(workflow, context["GITHUB_WORKFLOW_REF"]), "runtime input job differs")
    return raw


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


def command(arguments, check, maximum_file_bytes=None, maximum_output_bytes=65536, environment=None, as_bytes=False, cwd=None):
    check()
    if maximum_file_bytes is not None:
        arguments = ["/usr/bin/prlimit", f"--fsize={maximum_file_bytes}", "--", *arguments]
    child = subprocess.Popen(arguments, env=ENV if environment is None else environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True, cwd=cwd)
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
        need(code == 0, f"fixed installation command refused: exit={code}")
        check()
        data = bytes(output["out"])
        return data if as_bytes else data.decode("utf-8").strip()
    except BaseException as error:
        error.installation_stdout = bytes(output["out"])
        error.installation_stderr = bytes(output["err"])
        raise
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


def prepare_source_dependencies(plan, settings):
    """One frozen, hook-free install using the originally admitted native tool."""
    def check():
        fence(plan)
    check()
    need(os.getuid() == plan["broker_uid"] != 0, "original dependency broker required")
    need(0 < int(plan["deadline_ns"]) - time.monotonic_ns() <= 90_000_000_000,
         "dependency preparation allocation exceeds bound")
    need(isinstance(settings, dict) and set(settings) == {"pnpm", "workspace_sha256", "patches"},
         "validated dependency configuration absent")
    pnpm = settings["pnpm"]
    # Reuse the closed tool identity validator; this does not mint admission.
    inspect_plan({**plan, "tools": {"node": pnpm, "driver": pnpm}})
    source = WORKSPACE / "native-source"
    verify_installed_source(source, plan, check)
    owners = (0, os.getuid())
    metadata = json.loads(read_regular(source / "package.json", 65536, owners, check))
    need(metadata.get("packageManager") == "pnpm@12.14.0", "native source package-manager pin differs")
    workspace_config = read_regular(source / "pnpm-workspace.yaml", 65536, owners, check)
    need(hashlib.sha256(workspace_config).hexdigest() == settings["workspace_sha256"],
         "semantically validated workspace bytes changed")
    for package in (source, source / "apps/desktop"):
        need(not os.path.lexists(package / ".npmrc"), "source registry overrides are not admitted")
        manifest = json.loads(read_regular(package / "package.json", 65536, owners, check))
        need("pnpm" not in manifest, "manifest package-manager overrides not admitted")
        for field in ("dependencies", "devDependencies", "optionalDependencies"):
            dependencies = manifest.get(field, {})
            need(isinstance(dependencies, dict) and all(isinstance(value, str) and not re.search(
                r"^(file:|link:|git|https?:|ssh:)|^(\.|/)|^[^@:]+/", value)
                and (":" not in value or (value.count(":") == 1 and value.startswith(("npm:", "catalog:", "workspace:"))))
                and (not value.startswith("workspace:") or re.fullmatch(r"workspace:[*~^0-9][0-9.*~^ -]*", value))
                for value in dependencies.values()), "external or Git dependency route not admitted")
    need(isinstance(settings["patches"], list) and len(settings["patches"]) <= 128,
         "validated source patch inventory differs")
    for filename in settings["patches"]:
        need(isinstance(filename, str) and re.fullmatch(r"patches/[A-Za-z0-9_@.+-]+\.patch", filename),
             "source patch path differs")
        read_regular(source / filename, 1024 ** 2, owners, check)
    executable = Path(pnpm["path"])
    pnpm_bytes = read_regular(executable, 64 * 1024 ** 2, owners, check)
    need(len(pnpm_bytes) == pnpm["bytes"] and hashlib.sha256(pnpm_bytes).hexdigest() == pnpm["sha256"],
         "admitted package-manager bytes changed")
    home = WORKSPACE / "native-dependency-home"
    need(not os.path.lexists(home) and not any(os.path.lexists(source / p) for p in DEPENDENCIES),
         "retained dependency attempt requires explicit recovery")
    home.mkdir(mode=0o700)
    with (home / "intent.json").open("x", encoding="utf-8") as output:
        json.dump({"binding": plan["binding"], "source_commit": plan["source_commit"],
                   "pnpm_sha256": pnpm["sha256"], "automatic_retry": False, "authority": "none"}, output)
        output.flush()
        os.fsync(output.fileno())
    environment = {**ENV, "HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
                   "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data"),
                   "PATH": str(Path(plan["tools"]["node"]["path"]).parent) + ":/usr/bin:/bin",
                   "TMPDIR": str(home), "CI": "true", "COREPACK_ENABLE_NETWORK": "0",
                   "npm_config_userconfig": "/dev/null", "npm_config_globalconfig": "/dev/null"}
    need(command([str(executable), "--version"], check, environment=environment) == "12.14.0",
         "native package-manager runtime differs")
    last_inventory = 0
    def install_check():
        nonlocal last_inventory
        check()
        if time.monotonic_ns() - last_inventory < 250_000_000:
            return
        last_inventory = time.monotonic_ns()
        pending = [home, *(source / p for p in DEPENDENCIES if os.path.lexists(source / p))]
        count, total = 0, 0
        while pending:
            check()
            current = pending.pop()
            with os.scandir(current) as children:
                for child in children:
                    count += 1
                    need(count <= MAX_FILES, "dependency preparation inventory exceeds bound")
                    info = child.stat(follow_symlinks=False)
                    total += info.st_size
                    need(total <= MAX_BYTES, "dependency preparation bytes exceed bound")
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(child.path))
    command([str(executable), "--dir", str(source), "install", "--frozen-lockfile", "--ignore-scripts",
             "--ignore-pnpmfile", "--pm-on-fail=error", "--runtime-on-fail=error", "--package-import-method=copy",
             "--store-dir", str(home / "store"), "--registry=https://registry.npmjs.org/",
             "--config.modules-dir=node_modules", "--config.virtual-store-dir=" + str(source / "node_modules/.pnpm"),
             "--config.enable-global-virtual-store=false", "--config.node-linker=isolated",
             "--config.fetch-retries=0", "--config.fetch-timeout=15000", "--reporter=silent"],
            install_check, maximum_file_bytes=128 * 1024 ** 2, environment=environment)
    last_inventory = 0
    install_check()
    need(read_regular(executable, 64 * 1024 ** 2, owners, check) == pnpm_bytes,
         "package-manager bytes changed during install")
    return read_source_dependencies(plan)


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


def runtime_package_snapshot(check):
    rows = command(["/usr/bin/dpkg-query", "--show", "--showformat=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n",
                    *RUNTIME_PACKAGES], check).splitlines()
    packages = {}
    for row in rows:
        fields = row.split("\t")
        need(len(fields) == 4 and fields[0] in RUNTIME_PACKAGES and fields[0] not in packages
             and fields[3].rstrip() == "ii" and fields[2] in ("amd64", "all")
             and re.fullmatch(r"[0-9A-Za-z.+:~_-]{1,128}", fields[1]), "runtime package readback differs")
        packages[fields[0]] = {"version": fields[1], "architecture": fields[2]}
    need(set(packages) == set(RUNTIME_PACKAGES), "runtime package inventory incomplete")
    executables = {}
    for filename in RUNTIME_EXECUTABLES:
        actual = Path(filename).resolve(strict=True)
        data = read_regular(actual, 128 * 1024 ** 2, (0,), check)
        need(actual.stat().st_mode & 0o111, "runtime executable is not executable")
        executables[filename] = {"resolved": str(actual), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return {"packages": packages, "executables": executables}


def prepare_runtime_packages(plan):
    """Fixed Ubuntu inputs only; never execute native source or change policy."""
    directory = WORKSPACE / "work/hosted-linux-package-evidence"
    last_inventory = 0
    inventory_enabled = False
    def check():
        nonlocal last_inventory
        fence(plan)
        if not inventory_enabled or time.monotonic_ns() - last_inventory < 250_000_000:
            return
        last_inventory = time.monotonic_ns()
        pending, count, total = [directory], 0, 0
        while pending:
            fence(plan)
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    count += 1
                    need(count <= 8192, "runtime input inventory exceeds bound")
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        # APT atomically renames/removes partial downloads while
                        # this detector samples. A vanished leaf stores no bytes;
                        # retain its entry count and do not follow an alternative.
                        continue
                    total += info.st_size
                    need(total <= 512 * 1024 ** 2, "runtime input inventory exceeds bound")
                    # APT uses temporary leaf symlinks for mirror/index inputs.
                    # This is a storage detector, not input admission: count the
                    # link itself without reading or traversing its target.
                    need(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode),
                         f"runtime input kind differs: {str(Path(entry.path).relative_to(directory))[:512]} mode={stat.S_IFMT(info.st_mode):o}")
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(entry.path))
    check()
    need(sys.platform == "linux" and os.getuid() == 0, "fixed root-side package preparation required")
    need(0 < int(plan["deadline_ns"]) - time.monotonic_ns() <= 90_000_000_000, "runtime input allocation exceeds bound")
    release = read_regular(Path("/usr/lib/os-release").resolve(strict=True), 16384, (0,), check).decode()
    need(re.search(r"(?m)^ID=ubuntu$", release) and re.search(r'(?m)^VERSION_ID="24.04"$', release),
         "fixed Ubuntu24.04 runtime required")
    sources = Path("/etc/apt/sources.list.d/ubuntu.sources")
    source_bytes = read_regular(sources, 65536, (0,), check)
    need(source_bytes, "Ubuntu archive sources absent")
    if not os.path.lexists(directory.parent):
        directory.parent.mkdir(mode=0o700)
        os.chown(directory.parent, plan["broker_uid"], -1)
    parent_info = directory.parent.lstat()
    need(stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == plan["broker_uid"]
         and not parent_info.st_mode & 0o022 and directory.parent.resolve(strict=True) == directory.parent,
         "original work parent missing or linked")
    need(not os.path.lexists(directory), "retained runtime input attempt requires explicit recovery")
    directory.mkdir(mode=0o755)
    inventory_enabled = True
    def retain(name, value):
        check()
        with (directory / name).open("xb") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        (directory / name).chmod(0o444)
    retain("intent.json", json.dumps({"binding": plan["binding"], "context": plan["context"],
           "ubuntu_sources_sha256": hashlib.sha256(source_bytes).hexdigest(),
           "packages": RUNTIME_PACKAGES, "profile_version": PROFILE_VERSION,
           "automatic_retry": False, "authority": "none"}).encode())
    for name in ("lists", "archives"):
        (directory / name).mkdir(mode=0o755)
        (directory / name / "partial").mkdir(mode=0o700)
    options = ["-o", f"Dir::Etc::sourcelist={sources}", "-o", "Dir::Etc::sourceparts=-",
               "-o", f"Dir::State::lists={directory}/lists/", "-o", f"Dir::Cache::archives={directory}/archives/",
               "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache=",
               "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=15",
               "-o", "Acquire::https::Timeout=15", "-o", "DPkg::Lock::Timeout=5",
               "-o", "Acquire::AllowInsecureRepositories=false",
               "-o", "Acquire::AllowDowngradeToInsecureRepositories=false",
               "-o", "APT::Get::AllowUnauthenticated=false", "-o", "APT::Update::Error-Mode=any"]
    environment = {**ENV, "DEBIAN_FRONTEND": "noninteractive"}
    retain("stage-1-index.json", b'{"operation":"authenticated Ubuntu index update"}')
    command(["/usr/bin/apt-get", *options, "-qq", "update"], check, environment=environment,
            maximum_file_bytes=128 * 1024 ** 2)
    retain("stage-2-packages.json", b'{"operation":"fixed runtime package installation"}')
    command(["/usr/bin/apt-get", *options, "-qq", "install", "--yes", "--no-remove", "--no-install-recommends",
             *RUNTIME_PACKAGES], check, environment=environment, maximum_file_bytes=128 * 1024 ** 2)
    # Download into this retained private attempt; never install the profile package.
    retain("stage-3-profile-download.json", b'{"operation":"exact profile package download"}')
    # RLIMIT_FSIZE covers APT's metadata scratch as well as the download.
    # Keep the same scratch cap as update/install; the archive itself must
    # independently pass the exact 39592-byte/hash guard before extraction.
    command(["/usr/bin/apt-get", *options, "-qq", "download", f"apparmor-profiles={PROFILE_VERSION}"],
            check, environment=environment, cwd=directory, maximum_file_bytes=128 * 1024 ** 2)
    archive = directory / PROFILE_DEB
    data = read_regular(archive, 39592, (0,), check)
    need(len(data) == 39592 and hashlib.sha256(data).hexdigest() == PROFILE_DEB_SHA256,
         "fixed profile archive identity differs")
    # Only authenticated exact reviewed bytes reach these fixed format tools.
    retain("stage-4-profile-extraction.json", b'{"operation":"exact profile extraction"}')
    profile = command(["/bin/bash", "-o", "pipefail", "-c",
                       '/usr/bin/dpkg-deb --fsys-tarfile "$1" | /usr/bin/tar --extract --to-stdout --file=- ./usr/share/apparmor/extra-profiles/bwrap-userns-restrict',
                       "fixed-profile", str(archive)], check, maximum_output_bytes=1936, as_bytes=True)
    need(len(profile) == 1936 and hashlib.sha256(profile).hexdigest() == PROFILE_SHA256,
         "fixed profile input differs")
    retain("bwrap-userns-restrict.apparmor", profile)
    need(read_regular(sources, 65536, (0,), check) == source_bytes, "Ubuntu sources changed during preparation")
    retain("stage-5-readback.json", b'{"operation":"runtime package and executable readback"}')
    snapshot = runtime_package_snapshot(check)
    receipt = {"schema_version": 1, "binding": plan["binding"], "context": plan["context"],
               "ubuntu_sources_sha256": hashlib.sha256(source_bytes).hexdigest(), **snapshot,
               "profile_sha256": PROFILE_SHA256, "prepared": True, "automatic_retry": False,
               "native_acceptance": "not-established", "authority": "none"}
    retain("runtime.json", json.dumps(receipt).encode())
    check()
    return receipt


def read_runtime_packages(plan):
    def check():
        fence(plan)
    directory = WORKSPACE / "work/hosted-linux-package-evidence"
    receipt = json.loads(read_regular(directory / "runtime.json", 65536, (0,), check))
    need(receipt["binding"] == plan["binding"] and receipt["context"] == plan["context"]
         and receipt["prepared"] is True, "runtime inputs belong to another original parent")
    sources = read_regular(Path("/etc/apt/sources.list.d/ubuntu.sources"), 65536, (0,), check)
    need(hashlib.sha256(sources).hexdigest() == receipt["ubuntu_sources_sha256"], "Ubuntu sources changed")
    profile = read_regular(directory / "bwrap-userns-restrict.apparmor", 1936, (0,), check)
    need(len(profile) == 1936 and hashlib.sha256(profile).hexdigest() == PROFILE_SHA256, "runtime profile input changed")
    observed = runtime_package_snapshot(check)
    need(all(receipt[key] == value for key, value in observed.items()), "runtime packages or executable bytes changed")
    return receipt


def install(plan):
    def check():
        fence(plan)
    check()
    need(0 < int(plan["deadline_ns"]) - time.monotonic_ns() <= 120_000_000_000, "installation allocation exceeds bound")
    need(sys.platform == "linux" and os.getuid() == 0 and pwd is not None, "fixed root-side Linux materializer required")
    read_runtime_packages(plan)
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
    preparing = len(sys.argv) == 3 and sys.argv[1] == "--runtime-packages"
    try:
        operation = prepare_runtime_packages if preparing else install
        argument = sys.argv[2] if operation is prepare_runtime_packages else sys.argv[1] if len(sys.argv) == 2 else ""
        need(argument and len(argument.encode()) <= 8192, "one bounded fixed installation plan required")
        raw = (inspect_runtime_inputs_plan if preparing else inspect_plan)(json.loads(argument))
        result = operation(raw)
    except BaseException as error:
        result = {("prepared" if preparing else "installed"): False, "failure": str(error)[:1024], "partial_effects_retained": True,
                  "automatic_retry": False, "authority": "none"}
        # Bounded failure evidence may settle after the operation deadline. It
        # cannot launch another operation or write into another retained attempt.
        if preparing and hasattr(error, "installation_stderr"):
            try:
                directory = WORKSPACE / "work/hosted-linux-package-evidence"
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(descriptor)
                    need(info.st_uid == 0 and not info.st_mode & 0o022, "failure directory custody differs")
                    with os.fdopen(os.open("intent.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor), "rb") as source:
                        info = os.fstat(source.fileno())
                        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_size <= 8192, "failure intent custody differs")
                        data = source.read(8193)
                        need(len(data) <= 8192, "failure intent exceeds bound")
                    intent = json.loads(data)
                    need(intent["binding"] == raw["binding"] and intent["context"] == raw["context"], "failure intent differs")
                    for name in ("stdout", "stderr"):
                        data = getattr(error, "installation_" + name)
                        need(len(data) <= 65536, "failure capture exceeds bound")
                        file = os.open("failed-command." + name + ".bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                       0o600, dir_fd=descriptor)
                        with os.fdopen(file, "wb") as output:
                            output.write(data)
                            output.flush()
                            os.fsync(output.fileno())
                            os.fchmod(output.fileno(), 0o444)
                        result[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                        "prefix": data[:1024].decode("utf-8", "replace")}
                finally:
                    os.close(descriptor)
            except Exception as capture_error:
                result["failure_capture_error"] = str(capture_error)[:256]
        print(json.dumps(result))
        sys.exit(1)
    print(json.dumps(result, separators=(",", ":")))
