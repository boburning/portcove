import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import { usePreparationCompletionFocus } from "../features/preparation/use-preparation-completion-focus";
import { gameTitle, gameProjectLabel, gameIdentityLabel } from "../port-identity";
import type { GameFileObservationPresentation } from "../features/browsing/use-game-file-observation";
import { cn } from "cn";
import { RemovalControl, type ApplyRemoval } from "./RemovalReview";
import { BrowsingMatchDetails } from "../features/browsing/BrowsingMatchDetails";
import type { CatalogQueryResult } from "../features/browsing/catalog-query";
import { SteamEntryControl } from "./SteamEntry";
import { ExternalRuntimeControl } from "./ExternalRuntime";
import { ArtworkControls, ArtworkImage, DetailArtwork } from "./Artwork";
import type { ApplyBackupAction } from "./BackupReview";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import {
  type LucideIcon,
  AlertTriangle,
  ArrowLeft,
  ArchiveX,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileArchive,
  FileSearch,
  FolderOpen,
  Gamepad2,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { CliContinuity } from "./CliContinuity";
import type {
  ActivityRecord,
  BackupInventory,
  BackupProblem,
  BackupRecord,
  InstallPlan,
  PortDefinition,
  PortStatus,
  ReleaseChannel,
  SourceHealth,
  SourceInspectionReport,
  SourceProfile,
  SourceRecord,
  UpdatePolicy,
} from "../types";
import { OperationCancellation } from "./OperationCancellation";
import { GameFileQueryControl } from "./GameFileQuery";
import { GameFileFilterObservation } from "./GameFileFilterObservation";
import type { GameFileFilterContext } from "../features/browsing/game-file-query-context";
import { OutputLocationControl } from "./OutputLocation";
import { PreparationControl, type RunPreparation } from "./Preparation";
import {
  currentUpdateSnapshot,
  defaultReleaseChannel,
  formatBytes,
  hasUnconfirmedLaunchInput,
  installationMethodLabel,
  platformLabel,
  releaseChannelPresentation,
} from "../view-model";
import { BackupHistory } from "./BackupHistory";
import type { BackupReadState } from "../features/backups/use-port-backups";
import { GameUpdateControl, UpdatePolicyControl } from "./GameUpdates";
import type { Perform } from "../features/operations/use-operation-state";
import { ExternalLink as ProjectLink } from "./ExternalLink";
import { Icon, NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { SourceIdentityPanel } from "./SourceIdentity";
import { DetailQualificationSummary } from "./DetailQualificationSummary";
import { installPlanActionLabel } from "../install-plan-presentation";
import { portActionPresentation } from "../features/port-actions/port-action-presentation";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";

export interface DetailActions {
  activate: AsyncAction;
  backup: AsyncAction;
  check: () => Promise<unknown>;
  close: () => void;
  deleteBackup: ApplyBackupAction;
  dismissInstallReview: () => void;
  install: AsyncAction;
  launch: AsyncAction;
  openUserData: AsyncAction;
  reviewInstall: AsyncAction;
  restoreBackup: ApplyBackupAction;
  rollback: AsyncAction;
  remove: ApplyRemoval;
  setChannel: (channel: ReleaseChannel) => Promise<PortStatus | undefined>;
  setPolicy: (policy: UpdatePolicy) => Promise<PortStatus | undefined>;
  verify: AsyncAction;
}

type AsyncAction = () => void | Promise<unknown>;

interface DetailPanelProps {
  perform?: Perform | undefined;
  prepare?: RunPreparation | undefined;
  cancellableActivities?: ActivityRecord[] | undefined;
  port: PortDefinition;
  status?: PortStatus | undefined;
  installPlan?: InstallPlan | undefined;
  backups?: BackupRecord[];
  backupProblems?: BackupProblem[];
  backupState?: BackupInventory["state"] | undefined;
  backupCreateAssessment?: BackupInventory["create_assessment"] | undefined;
  backupRestoreAssessment?: BackupInventory["restore_assessment"] | undefined;
  backupReadState?: BackupReadState | undefined;
  retryBackupRead?: (() => Promise<void>) | undefined;
  source?: SourceRecord | undefined;
  sourceInspection?: SourceInspectionReport | undefined;
  sourceProfile?: SourceProfile | undefined;
  sourcePath: string;
  setSourcePath: (path: string) => void;
  pickSource?: AsyncAction | undefined;
  pickSourceArchive?: (() => void) | undefined;
  bios?: SourceRecord | undefined;
  biosInspection?: SourceInspectionReport | undefined;
  biosProfile?: SourceProfile | undefined;
  biosPath?: string | undefined;
  setBiosPath?: ((path: string) => void) | undefined;
  pickBios?: AsyncAction | undefined;
  busy?: string | undefined;
  libraryGeneration?: number;
  gameFileQueryContext?: string;
  gameFileFilterContext?: GameFileFilterContext | undefined;
  gameFileObservation?: GameFileObservationPresentation | undefined;
  browsingMatch?: CatalogQueryResult | undefined;
  browsingBinding?: string | undefined;
  outputLocationChanged?: (() => void) | undefined;
  externalRuntimeChanged?: (() => void) | undefined;
  openSourceEvidence?: ((evidenceId: string) => void) | undefined;
  openHostTool?: ((toolId: string) => void) | undefined;
  openLibraryStorage?: (() => void) | undefined;
  inspectSource?: ((profile: SourceProfile) => void) | undefined;
  actions: DetailActions;
}

export function DetailPanel(props: DetailPanelProps) {
  const {
    port,
    status,
    installPlan,
    backups = [],
    backupProblems = [],
    backupState = "healthy",
    backupCreateAssessment,
    backupRestoreAssessment,
    backupReadState,
    retryBackupRead,
    source,
    sourceInspection,
    sourceProfile,
    sourcePath,
    setSourcePath,
    pickSource,
    pickSourceArchive,
    bios,
    biosInspection,
    biosProfile,
    biosPath,
    setBiosPath,
    pickBios,
    busy,
    actions,
  } = props;
  const [outputApplying, setOutputApplying] = useState(false);
  const operationOwner = useOperationPresentation();
  const actionState = presentPortAction(
    operationOwner,
    port.id,
    status,
    status?.active || status?.external_runtime ? "launch" : "install",
    busy,
  );
  const effectiveBusy = actionState.busy ?? (outputApplying ? "storage location" : undefined);
  const selectedChannel = status?.channel ?? defaultReleaseChannel(port);
  const policy = status?.update_policy ?? "notify";
  const {
    sourceReady,
    biosReady,
    launchReady: readinessLaunchReady,
    installed,
    pendingSetup,
  } = detailReadiness(port, status, source, sourcePath, bios, biosPath);
  // Pending work excludes controls without rewriting observed readiness.
  const actionPresentation = actionState.readiness;
  const launchReady = readinessLaunchReady && (!installed || !actionPresentation.blocked);
  const selectedRequirement = selectedSourceRequirement(source, sourcePath, bios, biosPath);
  const missingRequirement: SelectedRequirement | undefined =
    !sourceReady && !biosReady ? "both" : !sourceReady ? "game" : !biosReady ? "bios" : undefined;
  const missingSourceLabels = [
    !sourceReady && port.source_profile && (sourceProfile?.label ?? "Game files"),
    !biosReady && port.bios_source_profile && (biosProfile?.label ?? "Required BIOS file"),
  ].filter((label): label is string => typeof label === "string");
  const runtimeUpdateAvailable = currentUpdateSnapshot(status)?.check.update_available === true;
  const installReviewVisible = Boolean(
    installPlan &&
    !actionPresentation.blocked &&
    !installed &&
    launchReady &&
    !status?.readiness?.blockers.includes("invalid_installation") &&
    !status?.readiness?.blockers.includes("missing_runtime"),
  );
  const state = presentDetailState({
    port,
    status,
    actionPresentation,
    installed,
    launchReady,
    pendingSetup,
    selectedRequirement,
    missingRequirement,
    runtimeUpdateAvailable,
  });
  const sources: SourceControls = {
    port,
    source,
    sourceInspection,
    sourceProfile,
    sourcePath,
    setSourcePath,
    pickSource,
    pickSourceArchive,
    bios,
    biosInspection,
    biosProfile,
    biosPath,
    setBiosPath,
    pickBios,
    sourceReady,
    biosReady,
    openSourceEvidence: props.openSourceEvidence,
    openHostTool: props.openHostTool,
    inspectSource: props.inspectSource,
    sourceHealth: status?.readiness?.source,
    biosHealth: status?.readiness?.bios,
  };
  const renderQueryControl = () =>
    props.libraryGeneration !== undefined &&
    selectedChannel && (
      <GameFileQueryControl
        port={port}
        channel={selectedChannel}
        generation={props.libraryGeneration}
        context={JSON.stringify([
          props.gameFileQueryContext,
          port,
          status,
          source,
          sourceProfile,
          sourceInspection,
          bios,
          biosProfile,
          biosInspection,
        ])}
        busy={Boolean(effectiveBusy)}
      />
    );
  const renderCancellations = () =>
    props.cancellableActivities
      ?.filter((activity) => !(installReviewVisible && activity.operation === "install"))
      .map((activity) => (
        <OperationCancellation
          key={activity.id}
          operationId={activity.id}
          state={activity.cancellation ?? undefined}
        />
      ));
  const renderDetailBody = () => (
    <DetailBody
      header={
        <DetailHero
          port={port}
          state={state}
          missingSourceLabels={!installed ? missingSourceLabels : []}
        />
      }
      observations={
        <>
          {!props.browsingMatch && (
            <GameFileFilterObservation portId={port.id} context={props.gameFileFilterContext} />
          )}
          <BrowsingMatchDetails
            portId={port.id}
            result={props.browsingMatch}
            binding={props.browsingBinding}
            gameFiles={props.gameFileFilterContext}
          />
          {props.gameFileObservation && (
            <GameFileObservationSummary
              observation={props.gameFileObservation}
              catalog
              portId={port.id}
            />
          )}
          {renderQueryControl()}
        </>
      }
      installCancellations={props.cancellableActivities?.filter(
        (activity) => activity.operation === "install",
      )}
      perform={props.perform}
      prepare={props.prepare}
      port={port}
      status={status}
      stagedVersion={status?.staged?.version}
      sources={sources}
      installed={installed}
      deferSetupChoices={!installed && missingRequirement !== undefined}
      sourceReady={sourceReady}
      biosReady={biosReady}
      launchReady={launchReady}
      pendingSetup={pendingSetup}
      runtimeUpdateAvailable={runtimeUpdateAvailable}
      installPlan={installPlan}
      selectedChannel={selectedChannel}
      policy={policy}
      backups={backups}
      backupProblems={backupProblems}
      backupState={backupState}
      backupCreateAssessment={backupCreateAssessment}
      backupRestoreAssessment={backupRestoreAssessment}
      backupReadState={backupReadState}
      retryBackupRead={retryBackupRead}
      busy={effectiveBusy}
      outputExternalBusy={actionState.busy}
      libraryGeneration={props.libraryGeneration ?? 0}
      outputLocationChanged={props.outputLocationChanged}
      externalRuntimeChanged={props.externalRuntimeChanged}
      outputApplying={setOutputApplying}
      actions={actions}
      openLibraryStorage={props.openLibraryStorage}
    />
  );
  return (
    <section
      className="detail-panel @container/detail relative w-full min-w-0 motion-reduce:[animation:none]"
      aria-labelledby="port-detail-title"
      data-detail-workspace
      data-detail-port-id={port.id}
    >
      <Button
        data-focusable
        className="detail-back mb-4"
        variant="ghost"
        size="sm"
        aria-label="Back to previous workspace"
        onClick={actions.close}
      >
        <Icon glyph={ArrowLeft} />
        Back
      </Button>
      {renderCancellations()}
      {renderDetailBody()}
    </section>
  );
}

interface DetailState {
  title: string;
  description: string;
  tone: "setup" | "available" | "ready";
  icon: LucideIcon;
  updateAttention?: string;
}

function DetailHero({
  port,
  state,
  missingSourceLabels,
}: {
  port: PortDefinition;
  state: DetailState;
  missingSourceLabels: string[];
}) {
  return (
    <div className="detail-hero flex items-start gap-4">
      <ArtworkImage
        port={port}
        className="detail-cover aspect-[2/3] w-16 flex-none rounded-pc-md bg-[var(--art-color)]"
      />
      <div className="min-w-0">
        <p className="mb-1 text-xs text-[var(--color-text-secondary)]">
          {port.platforms.map((platform) => platformLabel(platform)).join(" · ")}
        </p>
        <h1
          className="detail-title mb-0 text-[length:var(--text-2xl)] text-[var(--color-text)]"
          id="port-detail-title"
        >
          {gameTitle(port)}
        </h1>
        {gameProjectLabel(port) && (
          <p className="m-0 mt-1 text-sm text-pc-muted-foreground">
            Port project: {gameProjectLabel(port)}
          </p>
        )}
        <span
          className={cn(
            `hero-state mt-[10px] inline-flex items-center gap-2 text-[length:var(--text-xs)] font-[750] text-[var(--color-text)] ${state.tone}`,
            "[&.ready]:text-[var(--color-success-text-raised)] [&.setup]:text-[var(--color-warning-text)] [&.staged]:text-[var(--color-interactive-text)]",
          )}
        >
          <Icon glyph={state.icon} size="sm" />
          {state.title}
        </span>
        {state.tone !== "ready" && (
          <p className="hero-reason m-[var(--space-2)_0_0] max-w-[65ch] text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-[var(--color-text-secondary)]">
            {state.description}
          </p>
        )}
        {"updateAttention" in state && (
          <p className="mt-2 text-sm text-pc-muted-foreground" data-update-attention>
            {state.updateAttention}
          </p>
        )}
        {missingSourceLabels.length > 0 && (
          <p className="hero-requirement m-[var(--space-2)_0_0] max-w-[65ch] text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-[var(--color-text-secondary)]">
            Required for setup:{" "}
            <strong className="font-[600] [overflow-wrap:anywhere] text-[var(--color-text)]">
              {missingSourceLabels.join(" · ")}
            </strong>
          </p>
        )}
      </div>
    </div>
  );
}

function DetailBody({
  header,
  observations,
  installCancellations,
  perform,
  prepare,
  port,
  status,
  stagedVersion,
  sources,
  installed,
  deferSetupChoices,
  sourceReady,
  biosReady,
  launchReady,
  pendingSetup,
  runtimeUpdateAvailable,
  installPlan,
  selectedChannel,
  policy,
  backups,
  backupProblems,
  backupState,
  backupCreateAssessment,
  backupRestoreAssessment,
  backupReadState,
  retryBackupRead,
  busy,
  outputExternalBusy,
  libraryGeneration,
  outputLocationChanged,
  externalRuntimeChanged,
  outputApplying,
  actions,
  openLibraryStorage,
}: {
  header: ReactNode;
  observations: ReactNode;
  installCancellations?: ActivityRecord[] | undefined;
  perform?: Perform | undefined;
  prepare?: RunPreparation | undefined;
  port: PortDefinition;
  status?: PortStatus | undefined;
  stagedVersion?: string | undefined;
  sources: SourceControls;
  installed: boolean;
  deferSetupChoices: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  runtimeUpdateAvailable: boolean;
  installPlan?: InstallPlan | undefined;
  selectedChannel: ReleaseChannel;
  policy: UpdatePolicy;
  backups: BackupRecord[];
  backupProblems: BackupProblem[];
  backupState: BackupInventory["state"];
  backupCreateAssessment?: BackupInventory["create_assessment"] | undefined;
  backupRestoreAssessment?: BackupInventory["restore_assessment"] | undefined;
  backupReadState?: BackupReadState | undefined;
  retryBackupRead?: (() => Promise<void>) | undefined;
  busy?: string | undefined;
  outputExternalBusy?: string | undefined;
  libraryGeneration: number;
  outputLocationChanged?: (() => void) | undefined;
  externalRuntimeChanged?: (() => void) | undefined;
  outputApplying: (applying: boolean) => void;
  actions: DetailActions;
  openLibraryStorage?: (() => void) | undefined;
}) {
  const managedPreparation = needsManagedPreparation(port, installed);
  const external = port.release.provider === "user-prepared" || Boolean(status?.external_runtime);
  const compactActions = installed && !status?.external_runtime && launchReady && !pendingSetup;
  return (
    <div className="detail-body pb-10">
      <div
        className={cn(
          "detail-summary grid gap-3 border-b border-pc-border pb-5",
          compactActions &&
            "@min-[48rem]/detail:grid-cols-[minmax(0,1fr)_16rem] @min-[48rem]/detail:items-center",
        )}
      >
        {header}
        <div className={compactActions ? "w-full max-w-80" : undefined}>
          <StatusActionsGroup
            installCancellations={installCancellations}
            port={port}
            status={status}
            stagedVersion={stagedVersion}
            sources={sources}
            installed={installed}
            sourceReady={sourceReady}
            biosReady={biosReady}
            launchReady={launchReady}
            pendingSetup={pendingSetup}
            runtimeUpdateAvailable={runtimeUpdateAvailable}
            managedPreparation={managedPreparation}
            prepare={prepare}
            installPlan={installPlan}
            busy={busy}
            libraryGeneration={libraryGeneration}
            onChanged={externalRuntimeChanged}
            actions={actions}
            openLibraryStorage={openLibraryStorage}
          />
        </div>
      </div>
      {installed && !external && (
        <UpdatesGroup
          perform={perform}
          port={port}
          status={status}
          installed={installed}
          deferSetupChoices={deferSetupChoices}
          selectedChannel={selectedChannel}
          policy={policy}
          libraryGeneration={libraryGeneration}
          busy={busy}
          actions={actions}
        />
      )}
      <RequirementsGroup
        key={`requirements:${port.id}:${libraryGeneration}`}
        port={port}
        installed={installed}
        sources={sources}
        managedPreparation={managedPreparation}
        pendingSetup={pendingSetup}
        busy={busy}
      />
      <p className="leading-[var(--leading-relaxed)] text-[var(--color-text-secondary)]">
        {port.summary}
      </p>
      <details className="my-4">
        <summary className="cursor-pointer py-2 text-sm font-medium">
          File and filter details
        </summary>
        {observations}
      </details>
      <NavigationHints />
      <ArtworkControls key={`controls:${port.id}:${libraryGeneration}`} port={port} />
      <DetailArtwork key={`artwork:${port.id}:${libraryGeneration}`} port={port} />
      {status?.active && (
        <DetailGroup title="Installation and version">
          <InstallationVersionSummary status={status} selectedChannel={selectedChannel} />
        </DetailGroup>
      )}
      {!installed && !external && (
        <UpdatesGroup
          perform={perform}
          port={port}
          status={status}
          installed={installed}
          deferSetupChoices={deferSetupChoices}
          selectedChannel={selectedChannel}
          policy={policy}
          libraryGeneration={libraryGeneration}
          busy={busy}
          actions={actions}
        />
      )}
      {external ? (
        <DetailGroup title="Saves and storage">
          <p>
            Game-owned settings and saves in the external runtime remain outside Portcove's backup,
            update, and removal operations.
          </p>
        </DetailGroup>
      ) : (
        <SavesStorageGroup
          port={port}
          status={status}
          installed={installed}
          deferSetupChoices={deferSetupChoices}
          backups={backups}
          backupProblems={backupProblems}
          backupState={backupState}
          backupCreateAssessment={backupCreateAssessment}
          backupRestoreAssessment={backupRestoreAssessment}
          backupReadState={backupReadState}
          retryBackupRead={retryBackupRead}
          libraryGeneration={libraryGeneration}
          busy={busy}
          outputExternalBusy={outputExternalBusy}
          outputLocationChanged={outputLocationChanged}
          outputApplying={outputApplying}
          actions={actions}
        />
      )}
      <DetailGroup title="Compatibility and testing">
        <CompatibilitySummary port={port} />
        <DetailQualificationSummary
          port={port}
          sourceInspection={sources.sourceInspection}
          biosInspection={sources.biosInspection}
        />
      </DetailGroup>
      <DetailGroup title="Project and release">
        <ProjectReleaseSummary port={port} />
      </DetailGroup>
      {(!external || hasRecordedChecks(port, sources)) && (
        <TechnicalDetails
          libraryGeneration={libraryGeneration}
          port={port}
          status={status}
          selectedChannel={selectedChannel}
          installed={installed}
          busy={busy}
          sources={sources}
          actions={actions}
        />
      )}
    </div>
  );
}

function StatusActionsGroup({
  installCancellations,
  port,
  status,
  stagedVersion,
  sources,
  installed,
  sourceReady,
  biosReady,
  launchReady,
  pendingSetup,
  runtimeUpdateAvailable,
  managedPreparation,
  prepare,
  installPlan,
  busy,
  libraryGeneration,
  onChanged,
  actions,
  openLibraryStorage,
}: {
  installCancellations?: ActivityRecord[] | undefined;
  port: PortDefinition;
  status?: PortStatus | undefined;
  stagedVersion?: string | undefined;
  sources: SourceControls;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  runtimeUpdateAvailable: boolean;
  managedPreparation: boolean;
  prepare?: RunPreparation | undefined;
  installPlan?: InstallPlan | undefined;
  busy?: string | undefined;
  libraryGeneration: number;
  onChanged?: (() => void) | undefined;
  actions: DetailActions;
  openLibraryStorage?: (() => void) | undefined;
}) {
  const gameActions = useRef<HTMLElement>(null);
  const nextStep = useRef<HTMLHeadingElement>(null);
  const preparedFocus = usePreparationCompletionFocus({
    owner: gameActions,
    nextStep,
    identity: `${port.id}:${libraryGeneration}`,
    busy: Boolean(busy),
  });
  const actionPresentation = portActionPresentation(status, installed ? "launch" : "install");
  const trial =
    hasUnconfirmedLaunchInput(status, port) ||
    Boolean(
      selectedSourceRequirement(sources.source, sources.sourcePath, sources.bios, sources.biosPath),
    );
  if (port.release.provider === "user-prepared" || status?.external_runtime) {
    return (
      <section aria-label="Game actions" className="grid gap-3">
        <RetiredNotice port={port} />
        {status?.external_runtime && actionPresentation.blocked && (
          <p role="status">{actionPresentation.reason}</p>
        )}
        {status?.external_runtime?.shared_preferences?.contract === "smb1r-1.1-stable-windows" &&
          status.readiness?.blockers.some(
            (blocker) => blocker === "preparation_required" || blocker === "invalid_installation",
          ) && (
            <p role="status">
              Copy your recognized Super Mario Bros. (World) NES original to{" "}
              <code>{status.external_runtime.shared_preferences.path}</code> as{" "}
              <code>baserom.nes</code>. If <code>settings.cfg</code> exists there, review it as
              ordinary data without Godot object or resource constructors and use only the
              BaseAssets resource pack. Move custom levels and autosaves, blueprints, custom
              characters, extra resource packs and Godot loader metadata elsewhere manually,
              preserving their files. Refresh afterward. Portcove does not seed, own, update, back
              up or delete this shared directory.
            </p>
          )}
        {status?.external_runtime && (
          <PrimaryActions
            trial={trial}
            sources={sources}
            invalidInstallation={false}
            runtimeNeeded={false}
            runtimeUpdateAvailable={false}
            installed
            sourceReady={sourceReady}
            biosReady={biosReady}
            preparationRequired={false}
            launchReady={launchReady}
            pendingSetup={false}
            stagedVersion={undefined}
            busy={busy}
            actions={actions}
          />
        )}
        <ExternalRuntimeControl
          port={port}
          status={status}
          generation={libraryGeneration}
          busy={Boolean(busy)}
          onChanged={onChanged}
        />
      </section>
    );
  }
  if (!installed && actionPresentation.blocked)
    return (
      <section aria-label="Game actions" className="grid gap-3">
        <RetiredNotice port={port} />
        <p role="status">{actionPresentation.reason}</p>
        <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
          <Button data-focusable className="wide flex-1" variant="primary" size="lg" disabled>
            Installation unavailable
          </Button>
          {installPlan && (
            <Button
              data-focusable
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => actions.dismissInstallReview()}
            >
              Cancel review
            </Button>
          )}
        </div>
      </section>
    );
  return (
    <section
      ref={gameActions}
      data-task-owner={`${port.id}:${libraryGeneration}`}
      aria-label="Game actions"
      className="grid gap-3"
    >
      <RetiredNotice port={port} />
      {actionPresentation.blocked && <p role="status">{actionPresentation.reason}</p>}
      {(!launchReady || managedPreparation) && (
        <h2 ref={nextStep} tabIndex={-1} className="m-0 text-base">
          {managedPreparation && pendingSetup ? "Next step: prepare game data" : "Next step"}
        </h2>
      )}
      {managedPreparation && pendingSetup && sources.sourceReady && sources.biosReady && (
        <>
          <PreparationControl
            key={`${port.id}:${libraryGeneration}:${status?.active?.id}`}
            portId={port.id}
            taskLabel={`${gameTitle(port)}${gameProjectLabel(port) ? ` · Port: ${gameProjectLabel(port)}` : ""}`}
            generation={libraryGeneration}
            disabled={Boolean(busy) || !sources.sourceReady || !sources.biosReady}
            run={prepare}
            onPrepared={preparedFocus}
            focusFallback={() =>
              gameActions.current?.querySelector<HTMLElement>(
                "[data-confirmed-play]:not(:disabled)",
              ) ?? nextStep.current
            }
          />
        </>
      )}
      <PrimaryActions
        trial={trial}
        installCancellations={installCancellations}
        sources={sources}
        invalidInstallation={Boolean(status?.readiness?.blockers.includes("invalid_installation"))}
        preparationRequired={managedPreparation && pendingSetup}
        runtimeNeeded={Boolean(status?.readiness?.blockers.includes("missing_runtime"))}
        runtimeUpdateAvailable={runtimeUpdateAvailable}
        stagedVersion={stagedVersion}
        installed={installed}
        sourceReady={sourceReady}
        biosReady={biosReady}
        launchReady={launchReady}
        pendingSetup={pendingSetup}
        plan={installPlan}
        busy={busy}
        actions={actions}
        openLibraryStorage={openLibraryStorage}
      />
    </section>
  );
}

const disclosureSummaryStyle =
  "list-none [&::-webkit-details-marker]:hidden flex cursor-pointer list-none items-center justify-between gap-3 px-0.5 py-[15px] text-xs font-bold hover:text-[var(--color-interactive-text-strong)]";
const disclosureMetaStyle =
  "ml-auto text-[length:var(--text-2xs)] font-medium text-pc-muted-foreground";
const disclosureBodyStyle = "pt-0.5 pb-[22px]";

function RequirementsGroup({
  port,
  installed,
  sources,
  managedPreparation,
  pendingSetup,
  busy,
}: {
  port: PortDefinition;
  installed: boolean;
  sources: SourceControls;
  managedPreparation: boolean;
  pendingSetup: boolean;
  busy?: string | undefined;
}) {
  const needsAttention =
    !installed ||
    !sources.sourceReady ||
    !sources.biosReady ||
    (managedPreparation && pendingSetup);
  const [initiallyOpen] = useState(needsAttention);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (needsAttention && disclosure.current) disclosure.current.open = true;
  }, [needsAttention]);
  if (!port.source_profile && !port.bios_source_profile && !managedPreparation) return null;
  return (
    <DetailGroup title="Requirements">
      <details
        ref={disclosure}
        className="requirements-disclosure border-y border-pc-border"
        open={initiallyOpen}
      >
        <summary data-focusable className={`requirements-summary ${disclosureSummaryStyle}`}>
          Game-file requirements and setup
          <span className={`requirements-summary-meta ${disclosureMetaStyle}`}>File controls</span>
          <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
        </summary>
        <div className={`requirements-body grid gap-4 ${disclosureBodyStyle}`}>
          <RequirementsSummary port={port} />
          <SourceFields controls={sources} />
          <SourceIntakeActions controls={sources} busy={Boolean(busy)} />
        </div>
      </details>
    </DetailGroup>
  );
}

