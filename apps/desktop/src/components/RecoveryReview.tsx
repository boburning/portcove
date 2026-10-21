import { ActionReviewFailure } from "./ActionReviewFailure";
import { useRef, useState } from "react";
import { desktopApi } from "../api";
import type { DoctorReport, PortDefinition, PreparationCleanupPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { errorText, formatBytes, formatCountMessage } from "../view-model";
import type { DetailDestination } from "../view-model";
import { gameIdentityLabel } from "../port-identity";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

type Repair = DoctorReport["repair"];
type Item = Repair["items"][number];
const labels: Record<Item["kind"], string> = {
  retained_preparation: "Unfinished setup files",
  partial_operation: "Unfinished operation",
  cleanup_pending: "Unfinished files need review",
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
  onSelect,
  onOpenStorage,
  onReviewActivity,
  availableActivityIds,
}: {
  repair?: Repair | undefined;
  ports: PortDefinition[];
  refreshing: boolean;
  stale: boolean;
  failure?: unknown;
  refresh: () => Promise<unknown>;
  generation?: number;
  cleanupChanged?: () => Promise<unknown>;
  onSelect?: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onOpenStorage?: () => void;
  onReviewActivity?: (activityId: string) => void;
  availableActivityIds?: ReadonlySet<string>;
}) {
  const [cleanupOperation, setCleanupOperation] = useState<string>();
  const names = new Map(ports.map((port) => [port.id, gameIdentityLabel(port)]));
  const occurrences = new Map<string, number>();
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
  const quiet = state === "fresh" && repair?.items.length === 0;
  return (
    <section
      className={
        "recovery-review mt-6 flex min-w-0 flex-col gap-2 " +
        (quiet ? "py-2" : "rounded-pc-lg border border-pc-border bg-pc-surface p-4")
      }
      aria-label="Unfinished work and recovery"
      data-diagnostic-state={state}
    >
      <h2 className={quiet ? "m-0 text-sm font-medium text-pc-muted-foreground" : "m-0 text-lg"}>
        Unfinished work and recovery
      </h2>
      {refreshing && (
        <p className="mb-0 text-sm text-pc-secondary-foreground" role="status">
          {repair
            ? "Refreshing recovery information. The last completed check remains visible."
            : "Checking the library for unfinished work…"}
        </p>
      )}
      {!refreshing && Boolean(failure) && (
        <p className="mb-0 text-sm text-pc-danger-foreground" role="alert">
          Recovery information could not be refreshed: {errorText(failure)}
          {repair ? " The last completed check remains visible." : ""}
        </p>
      )}
      {!refreshing && !failure && stale && (
        <p className="mb-0 text-sm text-pc-warning-foreground" role="status">
          {repair
            ? "Recovery information is out of date. The last completed check remains visible."
            : "Recovery information has not been checked for the current library state."}
        </p>
      )}
      {(!stale || repair) && (
        <p className="mb-0 text-sm text-pc-muted-foreground">
          {formatCountMessage(repair?.items.length, countMessages)}
        </p>
      )}
      {(stale || Boolean(failure)) && !refreshing && (
        <Button
          data-focusable
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void refresh()}
        >
          Refresh recovery information
        </Button>
      )}
      {!!repair?.items.length && (
        <>
          <p className="mb-0 text-sm text-pc-secondary-foreground">
            Use Review to open the relevant screen, or expand an item for its recorded location and
            guidance. These links do not change files.
          </p>
          <div className="recovery-review-list grid gap-3" data-focus-group>
            {repair.items.map((item) => {
              const portId = item.port_id;
              const operationId = item.operation_id;
              const identity = JSON.stringify([operationId, portId, item.kind, item.path]);
              const occurrence = occurrences.get(identity) ?? 0;
              occurrences.set(identity, occurrence + 1);
              const origin = `updates:recovery:${identity}:${occurrence}`;
              const action = recoveryNavigation(item, {
                game:
                  portId && names.has(portId) && onSelect
                    ? (destination) => onSelect(portId, origin, destination)
                    : undefined,
                storage: onOpenStorage,
                activity:
                  operationId && availableActivityIds?.has(operationId) && onReviewActivity
                    ? () => onReviewActivity(operationId)
                    : undefined,
              });
              return (
                <div
                  className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-3 break-words"
                  key={origin}
                  data-recovery-operation={item.operation_id ?? undefined}
                >
                  <details>
                    <summary className="cursor-pointer" data-focusable>
                      {item.port_id ? (names.get(item.port_id) ?? item.port_id) : "Library"} ·{" "}
                      {Object.hasOwn(labels, item.kind)
                        ? labels[item.kind]
                        : "Recovery information needs review"}
                    </summary>
                    <dl className="text-xs">
                      <dt>Recorded location</dt>
                      <dd className="mt-1 mb-3">
                        {item.path ? (
                          <code className="whitespace-normal">{item.path}</code>
                        ) : (
                          "No location was recorded."
                        )}
                      </dd>
                      <dt>Suggested next step</dt>
                      <dd className="mt-1 mb-3">
                        {item.proposed_action || "No recovery guidance was recorded."}
                      </dd>
                      {item.operation_id && (
                        <>
                          <dt>Operation reference</dt>
                          <dd className="mt-1 mb-3">
                            <code className="whitespace-normal">{item.operation_id}</code>
                          </dd>
                        </>
                      )}
                    </dl>
                    {item.kind === "retained_preparation" && item.operation_id && (
                      <Button
                        data-focusable
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => setCleanupOperation(item.operation_id ?? undefined)}
                      >
                        Review unfinished setup files
                      </Button>
                    )}
                  </details>
                  {action && (
                    <Button
                      data-focusable
                      data-detail-origin={origin}
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={action.open}
                    >
                      {action.label}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {cleanupOperation && (
        <PreparationCleanupDialog
          key={`${cleanupOperation}:${generation}`}
          operationId={cleanupOperation}
          generation={generation}
          names={names}
          changed={cleanupChanged}
          close={() => setCleanupOperation(undefined)}
        />
      )}
    </section>
  );
}

function recoveryNavigation(
  item: Item,
  destinations: {
    game?: ((destination?: DetailDestination) => void) | undefined;
    storage?: (() => void) | undefined;
    activity?: (() => void) | undefined;
  },
): { label: string; open: () => void } | undefined {
  const game = destinations.game;
  const storage = destinations.storage
    ? { label: "Review library storage", open: destinations.storage }
    : undefined;
  switch (item.kind) {
    case "retained_preparation":
      return game ? { label: "Review game setup", open: () => game() } : storage;
    case "partial_operation":
    case "cleanup_pending":
      return destinations.activity
        ? { label: "Review activity", open: destinations.activity }
        : game
          ? { label: "Review game details", open: () => game() }
          : storage;
    case "missing_registered_path":
      return game ? { label: "Review game installation", open: () => game("saves") } : storage;
    case "degraded_backup":
    case "backup_recovery_required":
      return game ? { label: "Review saves and backups", open: () => game("saves") } : storage;
    case "orphaned_final_directory":
      return storage;
    default:
      return undefined;
  }
}

function PreparationCleanupDialog({
  operationId,
  generation,
  changed,
  close,
  names,
}: {
  operationId: string;
  generation: number;
  changed: () => Promise<unknown>;
  close: () => void;
  names: ReadonlyMap<string, string>;
}) {
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const [intent, setIntent] = useState<"inspect" | "cleanup">("inspect");
  const inspecting = intent === "inspect";
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${operationId}:${generation}:${intent}`,
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
    failureMessage: "Cleanup was not accepted. The retained recovery state remains unchanged.",
  });
  const emptyReview = Boolean(preview && !hasRetainedEntries(preview));
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={reviewTitle}
        showCloseButton={false}
        reviewSize="wide"
        aria-describedby="preparation-cleanup-description"
      >
        <DialogTitle
          ref={reviewTitle}
          tabIndex={-1}
          id="preparation-cleanup-title"
          className="mb-2 text-xl"
        >
          {inspecting
            ? "Files left by unfinished setup"
            : emptyReview
              ? "Clear unfinished setup record?"
              : "Delete files left by unfinished setup?"}
        </DialogTitle>
        <DialogDescription id="preparation-cleanup-description" className="mb-4 leading-relaxed">
          {inspecting
            ? "Review what remains from this setup and the locations recorded with it. Opening this account does not change files. Cleanup is a separate decision."
            : emptyReview
              ? "No setup working files remain. Clear the unfinished setup record and its recorded path if present."
              : "Delete the private working files left by this unfinished setup. Review the affected folder and preserved locations first."}
        </DialogDescription>
        {pending === "review" && <p role="status">Checking unfinished setup files…</p>}
        {preview && (
          <PreparationCleanupDetails
            preview={preview}
            readOnly={inspecting}
            name={names.get(preview.port_id) ?? preview.port_id}
          />
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={pending === "apply"} onClick={dismiss}>
            {inspecting ? "Close" : emptyReview ? "Cancel" : "Keep files"}
          </Button>
          {!preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Review again
            </Button>
          )}
          {preview && (
            <Button
              data-focusable
              variant={inspecting ? "outline" : "destructive"}
              disabled={Boolean(pending)}
              onClick={() => {
                if (inspecting) {
                  reviewTitle.current?.focus();
                  setIntent("cleanup");
                } else void execute();
              }}
            >
              {inspecting
                ? "Review cleanup…"
                : pending === "apply"
                  ? emptyReview
                    ? "Clearing unfinished setup record…"
                    : "Deleting setup working files…"
                  : emptyReview
                    ? "Clear unfinished setup record"
                    : "Delete setup working files"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function hasRetainedEntries(preview: PreparationCleanupPreview) {
  return Boolean(
    preview.retained.directories.length ||
    preview.retained.files.length ||
    preview.retained.skipped_entries.length,
  );
}

function PreparationCleanupDetails({
  preview,
  readOnly = false,
  name,
}: {
  preview: PreparationCleanupPreview;
  readOnly?: boolean;
  name: string;
}) {
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
      aria-label={
        readOnly
          ? "Retained setup files and recorded locations"
          : "Cleanup changes and preserved data"
      }
    >
      <p className="[overflow-wrap:anywhere]">
        <strong>{name}</strong> ·{" "}
        {formatCountMessage(preview.retained.files.length, {
          zero: "0 files",
          one: "1 file",
          other: "{count} files",
          unknown: "File count unavailable",
        })}{" "}
        · {formatBytes(preview.retained.total_bytes)}
      </p>
      <dl>
        <div>
          <dt>
            {readOnly
              ? "Recorded setup working folder"
              : entries.length
                ? "Setup working folder to delete"
                : "Recorded setup path to clear"}
          </dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.retained_path}
          </dd>
        </div>
        <div>
          <dt>{readOnly ? "Original installation" : "Original installation preserved"}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.original_install_path}
          </dd>
        </div>
        <div>
          <dt>{readOnly ? "Registered source" : "Registered source preserved"}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.source_path}
          </dd>
        </div>
        <div>
          <dt>{readOnly ? "Saved data" : "Saved data preserved"}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.persistent_data_path}
          </dd>
        </div>
        <div>
          <dt>{readOnly ? "Backups" : "Backups preserved"}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.backup_path}
          </dd>
        </div>
        <div>
          <dt>{readOnly ? "Logs" : "Logs preserved"}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.logs_path}
          </dd>
        </div>
      </dl>
      <p className="[overflow-wrap:anywhere]">
        {readOnly
          ? "These are the recorded locations for this operation. The working files are separate from the installation, registered source, saved data, backups and logs. Review cleanup separately to see exactly what can be removed."
          : entries.length
            ? "This deletes only the recorded setup working folder and its recovery journal. The deleted files cannot be recovered. If cleanup is interrupted, Portcove keeps the accepted cleanup in its journal and retries it when the library reopens."
            : "No setup working files were found. Cleanup clears the recorded setup path if it exists and its stale recovery journal."}
      </p>
      <p className="[overflow-wrap:anywhere]">
        {readOnly
          ? "Portcove checks the current files again when you open cleanup. Setup and any programs it started must have stopped before cleanup can run."
          : entries.length
            ? "Portcove must confirm that setup and any programs it started have stopped before deleting these files."
            : "Portcove must confirm that setup and any programs it started have stopped before clearing this record."}
      </p>
      <details>
        <summary data-focusable>Affected entries ({entries.length})</summary>
        {entries.length ? (
          <ul className="cleanup-entry-list m-[var(--space-2)_0_0] max-h-[12rem] overflow-auto ps-5">
            {entries.map((entry, index) => (
              <li
                className="m-[var(--space-1)_0] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
                key={`${entry.kind}:${entry.path}:${index}`}
              >
                <span>{entry.kind}</span> <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="[overflow-wrap:anywhere]">No retained private entries were found.</p>
        )}
      </details>
    </section>
  );
}
