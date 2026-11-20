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


def observe(bundle, helper, evidence, architecture, cpu, env, stage):
    report = {"stage": stage, "native_architecture": architecture}
    try:
        result = subprocess.run(
            (str(helper), str(bundle), str(cpu)), env=env,
            capture_output=True, text=True, timeout=90,
        )
        report["observer_exit"] = result.returncode
        if result.stdout:
            report.update(json.loads(result.stdout))
        report["library"] = library_status(Path(env["PORTCOVE_LIBRARY"]) / "portcove.sqlite3")
        require(result.returncode == 0 and report.get("terminated") is True,
                f"AppKit did not establish the attributed normal lifecycle ({stage})")
        require(report["library"]["ready"], f"Private Core library is not ready after normal quit ({stage})")
    finally:
        (evidence / f"{stage}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    return report


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
        checked(
            "/usr/bin/swiftc", "-parse-as-library", "scripts/verify-published-macos-owned-window.swift",
            "-o", str(helper), timeout=90,
        )
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
        fresh = observe(bundle, helper, evidence, architecture, cpu, env, "fresh-start")
        library = Path(env["PORTCOVE_LIBRARY"]) / "portcove.sqlite3"
        library_inode = library.stat().st_ino
        reopened = observe(bundle, helper, evidence, architecture, cpu, env, "reopen")
        require(reopened["pid"] != fresh["pid"], "Reopen must observe a distinct application instance")
        require(library.stat().st_ino == library_inode, "Reopen did not retain the private library database")
        require(sha256(executable) == executable_digest, "Executable changed during the native witness")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
