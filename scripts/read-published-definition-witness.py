"""Read the two selected production definitions without opening a writable library."""

import hashlib
import json
from pathlib import Path
import sqlite3
import sys

SUBJECTS = {
    "chameleon-twist-jp-recompiled": (
        1,
        "7094da5e80069bcd2ce69c6a6ac31027fce2e6d24172e0c21712ecfd4c8ef6b4",
        "beaf84046b4bcbda4cf4ba79246faa688f643e134f35bd4a7cbfa38101624e8d",
    ),
    "dungeon-crawl-stone-soup": (
        3,
        "43ccf30580b9d027274992278e4b2440707f4278db59ea7e929574af3fb27c60",
        "ff36ac51cacb397fa1d006fecc1223fb1d2ba7b47ee9a611bf7a119a0ef7f90f",
    ),
}


def hash_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def observe(database, index_digest, root_digest):
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=1) as db:
        try:
            rows = db.execute(
                """SELECT stable_id, active_json, historical_only
                   FROM definition_subject_selection
                   WHERE namespace = 'official' AND stable_id IN (?, ?)
                   ORDER BY stable_id""",
                tuple(SUBJECTS),
            ).fetchall()
        except sqlite3.OperationalError as error:
            if str(error) in ("no such table: definition_subject_selection", "database is locked"):
                return 3
            raise

    if len(rows) != len(SUBJECTS):
        return 3

    evidence = []
    for stable_id, active_json, historical_only in rows:
        revision, entry_digest, contract_digest = SUBJECTS[stable_id]
        data = json.loads(active_json)
        provenance = data["provenance"]
        snapshot = data["snapshot"]
        if (
            historical_only != 0
            or data["namespace"] != "official"
            or data["stable_id"] != stable_id
            or data["definition_revision"] != revision
            or provenance["index_sha256"] != index_digest
            or provenance["root_version"] != 1
            or provenance["root_sha256"] != root_digest
            or snapshot["namespace"] != "official"
            or snapshot["stable_id"] != stable_id
            or hash_text(snapshot["index_json"]) != index_digest
            or hash_text(snapshot["entry_json"]) != entry_digest
            or hash_text(snapshot["contract_json"]) != contract_digest
        ):
            raise ValueError(f"Persisted definition differs from the reviewed public target ({stable_id})")
        evidence.append(
            {
                "stable_id": stable_id,
                "revision": revision,
                "index_sha256": index_digest,
                "root_sha256": root_digest,
                "entry_sha256": entry_digest,
                "contract_sha256": contract_digest,
            }
        )
    print(json.dumps(evidence, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(observe(Path(sys.argv[1]), sys.argv[2], sys.argv[3]))
