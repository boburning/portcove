"""Observe an exact signed package's native startup and ordinary quit on a hosted Mac."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

CPU = {"macos-15": ("arm64", 0x0100000C), "macos-15-intel": ("x86_64", 0x01000007)}
PREVIEW_11_LIBRARY_SCHEMA = 72
LIBRARY_TABLES = {"installs", "activity_history", "definition_subject_selection"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked(*command, timeout=20):
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


def unpack(archive, root):
    with tarfile.open(archive, "r|gz", errorlevel=2) as bundle:
        seen = set()
        total = 0
        for item in bundle:
            path = PurePosixPath(item.name)
            require(
                path.parts and path.parts[0] == "Portcove.app" and ".." not in path.parts
                and path not in seen and len(seen) < 128 and (item.isdir() or item.isfile()),
                "Unexpected signed application archive member",
            )
            seen.add(path)
            require(0 <= item.size <= 256 * 1024 * 1024, "Application member exceeds its bound")
            total += item.size
            require(total <= 256 * 1024 * 1024, "Application bundle exceeds its bound")
            bundle.extract(item, root, filter="data")


def library_status(database):
    if not database.is_file():
        return {"ready": False, "reason": "database_absent"}
    try:
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1) as db:
            db.execute("BEGIN")
            tables = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "schema_migrations" not in tables:
                return {"ready": False, "reason": "schema_migration_ledger_absent"}
            versions = [version for (version,) in db.execute("SELECT version FROM schema_migrations ORDER BY version")]
    except sqlite3.OperationalError as error:
        return {"ready": False, "reason": type(error).__name__}
    missing = sorted(LIBRARY_TABLES - tables)
    ready = versions == list(range(1, PREVIEW_11_LIBRARY_SCHEMA + 1)) and not missing
    return {"ready": ready, "schema_version": max(versions, default=0), "missing_core_tables": missing}


def observe(executable, helper, run_dir, evidence, architecture, cpu, env, stage):
    started = time.time()
    protocol = str(started)
    with (run_dir / f"{stage}.stdout").open("wb") as stdout, (run_dir / f"{stage}.stderr").open("wb") as stderr:
        app = subprocess.Popen([str(executable)], cwd=run_dir, stdout=stdout, stderr=stderr, env=env)
        observed = {"pid": app.pid, "stage": stage, "native_architecture": architecture}
        try:
            args = (str(app.pid), str(executable), str(cpu), protocol)
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline and app.poll() is None:
                proof = subprocess.run(
                    (str(helper), "window", *args, "-"), capture_output=True, text=True, timeout=5
                )
                observed["last_native_probe_exit"] = proof.returncode
                observed["library"] = library_status(Path(env["PORTCOVE_LIBRARY"]) / "portcove.sqlite3")
                require(proof.returncode in (0, 2, 3), f"Native window probe failed ({stage})")
                if proof.returncode == 0:
                    count, reported_cpu, birth = proof.stdout.split()
                    require(int(reported_cpu) == cpu and int(count) > 0, "Native executable architecture or window differs")
                    observed.update(owned_windows=int(count), cocoa_launch_date=birth)
                    if observed["library"]["ready"]:
                        break
                time.sleep(0.3)
            require("owned_windows" in observed and observed["library"]["ready"],
                    f"Did not observe the exact native window and private library ({stage})")
            require(app.poll() is None, f"Application exited before the Cocoa quit ({stage})")
            checked(str(helper), "quit", *args, observed["cocoa_launch_date"], timeout=10)
            require(app.wait(timeout=20) == 0, f"Application exited unsuccessfully after Cocoa quit ({stage})")
            observed.update(quit="NSRunningApplication.terminate", exit_code=app.returncode, forced_cleanup=False)
        finally:
            if app.poll() is None:
                observed["forced_cleanup"] = True
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait(timeout=5)
            observed["exit_code"] = app.returncode
            (evidence / f"{stage}.json").write_text(json.dumps(observed, indent=2) + "\n", encoding="utf8")


def main(evidence, package):
    runner = os.environ["MACOS_RUNNER"]
    architecture, cpu = CPU[runner]
    require(platform.system() == "Darwin" and platform.machine() == architecture, "Wrong native macOS host")
    require(os.environ["GITHUB_ACTIONS"] == "true" and os.environ["RUNNER_ENVIRONMENT"] == "github-hosted"
            and os.environ["GITHUB_REPOSITORY"] == "boburning/portcove"
            and os.environ["GITHUB_SHA"] == checked("git", "rev-parse", "HEAD"),
            "Wrong native evidence scope")
    binding = json.loads((evidence / "published-binding.json").read_bytes())
    archive = package / binding["archive_name"]
    require(sha256(archive) == binding["archive"]["sha256"], "Verified archive changed before extraction")
    with tempfile.TemporaryDirectory(dir=os.environ["RUNNER_TEMP"], prefix="published-macos-") as directory:
        work = Path(directory).resolve()
        unpack(archive, work)
        bundle = work / "Portcove.app"
        info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
        require((info["CFBundleIdentifier"], info["CFBundleShortVersionString"], info["CFBundleExecutable"]) ==
                ("io.github.portcove.portcove", binding["version"], "portcove-desktop"), "Incorrect signed application identity")
        executable = bundle / "Contents/MacOS/portcove-desktop"
        executable_digest = binding["desktop_executable"]["sha256"]
        require(executable.stat().st_size == binding["desktop_executable"]["bytes"]
                and sha256(executable) == executable_digest, "Signed extracted executable differs")
        require(set(checked("/usr/bin/lipo", "-archs", str(executable)).split()) == {"arm64", "x86_64"},
                "Signed Desktop package is missing a native slice")
        checked("/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle))
        helper = work / "observe-window"
        checked("/usr/bin/swiftc", "scripts/verify-published-macos-owned-window.swift", "-o", str(helper), timeout=90)
        cocoa_home = work / "private-cocoa-home"
        cocoa_home.mkdir(mode=0o700)
        env = dict(os.environ)
        for secret in ("GH_TOKEN", "GITHUB_TOKEN", "PORTCOVE_GITHUB_TOKEN"):
            env.pop(secret, None)
        env.update(CFFIXED_USER_HOME=str(cocoa_home), PORTCOVE_LIBRARY=str(work / "library"),
                   PORTCOVE_PREFERENCES=str(work / "preferences.json"),
                   PORTCOVE_APPLICATION_UPDATE_PREFERENCES=str(work / "updater-preferences.json"),
                   PORTCOVE_APPLICATION_RUNTIME_LOCK=str(work / "desktop.lock"))
        host = {"runner": runner, "architecture": architecture, "system": checked("/usr/bin/sw_vers"),
                "harness_sha": os.environ["GITHUB_SHA"], "run": os.environ["GITHUB_RUN_ID"],
                "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "bundle_version": binding["version"],
                "desktop_sha256": executable_digest}
        (evidence / "host.json").write_text(json.dumps(host, indent=2) + "\n", encoding="utf8")
        observe(executable, helper, work, evidence, architecture, cpu, env, "fresh-start")
        observe(executable, helper, work, evidence, architecture, cpu, env, "reopen")
        require(sha256(executable) == executable_digest, "Executable changed during the native witness")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
