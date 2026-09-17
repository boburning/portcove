import { RemovalControl, type ApplyRemoval } from "./RemovalReview";
import { ArtworkControls, ArtworkImage, DetailArtwork } from "./Artwork";
import type { ApplyBackupAction } from "./BackupReview";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { useState } from "react";
import {
  AlertTriangle,
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
  X,
} from "lucide-react";
import { CliContinuity } from "./CliContinuity";
import { useDialogFocus } from "../dialog";
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
import { GameUpdateControl, UpdatePolicyControl } from "./GameUpdates";
import type { Perform } from "../use-portcove";
import { ExternalLink as ProjectLink } from "./ExternalLink";
import { Icon, NavigationHints } from "./ui";
import { SourceIdentityPanel } from "./SourceIdentity";
import { installPlanActionLabel } from "../install-plan-presentation";

export interface DetailActions {
  activate: AsyncAction;
  backup: AsyncAction;
  check: () => Promise<unknown>;
  close: () => void;
  deleteBackup: ApplyBackupAction;
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
  source?: SourceRecord;
  sourceInspection?: SourceInspectionReport;
  sourceProfile?: SourceProfile;
  sourcePath: string;
  setSourcePath: (path: string) => void;
  pickSource?: () => void;
  pickSourceArchive?: () => void;
  bios?: SourceRecord;
  biosInspection?: SourceInspectionReport;
  biosProfile?: SourceProfile;
  biosPath?: string;
  setBiosPath?: (path: string) => void;
  pickBios?: () => void;
  busy?: string;
  libraryGeneration?: number;
  outputLocationChanged?: () => void;
  openSourceEvidence?: (evidenceId: string) => void;
  inspectSource?: (profile: SourceProfile) => void;
  actions: DetailActions;
}

export function DetailPanel(props: DetailPanelProps) {
  const dialog = useDialogFocus(props.actions.close);
  return <DetailDialog props={props} dialog={dialog} />;
}

function DetailDialog({
  props,
  dialog,
}: {
  props: DetailPanelProps;
  dialog: ReturnType<typeof useDialogFocus>;
}) {
  const {
    port,
    status,
    installPlan,
    backups = [],
    backupProblems = [],
    backupState = "healthy",
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
  const { sourceReady, biosReady, launchReady, installed, pendingSetup } = detailReadiness(
    port,
    status,
    source,
    sourcePath,
    bios,
    biosPath,
  );
  const selectedSourcePath = Boolean(sourcePath.trim()) && (!source || sourcePath !== source.path);
  const selectedBiosPath = Boolean(biosPath?.trim()) && (!bios || biosPath?.trim() !== bios.path);
  const selectedRequirement = selectedSourcePath
    ? selectedBiosPath
      ? "both"
      : "game"
    : selectedBiosPath
      ? "bios"
      : undefined;
  const runtimeUpdateAvailable = currentUpdateSnapshot(status)?.check.update_available === true;
  const state =
    installed && typeof status?.readiness?.launchable !== "boolean"
      ? {
          title: "Readiness unavailable",
          description: "Current launch readiness is unavailable. Reopen Portcove to check again.",
          tone: "setup",
          icon: AlertTriangle,
        }
      : detailState(
          installed,
          launchReady,
          Boolean(status?.staged),
          pendingSetup,
          Boolean(status?.readiness?.blockers.includes("missing_runtime")),
          runtimeUpdateAvailable,
          status?.readiness?.source,
          status?.readiness?.bios,
          selectedRequirement,
          Boolean(status?.readiness?.blockers.includes("invalid_installation")),
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
    inspectSource: props.inspectSource,
    sourceHealth: status?.readiness?.source,
    biosHealth: status?.readiness?.bios,
  };
  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => closeFromScrim(event, actions.close)}
    >
      <section
        ref={dialog}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="port-detail-title"
      >
        <button
          data-focusable
          className="close icon-button"
          aria-label="Close port details"
          onClick={actions.close}
        >
          <Icon glyph={X} />
        </button>
        <DetailHero port={port} state={state} />
        <ArtworkControls key={`${port.id}:${props.libraryGeneration}`} port={port} />
        {props.cancellableActivities?.map((activity) => (
          <OperationCancellation
            key={activity.id}
            operationId={activity.id}
            state={activity.cancellation ?? undefined}
          />
        ))}
        <DetailBody
          perform={props.perform}
          prepare={props.prepare}
          port={port}
          status={status}
          state={state}
          sources={sources}
          installed={installed}
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
          busy={effectiveBusy}
          outputExternalBusy={busy}
          libraryGeneration={props.libraryGeneration ?? 0}
          outputLocationChanged={props.outputLocationChanged}
          outputApplying={setOutputApplying}
          actions={actions}
        />
      </section>
    </div>
  );
}

