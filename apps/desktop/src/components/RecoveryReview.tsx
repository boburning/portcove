import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import type { DoctorReport, PortDefinition, PreparationCleanupPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { errorText, formatBytes, formatCountMessage } from "../view-model";

type Repair = DoctorReport["repair"];
type Item = Repair["items"][number];
const labels: Record<Item["kind"], string> = {
  retained_preparation: "Retained preparation files",
  partial_operation: "Unfinished operation",
  cleanup_pending: "Retained files need review",
  orphaned_final_directory: "Unregistered game folder",
  missing_registered_path: "Registered game folder is missing",
  degraded_backup: "Backup needs attention",
  backup_recovery_required: "Backup recovery needs review",
};
const countMessages = {
  zero: "No recovery items were recorded in the last check.",
  one: "1 recorded item needs review.",
  other: "{count} recorded items need review.",
  unknown: "Recovery information is unavailable.",
};

export function RecoveryReview({
  repair,
  ports,
  refreshing,
  stale,
  failure,
  refresh,
  generation = 0,
  cleanupChanged = refresh,
}: {
  repair?: Repair;
  ports: PortDefinition[];
  refreshing: boolean;
  stale: boolean;
  failure?: unknown;
  refresh: () => Promise<unknown>;
  generation?: number;
  cleanupChanged?: () => Promise<unknown>;
}) {
  const [cleanupOperation, setCleanupOperation] = useState<string>();
  const names = new Map(ports.map((port) => [port.id, port.name]));
  const state =
    refreshing && !repair
      ? "loading"
      : failure
        ? "failed"
        : stale && repair
          ? "stale"
          : repair
            ? "fresh"
            : "never-loaded";
  return (
    <section
      className="recovery-review"
      aria-label="Retained work and repairs"
      data-diagnostic-state={state}
    >
      <h2>Retained work and repairs</h2>
      {refreshing && (
        <p role="status">
          {repair
            ? "Refreshing recovery information. The last completed check remains visible."
            : "Checking the library for retained work and repairs…"}
        </p>
      )}
      {!refreshing && Boolean(failure) && (
        <p role="alert">
          Recovery information could not be refreshed: {errorText(failure)}
          {repair ? " The last completed check remains visible." : ""}
        </p>
      )}
      {!refreshing && !failure && stale && (
        <p role="status">
          {repair
            ? "Recovery information is out of date. The last completed check remains visible."
            : "Recovery information has not been checked for the current library state."}
        </p>
      )}
      {(!stale || repair) && <p>{formatCountMessage(repair?.items.length, countMessages)}</p>}
      {(stale || Boolean(failure)) && !refreshing && (
        <button data-focusable className="small-control" onClick={() => void refresh()}>
          Refresh recovery information
        </button>
      )}
      {!!repair?.items.length && (
        <>
          <p>
            Open an item to review its recorded location and recovery guidance. Opening these
            details does not change files.
          </p>
          <div className="recovery-review-list" data-focus-group>
            {repair.items.map((item, index) => (
              <details
                key={`${item.operation_id ?? item.port_id ?? "library"}:${item.kind}:${item.path}:${index}`}
                data-recovery-operation={item.operation_id ?? undefined}
              >
                <summary data-focusable>
                  {item.port_id ? (names.get(item.port_id) ?? item.port_id) : "Library"} ·{" "}
                  {Object.hasOwn(labels, item.kind)
                    ? labels[item.kind]
                    : "Recovery information needs review"}
                </summary>
                <dl>
                  <dt>Recorded location</dt>
                  <dd>{item.path ? <code>{item.path}</code> : "No location was recorded."}</dd>
                  <dt>Recorded guidance</dt>
                  <dd>{item.proposed_action || "No recovery guidance was recorded."}</dd>
                  {item.operation_id && (
                    <>
                      <dt>Operation reference</dt>
                      <dd>
                        <code>{item.operation_id}</code>
                      </dd>
                    </>
                  )}
                </dl>
                {item.kind === "retained_preparation" && item.operation_id && (
                  <button
                    data-focusable
                    className="danger"
                    onClick={() => setCleanupOperation(item.operation_id ?? undefined)}
                  >
                    Review private-file cleanup
                  </button>
                )}
              </details>
            ))}
          </div>
        </>
      )}
      {cleanupOperation && (
        <PreparationCleanupDialog
          key={`${cleanupOperation}:${generation}`}
          operationId={cleanupOperation}
          generation={generation}
          changed={cleanupChanged}
          close={() => setCleanupOperation(undefined)}
        />
      )}
    </section>
  );
}

function PreparationCleanupDialog({
  operationId,
  generation,
  changed,
  close,
}: {
  operationId: string;
  generation: number;
  changed: () => Promise<unknown>;
  close: () => void;
}) {
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${operationId}:${generation}`,
    load: () => desktopApi.previewPreparationCleanup(operationId, generation),
    apply: async (current) => {
      const result = await desktopApi.cleanupPreparation(
        operationId,
        current.preview_sha256,
        generation,
      );
      if (!result) return "cancelled";
      await changed();
      return true;
    },
    close,
    failureMessage: "Cleanup was not accepted. The retained private files remain unchanged.",
  });
  const dialog = useDialogFocus(dismiss);
  return (
    <div className="scrim">
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preparation-cleanup-title"
        aria-describedby="preparation-cleanup-description"
      >
        <h2 id="preparation-cleanup-title">Review retained preparation cleanup</h2>
        <p id="preparation-cleanup-description">
          Permanently discard one failed attempt's private working files.
        </p>
        {pending === "review" && <p role="status">Reading the retained private folder…</p>}
        {preview && <PreparationCleanupDetails preview={preview} />}
        {error && <p role="alert">{error}</p>}
        <div className="actions">
          <button data-autofocus data-focusable disabled={pending === "apply"} onClick={dismiss}>
            Keep retained files
          </button>
          {!preview && (
            <button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Review again
            </button>
          )}
          {preview && (
            <button
              data-focusable
              className="danger"
              disabled={Boolean(pending)}
              onClick={() => void execute()}
            >
              {pending === "apply"
                ? "Removing reviewed private files…"
                : "Remove reviewed private files permanently"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function PreparationCleanupDetails({ preview }: { preview: PreparationCleanupPreview }) {
  const entries = [
    ...preview.retained.directories.map((path) => ({ path, kind: "Folder" })),
    ...preview.retained.files.map((file) => ({ path: file.relative_path, kind: "File" })),
    ...preview.retained.skipped_entries.map((entry) => ({
      path: entry.relative_path,
      kind: "Link or special entry",
    })),
  ];
  return (
    <section
      className="preparation-cleanup-details"
      aria-label="Cleanup changes and preserved data"
    >
      <p>
        <strong>{preview.port_id}</strong> · {preview.retained.files.length} files ·{" "}
        {formatBytes(preview.retained.total_bytes)}
      </p>
      <dl>
        <div>
          <dt>Private folder removed</dt>
          <dd>{preview.retained_path}</dd>
        </div>
        <div>
          <dt>Original installation preserved</dt>
          <dd>{preview.original_install_path}</dd>
        </div>
        <div>
          <dt>Registered source preserved</dt>
          <dd>{preview.source_path}</dd>
        </div>
        <div>
          <dt>Saved data preserved</dt>
          <dd>{preview.persistent_data_path}</dd>
        </div>
        <div>
          <dt>Backups preserved</dt>
          <dd>{preview.backup_path}</dd>
        </div>
        <div>
          <dt>Logs preserved</dt>
          <dd>{preview.logs_path}</dd>
        </div>
      </dl>
      <p>
        This removes only the recorded private folder and its recovery journal. The removed files
        cannot be recovered. If cleanup is interrupted, Portcove keeps the accepted cleanup in its
        journal and retries it when the library reopens.
      </p>
      <p>Before continuing, make sure any external setup process from this attempt has stopped.</p>
      <details>
        <summary data-focusable>Affected entries ({entries.length})</summary>
        {entries.length ? (
          <ul className="cleanup-entry-list">
            {entries.map((entry, index) => (
              <li key={`${entry.kind}:${entry.path}:${index}`}>
                <span>{entry.kind}</span> <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>The private folder is already absent; cleanup removes only its stale journal.</p>
        )}
      </details>
    </section>
  );
}
