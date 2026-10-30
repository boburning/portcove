"""One guest-only checkpoint/recovery cell; no reboot command or host authority.

Uses the existing installed AppImage stage, prepare-staged fixture and displayless
recovery entrypoints. The external guest controller owns actual OS reboot proof.
Synthetic file witnesses here do not qualify an installed game's preservation.
"""

import hashlib
import json
import os
import platform
import stat
import subprocess
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read_json(path, maximum=65536):
    require(path.is_file() and not path.is_symlink(), "JSON must be a direct file")
    require(path.stat().st_size <= maximum, "JSON exceeds cell input bound")
    return json.loads(path.read_bytes())


def identity(path):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, "Expected unlinked regular file")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "bytes": s.st_size,
        "sha256": digest,
        "uid": s.st_uid,
        "gid": s.st_gid,
        "mode": stat.S_IMODE(s.st_mode),
        "device": s.st_dev,
        "inode": s.st_ino,
    }


def boot_identity():
    return {
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "machine_id": Path("/etc/machine-id").read_text().strip(),
        "kernel": platform.release(),
        "uid": os.geteuid(),
        "gid": os.getegid(),
    }


def admit_resume(before, after):
    require(before["boot_id"] != after["boot_id"], "Recovery requires an actual new guest boot")
    for key in ("machine_id", "uid", "gid"):
        require(before[key] == after[key], "Guest or caller identity changed: " + key)