type DetailState = ReturnType<typeof detailState>;

function DetailHero({ port, state }: { port: PortDefinition; state: DetailState }) {
  return (
    <div className={`detail-hero art-${port.support_tier}`}>
      <ArtworkImage port={port} className="detail-cover" />
      <div>
        <p className="eyebrow">
          {port.platforms.map((platform) => platformLabel(platform)).join(" · ")}
        </p>
        <h2 id="port-detail-title">{port.name}</h2>
        <span className={`hero-state ${state.tone}`}>{state.title}</span>
      </div>
    </div>
  );
}

function DetailBody({
  perform,
  prepare,
  port,
  status,
  state,
  sources,
  installed,
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
  busy,
  outputExternalBusy,
  libraryGeneration,
  outputLocationChanged,
  outputApplying,
  actions,
}: {
  perform?: Perform;
  prepare?: RunPreparation;
  port: PortDefinition;
  status?: PortStatus;
  state: DetailState;
  sources: SourceControls;
  installed: boolean;
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
  busy?: string;
  outputExternalBusy?: string;
  libraryGeneration: number;
  outputLocationChanged?: () => void;
  outputApplying: (applying: boolean) => void;
  actions: DetailActions;
}) {
  const managedPreparation = Boolean(
    installed && port.adapter === "upstream-managed-setup" && port.setup_output_paths.length,
  );
  return (
    <div className="detail-body">
      <p className="summary">{port.summary}</p>
      <NavigationHints />
      <StatusActionsGroup
        port={port}
        status={status}
        state={state}
        installed={installed}
        sourceReady={sourceReady}
        biosReady={biosReady}
        launchReady={launchReady}
        pendingSetup={pendingSetup}
        runtimeUpdateAvailable={runtimeUpdateAvailable}
        managedPreparation={managedPreparation}
        installPlan={installPlan}
        busy={busy}
        actions={actions}
      />
      <DetailArtwork key={`${port.id}:${libraryGeneration}`} port={port} />
      <RequirementsGroup
        port={port}
        status={status}
        sources={sources}
        managedPreparation={managedPreparation}
        pendingSetup={pendingSetup}
        libraryGeneration={libraryGeneration}
        busy={busy}
        prepare={prepare}
      />
      <DetailGroup title="Installation and version">
        <InstallationVersionSummary status={status} selectedChannel={selectedChannel} />
      </DetailGroup>
      <UpdatesGroup
        perform={perform}
        port={port}
        status={status}
        installed={installed}
        selectedChannel={selectedChannel}
        policy={policy}
        libraryGeneration={libraryGeneration}
        busy={busy}
        actions={actions}
      />
      <SavesStorageGroup
        port={port}
        status={status}
        installed={installed}
        backups={backups}
        backupProblems={backupProblems}
        backupState={backupState}
        libraryGeneration={libraryGeneration}
        busy={busy}
        outputExternalBusy={outputExternalBusy}
        outputLocationChanged={outputLocationChanged}
        outputApplying={outputApplying}
        actions={actions}
      />
      <DetailGroup title="Compatibility and testing">
        <CompatibilitySummary port={port} />
      </DetailGroup>
      <DetailGroup title="Project and release">
        <ProjectReleaseSummary port={port} />
      </DetailGroup>
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
    </div>
  );
}

