"""Read-only admission for the exact authenticated AppImage with no app launch."""
import hashlib
import json
import os
import select
import stat
import subprocess
import sys
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
out = output / "ordinary-package-mount.json"
process = None
try:
    process = subprocess.Popen([app, "--appimage-mount"], stdout=subprocess.PIPE, text=False)
    if not select.select([process.stdout], [], [], 20)[0]:
        raise RuntimeError("FUSE mount did not announce a path")
    mount = process.stdout.readline(4096).decode("utf-8").strip()
    directory = Path(mount)
    if not directory.is_absolute() or not directory.name.startswith(".mount_"):
        raise RuntimeError("Unexpected AppImage mount path")
    records = []
    for row in Path("/proc/self/mountinfo").read_text().splitlines():
        before, after = row.split(" - ", 1)
        fields = before.split()
        if fields[4] != mount:
            continue
        filesystem, source, _ = after.split(" ", 2)
        records.append({"fs": filesystem, "source": source, "device": fields[2]})
    if len(records) != 1 or not records[0]["fs"].startswith("fuse"):
        raise RuntimeError("No unique ordinary FUSE filesystem belongs to the owned runtime")
    binaries = directory / "usr/bin"
    report["mount"] = records[0]
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
    with out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps(report))
sys.exit(0 if report["outcome"] == "passed" else 1)
