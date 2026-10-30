"""Small causal controls: no network, package execution, VM or host mutation."""

import ast
import configparser
import copy
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from common import identity, require, verified_admission
from evidence import copy_public_file
from prepare import COHORT, admit_provider
from qualification_archive import controls as archive_controls


def refused(action):
    try:
        action()
    except (RuntimeError, OSError):
        return
    raise AssertionError("Unsafe input was admitted")


def guest_unit_controls():
    """Verify inert boot transactions; never load units into the host manager.

    The pinned Ubuntu26 cloud-final service runs after multi-user.target.
    Preserve those ordering clauses, both boot branches and systemd's actual
    default target dependency handling. Executables are inert and never run.
    """
    tool = Path("/usr/bin/systemd-analyze").resolve()
    version = subprocess.run(
        [str(tool), "--version"], capture_output=True, timeout=10, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    )
    require(
        version.returncode == 0 and len(version.stdout) + len(version.stderr) <= 65536,
        "Static verifier version unavailable",
    )
    print(
        json.dumps(
            {
                "static_guest_ordering_tool": identity(tool),
                "version": version.stdout.decode(),
                "version_stderr": version.stderr.decode(),
            }
        ),
        flush=True,
    )
    source = Path(__file__).with_name("controller.py").read_bytes()
    assignments = [
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "unit" for target in node.targets)
    ]
    require(len(assignments) == 1, "One actual guest service template required")
    unit = ast.literal_eval(assignments[0].value)
    parsed = configparser.ConfigParser()
    parsed.read_string(unit)
    wanted = parsed["Install"]["WantedBy"]
    counterexample = unit.replace("WantedBy=" + wanted, "WantedBy=multi-user.target")
    rows = []
    with tempfile.TemporaryDirectory(prefix="portcove-unit-ordering-") as directory:
        for label, text, expected_cycle in [("current", unit, False), ("old-target", counterexample, True)]:
            root = Path(directory) / label
            units = root / "etc/systemd/system"
            units.mkdir(parents=True)
            (root / "bin").mkdir()
            inert = root / "bin/true"
            inert.write_text("#!/bin/sh\nexit 0\n")
            inert.chmod(0o755)
            (units / "default.target").write_text(
                "[Unit]\nDescription=Inert boot anchor\nRequires=multi-user.target cloud-init.target\n"
            )
            for name in ["multi-user.target", "cloud-init.target", "network-online.target"]:
                (units / name).write_text(
                    "[Unit]\nDescription=Inert ordering fixture\n"
                    + ("After=multi-user.target\n" if name == "cloud-init.target" else "")
                )
            for name in ["sysinit.target", "basic.target", "shutdown.target"]:
                (units / name).write_text("[Unit]\nDescription=Inert base fixture\nDefaultDependencies=no\n")
            (units / "cloud-final.service").write_text(
                "[Unit]\nDescription=Pinned cloud-final ordering\nAfter=multi-user.target\n"
                "[Service]\nType=oneshot\nExecStart=/bin/true\n"
            )
            (units / "portcove-reboot-cell.service").write_text(
                text.replace("ExecStart=/usr/local/lib/portcove-cell.sh", "ExecStart=/bin/true")
            )
            settings = configparser.ConfigParser()
            settings.read_string(text)
            for target, service in [
                (settings["Install"]["WantedBy"], "portcove-reboot-cell.service"),
                ("cloud-init.target", "cloud-final.service"),
            ]:
                links = units / (target + ".wants")
                links.mkdir(exist_ok=True)
                (links / service).symlink_to("../" + service)
            arguments = [str(tool), "--root=" + str(root), "--generators=no", "--man=no", "verify", "default.target"]
            result = subprocess.run(
                arguments,
                capture_output=True,
                timeout=10,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "SYSTEMD_LOG_LEVEL": "warning"},
            )
            require(len(result.stdout) + len(result.stderr) <= 65536, "Static verifier diagnostic bound")
            row = {
                "case": label,
                "code": result.returncode,
                "expected_cycle": expected_cycle,
                "stdout": result.stdout.decode(),
                "stderr": result.stderr.decode(),
            }
            rows.append(row)
            # This verifier can return OS0 after deleting an optional start job.
            # The original diagnostic, rather than exit status alone, is causal.
            print(json.dumps({"static_guest_ordering": row}), flush=True)
            if expected_cycle:
                require(result.returncode in (0, 1), "Static negative verifier did not complete")
                require(
                    "ordering cycle" in row["stderr"].lower()
                    and "deleted to break ordering cycle" in row["stderr"]
                    and all(
                        name in row["stderr"]
                        for name in ["portcove-reboot-cell.service", "cloud-final.service", "multi-user.target"]
                    ),
                    "Old target no longer reproduces the boot cycle and dropped job",
                )
            else:
                require(result.returncode == 0, "Static positive verifier did not complete")
                require(not row["stderr"], "Current guest service has a boot ordering diagnostic")
    require(unit != counterexample and len(rows) == 2, "Both distinct ordering controls must execute")