function StatusActionsGroup({
  port,
  status,
  state,
  installed,
  sourceReady,
  biosReady,
  launchReady,
  pendingSetup,
  runtimeUpdateAvailable,
  managedPreparation,
  installPlan,
  busy,
  actions,
}: {
  port: PortDefinition;
  status?: PortStatus;
  state: DetailState;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  runtimeUpdateAvailable: boolean;
  managedPreparation: boolean;
  installPlan?: InstallPlan;
  busy?: string;
  actions: DetailActions;
}) {
  return (
    <DetailGroup title="Status and actions">
      <RetiredNotice port={port} />
      <ReadinessCard state={state} />
      <PrimaryActions
        invalidInstallation={Boolean(status?.readiness?.blockers.includes("invalid_installation"))}
        preparationRequired={managedPreparation && pendingSetup}
        runtimeNeeded={Boolean(status?.readiness?.blockers.includes("missing_runtime"))}
        runtimeUpdateAvailable={runtimeUpdateAvailable}
        installed={installed}
        sourceReady={sourceReady}
        biosReady={biosReady}
        launchReady={launchReady}
        pendingSetup={pendingSetup}
        plan={installPlan}
        busy={busy}
        actions={actions}
      />
    </DetailGroup>
  );
}

function RequirementsGroup({
  port,
  status,
  sources,
  managedPreparation,
  pendingSetup,
  libraryGeneration,
  busy,
  prepare,
}: {
  port: PortDefinition;
  status?: PortStatus;
  sources: SourceControls;
  managedPreparation: boolean;
  pendingSetup: boolean;
  libraryGeneration: number;
  busy?: string;
  prepare?: RunPreparation;
}) {
  if (!port.source_profile && !port.bios_source_profile && !managedPreparation) return null;
  return (
    <DetailGroup title="Requirements">
      <RequirementsSummary port={port} />
      <SourceFields mode="missing" controls={sources} />
      <SourceFields mode="registered" controls={sources} />
      <SourceIntakeActions controls={sources} busy={Boolean(busy)} />
      {managedPreparation && pendingSetup && (
        <PreparationControl
          key={`${port.id}:${libraryGeneration}:${status?.active?.id}`}
          portId={port.id}
          generation={libraryGeneration}
          disabled={Boolean(busy) || !sources.sourceReady || !sources.biosReady}
          run={prepare}
        />
      )}
    </DetailGroup>
  );
}

