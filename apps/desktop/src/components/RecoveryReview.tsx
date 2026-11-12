import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { countMessage, useAppTranslation } from "../localization";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { useRef, useState } from "react";
import { desktopApi } from "../api";
import type { DoctorReport, PortDefinition, PreparationCleanupPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { errorText, formatBytes } from "../view-model";
import type { DetailDestination } from "../view-model";
import { gameIdentityLabel } from "../port-identity";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

type Repair = DoctorReport["repair"];
type Item = Repair["items"][number];
/** Core may add item kinds; an unrecognized kind keeps a general review label. */
function itemLabel(t: TFunction<"operations">, kind: string) {
  switch (kind) {
    case "malformed_journal":
      return t("recovery.kind.malformedJournal");
    case "retained_preparation":
      return t("recovery.kind.retainedPreparation");
    case "partial_operation":
      return t("recovery.kind.partialOperation");
    case "cleanup_pending":
      return t("recovery.kind.cleanupPending");
    case "orphaned_final_directory":
      return t("recovery.kind.orphanedFolder");
    case "missing_registered_path":
      return t("recovery.kind.missingFolder");
    case "degraded_backup":
      return t("recovery.kind.degradedBackup");
    case "backup_recovery_required":
      return t("recovery.kind.backupRecovery");
    default:
      return t("recovery.kind.unknown");
  }
}

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
  const { t } = useAppTranslation("operations");
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
      className={"recovery-review" + (quiet ? " recovery-review-quiet" : "")}
      aria-label={t("recovery.label")}
      data-diagnostic-state={state}
    >
      <header className="recovery-review-heading">
        <h2
          className={quiet ? "m-0 text-sm font-medium text-pc-muted-foreground" : "m-0 text-base"}
        >
          {t("recovery.heading")}
        </h2>
        {(!stale || repair) && (
          <p className="mb-0 text-sm text-pc-muted-foreground">
            {countMessage(repair?.items.length, "recoveryItems")}
          </p>
        )}
      </header>
      {refreshing && (
        <p className="mb-0 text-sm text-pc-secondary-foreground" role="status">
          {repair ? t("recovery.refreshing") : t("recovery.checking")}
        </p>
      )}
      {!refreshing && Boolean(failure) && (
        <p className="mb-0 text-sm text-pc-danger-foreground" role="alert">
          {repair
            ? t("recovery.failedRetained", { error: errorText(failure) })
            : t("recovery.failed", { error: errorText(failure) })}
        </p>
      )}
      {!refreshing && !failure && stale && (
        <p className="mb-0 text-sm text-pc-warning-foreground" role="status">
          {repair ? t("recovery.stale") : t("recovery.unchecked")}
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
          {t("recovery.refresh")}
        </Button>
      )}
      {repair?.journal_diagnostics &&
        (!repair.journal_diagnostics.enumeration_complete ||
          !repair.journal_diagnostics.related_assessments_complete) && (
          <p className="mb-0 text-sm text-pc-warning-foreground" role="status">
            {t("recovery.incomplete")}
          </p>
        )}
      {!!repair?.items.length && (
        <>
          <p className="mb-0 text-sm text-pc-secondary-foreground">{t("recovery.intro")}</p>
          <div className="recovery-review-list" data-focus-group>
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
                <RecoveryItem
                  key={origin}
                  item={item}
                  gameName={portId ? (names.get(portId) ?? portId) : t("recovery.library")}
                  origin={origin}
                  action={action}
                  reviewCleanup={setCleanupOperation}
                />
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

function RecoveryItem({
  item,
  gameName,
  origin,
  action,
  reviewCleanup,
}: {
  item: Item;
  gameName: string;
  origin: string;
  action: ReturnType<typeof recoveryNavigation>;
  reviewCleanup: (operationId: string | undefined) => void;
}) {
  const { t } = useAppTranslation("operations");
  return (
    <div className="recovery-review-item" data-recovery-operation={item.operation_id ?? undefined}>
      <details>
        <summary className="cursor-pointer" data-focusable>
          <Trans
            t={t}
            i18nKey="recovery.item.summary"
            values={{ label: itemLabel(t, item.kind) }}
            components={{ game: <bdi>{gameName}</bdi> }}
          />
        </summary>
        <dl className="text-xs">
          {item.kind === "malformed_journal" && (
            <>
              <dt>{t("recovery.item.observation")}</dt>
              <dd className="mt-1 mb-3">{item.message}</dd>
            </>
          )}
          <dt>{t("recovery.item.location")}</dt>
          <dd className="mt-1 mb-3">
            {item.path ? (
              <code className="whitespace-normal">{item.path}</code>
            ) : (
              t("recovery.item.noLocation")
            )}
          </dd>
          <dt>{t("recovery.item.nextStep")}</dt>
          <dd className="mt-1 mb-3">{item.proposed_action || t("recovery.item.noGuidance")}</dd>
          {item.operation_id && (
            <>
              <dt>{t("recovery.item.reference")}</dt>
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
            onClick={() => reviewCleanup(item.operation_id ?? undefined)}
          >
            {t("recovery.item.reviewFiles")}
          </Button>
        )}
      </details>
      {action && (
        <Button
          data-focusable
          data-detail-origin={origin}
          variant={action.target === "task" ? "link" : "outline"}
          size="sm"
          onClick={action.open}
        >
          {action.target === "task"
            ? t("recovery.navigation.task")
            : action.target === "setup"
              ? t("recovery.navigation.setup")
              : action.target === "details"
                ? t("recovery.navigation.details")
                : action.target === "installation"
                  ? t("recovery.navigation.installation")
                  : action.target === "saves"
                    ? t("recovery.navigation.saves")
                    : t("recovery.navigation.storage")}
        </Button>
      )}
    </div>
  );
}

function recoveryNavigation(
  item: Item,
  destinations: {
    game?: ((destination?: DetailDestination) => void) | undefined;
    storage?: (() => void) | undefined;
    activity?: (() => void) | undefined;
  },
):
  | {
      target: "storage" | "setup" | "task" | "details" | "installation" | "saves";
      open: () => void;
    }
  | undefined {
  const game = destinations.game;
  const storage = destinations.storage
    ? { target: "storage" as const, open: destinations.storage }
    : undefined;
  switch (item.kind) {
    case "malformed_journal":
      return undefined;
    case "retained_preparation":
      return game ? { target: "setup", open: () => game() } : storage;
    case "partial_operation":
    case "cleanup_pending":
      return destinations.activity
        ? { target: "task", open: destinations.activity }
        : game
          ? { target: "details", open: () => game() }
          : storage;
    case "missing_registered_path":
      return game ? { target: "installation", open: () => game("saves") } : storage;
    case "degraded_backup":
    case "backup_recovery_required":
      return game ? { target: "saves", open: () => game("saves") } : storage;
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
  const { t } = useAppTranslation("operations");
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
    failureMessage: t("recovery.cleanup.failure"),
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
            ? t("recovery.cleanup.title.inspect")
            : emptyReview
              ? t("recovery.cleanup.title.clear")
              : t("recovery.cleanup.title.delete")}
        </DialogTitle>
        <DialogDescription id="preparation-cleanup-description" className="mb-4 leading-relaxed">
          {inspecting
            ? t("recovery.cleanup.description.inspect")
            : emptyReview
              ? t("recovery.cleanup.description.clear")
              : t("recovery.cleanup.description.delete")}
        </DialogDescription>
        {pending === "review" && <p role="status">{t("recovery.cleanup.checking")}</p>}
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
            {inspecting
              ? t("recovery.cleanup.close")
              : emptyReview
                ? t("recovery.cleanup.cancel")
                : t("recovery.cleanup.keep")}
          </Button>
          {!preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              {t("recovery.cleanup.again")}
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
                ? t("recovery.cleanup.reviewCleanup")
                : pending === "apply"
                  ? emptyReview
                    ? t("recovery.cleanup.clearing")
                    : t("recovery.cleanup.deleting")
                  : emptyReview
                    ? t("recovery.cleanup.clear")
                    : t("recovery.cleanup.delete")}
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
  const { t } = useAppTranslation("operations");
  const entries = [
    ...preview.retained.directories.map((path) => ({ path, kind: "folder" as const })),
    ...preview.retained.files.map((file) => ({ path: file.relative_path, kind: "file" as const })),
    ...preview.retained.skipped_entries.map((entry) => ({
      path: entry.relative_path,
      kind: "special" as const,
    })),
  ];
  const recordedLocations = [
    [
      readOnly ? t("recovery.location.installation") : t("recovery.location.installationPreserved"),
      preview.original_install_path,
    ],
    [
      readOnly ? t("recovery.location.gameFiles") : t("recovery.location.gameFilesPreserved"),
      preview.source_path,
    ],
    [
      readOnly ? t("recovery.location.savedData") : t("recovery.location.savedDataPreserved"),
      preview.persistent_data_path,
    ],
    [
      readOnly ? t("recovery.location.backups") : t("recovery.location.backupsPreserved"),
      preview.backup_path,
    ],
    [
      readOnly ? t("recovery.location.logs") : t("recovery.location.logsPreserved"),
      preview.logs_path,
    ],
  ].map(([label, location]) => (
    <div key={label}>
      <dt>{label}</dt>
      <dd className="m-[var(--space-1)_0_var(--space-3)] wrap-anywhere">{location}</dd>
    </div>
  ));
  return (
    <section
      className="preparation-cleanup-details"
      aria-label={
        readOnly ? t("recovery.details.inspectLabel") : t("recovery.details.cleanupLabel")
      }
    >
      <p className="[overflow-wrap:anywhere]">
        <strong>{name}</strong> · {countMessage(preview.retained.files.length, "retainedFiles")} ·{" "}
        {formatBytes(preview.retained.total_bytes)}
      </p>
      {readOnly && (
        <div className="mb-4">
          <h3 className="mt-3 text-base font-semibold">{t("recovery.details.remains")}</h3>
          <p>
            {entries.length
              ? t("recovery.details.remainsFiles")
              : t("recovery.details.remainsRecord")}
          </p>
          <h3 className="mt-3 text-base font-semibold">{t("recovery.details.now")}</h3>
          <p>{t("recovery.details.nowText")}</p>
        </div>
      )}
      <dl>
        <div>
          <dt>
            {readOnly
              ? t("recovery.details.folder")
              : entries.length
                ? t("recovery.details.folderDelete")
                : t("recovery.details.pathClear")}
          </dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]">
            {preview.retained_path}
          </dd>
        </div>
        {!readOnly && recordedLocations}
      </dl>
      {readOnly && (
        <details>
          <summary className="cursor-pointer py-2 font-semibold" data-focusable>
            {t("recovery.details.locations")}
          </summary>
          <p className="text-xs wrap-anywhere">
            <Trans
              t={t}
              i18nKey="recovery.details.task"
              components={{ id: <bdi>{preview.operation_id}</bdi> }}
            />
          </p>
          <dl>{recordedLocations}</dl>
        </details>
      )}
      {!readOnly && (
        <p className="[overflow-wrap:anywhere]">
          {entries.length ? t("recovery.details.deleteScope") : t("recovery.details.clearScope")}
        </p>
      )}
      <p className="[overflow-wrap:anywhere]">
        {readOnly
          ? t("recovery.details.stopInspect")
          : entries.length
            ? t("recovery.details.stopDelete")
            : t("recovery.details.stopClear")}
      </p>
      <details>
        <summary data-focusable>{t("recovery.details.entries", { total: entries.length })}</summary>
        {entries.length ? (
          <ul className="cleanup-entry-list m-[var(--space-2)_0_0] max-h-[12rem] overflow-auto ps-5">
            {entries.map((entry, index) => (
              <li
                className="m-[var(--space-1)_0] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
                key={`${entry.kind}:${entry.path}:${index}`}
              >
                <span>
                  {entry.kind === "folder"
                    ? t("recovery.details.kind.folder")
                    : entry.kind === "file"
                      ? t("recovery.details.kind.file")
                      : t("recovery.details.kind.special")}
                </span>{" "}
                <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="[overflow-wrap:anywhere]">{t("recovery.details.noEntries")}</p>
        )}
      </details>
    </section>
  );
}
