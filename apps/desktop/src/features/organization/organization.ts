import type { LibraryOrganization } from "../../types";

export function updateNoticeHidden(
  choice: LibraryOrganization["update_notices"][string] | undefined,
  release: { version: string; artifact_sha256: string } | undefined,
) {
  return Boolean(
    choice?.paused ||
    (release &&
      choice?.skipped_release?.version === release.version &&
      choice.skipped_release.artifact_sha256 === release.artifact_sha256),
  );
}

export function setupConfirmed(
  snapshot: LibraryOrganization | undefined,
  portId: string,
  context: LibraryOrganization["setup_confirmations"][number]["context"],
) {
  return (
    snapshot?.setup_confirmations.some(
      (confirmation) =>
        confirmation.port_id === portId &&
        confirmation.context.kind === context.kind &&
        confirmation.context.installation_id === context.installation_id,
    ) ?? false
  );
}
