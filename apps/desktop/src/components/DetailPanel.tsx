import { RemovalControl, type ApplyRemoval } from "./RemovalReview";
import { SteamEntryControl } from "./SteamEntry";
import { ExternalRuntimeControl } from "./ExternalRuntime";
import { ArtworkControls, ArtworkImage, DetailArtwork } from "./Artwork";
import type { ApplyBackupAction } from "./BackupReview";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
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
import { OutputLocationControl } from "./OutputLocation";
import { PreparationControl, type RunPreparation } from "./Preparation";
import {
  currentUpdateSnapshot,
  formatBytes,
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
  perform?: Perform;
  prepare?: RunPreparation;
  cancellableActivities?: ActivityRecord[];
  port: PortDefinition;
  status?: PortStatus;
  installPlan?: InstallPlan;
  backups?: BackupRecord[];
  backupProblems?: BackupProblem[];
  backupState?: BackupInventory["state"];
  backupReadState?: BackupReadState;
  retryBackupRead?: () => Promise<void>;
  source?: SourceRecord;
  sourceInspection?: SourceInspectionReport;
  sourceProfile?: SourceProfile;
  sourcePath: string;
  setSourcePath: (path: string) => void;
  pickSource?: AsyncAction;
  pickSourceArchive?: () => void;
  bios?: SourceRecord;
  biosInspection?: SourceInspectionReport;
  biosProfile?: SourceProfile;
  biosPath?: string;
  setBiosPath?: (path: string) => void;
  pickBios?: AsyncAction;
  busy?: string;
  libraryGeneration?: number;
  outputLocationChanged?: () => void;
  externalRuntimeChanged?: () => void;
  openSourceEvidence?: (evidenceId: string) => void;
  openHostTool?: (toolId: string) => void;
  openLibraryStorage?: () => void;
  inspectSource?: (profile: SourceProfile) => void;
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
  const effectiveBusy = busy ?? (outputApplying ? "storage location" : undefined);
  const selectedChannel = status?.channel ?? port.channels[0];
  const policy = status?.update_policy ?? "notify";
  const {
    sourceReady,
    biosReady,
    launchReady: readinessLaunchReady,
    installed,
    pendingSetup,
  } = detailReadiness(port, status, source, sourcePath, bios, biosPath);
  const actionPresentation = portActionPresentation(status, installed ? "launch" : "install");
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
  const state =
    !installed && port.release.provider !== "user-prepared" && actionPresentation.blocked
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
        : installed && typeof status?.readiness?.launchable !== "boolean"
          ? {
              title: "Readiness unavailable",
              description:
                "Current launch readiness is unavailable. Reopen Portcove to check again.",
              tone: "setup",
              icon: AlertTriangle,
            }
          : detailState(
              installed,
              launchReady,
              status?.staged?.version,
              pendingSetup,
              Boolean(status?.readiness?.blockers.includes("missing_runtime")),
              runtimeUpdateAvailable,
              status?.readiness?.source,
              status?.readiness?.bios,
              selectedRequirement,
              missingRequirement,
              Boolean(status?.readiness?.blockers.includes("invalid_installation")),
              port.release.provider === "user-prepared",
            );
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
  return (
    <section
      className="detail-panel relative w-full min-w-0"
      aria-labelledby="port-detail-title"
      data-detail-workspace
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
      <DetailHero
        port={port}
        state={state}
        missingSourceLabels={!installed ? missingSourceLabels : []}
      />
      {props.cancellableActivities
        ?.filter((activity) => !(installReviewVisible && activity.operation === "install"))
        .map((activity) => (
          <OperationCancellation
            key={activity.id}
            operationId={activity.id}
            state={activity.cancellation ?? undefined}
          />
        ))}
      <DetailBody
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
        backupReadState={backupReadState}
        retryBackupRead={retryBackupRead}
        busy={effectiveBusy}
        outputExternalBusy={busy}
        libraryGeneration={props.libraryGeneration ?? 0}
        outputLocationChanged={props.outputLocationChanged}
        externalRuntimeChanged={props.externalRuntimeChanged}
        outputApplying={setOutputApplying}
        actions={actions}
        openLibraryStorage={props.openLibraryStorage}
      />
    </section>
  );
}

