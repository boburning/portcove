import type { BackupInventory, PortStatus } from "../types";
import type { BackupReadState } from "../features/backups/use-port-backups";

type Protection = NonNullable<BackupInventory["protection"]>;
type Installation = Protection["installations"][number];

const pathLabels: Record<Protection["managed_data"]["state"], string> = {
  present: "Found",
  missing: "Not found",
  unsafe: "Needs safety review",
  unreadable: "Couldn’t read",
};

const collectionLabels: Record<Installation["collection"], string> = {
  selected_for_collection:
    "These files may be included in the next backup. They’ll be checked before copying.",
  direct_to_managed_data:
    "This installation writes saves and settings directly to Portcove’s folder. They’re checked before a new backup is made.",
  not_initialized:
    "Portcove hasn’t selected files to copy from this installation yet. Files already in Portcove’s saves and settings folder may still be backed up.",
  inactive:
    "This version isn’t in use. New backups won’t collect files from its installation folder.",
  external_not_collected: "Portcove won’t collect saves from this installation’s folder",
  unavailable: "Portcove couldn’t confirm which files this installation can add to a new backup.",
};

/** Presentation only. Existing Core assessments and reviewed actions own eligibility. */
export function ProtectionSummary({
  portId,
  status,
  protection,
  readState,
  inventoryState,
  problems = [],
}: {
  portId: string;
  status?: PortStatus | undefined;
  protection?: Protection | null | undefined;
  readState?: BackupReadState | undefined;
  inventoryState?: BackupInventory["state"] | undefined;
  problems?: BackupInventory["problems"] | undefined;
}) {
  const matches =
    protection?.port_id === portId &&
    status?.port_id === portId &&
    (status.active?.id ?? null) ===
      (protection.installations.find((install) => install.role === "active")?.install_id ?? null) &&
    (status.previous?.id ?? null) ===
      (protection.installations.find((install) => install.role === "previous")?.install_id ??
        null) &&
    (status.staged?.id ?? null) ===
      (protection.installations.find((install) => install.role === "staged")?.install_id ?? null) &&
    (status.external_runtime?.id ?? null) ===
      (protection.installations.find((install) => install.role === "external")?.install_id ?? null);
  const complete = inventoryState === "healthy" && problems.length === 0;
  const current = matches && readState?.status === "current" && readState.hasInventory;
  return (
    <section aria-label="Backups and updates" className="grid min-w-0 gap-3 text-sm wrap-anywhere">
      <h3 className="m-0 text-base font-semibold">Backups and updates</h3>
      {!current && (
        <p role="status">
          {readState?.status === "failed"
            ? "We couldn’t load backup information. Previously loaded information may be out of date. Refresh backup history before continuing."
            : readState?.status === "pending"
              ? "Checking backup information. Previously loaded information may be out of date."
              : "Backup information is unavailable for this installation. Refresh backup history before continuing."}
        </p>
      )}
      {matches && protection && (
        <>
          <p>{current ? "Latest backup information" : "Last loaded backup information"}</p>
          {protection.problem && (
            <div role="status">
              <p>
                Some installation information couldn’t be loaded. Check the details and refresh
                backup history.
              </p>
              <details>
                <summary data-focusable>Installation check details</summary>
                <p>{protection.problem}</p>
              </details>
            </div>
          )}
          {!protection.installations.length && !protection.problem && (
            <p>No installation is recorded. Choose an installation to see who handles updates.</p>
          )}
          {!complete && (
            <p role="status">
              We couldn’t confirm your latest completed backup. Refresh backup history before
              continuing.
            </p>
          )}
          {protection.latest_completed_backup ? (
            <div>
              <p>
                {current && complete ? "Latest completed backup" : "Last known completed backup"}:{" "}
                {new Date(protection.latest_completed_backup.created_at * 1000).toLocaleString()} ·{" "}
                {protection.latest_completed_backup.file_count} files. Backup history is shared
                across this port’s installed versions. Choose Restore in Backup history to review
                the files before confirming. Another version may not be able to use these saves.
              </p>
              <details>
                <summary data-focusable>Backup identifier</summary>
                <code>{protection.latest_completed_backup.id}</code>
              </details>
            </div>
          ) : (
            <p>
              {!complete
                ? "We couldn’t confirm a completed backup because the history is incomplete."
                : current
                  ? "No completed backup recorded."
                  : "No completed backup was listed when backup history was last loaded."}
            </p>
          )}
          {protection.installations.map((install) => (
            <div
              className="grid gap-2 rounded-pc-md border border-pc-border p-3"
              key={install.install_id}
            >
              <h4 className="m-0 font-semibold">
                {
                  {
                    active: "Current version",
                    previous: "Previous version",
                    staged: "Prepared version",
                    external: "Installation you maintain",
                  }[install.role]
                }{" "}
                · {install.version}
              </h4>
              <p>
                Updates handled by:{" "}
                {install.update_owner === "portcove" ? "Portcove" : "the game’s launcher or you"}.
              </p>
              <p>{collectionLabels[install.collection]}</p>
              {!install.retained && install.role !== "external" && (
                <p>
                  Backup rules for this installation are unavailable. The current catalog may
                  describe a different version, so it can’t confirm which files this copy uses.
                </p>
              )}
              {install.problem && (
                <details>
                  <summary data-focusable>Backup check details</summary>
                  <p>{install.problem}</p>
                </details>
              )}
              {install.collection_root && (
                <p>
                  Where these files were found: <code>{install.collection_root}</code>
                </p>
              )}
              {!!install.collection_candidates.length && (
                <ul className="list-disc ps-5">
                  {install.collection_candidates.map((entry) => (
                    <li key={entry.path}>
                      <code>{entry.path}</code> · {pathLabels[entry.state]}
                    </li>
                  ))}
                </ul>
              )}
              <p>Finding these files does not mean they’ve been backed up or checked.</p>
              <Declaration title="Backup rules for this installation" value={install.retained} />
              <Declaration title="Files considered for backup" value={install.effective} />
              {install.exclusions.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ))}
          <p>
            Saved-data folder: <code>{protection.managed_data.path}</code> ·{" "}
            {pathLabels[protection.managed_data.state]}. This folder’s presence doesn’t mean its
            contents have been backed up.
          </p>
          <Declaration title="Backup rules in the current catalog" value={protection.catalog} />
          {protection.exclusions.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </>
      )}
    </section>
  );
}

function Declaration({ title, value }: { title: string; value: Installation["retained"] }) {
  return (
    <details>
      <summary data-focusable className="cursor-pointer">
        {title}
      </summary>
      {value ? (
        <>
          <p>
            Definition <code>{value.definition_sha256}</code>
          </p>
          <p>
            Save and settings rules:{" "}
            {value.saves_and_settings === "portcove-managed"
              ? "Portcove manages the listed files"
              : value.saves_and_settings === "external-user-owned"
                ? "You handle the external saves and settings"
                : "Coverage unknown"}
            . These are rules, not proof of backed-up saves.
          </p>
          {value.persistent_paths.length || value.persistent_file_patterns.length ? (
            <ul className="list-disc ps-5">
              {value.persistent_paths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
              {value.persistent_file_patterns.map((pattern) => (
                <li key={`${pattern.prefix}:${pattern.suffix}`}>
                  <code>
                    {pattern.prefix}*{pattern.suffix}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No files in this installation folder are listed for backup.</p>
          )}
        </>
      ) : (
        <p>
          Backup rules for this installation are unavailable. The current catalog can’t confirm what
          this installation backs up.
        </p>
      )}
    </details>
  );
}
