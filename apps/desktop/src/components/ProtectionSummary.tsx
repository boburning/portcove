import type { BackupInventory, PortStatus } from "../types";
import type { BackupReadState } from "../features/backups/use-port-backups";

type Protection = NonNullable<BackupInventory["protection"]>;
type Installation = Protection["installations"][number];

const collectionLabels: Record<Installation["collection"], string> = {
  selected_for_collection:
    "Active collection candidates selected by Core; backup checks run before copying",
  direct_to_managed_data: "Writes directly to the managed data folder",
  not_initialized: "Runtime collection is not initialized",
  inactive: "Inactive version: its runtime data is not collected by a new backup",
  external_not_collected: "The external runtime directory is not collected",
  unavailable: "Runtime coverage could not be established",
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
    <section
      aria-label="Player-data protection"
      className="grid min-w-0 gap-3 text-sm wrap-anywhere"
    >
      <h3 className="m-0 text-base font-semibold">Protection and update ownership</h3>
      {!current && (
        <p role="status">
          {readState?.status === "failed"
            ? "Protection information could not be read. Last loaded facts may be out of date. Refresh backup history before taking action."
            : readState?.status === "pending"
              ? "Checking protection information. Last loaded facts may be out of date."
              : "Protection information is unavailable for the current installation. Refresh backup history before taking action."}
        </p>
      )}
      {matches && protection && (
        <>
          <p>
            {current ? "Current Core snapshot" : "Last loaded Core snapshot"} for implementation{" "}
            <code>{protection.port_id}</code>. Game updates, application updates and definition
            updates have separate owners.
          </p>
          {protection.problem && (
            <p role="status">
              Installation protection could not be fully read: {protection.problem}
            </p>
          )}
          {!protection.installations.length && !protection.problem && (
            <p>
              No installation is recorded. Update ownership is unknown until an installation is
              selected.
            </p>
          )}
          {protection.installations.map((install) => (
            <div
              className="grid gap-2 rounded-pc-md border border-pc-border p-3"
              key={install.install_id}
            >
              <h4 className="m-0 font-semibold">
                {install.role} · {install.version}
              </h4>
              <p>
                Installation <code>{install.install_id}</code>: updates owned by{" "}
                {install.update_owner === "portcove" ? "Portcove" : "the upstream launcher or you"}.
                Review the current action availability before updating.
              </p>
              <p>{collectionLabels[install.collection]}</p>
              {install.problem && <p role="status">{install.problem}</p>}
              {install.collection_root && (
                <p>
                  Collection root: <code>{install.collection_root}</code>
                </p>
              )}
              {!!install.collection_candidates.length && (
                <ul className="list-disc ps-5">
                  {install.collection_candidates.map((entry) => (
                    <li key={entry.path}>
                      <code>{entry.path}</code> · {entry.state}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                Candidate presence is a metadata observation, not a completed backup or a
                file-integrity check.
              </p>
              <Declaration title="Retained installation declarations" value={install.retained} />
              <Declaration
                title="Effective checked collection declarations"
                value={install.effective}
              />
              {install.exclusions.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ))}
          <p>
            Managed backup data root: <code>{protection.managed_data.path}</code> ·{" "}
            {protection.managed_data.state}. Its existence alone does not establish save protection.
          </p>
          {!complete && (
            <p role="status">
              Backup history is incomplete or needs attention. The newest completed backup cannot be
              established from this read.
            </p>
          )}
          {protection.latest_completed_backup ? (
            <p>
              {current && complete ? "Latest completed backup" : "Last known completed backup"}:{" "}
              {new Date(protection.latest_completed_backup.created_at * 1000).toLocaleString()} ·{" "}
              <code>{protection.latest_completed_backup.id}</code> ·{" "}
              {protection.latest_completed_backup.file_count} files. This snapshot is shared by this
              implementation’s versions. Review its contents and current restore availability in
              backup history; its manifest does not prove game-save compatibility.
            </p>
          ) : (
            <p>
              {!complete
                ? "No completed backup could be established from this incomplete read."
                : current
                  ? "No completed backup was found in this read."
                  : "No completed backup was recorded in the last loaded read."}
            </p>
          )}
          <Declaration title="Current catalog declarations" value={protection.catalog} />
          {protection.exclusions.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <p>
            Previous-version recovery changes software separately from saved data. Older software
            may not understand newer saves or configuration. Review Versions before switching; use
            reviewed backup restore to change player data.
          </p>
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
            Saved-data declaration: {value.saves_and_settings ?? "unknown"}. These are rules, not
            proof of backed-up saves.
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
            <p>No local collection paths are declared.</p>
          )}
        </>
      ) : (
        <p>
          No verified declaration is available. Current catalog rules do not establish retained
          coverage.
        </p>
      )}
    </details>
  );
}