type DetailState = ReturnType<typeof detailState>;

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
    <div className="detail-hero flex min-h-[175px] items-end gap-5 overflow-hidden rounded-pc-lg border border-[var(--color-border-strong)] bg-pc-surface p-8 shadow-[var(--shadow-raised)]">
      <ArtworkImage
        port={port}
        className="detail-cover aspect-[2/3] w-24 flex-none rounded-pc-md bg-[var(--art-color)]"
      />
      <div className="min-w-0">
        <p className="eyebrow">
          {port.platforms.map((platform) => platformLabel(platform)).join(" · ")}
        </p>
        <h1 className="detail-title" id="port-detail-title">
          {port.name}
        </h1>
        <span className={`hero-state ${state.tone}`}>
          <Icon glyph={state.icon} size="sm" />
          {state.title}
        </span>
        {state.tone !== "ready" && <p className="hero-reason">{state.description}</p>}
        {"updateAttention" in state && (
          <p className="mt-2 text-sm text-pc-muted-foreground" data-update-attention>
            {state.updateAttention}
          </p>
        )}
        {missingSourceLabels.length > 0 && (
          <p className="hero-requirement">
            Required for setup: <strong>{missingSourceLabels.join(" · ")}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

function DetailBody({
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
  installCancellations?: ActivityRecord[];
  perform?: Perform;
  prepare?: RunPreparation;
  port: PortDefinition;
  status?: PortStatus;
  stagedVersion?: string;
  sources: SourceControls;
  installed: boolean;
  deferSetupChoices: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  runtimeUpdateAvailable: boolean;
  installPlan?: InstallPlan;
  selectedChannel: ReleaseChannel;
  policy: UpdatePolicy;
  backups: BackupRecord[];
  backupProblems: BackupProblem[];
  backupState: BackupInventory["state"];
  backupReadState?: BackupReadState;
  retryBackupRead?: () => Promise<void>;
  busy?: string;
  outputExternalBusy?: string;
  libraryGeneration: number;
  outputLocationChanged?: () => void;
  externalRuntimeChanged?: () => void;
  outputApplying: (applying: boolean) => void;
  actions: DetailActions;
  openLibraryStorage?: () => void;
}) {
  const managedPreparation = Boolean(
    installed &&
    (port.adapter === "upstream-managed-setup" || port.adapter === "libultraship-portable") &&
    port.setup_output_paths.length,
  );
  return (
    <div className="detail-body px-8 pt-7 pb-10">
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
        installPlan={installPlan}
        busy={busy}
        libraryGeneration={libraryGeneration}
        onChanged={externalRuntimeChanged}
        actions={actions}
        openLibraryStorage={openLibraryStorage}
      />
      <RequirementsGroup
        key={`requirements:${port.id}:${libraryGeneration}`}
        port={port}
        status={status}
        installed={installed}
        sources={sources}
        managedPreparation={managedPreparation}
        pendingSetup={pendingSetup}
        libraryGeneration={libraryGeneration}
        busy={busy}
        prepare={prepare}
      />
      <p className="leading-[var(--leading-relaxed)] text-[var(--color-text-secondary)]">
        {port.summary}
      </p>
      <NavigationHints />
      <ArtworkControls key={`${port.id}:${libraryGeneration}`} port={port} />
      <DetailArtwork key={`${port.id}:${libraryGeneration}`} port={port} />
      {status?.active && (
        <DetailGroup title="Installation and version">
          <InstallationVersionSummary status={status} selectedChannel={selectedChannel} />
        </DetailGroup>
      )}
      {port.release.provider !== "user-prepared" && !status?.external_runtime && (
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
      {port.release.provider === "user-prepared" || status?.external_runtime ? (
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
      {port.release.provider !== "user-prepared" && !status?.external_runtime && (
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
  installPlan,
  busy,
  libraryGeneration,
  onChanged,
  actions,
  openLibraryStorage,
}: {
  installCancellations?: ActivityRecord[];
  port: PortDefinition;
  status?: PortStatus;
  stagedVersion?: string;
  sources: SourceControls;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  runtimeUpdateAvailable: boolean;
  managedPreparation: boolean;
  installPlan?: InstallPlan;
  busy?: string;
  libraryGeneration: number;
  onChanged?: () => void;
  actions: DetailActions;
  openLibraryStorage?: () => void;
}) {
  const actionPresentation = portActionPresentation(status, installed ? "launch" : "install");
  if (port.release.provider === "user-prepared" || status?.external_runtime) {
    return (
      <DetailGroup title="Status and actions">
        <RetiredNotice port={port} />
        {status?.external_runtime && actionPresentation.blocked && (
          <p role="status">{actionPresentation.reason}</p>
        )}
        {status?.external_runtime && (
          <InstalledPlayActions
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
      </DetailGroup>
    );
  }
  if (!installed && actionPresentation.blocked)
    return (
      <DetailGroup title="Status and actions">
        <RetiredNotice port={port} />
        <p role="status">{actionPresentation.reason}</p>
        <div className="actions primary-actions">
          <Button data-focusable className="wide" variant="primary" size="lg" disabled>
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
      </DetailGroup>
    );
  return (
    <DetailGroup title="Status and actions">
      <RetiredNotice port={port} />
      {actionPresentation.blocked && <p role="status">{actionPresentation.reason}</p>}
      <PrimaryActions
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
    </DetailGroup>
  );
}

const disclosureSummaryStyle =
  "flex cursor-pointer list-none items-center justify-between gap-3 px-0.5 py-[15px] text-xs font-bold hover:text-[var(--color-interactive-text-strong)]";
const disclosureMetaStyle =
  "ml-auto text-[length:var(--text-2xs)] font-medium text-pc-muted-foreground";
const disclosureBodyStyle = "pt-0.5 pb-[22px]";

function RequirementsGroup({
  port,
  status,
  installed,
  sources,
  managedPreparation,
  pendingSetup,
  libraryGeneration,
  busy,
  prepare,
}: {
  port: PortDefinition;
  status?: PortStatus;
  installed: boolean;
  sources: SourceControls;
  managedPreparation: boolean;
  pendingSetup: boolean;
  libraryGeneration: number;
  busy?: string;
  prepare?: RunPreparation;
}) {
  const needsAttention =
    !installed ||
    !sources.sourceReady ||
    !sources.biosReady ||
    (managedPreparation && pendingSetup);
  const [initiallyOpen] = useState(needsAttention);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const preparationFocus = useRef<HTMLElement>(null);
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
        <summary
          ref={preparationFocus}
          data-focusable
          className={`requirements-summary ${disclosureSummaryStyle}`}
        >
          Game-file requirements and setup
          <span className={`requirements-summary-meta ${disclosureMetaStyle}`}>File controls</span>
          <Icon glyph={ChevronDown} />
        </summary>
        <div className={`requirements-body grid gap-4 ${disclosureBodyStyle}`}>
          <RequirementsSummary port={port} />
          <SourceFields controls={sources} />
          <SourceIntakeActions controls={sources} busy={Boolean(busy)} />
          {managedPreparation && pendingSetup && (
            <PreparationControl
              key={`${port.id}:${libraryGeneration}:${status?.active?.id}`}
              portId={port.id}
              generation={libraryGeneration}
              disabled={Boolean(busy) || !sources.sourceReady || !sources.biosReady}
              run={prepare}
              focusFallback={() => preparationFocus.current}
            />
          )}
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
  perform?: Perform;
  port: PortDefinition;
  status?: PortStatus;
  installed: boolean;
  deferSetupChoices: boolean;
  selectedChannel: ReleaseChannel;
  policy: UpdatePolicy;
  libraryGeneration: number;
  busy?: string;
  actions: DetailActions;
}) {
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
      <FutureSetupDisclosure
        deferred={deferSetupChoices}
        title="Release and update choices for later"
        description="Game files are still required before installation. These choices apply to a future managed install."
      >
        {preferences}
      </FutureSetupDisclosure>
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
          <GameUpdateControl
            key={`${port.id}:${libraryGeneration}:${status?.active?.id}:${status?.staged?.id}:${selectedChannel}:${policy}`}
            portId={port.id}
            generation={libraryGeneration}
            policy={policy}
            busy={Boolean(busy)}
            perform={perform}
          />
          <UpdateCheckAction busy={busy} check={actions.check} />
        </>
      )}
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
  status?: PortStatus;
  installed: boolean;
  deferSetupChoices: boolean;
  backups: BackupRecord[];
  backupProblems: BackupProblem[];
  backupState: BackupInventory["state"];
  backupReadState?: BackupReadState;
  retryBackupRead?: () => Promise<void>;
  libraryGeneration: number;
  busy?: string;
  outputExternalBusy?: string;
  outputLocationChanged?: () => void;
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
      {installed && <DataActions busy={busy} actions={actions} />}
      {hasBackupHistory && (
        <BackupHistory
          key={`${port.id}:${libraryGeneration}`}
          generation={libraryGeneration}
          backups={backups}
          problems={backupProblems}
          state={backupState}
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
        className={`advanced-summary ${disclosureSummaryStyle}`}
      >
        {title}
        <Icon glyph={ChevronDown} />
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
  status?: PortStatus;
  selectedChannel: ReleaseChannel;
}) {
  const checked = currentUpdateSnapshot(status)?.check;
  const latestEligible =
    checked?.release.version ??
    (status?.active ? "No current check" : "Version shown when you review installation.");
  return (
    <dl
      className="installation-facts m-0 grid rounded-pc-md border border-pc-border bg-[var(--color-bg-subtle)] [&>div]:min-w-0 [&>div]:px-3 [&>div]:py-2.5 [&_dt]:text-xs [&_dt]:text-pc-muted-foreground [&_dd]:m-0 [&_dd]:mt-1 [&_dd]:[overflow-wrap:anywhere]"
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

function StorageSummary({ status }: { status?: PortStatus }) {
  return (
    <div className="metadata">
      <span>
        <small>Saves and settings folder</small>
        {status?.user_data_root ?? "Created inside the selected library"}
      </span>
    </div>
  );
}

function CompatibilitySummary({ port }: { port: PortDefinition }) {
  return (
    <div className="metadata">
      <span>
        <small>Platforms</small>
        {port.platforms.map((value) => platformLabel(value)).join(" · ")}
      </span>
      {port.platforms.includes("linux-x86-64") && (
        <span>
          <small>Steam Deck</small>
          Not tested. Linux availability does not show whether this game works on SteamOS or in
          Gaming Mode.
        </span>
      )}
      <span>
        <small>Installation method</small>
        {installationMethodLabel(port)}
      </span>
    </div>
  );
}

function ProjectReleaseSummary({ port }: { port: PortDefinition }) {
  return (
    <>
      <div className="metadata">
        <span>
          <small>Upstream project</small>
          {upstreamStatusPresentation[port.upstream_status]}
        </span>
        <span>
          <small>Catalog designation (not a test result)</small>
          {supportTierPresentation[port.support_tier]}
        </span>
        <span>
          <small>Available release channels</small>
          {port.channels.map((channel) => releaseChannelPresentation(channel).label).join(" · ")}
        </span>
      </div>
      <div className="upstream-link">
        <ProjectLink href={port.project_url}>
          Open upstream project <Icon glyph={ExternalLink} size="sm" />
        </ProjectLink>
        <span>
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
    <div className="metadata" aria-label="Required game files and verification">
      {port.presentation.source_requirements.map((requirement) => (
        <span key={requirement.role}>
          <small>{requirement.role === "bios" ? "Required BIOS" : "Required game files"}</small>
          {requirement.label}
          <small>Check method: {sourceVerificationPresentation[requirement.verification]}</small>
        </span>
      ))}
    </div>
  );
}

function SavesAndSettingsSummary({ port }: { port: PortDefinition }) {
  return (
    <div className="metadata">
      <span>
        <small>Saved data handling</small>
        {port.presentation?.saves_and_settings === "portcove-managed"
          ? "Managed by Portcove for backup and restore"
          : port.presentation?.saves_and_settings === "external-user-owned"
            ? "Stored with your external runtime; Portcove does not back up or remove it"
            : "Unavailable in this catalog"}
      </span>
    </div>
  );
}

function TrustStrip({ status }: { status?: PortStatus }) {
  return (
    <div className="trust-strip">
      <span>
        <Icon glyph={HardDrive} size="sm" />
        Game files stay local
      </span>
      {status?.previous && (
        <span>
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
  const sourceReady = sourceRequirementReady(
    Boolean(port.source_profile),
    installed,
    status?.readiness?.source,
    Boolean(source || sourcePath.trim()),
  );
  const biosReady = sourceRequirementReady(
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
  sourceHealth?: SourceHealth | null;
  biosHealth?: SourceHealth | null;
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
    <div className="source-intake-shortcuts" aria-label="Check game files">
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
    <p className="retired-notice">
      <Icon glyph={ArchiveX} />{" "}
      <span>
        <strong>Retired upstream</strong>The upstream project is no longer maintained. Portcove
        checks available releases against its usual source and package requirements; no new upstream
        fixes are expected.
      </span>
    </p>
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
  status?: PortStatus;
  selectedChannel: ReleaseChannel;
  installed: boolean;
  busy?: string;
  sources: SourceControls;
  actions: DetailActions;
}) {
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
          Commands and maintenance
        </span>
        <Icon glyph={ChevronDown} />
      </summary>
      <div className={`advanced-body ${disclosureBodyStyle}`}>
        <div className="metadata">
          <span title={persistentFiles}>
            <small>Saved data patterns</small>
            {persistentFiles || "No saved data paths declared"}
          </span>
        </div>
        <DetailQualificationSummary
          port={port}
          sourceInspection={sources.sourceInspection}
          biosInspection={sources.biosInspection}
          technical
        />
        <CliContinuity
          key={`${port.id}:${libraryGeneration}`}
          generation={libraryGeneration}
          port={port}
          status={status}
          channel={selectedChannel}
          sourcePath={sources.sourcePath || sources.source?.path || ""}
          biosPath={sources.biosPath || sources.bios?.path || ""}
        />
        {installed && (
          <MaintenanceActions
            port={port}
            libraryGeneration={libraryGeneration}
            canRollback={Boolean(status?.previous)}
            verificationPrimary={Boolean(
              status?.readiness?.blockers.includes("invalid_installation"),
            )}
            busy={busy}
            actions={actions}
          />
        )}
        <div className="actions maintenance-actions">
          <SteamEntryControl
            key={`steam:${port.id}:${libraryGeneration}`}
            port={port}
            generation={libraryGeneration}
            installed={installed}
            busy={Boolean(busy)}
          />
        </div>
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
  profile?: SourceProfile;
  source?: SourceRecord;
  inspection?: SourceInspectionReport;
  health?: SourceHealth | null;
  path: string;
  setPath: (path: string) => void;
  pick?: AsyncAction;
  pickArchive?: () => void;
  openEvidence?: (evidenceId: string) => void;
  openHostTool?: (toolId: string) => void;
}) {
  const bios = heading === "Required BIOS";
  const copy = sourceFieldCopy(profile, bios);
  const selectedOverride = Boolean(path.trim()) && (!source || path !== source.path);
  const sourceNote = selectedOverride
    ? bios
      ? "Selected BIOS file has not been checked. Portcove validates it when you continue."
      : "Selected path has not been checked. Portcove validates these files when you continue."
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

function SourceFileDetails({ source }: { source?: SourceRecord }) {
  if (!source) return null;
  return (
    <details className="source-technical border-t border-pc-border">
      <summary
        data-focusable
        className="cursor-pointer py-3 font-medium text-pc-interactive-foreground"
      >
        File details
      </summary>
      <div className="digest-value">
        <strong>Saved SHA-256</strong>
        <code>{source.sha256 || "Not recorded"}</code>
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
  if (profile?.kind === "file-set")
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
  installCancellations?: ActivityRecord[];
  sources: SourceControls;
  invalidInstallation: boolean;
  preparationRequired: boolean;
  runtimeNeeded: boolean;
  runtimeUpdateAvailable: boolean;
  stagedVersion?: string;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  plan?: InstallPlan;
  busy?: string;
  actions: DetailActions;
  openLibraryStorage?: () => void;
}) {
  if (invalidInstallation)
    return (
      <div className="actions primary-actions">
        <Button
          data-focusable
          className="wide"
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
          <div className="actions primary-actions">
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
  return (
    <InstalledPlayActions
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
  preparationRequired,
  launchReady,
  pendingSetup,
  stagedVersion,
  busy,
  actions,
}: {
  preparationRequired: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  stagedVersion?: string;
  busy?: string;
  actions: DetailActions;
}) {
  return (
    <div className="actions primary-actions">
      <Button
        data-focusable
        className="wide"
        variant="primary"
        size="lg"
        title={
          preparationRequired
            ? "Prepare game data before playing"
            : launchReady
              ? "Launch this port"
              : "Review the current launch requirements"
        }
        disabled={preparationRequired || !launchReady || Boolean(busy)}
        onClick={() => {
          void actions.launch();
        }}
      >
        <Icon glyph={!launchReady ? AlertTriangle : pendingSetup ? Wrench : Gamepad2} />
        {preparationRequired
          ? "Prepare game data first"
          : !launchReady
            ? "Play unavailable"
            : pendingSetup
              ? "Complete setup and play"
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
  version?: string;
  busy?: string;
  activate: DetailActions["activate"];
}) {
  if (!version) return null;
  return (
    <Button
      data-focusable
      className="staged-action"
      variant="outline"
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
  cancellations?: ActivityRecord[];
  ready: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  pickSource?: AsyncAction;
  pickBios?: AsyncAction;
  sourceInputId?: string;
  biosInputId?: string;
  plan?: InstallPlan;
  busy?: string;
  install: AsyncAction;
  review: AsyncAction;
  dismiss: () => void;
  openLibraryStorage?: () => void;
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
      <div className={plan ? "hidden" : "actions primary-actions"}>
        <Button
          ref={reviewButton}
          data-focusable
          className={plan ? "hidden" : "wide"}
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
            className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
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
            {librarySpaceBlocked(plan) && (
              <p role="status" className="mt-3">
                This download needs more free space in the Portcove library. Free space on its drive
                or review the library location in Settings.
              </p>
            )}
            <DialogFooter className="mt-4">
              {openLibraryStorage && librarySpaceBlocked(plan) && (
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
  pick?: AsyncAction;
  inputId?: string;
  choosing: boolean;
  busy?: string;
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
    <div className="actions primary-actions">
      <Button
        ref={buttonRef}
        data-focusable
        className="wide"
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
    <div className="install-plan">
      <div>
        <p className="eyebrow">INSTALL PLAN</p>
        <strong>{plan.release.version}</strong>
        <span>
          {plan.channel} · {installPlanActionLabel(plan.action)}
        </span>
        {plan.bundled_runtime && (
          <span>Required component included · {formatBytes(plan.bundled_runtime.asset.size)}</span>
        )}
      </div>
      <div>
        <strong>{download ? formatBytes(plan.download_bytes) : "No download"}</strong>
        <span>
          {download
            ? libraryOutput
              ? `${formatBytes(plan.storage.volume_available_bytes)} available in library`
              : "Destination capacity checked at install"
            : localState}
        </span>
      </div>
      {download && (
        <div className="install-plan-destination">
          <strong>Install folder</strong>
          <code>{plan.output_location.effective_output_directory}</code>
        </div>
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
  busy?: string;
  install: AsyncAction;
}) {
  const blocked = plan.action === "blocked_unverified";
  const insufficientSpace = librarySpaceBlocked(plan);
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

function librarySpaceBlocked(plan: InstallPlan) {
  return (
    plan.action === "download" &&
    usesLibraryOutput(plan) &&
    plan.download_bytes > plan.storage.volume_available_bytes
  );
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
  verificationPrimary,
  busy,
  actions,
}: {
  port: PortDefinition;
  libraryGeneration: number;
  canRollback: boolean;
  verificationPrimary: boolean;
  busy?: string;
  actions: DetailActions;
}) {
  return (
    <div className="actions maintenance-actions">
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
        disabled={!canRollback || Boolean(busy)}
        onClick={() => {
          void actions.rollback();
        }}
      >
        <Icon glyph={RotateCcw} />
        Restore previous version
      </Button>
      <RemovalControl
        key={`${port.id}:${libraryGeneration}`}
        port={port}
        generation={libraryGeneration}
        busy={Boolean(busy)}
        apply={actions.remove}
      />
    </div>
  );
}

function DataActions({ busy, actions }: { busy?: string; actions: DetailActions }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        data-focusable
        variant="outline"
        title="Back up saves and settings"
        disabled={Boolean(busy)}
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

function UpdateCheckAction({ busy, check }: { busy?: string; check: DetailActions["check"] }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        data-focusable
        variant="outline"
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

function detailState(
  installed: boolean,
  launchReady: boolean,
  stagedVersion: string | undefined,
  pendingSetup: boolean,
  runtimeNeeded: boolean,
  runtimeUpdateAvailable: boolean,
  sourceHealth?: SourceHealth | null,
  biosHealth?: SourceHealth | null,
  selectedRequirement?: "game" | "bios" | "both",
  missingRequirement?: SelectedRequirement,
  invalidInstallation = false,
  externalRuntime = false,
) {
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
) {
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
  return { title: "Available to install", description, tone: "available", icon: Download };
}

function runtimeRequirementState(updateAvailable: boolean) {
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

function selectedRequirementState(requirement: SelectedRequirement) {
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

function sourceHealthState(kind: "game" | "bios", health?: SourceHealth | null) {
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
