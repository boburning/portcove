#!/usr/bin/env bash
set -euo pipefail

destination=$1
mkdir -p "$destination"
# Include failed collection runs: they can still contain a verified recovery
# point. New report/status-only runs have no recovery artifacts.
gh run list --workflow maintenance-inventory.yml --branch main --status completed --limit 120 \
  --json databaseId,displayTitle > "$destination/runs.json"
while read -r run; do
  gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.expired == false) | .name' > "$destination/artifacts.txt"
  while read -r proof; do
    backup=${proof/restore-proof/backup}
    if ! awk -v name="$backup" '$0 == name {found=1} END {exit !found}' "$destination/artifacts.txt"; then
      continue
    fi
    gh run download "$run" --name "$proof" --dir "$destination/proof"
    gh run download "$run" --name "$backup" --dir "$destination/backup"
    digest=$(sha256sum "$destination/backup/maintenance.dump" | cut -d' ' -f1)
    if jq -e --arg digest "$digest" \
      '.verified == true and .tables_match_manifest == true and .dump_sha256 == $digest and .manifest_dump_sha256 == $digest' \
      "$destination/proof/evidence.json" > /dev/null &&
      jq -e --arg digest "$digest" '.dump.sha256 == $digest' "$destination/backup/manifest.json" > /dev/null; then
      jq -c --arg artifact "$backup" --arg proof "$proof" \
        '{created_at, schema_version, dump_sha256: .dump.sha256, artifact: $artifact, proof: $proof}' \
        "$destination/backup/manifest.json" > "$destination/selected.json"
      exit 0
    fi
    rm -r "$destination/proof" "$destination/backup"
  done < <(awk -v pattern="^maintenance-restore-proof-${run}-[0-9]+$" '$0 ~ pattern' "$destination/artifacts.txt" | sort -Vr)
done < <(jq -r '.[] | select(.displayTitle | test("^Maintenance inventory( / (schedule|recover|recovery-full))?$")) | .databaseId' "$destination/runs.json")
echo "::warning title=Maintenance recovery baseline::No verified retained backup was found in the bounded workflow inventory."
exit 75