function UpdatesGroup({
  perform,
  port,
  status,
  installed,
  deferSetupChoices,
  selectedChannel,
  policy,
  libraryGeneration,
  busy,
  actions,
}: {
  perform?: Perform | undefined;
  port: PortDefinition;
  status?: PortStatus | undefined;
  installed: boolean;
  deferSetupChoices: boolean;
  selectedChannel: ReleaseChannel;
  policy: UpdatePolicy;
  libraryGeneration: number;
  busy?: string | undefined;
  actions: DetailActions;
}) {
  const checked = currentUpdateSnapshot(status)?.check;
  const knownCandidate = Boolean(status?.staged || checked?.update_available);
  const preferences = (
    <>
      <div>
        <ReleaseChannelControl
          key={`${port.id}:${libraryGeneration}`}
          channels={port.channels}
          selected={selectedChannel}
          busy={Boolean(busy)}
          change={actions.setChannel}
          refresh={actions.check}
        />
      </div>
      <div>
        <UpdatePolicyControl
          key={port.id}
          policy={policy}
          busy={Boolean(busy)}
          save={actions.setPolicy}
        />
      </div>
    </>
  );
  return (
    <DetailGroup title="Updates">
      {status?.staged && (
        <section aria-label="Use update saved for later">
          <p>
            Update saved for later: <strong>{status.staged.version}</strong>. Using this checked
            local copy does not download it again, and keeps the current version for rollback.
          </p>
        </section>
      )}
      {installed && (
        <>
          <p>
            {checked
              ? checked.update_available
                ? `Update ${checked.release.version} was available at the saved check. Review it again before making changes.`
                : "No update was found at the saved check. Review can identify a release again without changing the installation."
              : "There is no saved update check for this installation and channel. Review identifies the release before asking what to do."}
          </p>
          {!knownCandidate && <UpdateCheckAction busy={busy} check={actions.check} primary />}
          <GameUpdateControl
            key={`${port.id}:${libraryGeneration}:${status?.active?.id}:${status?.staged?.id}:${selectedChannel}:${policy}`}
            portId={port.id}
            generation={libraryGeneration}
            policy={policy}
            gameName={gameIdentityLabel(port)}
            busy={Boolean(busy)}
            perform={perform}
            primary={knownCandidate}
          />
          {knownCandidate && <UpdateCheckAction busy={busy} check={actions.check} />}
        </>
      )}
      <details className="mt-4">
        <summary data-focusable className="cursor-pointer py-2 text-sm font-medium">
          Future update preferences
        </summary>
        <p className="text-xs text-pc-muted-foreground">
          {deferSetupChoices ? "Game files are still required before installation. " : ""}
          These choices apply to future checks and managed updates. Saving them does not run an
          update.
        </p>
        {preferences}
      </details>
    </DetailGroup>
  );
}

