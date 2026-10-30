"""Explicit bounded public diagnostics; never archive a VM disk or private profile."""

import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

from common import hosted_context, identity, publish, require


def copy_public_file(root, relative, destination, maximum=8 * 1024**2):
    """Walk held directory descriptors without following guest-controlled links."""
    parts = relative.parts
    require(
        parts and not relative.is_absolute() and all(p not in ("", ".", "..") for p in parts),
        "Direct public relative path required",
    )
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(descriptor, "rb") as reader:
        before = os.fstat(reader.fileno())
        require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
            "Public file type/size bound",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        sha = hashlib.sha256()
        total = 0
        with destination.open("xb") as writer:
            while block := reader.read(min(1024 * 1024, maximum + 1 - total)):
                total += len(block)
                require(total <= before.st_size <= maximum, "Public input grew beyond bound")
                writer.write(block)
                sha.update(block)
            writer.flush()
            os.fsync(writer.fileno())
        after = os.fstat(reader.fileno())
        require(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            "Public input changed during copy",
        )
        require(total == before.st_size, "Public input truncated during copy")
    return {"path": str(relative), "bytes": total, "sha256": sha.hexdigest()}


def retain(root, context):
    output = root / "public-evidence"
    require(not output.exists(), "Never replace evidence")
    output.mkdir(mode=0o700)
    files = []
    root_names = [
        "tuple.json",
        "helper.json",
        "runtime.json",
        "launch-inputs.json",
        "artifact-download.status.json",
        "helper-build.status.json",
        "helper-build.stdout.txt",
        "helper-build.stderr.txt",
        "qemu-system-x86_64-version.status.json",
        "qemu-system-x86_64-version.stdout.txt",
        "qemu-system-x86_64-libraries.status.json",
        "qemu-system-x86_64-libraries.stdout.txt",
        "qemu-img-version.status.json",
        "qemu-img-version.stdout.txt",
        "qemu-img-libraries.status.json",
        "qemu-img-libraries.stdout.txt",
        "host-packages.stdout.txt",
        "host-packages.status.json",
        "rustc-version.stdout.txt",
        "rustc-version.status.json",
        "cargo-version.stdout.txt",
        "cargo-version.status.json",
        "keyring-package-receipt.json",
    ]
    files += [root / name for name in root_names]
    files += [root / "public-inputs/inputs.json", root / "public-inputs/configuration.json"]
    cohort = json.loads((Path(__file__).parent / "cohort.json").read_bytes())
    files += [root / "public-inputs" / row["path"] for row in cohort["files"] if row["bytes"] <= 65536]
    files += [
        root / "image" / name
        for name in [
            "image-receipt.json",
            "SHA256SUMS",
            "SHA256SUMS.gpg",
            "gpgv.stdout.txt",
            "gpgv.stderr.txt",
            "gpgv.status.json",
            "keyring-package.status.json",
            "keyring-package.stderr.txt",
        ]
    ]
    run = root / "guest-run"
    files += [
        run / name
        for name in [
            "qemu-start.json",
            "qemu-outcome.json",
            "result.json",
            "serial.log",
            "qemu.stdout",
            "qemu.stderr",
            "create-disk.status.json",
            "create-disk.stdout",
            "create-disk.stderr",
            "qemu-version.status.json",
            "qemu-version.stdout",
            "qemu-version.stderr",
            "qemu-img-version.status.json",
            "qemu-img-version.stdout",
            "qemu-img-version.stderr",
            "seed-user-data",
            "seed-meta-data",
            "seed-vendor-data",
            "seed-network-config",
            "seed-manifest.json",
        ]
    ]
    reports = run / "reports"
    files += [reports / name for name in ["checkpoint.stdout", "checkpoint.stderr", "recover.stdout", "recover.stderr"]]
    allowed = {
        "checkpoint.json",
        "reboot-recovery.json",
        "update-preferences.json",
        "host-preferences.json",
        "schedule.json",
        "startup-stage.json",
        "os-release.txt",
        "boot-id.txt",
        "cell-unit.txt",
        "cloud-final-unit.txt",
        "cloud-init-target.txt",
        "phase-status.json",
        "update-state-apply.json",
        "update-state-staging.json",
    }
    for label in [
        "installed-stage",
        "prepare-staged",
        "interrupted-apply",
        "displayless-recovery",
        "packages",
        "kernel",
        "mounts",
    ]:
        allowed |= {label + suffix for suffix in [".stdout.txt", ".stderr.txt", ".status.json", ".stdout", ".stderr"]}
    for phase in ["checkpoint", "recover"]:
        files += [reports / phase / name for name in sorted(allowed)]
    manifest = []
    total = 0
    for source in files:
        relative = source.relative_to(root)
        try:
            observed = copy_public_file(root, relative, output / relative)
        except FileNotFoundError:
            continue
        total += observed["bytes"]
        require(total <= 32 * 1024**2, "Public evidence total bound")
        manifest.append(observed)
    for name in [
        "common.py",
        "prepare.py",
        "image.py",
        "qualification_archive.py",
        "controller.py",
        "guest.py",
        "evidence.py",
        "cohort.json",
        "controls.py",
    ]:
        source = Path(__file__).parent / name
        destination = output / "controller-source" / name
        destination.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, destination)
        observed = identity(destination)
        total += observed["bytes"]
        require(total <= 32 * 1024**2, "Public evidence total bound")
        manifest.append({**observed, "path": "controller-source/" + name})
    publish(
        output / "public-manifest.json",
        {
            **context,
            "files": manifest,
            "bytes": total,
            "recovery_result_present": (run / "result.json").is_file(),
            "scope": "Explicit public input/status/seed/boot/journal reports only; VM/base disks, raw artifact, GPG/private homes, SSH keys, binaries and private transport stderr excluded. Presence is not acceptance.",
        },
    )
    print("Bounded public evidence retained; inspect actual phase statuses and reboot result")


if __name__ == "__main__":
    workspace, root = hosted_context()
    retain(
        root,
        {
            "controller_source": os.environ["GITHUB_SHA"],
            "run": os.environ["GITHUB_RUN_ID"],
            "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        },
    )
