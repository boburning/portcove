"""Small causal controls: no network, package execution, VM or host mutation."""

import copy
import hashlib
import os
import tempfile
from pathlib import Path

from common import require, verified_admission
from evidence import copy_public_file
from prepare import COHORT, admit_provider
from qualification_archive import controls as archive_controls


def refused(action):
    try:
        action()
    except (RuntimeError, OSError):
        return
    raise AssertionError("Unsafe input was admitted")


def controls():
    archive_controls()
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