function SavesStorageGroup({
  port,
  status,
  installed,
  deferSetupChoices,
  backups,
  backupProblems,
  backupState,
  backupCreateAssessment,
  backupRestoreAssessment,
  backupReadState,
  retryBackupRead,
  libraryGeneration,
  busy,
  outputExternalBusy,
  outputLocationChanged,
  outputApplying,
  actions,
}: {
  port: PortDefinition;
  status?: PortStatus | undefined;
  installed: boolean;
  deferSetupChoices: boolean;
  backups: BackupRecord[];
  backupProblems: BackupProblem[];
  backupState: BackupInventory["state"];
  backupCreateAssessment?: BackupInventory["create_assessment"] | undefined;
  backupRestoreAssessment?: BackupInventory["restore_assessment"] | undefined;
  backupReadState?: BackupReadState | undefined;
  retryBackupRead?: (() => Promise<void>) | undefined;
  libraryGeneration: number;
  busy?: string | undefined;
  outputExternalBusy?: string | undefined;
  outputLocationChanged?: (() => void) | undefined;
  outputApplying: (applying: boolean) => void;
  actions: DetailActions;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const hasBackupHistory =
    installed ||
    backups.length > 0 ||
    backupProblems.length > 0 ||
    (backupReadState !== undefined && backupReadState.status !== "idle");
  const outputLocation = (
    <OutputLocationControl
      key={`${port.id}:${libraryGeneration}`}
      portId={port.id}
      generation={libraryGeneration}
      busy={outputExternalBusy}
      onChanged={outputLocationChanged}
      onApplying={outputApplying}
    />
  );
  return (
    <DetailGroup title="Saves and storage" headingRef={heading}>
      <TrustStrip status={status} />
      <SavesAndSettingsSummary port={port} />
      <StorageSummary status={status} />
      <FutureSetupDisclosure
        deferred={deferSetupChoices}
        title="Folder for a future install"
        description="Game files are still required before installation. Choosing an output folder here does not move or install a game."
      >
        {outputLocation}
      </FutureSetupDisclosure>
      <DataActions
        busy={busy}
        actions={actions}
        assessment={backupCreateAssessment}
        readState={backupReadState}
      />
      {hasBackupHistory && (
        <BackupHistory
          key={`${port.id}:${libraryGeneration}`}
          generation={libraryGeneration}
          backups={backups}
          problems={backupProblems}
          state={backupState}
          restoreAssessment={backupRestoreAssessment}
          readState={backupReadState}
          retryRead={retryBackupRead}
          busy={busy}
          restore={actions.restoreBackup}
          remove={actions.deleteBackup}
          focusFallback={() => heading.current}
        />
      )}
    </DetailGroup>
  );
}

function FutureSetupDisclosure({
  deferred,
  title,
  description,
  children,
}: {
  deferred: boolean;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <details
      className={`future-setup-disclosure${deferred ? " advanced-settings is-deferred border-y border-pc-border" : ""}`}
      open={!deferred}
    >
      <summary
        data-focusable={deferred ? true : undefined}
        className={cn(`advanced-summary ${disclosureSummaryStyle}`, !deferred && "hidden")}
      >
        {title}
        <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
      </summary>
      <div className={`grid gap-4${deferred ? ` advanced-body ${disclosureBodyStyle}` : ""}`}>
        {deferred && <p>{description}</p>}
        {children}
      </div>
    </details>
  );
}

function DetailGroup({
  title,
  children,
  headingRef,
}: {
  title: string;
  children: React.ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const headingId = `detail-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section
      className="detail-group mt-7 grid gap-4 border-t border-pc-border pt-6 first:mt-0 first:border-t-0 first:pt-0"
      aria-labelledby={headingId}
    >
      <h2 ref={headingRef} id={headingId} tabIndex={-1} className="m-0 text-base">
        {title}
      </h2>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function InstallationVersionSummary({
  status,
  selectedChannel,
}: {
  status?: PortStatus | undefined;
  selectedChannel: ReleaseChannel;
}) {
  const checked = currentUpdateSnapshot(status)?.check;
  const latestEligible =
    checked?.release.version ??
    (status?.active ? "No current check" : "Version shown when you review installation.");
  return (
    <dl
      className="installation-facts m-0 grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_9.25rem),_1fr))] rounded-pc-md border border-pc-border bg-[var(--color-bg-subtle)] [&_dd]:m-0 [&_dd]:mt-1 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-xs [&_dt]:text-pc-muted-foreground [&>div]:min-w-0 [&>div]:px-3 [&>div]:py-2.5"
      aria-label="Installation and release versions"
    >
      <div>
        <dt>Installed version</dt>
        <dd>{status?.active?.version ?? "Not installed"}</dd>
      </div>
      <div>
        <dt>Selected channel</dt>
        <dd>{releaseChannelPresentation(selectedChannel).label}</dd>
      </div>
      {status?.active && (
        <div>
          <dt>Installed channel</dt>
          <dd>{releaseChannelPresentation(status.active.channel).label}</dd>
        </div>
      )}
      <div>
        <dt>Latest available for your settings</dt>
        <dd>{latestEligible}</dd>
      </div>
      {status?.staged && (
        <div>
          <dt>Update saved for later</dt>
          <dd>{status.staged.version}</dd>
        </div>
      )}
      {status?.active && (
        <div className="col-span-full border-t border-pc-border">
          <dt>Installed folder</dt>
          <dd>{status.active.path}</dd>
        </div>
      )}
    </dl>
  );
}

function StorageSummary({ status }: { status?: PortStatus | undefined }) {
  return (
    <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
      <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">
          Saves and settings folder
        </small>
        {status?.user_data_root ?? "Created inside the selected library"}
      </span>
    </div>
  );
}

function CompatibilitySummary({ port }: { port: PortDefinition }) {
  return (
    <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
      <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">Platforms</small>
        {port.platforms.map((value) => platformLabel(value)).join(" · ")}
      </span>
      {port.platforms.includes("linux-x86-64") && (
        <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">Steam Deck</small>
          Not tested. Linux availability does not show whether this game works on SteamOS or in
          Gaming Mode.
        </span>
      )}
      <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">Installation method</small>
        {installationMethodLabel(port)}
      </span>
    </div>
  );
}

function ProjectReleaseSummary({ port }: { port: PortDefinition }) {
  return (
    <>
      <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
        <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">Upstream project</small>
          {upstreamStatusPresentation[port.upstream_status]}
        </span>
        <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">
            Catalog designation (not a test result)
          </small>
          {supportTierPresentation[port.support_tier]}
        </span>
        <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">
            Available release channels
          </small>
          {port.channels.map((channel) => releaseChannelPresentation(channel).label).join(" · ")}
        </span>
      </div>
      <div className="upstream-link m-[var(--space-4)_0] grid gap-1 text-[length:var(--text-xs)]">
        <ProjectLink href={port.project_url}>
          Open upstream project <Icon glyph={ExternalLink} size="sm" />
        </ProjectLink>
        <span className="text-[var(--color-text-muted)]">
          {port.release.provider === "direct-manifest"
            ? port.upstream_status === "retired"
              ? "Portcove uses the pinned release recorded in the catalog."
              : "Portcove uses the release details recorded in the catalog."
            : port.release.provider === "user-prepared"
              ? "Portcove uses the accepted package identity recorded in the catalog. You prepare the runtime."
              : "Portcove checks this project for releases."}
        </span>
      </div>
    </>
  );
}

function RequirementsSummary({ port }: { port: PortDefinition }) {
  if (!port.presentation)
    return <p>Structured requirement details are unavailable in this catalog.</p>;
  return (
    <div
      className="metadata grid grid-cols-[1fr_1fr] gap-[10px]"
      role="group"
      aria-label="Required game files and verification"
    >
      {port.presentation.source_requirements.map((requirement) => (
        <span
          className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
          key={requirement.role}
        >
          <small className="mb-[5px] block text-[var(--color-text-muted)]">
            {requirement.role === "bios" ? "Required BIOS" : "Required game files"}
          </small>
          {requirement.label}
          <small className="mb-[5px] block text-[var(--color-text-muted)]">
            Check method: {sourceVerificationPresentation[requirement.verification]}
          </small>
        </span>
      ))}
    </div>
  );
}

function SavesAndSettingsSummary({ port }: { port: PortDefinition }) {
  return (
    <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
      <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">Saved data handling</small>
        {port.presentation?.saves_and_settings === "portcove-managed"
          ? "Managed by Portcove for backup and restore"
          : port.presentation?.saves_and_settings === "external-user-owned"
            ? "Stored with your external runtime; Portcove does not back up or remove it"
            : "Unavailable in this catalog"}
      </span>
    </div>
  );
}

function TrustStrip({ status }: { status?: PortStatus | undefined }) {
  return (
    <div className="trust-strip m-[13px_1px_22px] flex flex-wrap gap-[7px_12px] text-[length:var(--text-2xs)] text-[var(--color-text-muted)]">
      <span className="inline-flex items-center gap-1">
        <Icon glyph={HardDrive} size="sm" />
        Game files stay local
      </span>
      {status?.previous && (
        <span className="inline-flex items-center gap-1">
          <Icon glyph={RotateCcw} size="sm" />
          Previous version recorded · {status.previous.version}
        </span>
      )}
    </div>
  );
}

function detailReadiness(
  port: PortDefinition,
  status: PortStatus | undefined,
  source: SourceRecord | undefined,
  sourcePath: string,
  bios: SourceRecord | undefined,
  biosPath: string | undefined,
) {
  const installed = Boolean(status?.active || status?.external_runtime);
  const sourceReady =
    !status?.readiness?.blockers.includes("incompatible_source") &&
    sourceRequirementReady(
      Boolean(port.source_profile),
      installed,
      status?.readiness?.source,
      Boolean(source || sourcePath.trim()),
    );
  const biosReady =
    !status?.readiness?.blockers.includes("incompatible_bios") &&
    sourceRequirementReady(
      Boolean(port.bios_source_profile),
      installed,
      status?.readiness?.bios,
      Boolean(bios || biosPath?.trim()),
    );
  return {
    sourceReady,
    biosReady,
    launchReady: installed ? status?.readiness?.launchable === true : sourceReady && biosReady,
    installed,
    pendingSetup: Boolean(status?.readiness?.pending_setup),
  };
}

function sourceRequirementReady(
  required: boolean,
  installed: boolean,
  health: SourceHealth | null | undefined,
  selected: boolean,
) {
  if (!required) return true;
  if (!installed || health == null) return selected;
  return health === "current";
}

type SourceControls = Pick<
  DetailPanelProps,
  | "port"
  | "source"
  | "sourceInspection"
  | "sourceProfile"
  | "sourcePath"
  | "setSourcePath"
  | "pickSource"
  | "pickSourceArchive"
  | "bios"
  | "biosInspection"
  | "biosProfile"
  | "biosPath"
  | "setBiosPath"
  | "pickBios"
  | "openSourceEvidence"
  | "openHostTool"
  | "inspectSource"
> & {
  sourceReady: boolean;
  biosReady: boolean;
  sourceHealth?: SourceHealth | null | undefined;
  biosHealth?: SourceHealth | null | undefined;
};

function SourceFields({ controls }: { controls: SourceControls }) {
  return (
    <>
      {originalSourceField(controls)}
      {biosSourceField(controls)}
    </>
  );
}

function SourceIntakeActions({ controls, busy }: { controls: SourceControls; busy: boolean }) {
  if (!controls.inspectSource || (!controls.sourceProfile && !controls.biosProfile)) return null;
  return (
    <div
      className="source-intake-shortcuts m-[var(--space-4)_0] flex flex-wrap gap-2"
      role="group"
      aria-label="Check game files"
    >
      {controls.sourceProfile && (
        <Button
          data-focusable
          variant="outline"
          type="button"
          disabled={busy}
          onClick={() => controls.inspectSource?.(controls.sourceProfile!)}
        >
          <Icon glyph={FileSearch} />
          Check game files
        </Button>
      )}
      {controls.biosProfile && (
        <Button
          data-focusable
          variant="outline"
          type="button"
          disabled={busy}
          onClick={() => controls.inspectSource?.(controls.biosProfile!)}
        >
          <Icon glyph={FileSearch} />
          Check required BIOS
        </Button>
      )}
    </div>
  );
}

function originalSourceField(controls: SourceControls) {
  const profileId = controls.port.source_profile;
  if (!profileId) return null;
  return (
    <SourceField
      heading="Game files"
      profileId={profileId}
      profile={controls.sourceProfile}
      source={controls.source}
      inspection={controls.sourceInspection}
      health={controls.sourceHealth}
      path={controls.sourcePath}
      setPath={controls.setSourcePath}
      pick={controls.pickSource}
      pickArchive={controls.pickSourceArchive}
      openEvidence={controls.openSourceEvidence}
      openHostTool={controls.openHostTool}
    />
  );
}

function biosSourceField(controls: SourceControls) {
  const profileId = controls.port.bios_source_profile;
  if (!profileId || !controls.biosProfile || !controls.setBiosPath) return null;
  return (
    <SourceField
      heading="Required BIOS"
      profileId={profileId}
      profile={controls.biosProfile}
      source={controls.bios}
      inspection={controls.biosInspection}
      health={controls.biosHealth}
      path={controls.biosPath ?? ""}
      setPath={controls.setBiosPath}
      pick={controls.pickBios}
      openEvidence={controls.openSourceEvidence}
      openHostTool={controls.openHostTool}
    />
  );
}

function RetiredNotice({ port }: { port: PortDefinition }) {
  if (port.upstream_status !== "retired") return null;
  return (
    <p className="retired-notice flex items-start gap-2 rounded-pc-md border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-[10px_12px] text-[var(--color-text-secondary)]">
      <Icon className="mt-[0.1rem] flex-none" glyph={ArchiveX} />{" "}
      <span className="block">
        <strong className="mb-1 block text-[var(--color-text)]">Retired upstream</strong>The
        upstream project is no longer maintained. Portcove checks available releases against its
        usual source and package requirements; no new upstream fixes are expected.
      </span>
    </p>
  );
}

function hasRecordedChecks(port: PortDefinition, sources: SourceControls) {
  return [sources.sourceInspection, sources.biosInspection].some((report) =>
    report?.applications.some(
      (application) =>
        application.port_id === port.id && application.qualification.exact_records.length > 0,
    ),
  );
}

function TechnicalDetails({
  libraryGeneration,
  port,
  status,
  selectedChannel,
  installed,
  busy,
  sources,
  actions,
}: {
  libraryGeneration: number;
  port: PortDefinition;
  status?: PortStatus | undefined;
  selectedChannel: ReleaseChannel;
  installed: boolean;
  busy?: string | undefined;
  sources: SourceControls;
  actions: DetailActions;
}) {
  const includeManagement = port.release.provider !== "user-prepared" && !status?.external_runtime;
  const persistentFiles = [
    ...port.persistent_paths,
    ...(port.persistent_file_patterns ?? []).map(
      (pattern) => `${pattern.prefix}*${pattern.suffix}`,
    ),
  ].join(" · ");
  return (
    <details className="advanced-settings border-y border-pc-border">
      <summary data-focusable className={`advanced-summary ${disclosureSummaryStyle}`}>
        Technical details{" "}
        <span className={`advanced-summary-meta ${disclosureMetaStyle}`}>
          {includeManagement ? "Commands and maintenance" : "Recorded check identities"}
        </span>
        <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
      </summary>
      <div className={`advanced-body ${disclosureBodyStyle}`}>
        {includeManagement && (
          <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
            <span
              className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
              title={persistentFiles}
            >
              <small className="mb-[5px] block text-[var(--color-text-muted)]">
                Saved data patterns
              </small>
              {persistentFiles || "No saved data paths declared"}
            </span>
          </div>
        )}
        <DetailQualificationSummary
          port={port}
          sourceInspection={sources.sourceInspection}
          biosInspection={sources.biosInspection}
          technical
        />
        {includeManagement && (
          <CliContinuity
            key={`${port.id}:${libraryGeneration}`}
            generation={libraryGeneration}
            port={port}
            status={status}
            channel={selectedChannel}
            sourcePath={sources.sourcePath || sources.source?.path || ""}
            biosPath={sources.biosPath || sources.bios?.path || ""}
          />
        )}
        {includeManagement && installed && (
          <MaintenanceActions
            port={port}
            libraryGeneration={libraryGeneration}
            canRollback={Boolean(status?.previous)}
            status={status}
            verificationPrimary={Boolean(
              status?.readiness?.blockers.includes("invalid_installation"),
            )}
            busy={busy}
            actions={actions}
          />
        )}
        {includeManagement && (
          <div className="actions maintenance-actions mt-[18px] flex flex-wrap gap-[8px] pt-[18px] [border-top:1px_solid_var(--color-border)] [&.compact]:mt-[14px]">
            <SteamEntryControl
              key={`steam:${port.id}:${libraryGeneration}`}
              port={port}
              generation={libraryGeneration}
              installed={installed}
              busy={Boolean(busy)}
            />
          </div>
        )}
      </div>
    </details>
  );
}

const sourceVerificationPresentation: Record<
  NonNullable<PortDefinition["presentation"]>["source_requirements"][number]["verification"],
  string
> = {
  "catalog-identity": "Known file signatures",
  "upstream-validator": "The port’s validation tool",
  "catalog-rules": "Required files and format checks",
};

const upstreamStatusPresentation: Record<PortDefinition["upstream_status"], string> = {
  active: "Active",
  retired: "Retired",
  superseded: "Superseded",
  abandoned: "Abandoned",
};

const supportTierPresentation: Record<PortDefinition["support_tier"], string> = {
  stable: "Stable",
  beta: "Beta",
  rolling: "Rolling",
};

function SourceField({
  heading,
  profileId,
  profile,
  source,
  inspection,
  health,
  path,
  setPath,
  pick,
  pickArchive,
  openEvidence,
  openHostTool,
}: {
  heading: string;
  profileId: string;
  profile?: SourceProfile | undefined;
  source?: SourceRecord | undefined;
  inspection?: SourceInspectionReport | undefined;
  health?: SourceHealth | null | undefined;
  path: string;
  setPath: (path: string) => void;
  pick?: AsyncAction | undefined;
  pickArchive?: (() => void) | undefined;
  openEvidence?: ((evidenceId: string) => void) | undefined;
  openHostTool?: ((toolId: string) => void) | undefined;
}) {
  const bios = heading === "Required BIOS";
  const copy = sourceFieldCopy(profile, bios);
  const selectedOverride = Boolean(path.trim()) && (!source || path !== source.path);
  const sourceNote = selectedOverride
    ? bios
      ? "Selected BIOS file has not been checked. Choose Check required BIOS to check and save this location."
      : "Selected path has not been checked. Choose Check game files to check and save this location."
    : source
      ? sourceHealthNote(inspection?.health ?? health, bios)
      : copy.note;
  const inputId = `source-${profileId}`;
  return (
    <div className="[&_small]:mt-[7px] [&_small]:block [&_small]:text-pc-muted-foreground">
      <label
        htmlFor={inputId}
        className="mb-2 block text-xs font-bold text-[color:var(--color-text-secondary)]"
      >
        {heading} · {profile?.label ?? profileId}
      </label>
      <div className="flex items-stretch gap-2 [&_input]:min-w-0">
        <Input
          data-focusable
          id={inputId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={copy.placeholder}
        />
        {pick && (
          <Button data-focusable variant="outline" type="button" onClick={() => void pick()}>
            <Icon glyph={FolderOpen} />
            {bios ? "Choose BIOS file" : "Choose game files"}
          </Button>
        )}
        {pickArchive && (
          <Button data-focusable variant="outline" type="button" onClick={pickArchive}>
            <Icon glyph={FileArchive} />
            Choose ZIP file
          </Button>
        )}
      </div>
      <small>{sourceNote}</small>
      <SourceFileDetails source={source} />
      {selectedOverride && source && health && health !== "current" && (
        <small>{sourceHealthNote(health, bios)}</small>
      )}
      {!selectedOverride && inspection && (
        <SourceIdentityPanel
          report={inspection}
          openEvidence={openEvidence}
          openHostTool={openHostTool}
        />
      )}
    </div>
  );
}

function SourceFileDetails({ source }: { source?: SourceRecord | undefined }) {
  if (!source) return null;
  return (
    <details className="source-technical border-t border-pc-border">
      <summary
        data-focusable
        className="cursor-pointer py-3 font-medium text-pc-interactive-foreground"
      >
        File details
      </summary>
      <div className="digest-value grid min-w-0 grid-cols-[minmax(0,_1fr)_auto] items-center gap-[3px_var(--space-2)] [&.missing]:grid-cols-[1fr] [&.missing]:rounded-pc-md [&.missing]:p-2 [&.missing]:[border:1px_dashed_var(--color-warning-border)]">
        <strong className="text-[length:var(--text-xs)] font-medium">Saved SHA-256</strong>
        <code className="col-[1] block bg-[transparent] p-0 [overflow-wrap:anywhere] whitespace-normal text-[var(--color-text-muted)]">
          {source.sha256 || "Not recorded"}
        </code>
      </div>
    </details>
  );
}

function sourceHealthNote(health: SourceHealth | null | undefined, bios: boolean) {
  if (health === "current")
    return bios
      ? "BIOS file is unchanged since it was added"
      : "Files are unchanged since they were added";
  if (health === "not_checked")
    return bios
      ? "BIOS file added · current contents not checked"
      : "Files added · current contents not checked";
  if (health === "changed")
    return bios
      ? "BIOS file has changed since it was added"
      : "Files have changed since they were added";
  if (health === "missing")
    return bios
      ? "BIOS file not found at the saved location"
      : "Files not found at the saved location";
  if (health === "unreadable")
    return bios ? "Portcove couldn't read this BIOS file" : "Portcove couldn't read these files";
  if (health === "not_baselined")
    return bios
      ? "No saved record to compare this BIOS file with"
      : "No saved record to compare these files with";
  return bios ? "BIOS check status unavailable" : "Game-file check status unavailable";
}

function sourceFieldCopy(profile: SourceProfile | undefined, bios: boolean) {
  if (profile?.kind === "file-set" || profile?.kind === "relative-file-set")
    return {
      placeholder: "Choose the folder or ZIP file that contains the required game files",
      note: "Portcove checks this location without uploading or changing it.",
    };
  if (profile?.kind === "psx-disc" && (profile.disc?.discs?.length ?? 0) > 1)
    return {
      placeholder: "Choose the folder that contains all required game discs",
      note: "Portcove checks this folder without uploading or changing it.",
    };
  return {
    placeholder: bios ? "Choose the required BIOS file" : "Choose the required game file",
    note: bios
      ? "Portcove uses this BIOS file in place and never uploads or changes it."
      : "Portcove uses this game file in place and never uploads or changes it.",
  };
}

function PrimaryActions({
  trial,
  installCancellations,
  sources,
  invalidInstallation,
  preparationRequired,
  runtimeNeeded,
  runtimeUpdateAvailable,
  stagedVersion,
  installed,
  sourceReady,
  biosReady,
  launchReady,
  pendingSetup,
  plan,
  busy,
  actions,
  openLibraryStorage,
}: {
  trial: boolean;
  installCancellations?: ActivityRecord[] | undefined;
  sources: SourceControls;
  invalidInstallation: boolean;
  preparationRequired: boolean;
  runtimeNeeded: boolean;
  runtimeUpdateAvailable: boolean;
  stagedVersion?: string | undefined;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  plan?: InstallPlan | undefined;
  busy?: string | undefined;
  actions: DetailActions;
  openLibraryStorage?: (() => void) | undefined;
}) {
  if (invalidInstallation)
    return (
      <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
        <Button
          data-focusable
          className="wide flex-1"
          variant="primary"
          size="lg"
          disabled={Boolean(busy)}
          onClick={() => void actions.verify()}
        >
          <Icon glyph={ShieldCheck} />
          Verify installation
        </Button>
        <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />
      </div>
    );
  if (runtimeNeeded)
    return (
      <>
        {runtimeUpdateAvailable ? (
          <p>Review the game update below to install the required component.</p>
        ) : (
          <p>
            Check for updates. If none is available, verify the installation for diagnostic details.
          </p>
        )}
        {stagedVersion && (
          <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
            <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />
          </div>
        )}
      </>
    );
  if (!installed)
    return (
      <InstallAction
        cancellations={installCancellations}
        ready={launchReady}
        sourceReady={sourceReady}
        biosReady={biosReady}
        pickSource={sources.pickSource}
        pickBios={sources.pickBios}
        sourceInputId={
          sources.port.source_profile ? `source-${sources.port.source_profile}` : undefined
        }
        biosInputId={
          sources.port.bios_source_profile && sources.biosProfile && sources.setBiosPath
            ? `source-${sources.port.bios_source_profile}`
            : undefined
        }
        plan={plan}
        busy={busy}
        install={actions.install}
        review={actions.reviewInstall}
        dismiss={actions.dismissInstallReview}
        openLibraryStorage={openLibraryStorage}
      />
    );
  const missingProfile = !sourceReady
    ? sources.sourceProfile
    : !biosReady
      ? sources.biosProfile
      : undefined;
  if (missingProfile && sources.inspectSource)
    return (
      <div className="actions primary-actions mt-4 flex flex-wrap gap-2">
        <Button
          data-focusable
          className="wide flex-1"
          variant="primary"
          size="lg"
          disabled={Boolean(busy)}
          onClick={() => sources.inspectSource?.(missingProfile)}
        >
          <Icon glyph={FileSearch} />
          {missingProfile.id === sources.port.bios_source_profile
            ? "Locate required BIOS"
            : "Locate game files"}
        </Button>
      </div>
    );
  return (
    <InstalledPlayActions
      trial={trial}
      preparationRequired={preparationRequired}
      launchReady={launchReady}
      pendingSetup={pendingSetup}
      stagedVersion={stagedVersion}
      busy={busy}
      actions={actions}
    />
  );
}

function InstalledPlayActions({
  trial = false,
  preparationRequired,
  launchReady,
  pendingSetup,
  stagedVersion,
  busy,
  actions,
}: {
  trial?: boolean;
  preparationRequired: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  stagedVersion?: string | undefined;
  busy?: string | undefined;
  actions: DetailActions;
}) {
  if (preparationRequired)
    return <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />;
  return (
    <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
      <Button
        data-focusable
        data-launch-action
        data-confirmed-play={launchReady && !trial && !pendingSetup ? "" : undefined}
        className="wide flex-1"
        variant="primary"
        size="lg"
        title={
          launchReady
            ? trial
              ? "Try launching; compatibility is unconfirmed"
              : "Launch this port"
            : "Review the current launch requirements"
        }
        disabled={!launchReady || Boolean(busy)}
        onClick={() => {
          void actions.launch();
        }}
      >
        <Icon glyph={!launchReady ? AlertTriangle : pendingSetup ? Wrench : Gamepad2} />
        {!launchReady
          ? "Play unavailable"
          : pendingSetup
            ? "Start setup"
            : trial
              ? "Try launch"
              : "Play"}
      </Button>
      <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />
    </div>
  );
}

function StagedActivation({
  version,
  busy,
  activate,
}: {
  version?: string | undefined;
  busy?: string | undefined;
  activate: DetailActions["activate"];
}) {
  if (!version) return null;
  return (
    <Button
      data-focusable
      className="staged-action"
      variant="selected"
      size="lg"
      disabled={Boolean(busy)}
      onClick={() => {
        void activate();
      }}
    >
      Use update · {version}
    </Button>
  );
}

export function InstallAction({
  cancellations,
  ready,
  sourceReady,
  biosReady,
  pickSource,
  pickBios,
  sourceInputId,
  biosInputId,
  plan,
  busy,
  install,
  review,
  dismiss,
  openLibraryStorage,
  portaled = true,
}: {
  cancellations?: ActivityRecord[] | undefined;
  ready: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  pickSource?: AsyncAction | undefined;
  pickBios?: AsyncAction | undefined;
  sourceInputId?: string | undefined;
  biosInputId?: string | undefined;
  plan?: InstallPlan | undefined;
  busy?: string | undefined;
  install: AsyncAction;
  review: AsyncAction;
  dismiss: () => void;
  openLibraryStorage?: (() => void) | undefined;
  portaled?: boolean;
}) {
  const reviewButton = useRef<HTMLButtonElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    if (!choosing && restoreFocus.current) {
      restoreFocus.current = false;
      (ready ? reviewButton : chooseButton).current?.focus();
    }
  }, [choosing, ready, sourceReady, biosReady]);
  if (!ready) {
    const pick = !sourceReady ? pickSource : pickBios;
    const inputId = !sourceReady ? sourceInputId : biosInputId;
    return (
      <MissingInstallAction
        sourceReady={sourceReady}
        biosReady={biosReady}
        pick={pick}
        inputId={inputId}
        choosing={choosing}
        busy={busy}
        buttonRef={chooseButton}
        onPick={() => {
          if (pick) {
            restoreFocus.current = true;
            setChoosing(true);
            void Promise.resolve()
              .then(pick)
              .then(
                () => setChoosing(false),
                () => setChoosing(false),
              );
          } else if (inputId) {
            document.getElementById(inputId)?.focus();
          }
        }}
      />
    );
  }
  const action = plan ? installPlanActionLabel(plan.action) : undefined;
  return (
    <>
      <div
        className={cn(
          plan ? "hidden" : "actions primary-actions mt-[16px] flex flex-wrap gap-[8px]",
          "[&.compact]:mt-[14px]",
        )}
      >
        <Button
          ref={reviewButton}
          data-focusable
          className={cn(plan ? "hidden" : "wide", "flex-1")}
          variant="primary"
          size="lg"
          disabled={Boolean(busy)}
          onClick={() => {
            void review();
          }}
        >
          <Icon glyph={ShieldCheck} />
          {busy === "review install" ? "Checking release…" : "Review installation"}
        </Button>
      </div>
      {plan && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !busy) dismiss();
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={reviewButton}
            portaled={portaled}
            reviewSize="standard"
            aria-describedby="install-review-description"
          >
            <DialogTitle id="install-review-title" className="mb-2 text-xl">
              Review installation
            </DialogTitle>
            <DialogDescription id="install-review-description" className="mb-4 leading-relaxed">
              {plan.action === "download"
                ? "Review the version, download size, and install folder."
                : "Review the version and how this local release will be used."}
            </DialogDescription>
            {action ? (
              <InstallPlanSummary plan={plan} />
            ) : (
              <p role="alert">
                This version of Portcove cannot display the installation plan. Review it again, or
                update Portcove if this continues.
              </p>
            )}
            {cancellations?.map((activity) => (
              <OperationCancellation
                key={activity.id}
                operationId={activity.id}
                state={activity.cancellation ?? undefined}
              />
            ))}
            {installSpaceBlocked(plan) && (
              <p role="status" className="mt-3">
                {usesLibraryOutput(plan)
                  ? "This installation needs more free space in the Portcove library. Free space on its drive or review the library location in Settings."
                  : "This installation needs more temporary free space in the install folder's drive."}
              </p>
            )}
            <DialogFooter className="mt-4">
              {openLibraryStorage && usesLibraryOutput(plan) && installSpaceBlocked(plan) && (
                <Button
                  data-focusable
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    dismiss();
                    openLibraryStorage();
                  }}
                >
                  Open Library and storage
                </Button>
              )}
              {action ? (
                <PlannedInstallButton plan={plan} busy={busy} install={install} />
              ) : (
                <Button
                  data-focusable
                  variant="primary"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    void review();
                  }}
                >
                  Review installation again
                </Button>
              )}
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => dismiss()}
              >
                Cancel review
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function MissingInstallAction({
  sourceReady,
  biosReady,
  pick,
  inputId,
  choosing,
  busy,
  buttonRef,
  onPick,
}: {
  sourceReady: boolean;
  biosReady: boolean;
  pick?: AsyncAction | undefined;
  inputId?: string | undefined;
  choosing: boolean;
  busy?: string | undefined;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPick: () => void;
}) {
  const bothMissing = !sourceReady && !biosReady;
  const buttonLabel = bothMissing
    ? "Choose game files and BIOS"
    : !biosReady
      ? "Choose BIOS file"
      : "Choose game files";
  const title = bothMissing
    ? "Add all required game files and the BIOS file before installing"
    : !biosReady
      ? "Add the required BIOS file before installing"
      : "Add all required game files before installing";
  return (
    <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
      <Button
        ref={buttonRef}
        data-focusable
        className="wide flex-1"
        variant="primary"
        size="lg"
        title={title}
        disabled={Boolean(busy) || choosing || (!pick && !inputId)}
        onClick={onPick}
      >
        <Icon glyph={AlertTriangle} />
        {buttonLabel}
      </Button>
      {bothMissing && <p>Choose game files first, then the required BIOS file.</p>}
    </div>
  );
}

function InstallPlanSummary({ plan }: { plan: InstallPlan }) {
  const download = plan.action === "download";
  const libraryOutput = usesLibraryOutput(plan);
  const localState =
    plan.action === "blocked_unverified"
      ? "Local copy needs checking"
      : "Local release already checked";
  return (
    <div className="install-plan mt-[16px] grid grid-cols-1 [align-items:end] gap-[18px] rounded-pc-lg border border-[var(--color-interactive-border)] bg-[var(--color-interactive-subtle)] p-[14px] @min-[30rem]/detail:grid-cols-[1fr_auto]">
      <div>
        <p className="eyebrow mb-[5px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
          INSTALL PLAN
        </p>
        <strong className="block text-[length:var(--text-sm)]">{plan.release.version}</strong>
        <span className="mt-[4px] block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)] capitalize">
          {releaseChannelPresentation(plan.channel).label} · {installPlanActionLabel(plan.action)}
        </span>
        {plan.bundled_runtime && (
          <span className="mt-[4px] block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)] capitalize">
            Required component included · {formatBytes(plan.bundled_runtime.asset.size)}
          </span>
        )}
        {(plan.auxiliary_downloads?.length ?? 0) > 0 && (
          <span className="mt-[4px] block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)]">
            Required build components included · Download may be reduced by cached files
          </span>
        )}
      </div>
      <div className="text-end">
        <strong className="block text-[length:var(--text-sm)]">
          {download ? formatBytes(plan.download_bytes) : "No download"}
        </strong>
        <span className="mt-[4px] block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)] capitalize">
          {download
            ? libraryOutput
              ? plan.temporary_space?.available_bytes === null
                ? "Destination capacity is unknown"
                : `${formatBytes(plan.temporary_space?.available_bytes ?? plan.storage.volume_available_bytes)} available in library`
              : "Destination capacity checked at install"
            : localState}
        </span>
      </div>
      {download && (
        <div className="install-plan-destination col-span-full pt-[12px] [border-top:1px_solid_var(--color-interactive-border)]">
          <strong className="block text-[length:var(--text-sm)]">Install folder</strong>
          <code className="mt-[4px] block [overflow-wrap:anywhere] select-text">
            {plan.output_location.effective_output_directory}
          </code>
          {plan.temporary_space ? (
            <p className="mt-[4px] text-[length:var(--text-2xs)] text-[var(--color-text-secondary)]">
              Temporary space required: {formatBytes(plan.temporary_space.required_bytes)} at{" "}
              <code>{plan.temporary_space.path}</code>.{" "}
              {plan.temporary_space.available_bytes === null
                ? "Capacity is unknown."
                : `${formatBytes(plan.temporary_space.available_bytes)} available on this drive.`}{" "}
              Space is checked again at install. Final installed size is unknown.
            </p>
          ) : (
            <p>Temporary space is checked at install. Final installed size is unknown.</p>
          )}
        </div>
      )}
      {plan.preservation_notices?.map((notice) => (
        <p key={notice} className="col-span-full text-[length:var(--text-sm)]">
          {notice}
        </p>
      ))}
      {plan.shared_preferences && (
        <p className="col-span-full text-[length:var(--text-sm)]">
          ReGaiden can rewrite shared preferences at{" "}
          <bdi dir="ltr">{plan.shared_preferences.binding.path}</bdi> and affect other copies in
          this Windows account. Portcove does not own or back up that shared file. Its local
          fallback at <bdi dir="ltr">{plan.shared_preferences.local_fallback_path}</bdi> is managed
          with this installation. The Windows confirmation will ask you to accept this scope before
          installing.
        </p>
      )}
    </div>
  );
}

function PlannedInstallButton({
  plan,
  busy,
  install,
}: {
  plan: InstallPlan;
  busy?: string | undefined;
  install: AsyncAction;
}) {
  const blocked = plan.action === "blocked_unverified";
  const insufficientSpace = installSpaceBlocked(plan);
  let label =
    plan.action === "download"
      ? `Install · ${formatBytes(plan.download_bytes)}`
      : plan.action === "reuse_retained"
        ? "Use previous release"
        : plan.action === "already_active"
          ? "Use installed release"
          : "Use ready release";
  if (blocked) label = "Verify or replace the local copy before installing";
  else if (insufficientSpace) label = "Free space required";
  else if (busy === "install") label = "Installing…";
  return (
    <Button
      data-focusable
      data-autofocus={!blocked && !insufficientSpace}
      variant="primary"
      disabled={blocked || insufficientSpace || Boolean(busy)}
      onClick={() => {
        void install();
      }}
    >
      <Icon glyph={Download} />
      {label}
    </Button>
  );
}

function installSpaceBlocked(plan: InstallPlan) {
  return plan.action === "download" && plan.temporary_space?.sufficient === false;
}

function usesLibraryOutput(plan: InstallPlan) {
  return (
    plan.output_location.effective_output_directory ===
    plan.output_location.default_output_directory
  );
}

function MaintenanceActions({
  port,
  libraryGeneration,
  canRollback,
  status,
  verificationPrimary,
  busy,
  actions,
}: {
  port: PortDefinition;
  libraryGeneration: number;
  canRollback: boolean;
  status?: PortStatus | undefined;
  verificationPrimary: boolean;
  busy?: string | undefined;
  actions: DetailActions;
}) {
  const rollback = portActionPresentation(status, "rollback");
  return (
    <div className="actions maintenance-actions mt-[18px] flex flex-wrap gap-[8px] pt-[18px] [border-top:1px_solid_var(--color-border)] [&.compact]:mt-[14px]">
      {!verificationPrimary && (
        <Button
          data-focusable
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => {
            void actions.verify();
          }}
        >
          <Icon glyph={ShieldCheck} />
          Verify installation
        </Button>
      )}
      <Button
        data-focusable
        variant="outline"
        disabled={!canRollback || rollback.blocked || Boolean(busy)}
        onClick={() => {
          void actions.rollback();
        }}
      >
        <Icon glyph={RotateCcw} />
        Restore previous version
      </Button>
      {rollback.blocked && (
        <p role="status" data-rollback-assessment>
          {rollback.reason}
        </p>
      )}
      <RemovalControl
        key={`${port.id}:${libraryGeneration}`}
        port={port}
        status={status}
        generation={libraryGeneration}
        busy={Boolean(busy)}
        apply={actions.remove}
      />
    </div>
  );
}

function DataActions({
  busy,
  actions,
  assessment,
  readState,
}: {
  busy?: string | undefined;
  actions: DetailActions;
  assessment?: BackupInventory["create_assessment"] | undefined;
  readState?: BackupReadState | undefined;
}) {
  const { available, explanation } = backupCreatePresentation(assessment, readState);
  return (
    <div className="flex flex-wrap gap-2">
      <p role="status" className="w-full" id="backup-create-explanation">
        {explanation}
      </p>
      <Button
        data-focusable
        variant="outline"
        title={explanation}
        aria-describedby="backup-create-explanation"
        disabled={Boolean(busy) || !available}
        onClick={() => {
          void actions.backup();
        }}
      >
        <Icon glyph={Save} />
        Back up data
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy)}
        onClick={() => {
          void actions.openUserData();
        }}
      >
        <Icon glyph={FolderOpen} />
        Open data folder
      </Button>
    </div>
  );
}

function UpdateCheckAction({
  busy,
  check,
  primary = false,
}: {
  busy?: string | undefined;
  check: DetailActions["check"];
  primary?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        data-focusable
        variant={primary ? "primary" : "outline"}
        disabled={Boolean(busy)}
        onClick={() => {
          void check();
        }}
      >
        <Icon glyph={RefreshCw} />
        Check for updates
      </Button>
    </div>
  );
}

interface DetailStateInput {
  installed: boolean;
  launchReady: boolean;
  stagedVersion: string | undefined;
  pendingSetup: boolean;
  runtimeNeeded: boolean;
  runtimeUpdateAvailable: boolean;
  sourceHealth: SourceHealth | null | undefined;
  biosHealth: SourceHealth | null | undefined;
  selectedRequirement: SelectedRequirement | undefined;
  missingRequirement: SelectedRequirement | undefined;
  invalidInstallation: boolean;
  externalRuntime: boolean;
}

function detailState({
  installed,
  launchReady,
  stagedVersion,
  pendingSetup,
  runtimeNeeded,
  runtimeUpdateAvailable,
  sourceHealth,
  biosHealth,
  selectedRequirement,
  missingRequirement,
  invalidInstallation,
  externalRuntime,
}: DetailStateInput): DetailState {
  if (invalidInstallation)
    return {
      title: "Installation needs repair",
      description:
        "Portcove couldn't verify the installed files. Choose Verify installation to check them.",
      tone: "setup",
      icon: AlertTriangle,
    };
  if (!installed)
    return availableInstallState(selectedRequirement, missingRequirement, externalRuntime);
  if (runtimeNeeded) return runtimeRequirementState(runtimeUpdateAvailable);
  const sourceIssue = sourceHealthState("game", sourceHealth);
  if (sourceIssue) return sourceIssue;
  const biosIssue = sourceHealthState("bios", biosHealth);
  if (biosIssue) return biosIssue;
  if (
    pendingSetup &&
    !launchReady &&
    sourceHealth !== "unregistered" &&
    biosHealth !== "unregistered"
  )
    return {
      title: "First-time setup required",
      description: "Complete the port's setup before playing.",
      tone: "setup",
      icon: Wrench,
    };
  if (!launchReady)
    return {
      title: "Launch unavailable",
      description:
        "Review the game's current requirements and recovery information before playing.",
      tone: "setup",
      icon: Wrench,
    };
  if (selectedRequirement) return selectedRequirementState(selectedRequirement);
  if (pendingSetup)
    return {
      title: "First-time setup required",
      description: "Complete the port's setup before playing.",
      tone: "setup",
      icon: Wrench,
    };
  if (stagedVersion)
    return {
      title: "Ready to play",
      description: "The installed version and all required game files are available.",
      updateAttention: `Play the installed version or use the saved update ${stagedVersion}.`,
      tone: "ready",
      icon: CheckCircle2,
    };
  return {
    title: "Ready to play",
    description: "The installed version and all required game files are available.",
    tone: "ready",
    icon: CheckCircle2,
  };
}

type SelectedRequirement = "game" | "bios" | "both";

function selectedSourceRequirement(
  source: SourceRecord | undefined,
  sourcePath: string,
  bios: SourceRecord | undefined,
  biosPath: string | undefined,
): SelectedRequirement | undefined {
  const gameSelected = Boolean(sourcePath.trim()) && sourcePath !== source?.path;
  const biosSelection = biosPath?.trim();
  const biosSelected = Boolean(biosSelection) && biosSelection !== bios?.path;
  if (gameSelected && biosSelected) return "both";
  if (gameSelected) return "game";
  if (biosSelected) return "bios";
  return undefined;
}

function availableInstallState(
  selectedRequirement?: SelectedRequirement,
  missingRequirement?: SelectedRequirement,
  externalRuntime = false,
): DetailState {
  if (missingRequirement) {
    const requirement =
      missingRequirement === "both"
        ? "Game files and BIOS"
        : missingRequirement === "bios"
          ? "Required BIOS file"
          : "Game files";
    const nextStep =
      missingRequirement === "both"
        ? "Choose the required game files, then the BIOS file"
        : missingRequirement === "bios"
          ? "Choose the required BIOS file"
          : "Choose the required game files";
    return {
      title: `${requirement} needed`,
      description: externalRuntime
        ? `${nextStep} before registering your prepared runtime. Portcove checks selected files and the external folder.`
        : `${nextStep} before reviewing installation. Portcove checks selected files before activation.`,
      tone: "setup",
      icon: Wrench,
    };
  }
  if (externalRuntime)
    return {
      title: "Prepare your runtime",
      description:
        "Choose the accepted external folder after preparing it. Portcove reviews its files without installing or owning them.",
      tone: "available",
      icon: Wrench,
    };
  let description =
    "Portcove will check required game files and verify the release before it becomes active.";
  if (selectedRequirement === "bios")
    description =
      "The selected BIOS file has not been checked. Portcove validates it when you continue installation.";
  if (selectedRequirement === "both")
    description =
      "The selected game files and BIOS file have not been checked. Portcove validates them when you continue installation.";
  if (selectedRequirement === "game")
    description =
      "Selected game files have not been checked. Portcove validates them when you continue installation.";
  return {
    title: selectedRequirement ? "Files selected · not checked" : "Available to install",
    description,
    tone: "available",
    icon: Download,
  };
}

function runtimeRequirementState(updateAvailable: boolean): DetailState {
  return updateAvailable
    ? {
        title: "Update required before playing",
        description:
          "Install the available update that includes the required component. Existing saves stay in your library.",
        tone: "setup",
        icon: Wrench,
      }
    : {
        title: "Required component unavailable",
        description:
          "Check for updates. If none is available, verify the installation for diagnostic details.",
        tone: "setup",
        icon: Wrench,
      };
}

function selectedRequirementState(requirement: SelectedRequirement): DetailState {
  if (requirement === "bios")
    return {
      title: "BIOS file needs checking",
      description:
        "The selected BIOS file has not been checked. Portcove validates it before starting the game.",
      tone: "setup",
      icon: Wrench,
    };
  if (requirement === "both")
    return {
      title: "Game files and BIOS need checking",
      description:
        "The selected game files and BIOS file have not been checked. Portcove validates them before starting the game.",
      tone: "setup",
      icon: Wrench,
    };
  return {
    title: "Game files need checking",
    description:
      "The selected game-file path has not been checked. Portcove validates it before starting the game.",
    tone: "setup",
    icon: Wrench,
  };
}

function sourceHealthState(
  kind: "game" | "bios",
  health?: SourceHealth | null,
): DetailState | undefined {
  const label = kind === "bios" ? "Required BIOS file" : "Game files";
  const chooseAgain =
    kind === "bios"
      ? "Choose and add the required BIOS file again before playing."
      : "Choose and add the game files again before playing.";
  const restoreAccess =
    kind === "bios"
      ? "Restore access to the required BIOS file or add it again before playing."
      : "Restore access to the game files or add them again before playing.";
  if (health === "changed")
    return {
      title: `${label} changed`,
      description: chooseAgain,
      tone: "setup",
      icon: AlertTriangle,
    };
  if (health === "missing")
    return {
      title: `${label} missing`,
      description: chooseAgain,
      tone: "setup",
      icon: AlertTriangle,
    };
  if (health === "unreadable")
    return {
      title: `${label} unreadable`,
      description: restoreAccess,
      tone: "setup",
      icon: AlertTriangle,
    };
  return undefined;
}

function presentDetailState({
  port,
  status,
  actionPresentation,
  installed,
  launchReady,
  pendingSetup,
  selectedRequirement,
  missingRequirement,
  runtimeUpdateAvailable,
}: {
  port: PortDefinition;
  status: PortStatus | undefined;
  actionPresentation: ReturnType<typeof portActionPresentation>;
  installed: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  selectedRequirement: SelectedRequirement | undefined;
  missingRequirement: SelectedRequirement | undefined;
  runtimeUpdateAvailable: boolean;
}): DetailState {
  const setup = presentSetupState(
    port,
    status,
    actionPresentation,
    installed,
    selectedRequirement,
    missingRequirement,
  );
  if (setup) return setup;
  return installed && typeof status?.readiness?.launchable !== "boolean"
    ? {
        title: "Readiness unavailable",
        description: "Current launch readiness is unavailable. Reopen Portcove to check again.",
        tone: "setup",
        icon: AlertTriangle,
      }
    : installed &&
        launchReady &&
        !pendingSetup &&
        !selectedRequirement &&
        hasUnconfirmedLaunchInput(status, port)
      ? {
          title: "Compatibility unconfirmed",
          description:
            "The files are available, but this edition has not been confirmed for the installed version. Try launch to let the port check them; setup may still be needed.",
          tone: "setup",
          icon: AlertTriangle,
          ...(status?.staged
            ? {
                updateAttention: `Update ${status.staged.version} is downloaded. You can review it separately.`,
              }
            : {}),
        }
      : detailState({
          installed,
          launchReady,
          stagedVersion: status?.staged?.version,
          pendingSetup,
          runtimeNeeded: Boolean(status?.readiness?.blockers.includes("missing_runtime")),
          runtimeUpdateAvailable,
          sourceHealth: status?.readiness?.source,
          biosHealth: status?.readiness?.bios,
          selectedRequirement,
          missingRequirement,
          invalidInstallation: Boolean(
            status?.readiness?.blockers.includes("invalid_installation"),
          ),
          externalRuntime: port.release.provider === "user-prepared",
        });
}

function presentSetupState(
  port: PortDefinition,
  status: PortStatus | undefined,
  actionPresentation: ReturnType<typeof portActionPresentation>,
  installed: boolean,
  selectedRequirement: SelectedRequirement | undefined,
  missingRequirement: SelectedRequirement | undefined,
): DetailState | undefined {
  return !installed && port.release.provider !== "user-prepared" && actionPresentation.blocked
    ? {
        title: "Setup unavailable",
        description: actionPresentation.reason,
        tone: "setup",
        icon: AlertTriangle,
      }
    : !installed &&
        port.release.provider !== "user-prepared" &&
        !missingRequirement &&
        !status?.port_actions?.some((assessment) => assessment.action === "install")
      ? {
          title: "Setup status unknown",
          description: selectedRequirement
            ? `${availableInstallState(selectedRequirement).description} Current setup availability is unavailable. Refresh the workspace to check again.`
            : "Current setup availability is unavailable. Refresh the workspace to check again.",
          tone: "setup",
          icon: AlertTriangle,
        }
      : undefined;
}

function backupCreatePresentation(
  assessment: BackupInventory["create_assessment"] | undefined,
  readState: BackupReadState | undefined,
) {
  const current =
    readState?.status === "current" &&
    readState.hasInventory &&
    assessment?.action === "backup_create";
  const available =
    current &&
    assessment?.availability === "allowed" &&
    assessment.reason === "available" &&
    assessment.definition == null;
  const consistent =
    assessment?.definition == null &&
    (available ||
      (assessment?.availability === "waiting" && assessment.reason === "missing_data") ||
      (assessment?.availability === "held" &&
        ["unreadable_data", "unsafe_data", "recovery_required", "assessment_incomplete"].includes(
          assessment.reason,
        )));

  return {
    available,
    explanation: backupCreateExplanation(
      assessment,
      readState,
      Boolean(current),
      Boolean(available),
      consistent,
    ),
  };
}

function backupCreateExplanation(
  assessment: BackupInventory["create_assessment"] | undefined,
  readState: BackupReadState | undefined,
  current: boolean,
  available: boolean,
  consistent: boolean,
) {
  const unavailable =
    "Current backup availability is unavailable. Refresh the backup inventory to check again.";
  if (!current) {
    if (readState?.status === "current") return unavailable;
    if (readState?.status === "failed")
      return "Your saved data could not be checked. Retry the backup inventory read.";
    return "Checking your saved data…";
  }
  if (available) return "Back up owned saves and settings.";
  if (!consistent) return unavailable;
  const reasons: Partial<
    Record<NonNullable<BackupInventory["create_assessment"]>["reason"], string>
  > = {
    missing_data: "There are no owned saves or settings to back up yet.",
    recovery_required: "Restart Portcove to retry recovery, then check your backups again.",
    unsafe_data: "The saved-data location needs path and ownership review.",
    assessment_incomplete: "The saved-data check did not finish. Your data is preserved.",
    unreadable_data: "Your saved data could not be read. Check its location, then retry.",
  };
  return assessment && Object.hasOwn(reasons, assessment.reason)
    ? reasons[assessment.reason]!
    : unavailable;
}

function needsManagedPreparation(port: PortDefinition, installed: boolean) {
  return Boolean(
    installed &&
    (port.adapter === "upstream-managed-setup" || port.adapter === "libultraship-portable") &&
    port.setup_output_paths.length,
  );
}
