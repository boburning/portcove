"""Read-only admission for the exact authenticated AppImage with no app launch."""
import hashlib
import json
import os
import select
import stat
import subprocess
import sys
import time
from pathlib import Path

root = Path(os.environ["RUNNER_TEMP"]) / "portcove-installed-linux-recovery"
output = Path("work/linux-installed-recovery")
os_version = os.uname()
if os_version.sysname != "Linux" or os_version.machine != "x86_64" or os.geteuid() == 0:
    raise SystemExit("The ordinary hosted x64 Linux account is required")
if os.environ.get("APPIMAGE_EXTRACT_AND_RUN"):
    raise SystemExit("Extraction cannot establish a FUSE mount")
custody = json.loads((output / "package-custody.json").read_text())
app = root / "Portcove.AppImage"
expected = custody["product"]["app"]


def identity(filename):
    entry = filename.lstat()
    if not stat.S_ISREG(entry.st_mode):
        raise RuntimeError("Expected a regular authenticated file")
    with filename.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": str(filename), "bytes": entry.st_size, "sha256": digest}


if identity(app) != expected:
    raise SystemExit("Package bytes changed before mount")
report = {"package": expected, "mode": "ordinary built-in FUSE mount", "outcome": "failed"}
scope = os.environ.get("PORTCOVE_APPIMAGE_MOUNT_SCOPE", "ordinary")
if scope not in ("ordinary", "private"):
    raise SystemExit("Invalid package mount scope")
out = output / f"{scope}-package-mount.json"
process = None
recorded_mount = None


def mount_rows():
    return Path("/proc/self/mountinfo").read_text().splitlines()


try:
    process = subprocess.Popen([app, "--appimage-mount"], stdout=subprocess.PIPE, text=False)
    deadline = time.monotonic() + 20
    announcement = bytearray()
    while b"\n" not in announcement:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise RuntimeError("FUSE mount did not announce a path")
        block = os.read(process.stdout.fileno(), 4096 - len(announcement))
        if not block:
            raise RuntimeError("FUSE mount announcement was incomplete")
        announcement.extend(block)
    mount = bytes(announcement).split(b"\n", 1)[0].decode("utf-8")
    directory = Path(mount)
    if not directory.is_absolute() or not directory.name.startswith(".mount_"):
        raise RuntimeError("Unexpected AppImage mount path")
    records = []
    for row in mount_rows():
        before, after = row.split(" - ", 1)
        fields = before.split()
        if fields[4] != mount:
            continue
        filesystem, source, _ = after.split(" ", 2)
        records.append({"id": fields[0], "path": mount, "fs": filesystem, "source": source, "device": fields[2]})
    if len(records) != 1 or not records[0]["fs"].startswith("fuse"):
        raise RuntimeError("No unique ordinary FUSE filesystem belongs to the owned runtime")
    binaries = directory / "usr/bin"
    recorded_mount = records[0]
    report["mount"] = recorded_mount
    report["bin_names"] = sorted(entry.name for entry in binaries.iterdir())
    report["desktops"] = [
        {"relative": f"usr/bin/{entry.name}", **identity(entry)}
        for entry in binaries.iterdir()
        if entry.name.lower() in {"portcove", "portcove-desktop"}
    ]
    if len(report["desktops"]) != 1:
        raise RuntimeError("Expected exactly one enclosed Portcove Desktop executable")
    if identity(app) != expected:
        raise RuntimeError("Package changed while mounted")
    report["outcome"] = "passed"
finally:
    if process is not None:
        if process.poll() is None:
            process.terminate()
        try:
            report["mounted_process_exit"] = process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            report["mounted_process_exit"] = process.wait(timeout=5)
            report["outcome"] = "failed"
    if recorded_mount is not None:
        deadline = time.monotonic() + 8
        while True:
            retained = any(
                row.split(" - ", 1)[0].split()[0] == recorded_mount["id"]
                and row.split(" - ", 1)[0].split()[4] == recorded_mount["path"]
                for row in mount_rows()
            )
            if not retained or time.monotonic() >= deadline:
                break
            time.sleep(0.05)
        report["owned_mount_retired"] = not retained
        if retained:
            report["outcome"] = "failed"
    with out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps(report))
sys.exit(0 if report["outcome"] == "passed" else 1)