def publish(path, value):
    # Exclusive immutable reports; an earlier failure/checkpoint is never replaced.
    with path.open("x") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def execute(root, label, arguments, environment, expected, timeout=120):
    result = None
    failure = None
    try:
        with (root / (label + ".stdout.txt")).open("xb") as out, (root / (label + ".stderr.txt")).open("xb") as err:
            result = subprocess.run(arguments, env=environment, stdout=out, stderr=err, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as error:
        failure = error
    # Publish even timeout/launch refusal before parsing, assertions or rethrow.
    publish(
        root / (label + ".status.json"),
        {
            "arguments": arguments,
            "code": None if result is None else result.returncode,
            "timed_out": isinstance(failure, subprocess.TimeoutExpired),
            "error": None if failure is None else str(failure),
            "capture_scope": "Raw files; size postchecked after child settlement, not a streaming output cap",
        },
    )
    if failure is not None:
        raise failure
    require(result.returncode == expected, label + " returned unexpected OS status")
    for suffix in (".stdout.txt", ".stderr.txt"):
        require((root / (label + suffix)).stat().st_size <= 1024 * 1024, "Child output exceeded bound")
    return (root / (label + ".stdout.txt")).read_text()


def controls():
    before = {"boot_id": "old", "machine_id": "same", "uid": 1001, "gid": 1001}
    admit_resume(before, {**before, "boot_id": "new"})
    for after in (before, {**before, "boot_id": "new", "machine_id": "other"}, {**before, "boot_id": "new", "uid": 0}):
        try:
            admit_resume(before, after)
        except RuntimeError:
            continue
        raise AssertionError("Unsafe recovery admission accepted")
    print("One positive and three negative boot admission controls passed; no native/reboot claim")


def run(phase, configuration):
    require(phase in ("checkpoint", "recover"), "Unknown cell phase")
    require(os.geteuid() == 1001 and os.getegid() == 1001, "Requires guest's ordinary UID/GID1001")
    caps = next(
        line.split()[1] for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:")
    )
    require(int(caps, 16) == 0 and platform.machine() == "x86_64", "Rootless x86-64 only")
    require(Path("/run/portcove-owned-reboot-guest").is_file(), "Not an admitted owned guest")
    config = read_json(Path(configuration))
    require(config["source_commit"] == "38cc869f1f1db165351d65a9b490d8d35c71dd56", "Wrong product source")
    root = Path(config["state"])
    require(
        root.is_absolute() and root.resolve() == root and root.is_relative_to(Path("/home/portcove")),
        "Guest-owned state only",
    )
    require(root.is_dir() and not root.is_symlink() and root.stat().st_uid == 1001, "Wrong state ownership")
    for name in ("stable", "candidate", "helper"):
        selected = config[name]
        actual = identity(Path(selected["path"]))
        require(
            actual["sha256"] == selected["sha256"] and actual["bytes"] == selected["bytes"],
            name + " bytes do not match the retained input",
        )
    stable, candidate, helper = (config[name]["path"] for name in ("stable", "candidate", "helper"))
    require(identity(Path(stable))["uid"] == 1001, "AppImage not owned by application caller")
    stage = root / "update-state"
    library = root / "library"
    preferences = root / "update-preferences.json"
    swap = Path(stable).parent / (".portcove-appimage-" + config["candidate"]["sha256"][:16] + ".swap")
    # Guest-local allowlist: never inherit host/application/auth/loader/runtime aliases.
    temporary = root / "tmp"
    if phase == "checkpoint":
        temporary.mkdir()
    require(temporary.is_dir() and not temporary.is_symlink(), "Invalid private guest temporary directory")
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/home/portcove",
        "USER": "portcove",
        "LOGNAME": "portcove",
        "LANG": "C.UTF-8",
        "TMPDIR": str(temporary),
    }
    env.update(
        {
            "PORTCOVE_APPLICATION_UPDATE_PREFERENCES": str(preferences),
            "PORTCOVE_APPLICATION_UPDATE_STAGING": str(stage),
            "PORTCOVE_APPLICATION_RUNTIME_LOCK": str(root / "runtime.lock"),
            "PORTCOVE_APPLICATION_UPDATE_SCHEDULE": str(root / "schedule.json"),
            "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT": "after-reconciliation",
            "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE": str(root / "startup-stage.json"),
            "PORTCOVE_LIBRARY": str(library),
            "PORTCOVE_PREFERENCES": str(root / "host-preferences.json"),
        }
    )
    checkpoint_path = root / "checkpoint.json"
    if phase == "checkpoint":
        require(not stage.exists() and not checkpoint_path.exists() and not swap.exists(), "Cell is not fresh")
        selected = json.loads(
            execute(root, "installed-stage", [stable, "--portcove-qualify-update-stage", candidate], env, 0)
        )
        require(
            selected
            == {"version": "0.3.0", "sha256": config["candidate"]["sha256"], "bytes": config["candidate"]["bytes"]},
            "Installed stage identity mismatch",
        )
        prepared = json.loads(
            execute(
                root,
                "prepare-staged",
                [helper, "prepare-staged", "0.1.0", str(preferences), str(stage), str(library)],
                env,
                0,
            )
        )
        require(prepared["candidate_sha256"] == selected["sha256"], "Apply intent selected another payload")
        markers = root / "preserved-witnesses"
        markers.mkdir()
        for name in ("library.txt", "save.txt", "configuration.txt"):
            (markers / name).write_text("Synthetic reboot witness: " + name + "\n")
        execute(
            root,
            "interrupted-apply",
            [stable, "--portcove-apply-update", str(prepared["apply_revision"])],
            {**env, "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT": "during-swap-copy"},
            86,
        )
        partial = identity(swap)
        require(0 < partial["bytes"] < selected["bytes"], "Partial replacement not observed")
        files = [
            Path(stable),
            swap,
            stage / "apply.json",
            stage / "staging.json",
            stage / "candidate.payload",
            preferences,
            *sorted(markers.iterdir()),
        ]
        snapshot = {str(path): identity(path) for path in files}
        require(snapshot[str(stage / "candidate.payload")]["sha256"] == selected["sha256"], "Verified candidate lost")
        publish(
            checkpoint_path,
            {
                "phase": "interrupted-awaiting-guest-reboot",
                "boot": boot_identity(),
                "cap_eff": caps,
                "configuration_sha256": identity(Path(configuration))["sha256"],
                "files": snapshot,
                "scope": "Process interruption86 before normal guest reboot; synthetic witnesses only",
            },
        )
        print("Guest checkpoint retained; external owned guest controller must perform normal OS reboot")
        return
    checkpoint = read_json(checkpoint_path)
    admit_resume(checkpoint["boot"], boot_identity())
    require(
        checkpoint["configuration_sha256"] == identity(Path(configuration))["sha256"],
        "Configuration changed across reboot",
    )
    # Verify original journal, file ownership, bytes and inode before recovery can mutate anything.
    for filename, expected in checkpoint["files"].items():
        require(identity(Path(filename)) == expected, "Checkpoint changed before recovery: " + filename)
    execute(
        root,
        "displayless-recovery",
        [stable, "--application-update-recovery", "recover", "interrupted-appimage"],
        env,
        0,
    )
    apply = read_json(stage / "apply.json")
    require(
        apply["native_launch"] == "failed" and apply["native_replacement"] is None,
        "Recovery did not make attempt retryable",
    )
    require(not swap.exists(), "Verified partial swap retained after recovery")
    for filename, expected in checkpoint["files"].items():
        if filename not in (str(swap), str(stage / "apply.json"), str(stage / "staging.json")):
            require(identity(Path(filename)) == expected, "Recovery changed retained data: " + filename)
    publish(
        root / "reboot-recovery.json",
        {
            "phase": "complete",
            "before": checkpoint["boot"],
            "after": boot_identity(),
            "cap_eff": caps,
            "stable_preserved": True,
            "verified_candidate_retained": True,
            "partial_swap_removed": True,
            "witnesses_preserved": True,
            "recovery_os_exit_code": 0,
            "scope": "Actual guest reboot identity check plus interrupted-copy recovery; no real installed game, power-loss, GUI, host-reboot, Deck or production claim",
        },
    )


if __name__ == "__main__":
    if sys.argv[1:] == ["controls"]:
        controls()
    else:
        require(len(sys.argv) == 3, "usage: guest-reboot-case.py checkpoint|recover CONFIGURATION")
        run(*sys.argv[1:])
