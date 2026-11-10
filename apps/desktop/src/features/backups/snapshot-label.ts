import type { BackupRecord } from "../../types";

const changes = {
  update: "an update",
  activation: "activating a saved update",
  rollback: "restoring a previous version",
} as const;

/**
 * Says which version change Portcove took a snapshot for. Snapshots the player
 * took themselves carry no label and return `undefined`, so they stay unlabelled.
 */
export function automaticSnapshotLabel(
  backup: Pick<BackupRecord, "automatic">,
): string | undefined {
  const label = backup.automatic;
  if (!label) return undefined;
  const change = changes[label.operation];
  const versions = label.from_version
    ? `${label.from_version} to ${label.to_version}`
    : `to ${label.to_version}`;
  return `Automatic snapshot before ${change} (${versions})`;
}