function UpdatesGroup({
  perform,
  port,
  status,
  installed,
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
  selectedChannel: ReleaseChannel;
  policy: UpdatePolicy;
  libraryGeneration: number;
  busy?: string;
  actions: DetailActions;
}) {
  return (
    <DetailGroup title="Updates">
      <div className="detail-section">
        <ReleaseChannelControl
          key={`${port.id}:${libraryGeneration}`}
          channels={port.channels}
          selected={selectedChannel}
          busy={Boolean(busy)}
          change={actions.setChannel}
          refresh={actions.check}
        />
      </div>
      <div className="detail-section">
        <UpdatePolicyControl
          key={port.id}
          policy={policy}
          busy={Boolean(busy)}
          save={actions.setPolicy}
        />
      </div>
      {status?.staged && (
        <section aria-label="Activate staged update">
          <p>
            Staged update: <strong>{status.staged.version}</strong>. Activation uses this verified
            local copy without downloading and keeps the current version for rollback.
          </p>
          <button
            data-focusable
            disabled={Boolean(busy)}
            onClick={() => {
              void actions.activate();
            }}
          >
            Activate staged update · {status.staged.version}
          </button>
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
  backups,
  backupProblems,
  backupState,
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
  backups: BackupRecord[];
  backupProblems: BackupProblem[];
  backupState: BackupInventory["state"];
  libraryGeneration: number;
  busy?: string;
  outputExternalBusy?: string;
  outputLocationChanged?: () => void;
  outputApplying: (applying: boolean) => void;
  actions: DetailActions;
}) {
  const hasBackupHistory = installed || backups.length > 0 || backupProblems.length > 0;
  return (
    <DetailGroup title="Saves and storage">
      <TrustStrip status={status} />
      <SavesAndSettingsSummary port={port} />
      <StorageSummary status={status} />
      <OutputLocationControl
        key={`${port.id}:${libraryGeneration}`}
        portId={port.id}
        generation={libraryGeneration}
        busy={outputExternalBusy}
        onChanged={outputLocationChanged}
        onApplying={outputApplying}
      />
      {installed && <DataActions busy={busy} actions={actions} />}
      {hasBackupHistory && (
        <BackupHistory
          key={`${port.id}:${libraryGeneration}`}
          generation={libraryGeneration}
          backups={backups}
          problems={backupProblems}
          state={backupState}
          busy={busy}
          restore={actions.restoreBackup}
          remove={actions.deleteBackup}
        />
      )}
    </DetailGroup>
  );
}

function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const headingId = `detail-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="detail-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <div className="detail-group-content">{children}</div>
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
  const latestEligible = checked?.release.version ?? "Unknown — check for updates";
  return (
    <div className="metadata" aria-label="Installation and release versions">
      <span>
        <small>Installed version</small>
        {status?.active?.version ?? "Not installed"}
      </span>
      <span>
        <small>Selected channel</small>
        {releaseChannelPresentation(selectedChannel).label}
      </span>
      {status?.active && (
        <span>
          <small>Installed channel</small>
          {releaseChannelPresentation(status.active.channel).label}
        </span>
      )}
      <span>
        <small>Latest eligible release</small>
        {latestEligible}
      </span>
      {status?.staged && (
        <span>
          <small>Staged version</small>
          {status.staged.version}
        </span>
      )}
    </div>
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
      <span>
        <small>Installation method</small>
        {installationMethodLabel(port)}
      </span>
      <span>
        <small>Automated testing</small>
        {testingCoverageLabel(port.platforms, port.automated_tested_platforms, "Not yet tested")}
      </span>
      <span>
        <small>Physical device testing</small>
        {testingCoverageLabel(
          port.platforms,
          port.manually_validated_platforms,
          "No completed device test",
        )}
      </span>
    </div>
  );
}

function testingCoverageLabel(
  supported: PortDefinition["platforms"],
  completed: PortDefinition["platforms"],
  emptyLabel: string,
) {
  const completedSet = new Set(completed);
  const recorded = supported.filter((platform) => completedSet.has(platform));
  if (recorded.length === 0) return emptyLabel;
  const unrecorded = supported.filter((platform) => !completedSet.has(platform));
  const completedLabel = recorded.map((platform) => platformLabel(platform)).join(" · ");
  return unrecorded.length === 0
    ? completedLabel
    : `${completedLabel} · Not recorded: ${unrecorded.map((platform) => platformLabel(platform)).join(" · ")}`;
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
          <small>Portcove support</small>
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
          {requirement.label} · {sourceVerificationPresentation[requirement.verification]}
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
          : "Unavailable in this catalog"}
      </span>
    </div>
  );
}

function ReadinessCard({ state }: { state: DetailState }) {
  return (
    <div className={`readiness-card ${state.tone}`}>
      <span>
        <Icon glyph={state.icon} />
      </span>
      <div>
        <strong>{state.title}</strong>
        <p>{state.description}</p>
      </div>
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
  const installed = Boolean(status?.active);
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
  | "inspectSource"
> & {
  sourceReady: boolean;
  biosReady: boolean;
  sourceHealth?: SourceHealth | null;
  biosHealth?: SourceHealth | null;
};

function SourceFields({
  mode,
  controls,
}: {
  mode: "missing" | "registered";
  controls: SourceControls;
}) {
  return (
    <>
      {originalSourceField(mode, controls)}
      {biosSourceField(mode, controls)}
    </>
  );
}

function SourceIntakeActions({ controls, busy }: { controls: SourceControls; busy: boolean }) {
  if (!controls.inspectSource || (!controls.sourceProfile && !controls.biosProfile)) return null;
  return (
    <div className="source-intake-shortcuts" aria-label="Check game files">
      {controls.sourceProfile && (
        <button
          data-focusable
          className="button-with-icon"
          type="button"
          disabled={busy}
          onClick={() => controls.inspectSource?.(controls.sourceProfile!)}
        >
          <Icon glyph={FileSearch} />
          Check original game files
        </button>
      )}
      {controls.biosProfile && (
        <button
          data-focusable
          className="button-with-icon"
          type="button"
          disabled={busy}
          onClick={() => controls.inspectSource?.(controls.biosProfile!)}
        >
          <Icon glyph={FileSearch} />
          Check required BIOS
        </button>
      )}
    </div>
  );
}

function originalSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.source_profile;
  if (!profileId || controls.sourceReady !== (mode === "registered")) return null;
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
    />
  );
}

function biosSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.bios_source_profile;
  if (
    !profileId ||
    !controls.biosProfile ||
    !controls.setBiosPath ||
    controls.biosReady !== (mode === "registered")
  )
    return null;
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
    />
  );
}

function RetiredNotice({ port }: { port: PortDefinition }) {
  if (port.upstream_status !== "retired") return null;
  return (
    <p className="retired-notice">
      <Icon glyph={ArchiveX} />{" "}
      <span>
        <strong>Retired upstream</strong>The upstream project is no longer maintained. Portcove can
        still install its pinned release, but no new upstream fixes are expected.
      </span>
    </p>
  );
}

function closeFromScrim(event: React.MouseEvent<HTMLDivElement>, close: () => void) {
  if (event.currentTarget === event.target) close();
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
    <details className="advanced-settings">
      <summary data-focusable className="advanced-summary">
        Technical details <span className="advanced-summary-meta">Commands and maintenance</span>
        <Icon glyph={ChevronDown} />
      </summary>
      <div className="advanced-body">
        <div className="metadata">
          <span title={persistentFiles}>
            <small>Saved data patterns</small>
            {persistentFiles || "No saved data paths declared"}
          </span>
        </div>
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
            busy={busy}
            actions={actions}
          />
        )}
      </div>
    </details>
  );
}

const sourceVerificationPresentation: Record<
  NonNullable<PortDefinition["presentation"]>["source_requirements"][number]["verification"],
  string
> = {
  "catalog-identity": "Compared with reviewed catalog identity",
  "upstream-validator": "Checked by the upstream validator",
  "catalog-rules": "Checked with catalog-declared file rules",
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
}: {
  heading: string;
  profileId: string;
  profile?: SourceProfile;
  source?: SourceRecord;
  inspection?: SourceInspectionReport;
  health?: SourceHealth | null;
  path: string;
  setPath: (path: string) => void;
  pick?: () => void;
  pickArchive?: () => void;
  openEvidence?: (evidenceId: string) => void;
}) {
  const bios = heading === "Required BIOS";
  const copy = sourceFieldCopy(profile, bios);
  const selectedOverride = Boolean(path.trim()) && (!source || path !== source.path);
  const sourceNote = selectedOverride
    ? bios
      ? "Selected BIOS file has not been checked. Portcove validates it when you continue."
      : "Selected path has not been checked. Portcove validates these files when you continue."
    : source
      ? sourceHealthNote(inspection?.health ?? health, source, bios)
      : copy.note;
  const inputId = `source-${profileId}`;
  return (
    <div className="detail-section">
      <label htmlFor={inputId}>
        {heading} · {profile?.label ?? profileId}
      </label>
      <div className="path-entry">
        <input
          data-focusable
          id={inputId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={copy.placeholder}
        />
        {pick && (
          <button data-focusable className="button-with-icon" type="button" onClick={pick}>
            <Icon glyph={FolderOpen} />
            {bios ? "Choose BIOS file" : "Choose game files"}
          </button>
        )}
        {pickArchive && (
          <button data-focusable className="button-with-icon" type="button" onClick={pickArchive}>
            <Icon glyph={FileArchive} />
            Choose ZIP file
          </button>
        )}
      </div>
      <small>{sourceNote}</small>
      {selectedOverride && source && health && health !== "current" && (
        <small>{sourceHealthNote(health, source, bios)}</small>
      )}
      {!selectedOverride && inspection && (
        <SourceIdentityPanel report={inspection} openEvidence={openEvidence} />
      )}
    </div>
  );
}

function sourceHealthNote(
  health: SourceHealth | null | undefined,
  source: SourceRecord,
  bios: boolean,
) {
  const hash = `${source.sha256.slice(0, 12)}…`;
  const label = bios ? "BIOS file" : "game files";
  if (health === "current") return `Current registered ${label} checked · ${hash}`;
  if (health === "changed")
    return `Registered ${label} changed since ${bios ? "it was" : "they were"} added.`;
  if (health === "missing") return `Registered ${label} ${bios ? "is" : "are"} missing.`;
  if (health === "unreadable") return `Registered ${label} cannot be read.`;
  if (health === "not_checked") return `Registered ${label} · current bytes not checked · ${hash}`;
  if (health === "not_baselined")
    return `Selected ${label} ${bios ? "has" : "have"} no saved identity baseline.`;
  return `Registered ${label} · ${hash}`;
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
  invalidInstallation,
  preparationRequired,
  runtimeNeeded,
  runtimeUpdateAvailable,
  installed,
  sourceReady,
  biosReady,
  launchReady,
  pendingSetup,
  plan,
  busy,
  actions,
}: {
  invalidInstallation: boolean;
  preparationRequired: boolean;
  runtimeNeeded: boolean;
  runtimeUpdateAvailable: boolean;
  installed: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  launchReady: boolean;
  pendingSetup: boolean;
  plan?: InstallPlan;
  busy?: string;
  actions: DetailActions;
}) {
  if (invalidInstallation)
    return <p>Verify the game files below and review repair before playing.</p>;
  if (runtimeNeeded)
    return runtimeUpdateAvailable ? (
      <p>Review the game update below to install the required component.</p>
    ) : (
      <p>
        Check for updates. If none is available, verify the installation for diagnostic details.
      </p>
    );
  if (!installed)
    return (
      <InstallAction
        ready={launchReady}
        sourceReady={sourceReady}
        biosReady={biosReady}
        plan={plan}
        busy={busy}
        install={actions.install}
        review={actions.reviewInstall}
      />
    );
  return (
    <div className="actions primary-actions">
      <button
        data-focusable
        className="primary wide button-with-icon"
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
              : "Play now"}
      </button>
    </div>
  );
}

function InstallAction({
  ready,
  sourceReady,
  biosReady,
  plan,
  busy,
  install,
  review,
}: {
  ready: boolean;
  sourceReady: boolean;
  biosReady: boolean;
  plan?: InstallPlan;
  busy?: string;
  install: AsyncAction;
  review: AsyncAction;
}) {
  if (!ready) {
    const buttonLabel =
      !sourceReady && !biosReady
        ? "Choose game files and BIOS"
        : !biosReady
          ? "Choose BIOS file"
          : "Choose game files";
    const title =
      !sourceReady && !biosReady
        ? "Add all required game files and the BIOS file before installing"
        : !biosReady
          ? "Add the required BIOS file before installing"
          : "Add all required game files before installing";
    return (
      <div className="actions primary-actions">
        <button data-focusable className="primary wide button-with-icon" title={title} disabled>
          <Icon glyph={AlertTriangle} />
          {buttonLabel}
        </button>
      </div>
    );
  }
  if (!plan)
    return (
      <div className="actions primary-actions">
        <button
          data-focusable
          className="primary wide button-with-icon"
          disabled={Boolean(busy)}
          onClick={() => {
            void review();
          }}
        >
          <Icon glyph={ShieldCheck} />
          {busy === "review install" ? "Checking release…" : "Review install"}
        </button>
      </div>
    );
  if (!installPlanActionLabel(plan.action))
    return (
      <div className="actions primary-actions">
        <p role="alert">
          This version of Portcove cannot display the installation plan. Review it again, or update
          Portcove if this continues.
        </p>
        <button
          data-focusable
          disabled={Boolean(busy)}
          onClick={() => {
            void review();
          }}
        >
          Review install again
        </button>
      </div>
    );
  return (
    <>
      <InstallPlanSummary plan={plan} />
      <PlannedInstallButton plan={plan} busy={busy} install={install} />
    </>
  );
}

function InstallPlanSummary({ plan }: { plan: InstallPlan }) {
  const download = plan.action === "download";
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
          {download ? `${formatBytes(plan.storage.volume_available_bytes)} available` : localState}
        </span>
      </div>
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
  const insufficientSpace =
    plan.action === "download" && plan.download_bytes > plan.storage.volume_available_bytes;
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
    <div className="actions primary-actions">
      <button
        data-focusable
        className="primary wide button-with-icon"
        disabled={blocked || insufficientSpace || Boolean(busy)}
        onClick={() => {
          void install();
        }}
      >
        <Icon glyph={Download} />
        {label}
      </button>
    </div>
  );
}

function MaintenanceActions({
  port,
  libraryGeneration,
  canRollback,
  busy,
  actions,
}: {
  port: PortDefinition;
  libraryGeneration: number;
  canRollback: boolean;
  busy?: string;
  actions: DetailActions;
}) {
  return (
    <div className="actions maintenance-actions">
      <button
        data-focusable
        className="button-with-icon"
        disabled={Boolean(busy)}
        onClick={() => {
          void actions.verify();
        }}
      >
        <Icon glyph={ShieldCheck} />
        Verify installation
      </button>
      <button
        data-focusable
        className="button-with-icon"
        disabled={!canRollback || Boolean(busy)}
        onClick={() => {
          void actions.rollback();
        }}
      >
        <Icon glyph={RotateCcw} />
        Restore previous version
      </button>
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
    <div className="actions detail-inline-actions">
      <button
        data-focusable
        className="button-with-icon"
        title="Back up saves and settings"
        disabled={Boolean(busy)}
        onClick={() => {
          void actions.backup();
        }}
      >
        <Icon glyph={Save} />
        Back up data
      </button>
      <button
        data-focusable
        className="button-with-icon"
        disabled={Boolean(busy)}
        onClick={() => {
          void actions.openUserData();
        }}
      >
        <Icon glyph={FolderOpen} />
        Open data folder
      </button>
    </div>
  );
}

function UpdateCheckAction({ busy, check }: { busy?: string; check: DetailActions["check"] }) {
  return (
    <div className="actions detail-inline-actions">
      <button
        data-focusable
        className="button-with-icon"
        disabled={Boolean(busy)}
        onClick={() => {
          void check();
        }}
      >
        <Icon glyph={RefreshCw} />
        Check for updates
      </button>
    </div>
  );
}

function detailState(
  installed: boolean,
  launchReady: boolean,
  staged: boolean,
  pendingSetup: boolean,
  runtimeNeeded: boolean,
  runtimeUpdateAvailable: boolean,
  sourceHealth?: SourceHealth | null,
  biosHealth?: SourceHealth | null,
  selectedRequirement?: "game" | "bios" | "both",
  invalidInstallation = false,
) {
  if (invalidInstallation)
    return {
      title: "Installation needs repair",
      description:
        "Portcove could not verify this installation. Verify the game files and review repair before playing.",
      tone: "setup",
      icon: AlertTriangle,
    };
  if (!installed)
    return {
      title: "Available to install",
      description:
        selectedRequirement === "bios"
          ? "The selected BIOS file has not been checked. Portcove validates it when you continue installation."
          : selectedRequirement === "both"
            ? "The selected game files and BIOS file have not been checked. Portcove validates them when you continue installation."
            : selectedRequirement === "game"
              ? "Selected game files have not been checked. Portcove validates them when you continue installation."
              : "Portcove will check required game files and verify the release before it becomes active.",
      tone: "available",
      icon: Download,
    };
  if (runtimeNeeded)
    return runtimeUpdateAvailable
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
      title: "Game files required",
      description: "Run the port's setup before playing for the first time.",
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
  if (selectedRequirement)
    return {
      title:
        selectedRequirement === "bios"
          ? "BIOS file needs checking"
          : selectedRequirement === "both"
            ? "Game files and BIOS need checking"
            : "Game files need checking",
      description:
        selectedRequirement === "bios"
          ? "The selected BIOS file has not been checked. Portcove validates it before starting the game."
          : selectedRequirement === "both"
            ? "The selected game files and BIOS file have not been checked. Portcove validates them before starting the game."
            : "The selected game-file path has not been checked. Portcove validates it before starting the game.",
      tone: "setup",
      icon: Wrench,
    };
  if (pendingSetup)
    return {
      title: "Game files required",
      description: "Run the port's setup before playing for the first time.",
      tone: "setup",
      icon: Wrench,
    };
  if (staged)
    return {
      title: "Ready to play · update downloaded",
      description: "Play the installed version or review the downloaded update.",
      tone: "staged",
      icon: RefreshCw,
    };
  return {
    title: "Ready to play",
    description: "The installed version and all required game files are available.",
    tone: "ready",
    icon: CheckCircle2,
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