def controls():
    archive_controls()
    guest_unit_controls()
    raw = b'{"source":"frozen"}\n'
    digest = hashlib.sha256(raw).hexdigest()
    require(verified_admission(raw, digest) == {"source": "frozen"}, "Valid admission refused")
    refused(lambda: verified_admission(raw + b" ", digest))
    run = {
        "id": COHORT["run"],
        "head_sha": COHORT["source"],
        "run_attempt": COHORT["attempt"],
        "workflow_id": COHORT["workflow_id"],
        "status": "completed",
        "conclusion": "success",
    }
    artifact = {
        "id": COHORT["artifact"],
        "expired": False,
        "workflow_run": {"id": COHORT["run"], "head_sha": COHORT["source"]},
        "size_in_bytes": COHORT["archive_bytes"],
        "digest": "sha256:" + COHORT["archive_sha256"],
    }
    admit_provider(run, artifact)
    for key, wrong in [("head_sha", "0" * 40), ("run_attempt", 2), ("conclusion", "failure"), ("workflow_id", 1)]:
        changed = copy.deepcopy(run)
        changed[key] = wrong
        refused(lambda changed=changed: admit_provider(changed, artifact))
    for key, wrong in [
        ("expired", True),
        ("size_in_bytes", COHORT["archive_bytes"] + 1),
        ("digest", "sha256:" + "0" * 64),
    ]:
        changed = copy.deepcopy(artifact)
        changed[key] = wrong
        refused(lambda changed=changed: admit_provider(run, changed))
    changed = copy.deepcopy(artifact)
    changed["workflow_run"]["head_sha"] = "0" * 40
    refused(lambda changed=changed: admit_provider(run, changed))
    with tempfile.TemporaryDirectory(prefix="portcove-public-controls-") as folder:
        root = Path(folder)
        source = root / "source"
        output = root / "output"
        source.mkdir()
        output.mkdir()
        (source / "valid").write_bytes(b"abcd")
        result = copy_public_file(source, Path("valid"), output / "valid", maximum=4)
        require(result["bytes"] == 4 and (output / "valid").read_bytes() == b"abcd", "Bounded public copy failed")
        (source / "large").write_bytes(b"abcde")
        refused(lambda: copy_public_file(source, Path("large"), output / "large", maximum=4))
        require(not (output / "large").exists(), "Oversize input published before rejection")
        (source / "link").symlink_to(source / "valid")
        refused(lambda: copy_public_file(source, Path("link"), output / "link"))
        (source / "parent").symlink_to(source, target_is_directory=True)
        refused(lambda: copy_public_file(source, Path("parent/valid"), output / "parent-valid"))
        os.link(source / "valid", source / "hardlink")
        refused(lambda: copy_public_file(source, Path("hardlink"), output / "hardlink"))
        refused(lambda: copy_public_file(source, Path("../source/valid"), output / "escape"))
    print("Manifest admission, frozen provider, public-file privacy and raw archive controls passed")


if __name__ == "__main__":
    controls()
