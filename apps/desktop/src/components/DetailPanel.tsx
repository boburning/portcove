import { Chip } from "./ui/chip";
import { IdentityIcon } from "../features/identity/IdentityIcon";
import { identityStyle } from "../features/identity/identity-style";
import { ListingMaintenanceFacts } from "../features/browsing/ListingMaintenanceFacts";
import { gameFilesPresentation } from "../features/port-actions/browse-presentation";
import { CurrentStateSummary, ManagementRow } from "./ui/patterns";
import { DetailLayout } from "./DetailLayout";
import { SetupStatement, UpdateNoticePreferences, type DetailOrganization } from "./DetailChoices";
import {
  initialDetailSection,
  detailWorkSection,
  type DetailOpening,
} from "../features/game-details/detail-sections";
import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import { usePreparationCompletionFocus } from "../features/preparation/use-preparation-completion-focus";
import { gameTitle, gameProjectLabel, gameIdentityLabel } from "../port-identity";
import type { GameFileObservationPresentation } from "../features/browsing/use-game-file-observation";
import { cn } from "cn";
import { RemovalControl, type ApplyRemoval } from "./RemovalReview";
import { BrowsingMatchDetails } from "../features/browsing/BrowsingMatchDetails";
import type { CatalogQueryResult } from "../features/browsing/catalog-query";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import { SteamEntryControl } from "./SteamEntry";
import { AuthoredPreparationGuidance, ExternalRuntimeControl } from "./ExternalRuntime";
import {
  usesExternalRuntimeRoute,
  usesUserSelectedRuntime,
} from "../shared/external-runtime-trust";
import { ArtworkControls } from "./Artwork";
import type { ApplyBackupAction } from "./BackupReview";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import {
  type LucideIcon,
  AlertTriangle,
  ArchiveX,
  ArrowRight,
  ArrowUpRight,
  Info,
  Play,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileArchive,
  FileSearch,
  FolderOpen,
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
  BIOS_BLOCKERS,
  SOURCE_BLOCKERS,
  currentUpdateSnapshot,
  defaultReleaseChannel,
  formatBytes,
  hasUnconfirmedLaunchInput,
  installationMethodLabel,
  installationMethodLabels,
  platformLabel,
  releaseChannelPresentation,
} from "../view-model";
import { BackupHistory } from "./BackupHistory";
import { ProtectionSummary } from "./ProtectionSummary";
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
import {
  hasPendingSetupAction,
  portActionPresentation,
} from "../features/port-actions/port-action-presentation";
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
  openSetupFolder?: AsyncAction;
  reviewInstall: AsyncAction;
  restoreBackup: ApplyBackupAction;
  recoverGhostshipLegacy?: ApplyBackupAction | undefined;
  rollback: AsyncAction;
  remove: ApplyRemoval;
  setChannel: (channel: ReleaseChannel) => Promise<PortStatus | undefined>;
  setPolicy: (policy: UpdatePolicy) => Promise<PortStatus | undefined>;
  verify: AsyncAction;
}

type AsyncAction = () => void | Promise<unknown>;

interface DetailPanelProps {
  backLabel?: string | undefined;
  favoriteControl?: ReactNode;
  opening?: DetailOpening | undefined;
  extraFiles?: ReactNode;
  openActivity?: (() => void) | undefined;
  openSupport?: (() => void) | undefined;
  organization?: DetailOrganization | undefined;
  perform?: Perform | undefined;
  prepare?: RunPreparation | undefined;
  cancellableActivities?: ActivityRecord[] | undefined;
  port: PortDefinition;
  displayPort?: CatalogEntry | undefined;
  status?: PortStatus | undefined;
  installPlan?: InstallPlan | undefined;
  backups?: BackupRecord[];
  backupProblems?: BackupProblem[];
  backupState?: BackupInventory["state"] | undefined;
  backupProtection?: BackupInventory["protection"] | undefined;
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
    backupProtection,
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
      backLabel={props.backLabel}
      favoriteControl={props.favoriteControl}
      state={state}
      opening={props.opening}
      extraFiles={props.extraFiles}
      openActivity={props.openActivity}
      openSupport={props.openSupport}
      organization={props.organization}
      cancellations={renderCancellations()}
      hasFileObservations={Boolean(
        (props.browsingMatch && props.browsingBinding) ||
        (!props.browsingMatch && props.gameFileFilterContext?.byPort.has(port.id)) ||
        props.gameFileObservation?.lastAccepted?.routes.some(
          (route) => route.port_id === port.id,
        ) ||
        (props.libraryGeneration !== undefined && selectedChannel),
      )}
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
      displayPort={props.displayPort}
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
      backupProtection={backupProtection}
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
  return renderDetailBody();
}

interface DetailState {
  title: string;
  description: string;
  tone: "setup" | "available" | "ready" | "unknown";
  icon: LucideIcon;
  updateAttention?: string;
}

function DetailBody(model: {
  backLabel?: string | undefined;
  favoriteControl?: ReactNode;
  state: DetailState;
  opening?: DetailOpening | undefined;
  extraFiles?: ReactNode;
  openActivity?: (() => void) | undefined;
  openSupport?: (() => void) | undefined;
  organization?: DetailOrganization | undefined;
  cancellations: ReactNode;
  observations: ReactNode;
  hasFileObservations: boolean;
  installCancellations?: ActivityRecord[] | undefined;
  perform?: Perform | undefined;
  prepare?: RunPreparation | undefined;
  port: PortDefinition;
  displayPort?: CatalogEntry | undefined;
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
  backupProtection?: BackupInventory["protection"] | undefined;
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
  const { busy } = model;
  const managedPreparation = needsManagedPreparation(model.port, model.installed, model.status);
  const external = usesExternalRuntimeRoute(model.port, model.status);
  const directInstall =
    !model.installed && !model.status?.staged && !external && model.sourceReady && model.biosReady;
  const initialSection = initialDetailSection({
    destination: model.opening?.destination,
    needsFiles:
      !model.installed ||
      !model.status?.readiness ||
      !model.status.readiness.launchable ||
      model.pendingSetup ||
      !model.sourceReady ||
      !model.biosReady,
    hasUpdate: model.runtimeUpdateAvailable || Boolean(model.stagedVersion),
  });
  return (
    <DetailLayout
      backLabel={model.backLabel}
      favoriteControl={model.favoriteControl}
      port={model.displayPort ?? model.port}
      projectUrl={model.port.project_url}
      openSupport={model.openSupport}
      overviewRequirements={<DetailRequirementsFacts model={model} external={external} />}
      overviewActions={(reveal) => <DetailOverviewActions model={model} reveal={reveal} />}
      overviewDetails={<DetailOverviewEvidence model={model} />}
      selectedChannel={model.selectedChannel}
      opening={model.opening}
      initialSection={initialSection}
      close={model.actions.close}
      steam={!external}
      readiness={
        <span
          className={cn(
            "inline-flex items-center gap-2",
            model.state.tone === "ready"
              ? "text-pc-success-foreground"
              : model.state.tone === "available" || model.state.tone === "unknown"
                ? "text-pc-muted-foreground"
                : "text-pc-warning-foreground",
          )}
        >
          <Icon glyph={model.state.icon} />
          {model.state.title}
        </span>
      }
      installation={detailInstallationLabel(model.status, directInstall)}
      action={(reveal) =>
        model.installed && model.launchReady ? (
          <DetailHeaderAction {...{ model, busy }} />
        ) : (
          <Button
            data-focusable
            variant="primary"
            size="lg"
            disabled={Boolean(busy)}
            onClick={() => {
              reveal(
                "files",
                "detail-game-actions",
                external
                  ? undefined
                  : ".primary-actions button:not(:disabled):not([aria-disabled=true]), .preparation-control button:not(:disabled)",
              );
              if (directInstall) void model.actions.reviewInstall();
            }}
          >
            {directInstall ? "Install" : "Set up"}
            <Icon glyph={ArrowRight} />
          </Button>
        )
      }
      attention={(reveal) => (
        <>
          {model.cancellations}
          {busy ? (
            <div role="status" className="detail-notice-row">
              <Icon glyph={RefreshCw} />
              <span>
                Working: {busy}.{" "}
                <Button variant="link" onClick={() => reveal(detailWorkSection(busy))}>
                  View work <Icon glyph={ArrowRight} />
                </Button>
              </span>
            </div>
          ) : model.state.tone !== "ready" ? (
            <div className="detail-notice-row">
              <Icon glyph={Info} />
              <span data-detail-reason>{model.state.description}</span>
            </div>
          ) : null}
          {(model.runtimeUpdateAvailable || model.stagedVersion) && (
            <div data-update-attention className="detail-notice-row">
              <Icon glyph={Download} />
              <span>
                {model.stagedVersion
                  ? "Update saved for later · " + model.stagedVersion
                  : (model.state.updateAttention ??
                    "An update was available at the last check.")}{" "}
                <Button variant="link" onClick={() => reveal("versions")}>
                  Review update <Icon glyph={ArrowRight} />
                </Button>
              </span>
            </div>
          )}
        </>
      )}
    >
      {(reveal) => ({
        overview: <DetailOverviewSection model={model} />,
        files: <DetailFilesSection {...{ model, managedPreparation }} />,
        saves: <DetailSavesSection {...{ model, external }} />,
        versions: <DetailVersionsSection {...{ model, external }} />,
        manage: <DetailManageSection {...{ model, external, reveal }} />,
      })}
    </DetailLayout>
  );
}

function useStatusActionsGroup({
  hidePlay = false,
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
  hidePlay?: boolean;
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
  return {
    hidePlay,
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
    gameActions,
    nextStep,
    preparedFocus,
  };
}

function StatusActionsGroup(props: Parameters<typeof useStatusActionsGroup>[0]) {
  return <StatusActionsGroupView {...useStatusActionsGroup(props)} />;
}

function StatusActionsGroupView({
  gameActions,
  nextStep,
  ...model
}: ReturnType<typeof useStatusActionsGroup>) {
  const actionPresentation = portActionPresentation(
    model.status,
    model.installed ? "launch" : "install",
  );
  const trial =
    hasUnconfirmedLaunchInput(model.status, model.port) ||
    Boolean(
      selectedSourceRequirement(
        model.sources.source,
        model.sources.sourcePath,
        model.sources.bios,
        model.sources.biosPath,
      ),
    );
  const fileState = gameFilesPresentation(model.port, model.status);
  const fileSummary = (
    <CurrentStateSummary
      title={fileState.title}
      headingRef={nextStep}
      className="border-0 bg-transparent p-0"
    >
      <p className="m-0 text-sm text-pc-muted-foreground">{fileState.description}</p>
    </CurrentStateSummary>
  );
  const manualSetup =
    model.installed &&
    model.port.adapter === "native-portable" &&
    hasPendingSetupAction(model.status);
  if (usesExternalRuntimeRoute(model.port, model.status)) {
    return (
      <>
        {fileSummary}
        <ExternalStatusActions
          {...{
            hidePlay: model.hidePlay,
            port: model.port,
            status: model.status,
            sources: model.sources,
            sourceReady: model.sourceReady,
            biosReady: model.biosReady,
            launchReady: model.launchReady,
            busy: model.busy,
            libraryGeneration: model.libraryGeneration,
            onChanged: model.onChanged,
            actions: model.actions,
            actionPresentation,
            trial,
          }}
        />
      </>
    );
  }
  if (!model.installed && !model.stagedVersion && actionPresentation.blocked)
    return (
      <section
        id="detail-game-actions"
        tabIndex={-1}
        aria-label="Game actions"
        className="grid gap-3"
      >
        {fileSummary}
        <RetiredNotice port={model.port} />
        <p role="status">{actionPresentation.reason}</p>
        <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
          <Button data-focusable className="wide flex-1" variant="primary" size="lg" disabled>
            Installation unavailable
          </Button>
          {model.installPlan && (
            <Button
              data-focusable
              variant="outline"
              disabled={Boolean(model.busy)}
              onClick={() => model.actions.dismissInstallReview()}
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
      id="detail-game-actions"
      tabIndex={-1}
      data-task-owner={`${model.port.id}:${model.libraryGeneration}`}
      aria-label="Game actions"
      className="grid gap-3"
    >
      {fileSummary}
      <RetiredNotice port={model.port} />
      {actionPresentation.blocked && <p role="status">{actionPresentation.reason}</p>}
      {<ManualSetupActions {...{ model, manualSetup }} />}
      {<ManagedPreparationAction {...{ gameActions, nextStep, model }} />}
      {!model.hidePlay && !manualSetup && (
        <PrimaryActions
          trial={trial}
          installCancellations={model.installCancellations}
          sources={model.sources}
          invalidInstallation={Boolean(
            model.status?.readiness?.blockers.includes("invalid_installation"),
          )}
          preparationRequired={model.managedPreparation && model.pendingSetup}
          runtimeNeeded={Boolean(model.status?.readiness?.blockers.includes("missing_runtime"))}
          runtimeUpdateAvailable={model.runtimeUpdateAvailable}
          stagedVersion={model.stagedVersion}
          installed={model.installed}
          sourceReady={model.sourceReady}
          biosReady={model.biosReady}
          launchReady={model.launchReady}
          pendingSetup={model.pendingSetup}
          plan={model.installPlan}
          busy={model.busy}
          actions={model.actions}
          openLibraryStorage={model.openLibraryStorage}
        />
      )}
    </section>
  );
}

const disclosureSummaryStyle =
  "list-none [&::-webkit-details-marker]:hidden flex cursor-pointer list-none items-center justify-between gap-3 px-0.5 py-[15px] text-xs font-bold hover:text-[var(--color-interactive-text-strong)]";
const disclosureMetaStyle = "ml-auto text-xs font-medium text-pc-muted-foreground";
const disclosureBodyStyle = "pt-0.5 pb-[22px]";

function requirementsGroupContext({
  port,
  installed,
  status,
  sources,
  managedPreparation,
  pendingSetup,
}: Omit<Parameters<typeof RequirementsGroup>[0], "busy">) {
  const setup =
    status?.active || status?.external_runtime
      ? (status.readiness?.setup_contract ?? null)
      : undefined;
  const current = requirementsPresentation(
    port,
    installed,
    sources,
    managedPreparation,
    pendingSetup,
  );
  const authoredSetup =
    setup == null ? current.authoredSetup : Boolean(setup.manual_setup || setup.manual_preparation);
  return {
    setup,
    needsAttention: current.needsAttention,
    authoredSetup,
    hidden: current.hidden && !setup?.source_requirements.length && !authoredSetup,
  };
}

function RequirementsGroup({
  port,
  installed,
  status,
  sources,
  managedPreparation,
  pendingSetup,
  busy,
}: {
  port: PortDefinition;
  installed: boolean;
  status?: PortStatus | undefined;
  sources: SourceControls;
  managedPreparation: boolean;
  pendingSetup: boolean;
  busy?: string | undefined;
}) {
  const { setup, needsAttention, authoredSetup, hidden } = requirementsGroupContext({
    port,
    installed,
    status,
    sources,
    managedPreparation,
    pendingSetup,
  });
  const [initiallyOpen] = useState(needsAttention);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (needsAttention && disclosure.current) disclosure.current.open = true;
  }, [needsAttention]);
  if (hidden) return null;
  return (
    <DetailGroup title="Requirements">
      <details
        ref={disclosure}
        className="requirements-disclosure border-y border-pc-border"
        open={initiallyOpen}
      >
        <summary data-focusable className={`requirements-summary ${disclosureSummaryStyle}`}>
          Game-file requirements and setup
          <span className={`requirements-summary-meta ${disclosureMetaStyle}`}>
            {authoredSetup && !port.source_profile && !port.bios_source_profile
              ? "Game instructions"
              : "File controls"}
          </span>
          <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
        </summary>
        <div className={`requirements-body grid gap-4 ${disclosureBodyStyle}`}>
          {authoredSetup && (
            <>
              {setup === null && (
                <p className="text-xs text-pc-muted-foreground">
                  Current catalog guide; this installation’s recorded setup facts are unavailable.
                </p>
              )}
              <AuthoredPreparationGuidance
                port={port}
                ownership="managed"
                setup={setup === null ? undefined : setup}
              />
            </>
          )}
          {(!authoredSetup ||
            Boolean(
              setup === undefined
                ? port.presentation?.source_requirements.length
                : setup?.source_requirements.length,
            )) && <RequirementsSummary port={port} status={status} />}
          <SourceFields controls={sources} />
          <SourceIntakeActions controls={sources} busy={Boolean(busy)} />
        </div>
      </details>
    </DetailGroup>
  );
}

function checkedUpdateMatchesStaged(status: PortStatus | undefined) {
  const checked = currentUpdateSnapshot(status)?.check;
  const staged = status?.staged;
  return Boolean(
    checked &&
    staged &&
    checked.port_id === staged.port_id &&
    checked.release.version === staged.version &&
    checked.release.channel === staged.channel &&
    checked.release.asset.sha256 === staged.artifact.sha256 &&
    checked.release.asset.name === staged.artifact.asset_name &&
    checked.release.asset.size === staged.artifact.size &&
    JSON.stringify(checked.required_runtime ?? null) === JSON.stringify(staged.runtime ?? null),
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
  const knownCandidate = Boolean(
    status?.acquisition || (checked?.update_available && !checkedUpdateMatchesStaged(status)),
  );
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
    <DetailGroup
      title="Updates"
      action={installed ? <UpdateCheckAction busy={busy} check={actions.check} /> : undefined}
    >
      {installed && (
        <>
          <p>
            {checked
              ? checked.update_available
                ? `Update ${checked.release.version} was available at the last check. Review it before making changes.`
                : "No update was found at the last check. You can check again."
              : "No update check is saved for this installation and channel."}
          </p>
          {knownCandidate && (
            <GameUpdateControl
              key={`${port.id}:${libraryGeneration}:${status?.active?.id}:${status?.staged?.id}:${selectedChannel}:${policy}`}
              portId={port.id}
              generation={libraryGeneration}
              policy={policy}
              gameName={gameIdentityLabel(port)}
              currentVersion={status?.active?.version}
              status={status}
              busy={Boolean(busy)}
              perform={perform}
              primary={!status?.staged}
            />
          )}
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
  backups,
  backupProblems,
  backupState,
  backupCreateAssessment,
  backupRestoreAssessment,
  backupReadState,
  retryBackupRead,
  libraryGeneration,
  busy,
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
  const backupPresentation = backupCreatePresentation(backupCreateAssessment, backupReadState);
  return (
    <section
      className="detail-group detail-saves-workspace [&>.backup-history]:mt-0 [&>.backup-history]:border-t-0 [&>.backup-history]:pt-0"
      aria-labelledby="detail-saves-and-storage"
    >
      <h2 id="detail-saves-and-storage" tabIndex={-1} className="sr-only">
        Saves & backups
      </h2>
      <header className="detail-saved-data-header">
        <div className="min-w-0 flex-1">
          <h3 ref={heading} tabIndex={-1} className="m-0 text-base font-semibold">
            Saved data
          </h3>
          <p
            role="status"
            className="mt-2 text-sm text-pc-muted-foreground"
            id="backup-create-explanation"
          >
            {backupPresentation.explanation}
          </p>
        </div>
        <BackupCreateAction busy={busy} actions={actions} presentation={backupPresentation} />
      </header>
      <div className="detail-saved-data-summary">
        <div className="detail-saved-data-fact">
          <Icon glyph={FileArchive} size="lg" />
          <div className="min-w-0">
            <p className="m-0 text-base font-semibold">
              {backupReadState?.status === "current" &&
              backupReadState.hasInventory &&
              backupState === "healthy"
                ? `${backups.length} ${backups.length === 1 ? "backup" : "backups"}`
                : "Review history below"}
            </p>
            <p className="mt-1 text-xs text-pc-muted-foreground">Saves and settings snapshots</p>
          </div>
        </div>
        <StorageSummary status={status} />
        <Button
          data-focusable
          variant="outline"
          className="justify-self-start"
          aria-label="Open folder for saved data"
          disabled={Boolean(busy)}
          onClick={() => {
            void actions.openUserData();
          }}
        >
          <Icon glyph={FolderOpen} />
          Open folder
        </Button>
      </div>
      {hasBackupHistory && (
        <BackupHistory
          embedded
          gameName={gameIdentityLabel(port)}
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
          recoverGhostshipLegacy={actions.recoverGhostshipLegacy}
          remove={actions.deleteBackup}
          focusFallback={() => heading.current}
        />
      )}
      <p className="m-0 text-xs text-pc-muted-foreground">
        Backups cover managed saves and settings. Game-version rollback, library metadata and other
        folders are separate.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer py-2 font-medium">Coverage and recorded rules</summary>
        <SavesAndSettingsSummary port={port} status={status} />
        <TrustStrip status={status} />
      </details>
    </section>
  );
}

function FutureSetupDisclosure({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <details className="future-setup-disclosure advanced-settings border-y border-pc-border">
      <summary data-focusable className={`advanced-summary ${disclosureSummaryStyle}`}>
        {title}
        <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
      </summary>
      <div className={`advanced-body grid gap-4 ${disclosureBodyStyle}`}>
        <p>{description}</p>
        {children}
      </div>
    </details>
  );
}

function DetailGroup({
  title,
  children,
  headingRef,
  hideHeading = false,
  action,
  headingId: explicitHeadingId,
}: {
  title: string;
  children: React.ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  hideHeading?: boolean;
  action?: ReactNode;
  headingId?: string;
}) {
  const headingId = explicitHeadingId ?? `detail-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="detail-group mt-7 grid gap-4 first:mt-0" aria-labelledby={headingId}>
      <div className="detail-section-heading">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className={cn("m-0 text-base", hideHeading && "sr-only")}
        >
          {title}
        </h2>
        {action}
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

export function InstallationVersionSummary({
  status,
  selectedChannel,
  action,
}: {
  status?: PortStatus | undefined;
  selectedChannel: ReleaseChannel;
  action?: ReactNode;
}) {
  const checked = currentUpdateSnapshot(status)?.check;
  const candidate =
    status?.staged?.version ?? (checked?.update_available ? checked.release.version : undefined);
  const channel = status?.active?.channel ?? selectedChannel;
  const channelChip = (value: ReleaseChannel) => (
    <Chip style={identityStyle(value, true)}>
      <IdentityIcon name={value} channel />
      {releaseChannelPresentation(value).label}
    </Chip>
  );
  return (
    <section className="detail-version-stage" aria-label="Installation and release versions">
      <div className="detail-version-pair">
        <div className="detail-version-current">
          <p className="detail-version-label">
            {status?.active ? "Installed version" : "No managed installation"}
          </p>
          <strong>{status?.active?.version ?? "Not installed"}</strong>
          {status?.active && channelChip(channel)}
        </div>
        {candidate && (
          <>
            <Icon glyph={ArrowRight} className="detail-version-direction" />
            <div className="detail-version-candidate">
              <p className="detail-version-label">
                {status?.staged ? "Update saved for later" : "Available at last check"}
              </p>
              <strong>{candidate}</strong>
              {channelChip(status?.staged?.channel ?? selectedChannel)}
            </div>
          </>
        )}
        {action && <div className="detail-version-action">{action}</div>}
      </div>
      {status?.staged && (
        <p className="detail-version-context">
          Using this checked local copy does not download it again, and keeps the current version
          for rollback.
        </p>
      )}
      {channel !== selectedChannel && (
        <p className="detail-version-context">
          Selected channel for future checks: {channelChip(selectedChannel)}
        </p>
      )}
      {!candidate && (
        <p className="detail-version-context">
          {!status?.active
            ? "Set up this game before managing its installed versions here."
            : checked
              ? `No update was found at the last check (${checked.release.version}).`
              : "Check for updates to see the latest available version."}
        </p>
      )}
      {status?.staged && checked?.update_available && !checkedUpdateMatchesStaged(status) && (
        <p className="detail-version-context">
          Latest release at last check: {checked.release.version}. The saved update above is a
          separate candidate.
        </p>
      )}
    </section>
  );
}

function StorageSummary({ status }: { status?: PortStatus | undefined }) {
  return (
    <div className="detail-saved-data-fact">
      <Icon glyph={FolderOpen} size="lg" />
      <div className="min-w-0 text-xs wrap-anywhere">
        <p className="m-0 text-sm font-semibold">Saves and settings folder</p>
        {status?.user_data_root ? (
          <p className="mt-1 text-pc-muted-foreground select-text">{status.user_data_root}</p>
        ) : (
          <p className="mt-1 text-pc-muted-foreground">Folder not available</p>
        )}
      </div>
    </div>
  );
}

function CompatibilitySummary({ port }: { port: PortDefinition }) {
  return (
    <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
      <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">Platforms</small>
        {port.platforms.map((value) => platformLabel(value)).join(" · ")}
      </span>
      {port.platforms.includes("linux-x86-64") && (
        <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">Steam Deck</small>
          Not tested. Linux availability does not show whether this game works on SteamOS or in
          Gaming Mode.
        </span>
      )}
      <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
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
        <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">Upstream project</small>
          {upstreamStatusPresentation[port.upstream_status]}
        </span>
        <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
          <small className="mb-[5px] block text-[var(--color-text-muted)]">
            Catalog designation (not a test result)
          </small>
          {supportTierPresentation[port.support_tier]}
        </span>
        <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
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
              ? usesUserSelectedRuntime(port)
                ? "You or the upstream launcher manage setup and updates. Portcove saves your selected launch details without authenticating the files as an official package."
                : "Portcove uses the accepted package identity recorded in the catalog. You prepare the runtime."
              : "Portcove checks this project for releases."}
        </span>
      </div>
    </>
  );
}

function RequirementsSummary({
  port,
  status,
}: {
  port: PortDefinition;
  status?: PortStatus | undefined;
}) {
  const retained = Boolean(status?.active || status?.external_runtime);
  const requirements = retained
    ? status?.readiness?.setup_contract?.source_requirements
    : port.presentation?.source_requirements;
  if (!requirements)
    return (
      <p>
        Detailed setup requirements are unavailable. Check this port’s instructions before
        continuing.
      </p>
    );
  return (
    <div
      className="metadata grid grid-cols-[1fr_1fr] gap-[10px]"
      role="group"
      aria-label="Required game files and verification"
    >
      {requirements.map((requirement) => (
        <span
          className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
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

function savedDataContext(status: PortStatus | undefined) {
  const retained = Boolean(
    status?.active || status?.staged || status?.previous || status?.external_runtime,
  );
  const setup = status?.readiness?.setup_contract;
  const retainedSetup = retained && setup?.retained ? setup : undefined;
  return { retained, setup, retainedSetup };
}

function savesAndSettingsPresentation(port: PortDefinition, status: PortStatus | undefined) {
  const { retained, setup, retainedSetup } = savedDataContext(status);
  const behavior = retained
    ? retainedSetup?.saves_and_settings
    : (setup?.saves_and_settings ?? port.presentation?.saves_and_settings);
  const declared = [
    ...(retained ? (retainedSetup?.persistent_paths ?? []) : port.persistent_paths),
    ...(retained
      ? (retainedSetup?.persistent_file_patterns ?? [])
      : (port.persistent_file_patterns ?? [])
    ).map((pattern) => `${pattern.prefix}*${pattern.suffix}`),
  ];
  return { retained, retainedSetup, behavior, declared };
}

function SavesAndSettingsSummary({
  port,
  status,
}: {
  port: PortDefinition;
  status?: PortStatus | undefined;
}) {
  const { retained, retainedSetup, behavior, declared } = savesAndSettingsPresentation(
    port,
    status,
  );
  return (
    <div className="grid min-w-0 gap-3 text-sm wrap-anywhere">
      <span className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        <small className="mb-[5px] block text-[var(--color-text-muted)]">Saved data handling</small>
        {retained && !retainedSetup
          ? "This installation’s saved-data coverage could not be verified."
          : behavior === "portcove-managed"
            ? "Managed by Portcove for backup and restore"
            : behavior === "external-user-owned"
              ? "External saves and settings are outside Portcove backups; declared local data may still be covered"
              : "Unavailable in this catalog"}
      </span>
      <section aria-label="Saved-data coverage">
        <h3 className="mb-1 text-sm font-semibold">What a backup covers</h3>
        {retained && !retainedSetup ? (
          <p>
            Portcove can back up data already in its managed saves and settings folder. Runtime
            collection coverage is unknown here; current catalog declarations do not establish rules
            for this retained installation.
          </p>
        ) : (
          <>
            <p>
              {retainedSetup
                ? "This installation’s recorded saved-data declarations"
                : "Current catalog saved-data declarations"}
              {declared.length ? ":" : " are unavailable in this catalog."}
            </p>
            {declared.length > 0 && (
              <ul className="my-2 list-disc ps-5">
                {declared.map((location) => (
                  <li key={location}>
                    <code>{location}</code>
                  </li>
                ))}
              </ul>
            )}
            <p>
              Portcove checks the managed saves and settings folder when creating a backup. Other
              locations are not covered.
            </p>
          </>
        )}
      </section>
      <p>Game-version rollback and library metadata export are separate from saved-data backup.</p>
    </div>
  );
}

function TrustStrip({ status }: { status?: PortStatus | undefined }) {
  return (
    <div className="trust-strip m-[13px_1px_22px] flex flex-wrap gap-[7px_12px] text-xs text-[var(--color-text-muted)]">
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
  const coreAllowsLaunch = installed && status?.readiness?.launchable === true;
  // A draft can request a review; Core still validates it before installation.
  // Only missing registration is bypassed, never a known failure or installed refusal.
  const selectedUnregisteredSource =
    !installed &&
    !source &&
    status?.readiness?.source === "unregistered" &&
    Boolean(sourcePath.trim());
  const selectedUnregisteredBios =
    !installed && !bios && status?.readiness?.bios === "unregistered" && Boolean(biosPath?.trim());
  const sourceReady =
    !status?.readiness?.blockers.some(
      (blocker) =>
        SOURCE_BLOCKERS.includes(blocker) &&
        !(blocker === "missing_source" && selectedUnregisteredSource),
    ) &&
    (coreAllowsLaunch ||
      sourceRequirementReady(
        Boolean(port.source_profile),
        installed,
        status?.readiness?.source,
        Boolean(source || sourcePath.trim()),
      ));
  const biosReady =
    !status?.readiness?.blockers.some(
      (blocker) =>
        BIOS_BLOCKERS.includes(blocker) &&
        !(blocker === "missing_bios" && selectedUnregisteredBios),
    ) &&
    (coreAllowsLaunch ||
      sourceRequirementReady(
        Boolean(port.bios_source_profile),
        installed,
        status?.readiness?.bios,
        Boolean(bios || biosPath?.trim()),
      ));
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
  // Registered inputs are verified by Core during explicit Play, not browsing.
  return health === "current" || (health === "not_checked" && selected);
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
  sources,
}: {
  libraryGeneration: number;
  port: PortDefinition;
  status?: PortStatus | undefined;
  selectedChannel: ReleaseChannel;
  sources: SourceControls;
}) {
  const includeManagement = !usesExternalRuntimeRoute(port, status);
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
          {includeManagement ? "Commands and recorded checks" : "Recorded check identities"}
        </span>
        <Icon className="text-[var(--color-interactive-text)]" glyph={ChevronDown} />
      </summary>
      <div className={`advanced-body ${disclosureBodyStyle}`}>
        {includeManagement && (
          <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
            <span
              className="min-w-0 py-1 text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]"
              title={persistentFiles}
            >
              <small className="mb-[5px] block text-[var(--color-text-muted)]">
                Current catalog saved-data declarations
              </small>
              {status?.active || status?.staged
                ? "Saved data follows this installation's retained contract."
                : persistentFiles || "No saved data paths declared"}
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
          <TechnicalCommandContinuity
            {...{ libraryGeneration, port, status, selectedChannel, sources }}
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
      <div className="flex flex-wrap items-stretch gap-2 [&_input]:min-w-0">
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
          Check installed files
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
            Check for updates. If none is available, check installed files for diagnostic details.
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
    return stagedVersion ? (
      <div className="actions primary-actions mt-[16px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
        <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />
      </div>
    ) : (
      <UninstalledPrimaryActions
        {...{
          installCancellations,
          sources,
          sourceReady,
          biosReady,
          launchReady,
          plan,
          busy,
          actions,
          openLibraryStorage,
        }}
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
            ? "Select BIOS file"
            : "Select game files"}
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

function installedPlayPresentation(launchReady: boolean, trial: boolean, pendingSetup: boolean) {
  return {
    title: launchReady
      ? trial
        ? "Try launching; compatibility is unconfirmed"
        : pendingSetup
          ? "Launch this port to finish its first-time setup"
          : "Launch this port"
      : "Review the current launch requirements",
    glyph: !launchReady ? AlertTriangle : pendingSetup ? Wrench : Play,
    label: !launchReady
      ? "Play unavailable"
      : pendingSetup
        ? "Launch to finish setup"
        : trial
          ? "Try launch"
          : "Play",
  };
}

function InstalledPlayActions({
  compact = false,
  hero = false,
  trial = false,
  preparationRequired,
  launchReady,
  pendingSetup,
  stagedVersion,
  busy,
  actions,
}: {
  compact?: boolean;
  hero?: boolean;
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
  const presentation = installedPlayPresentation(launchReady, trial, pendingSetup);
  return (
    <div
      className={cn(
        "actions primary-actions flex flex-wrap gap-2",
        !compact && "mt-4",
        hero && "detail-hero-primary",
      )}
    >
      <Button
        data-focusable
        data-launch-action
        data-confirmed-play={launchReady && !trial && !pendingSetup ? "" : undefined}
        className={cn(compact ? undefined : "wide flex-1", hero && "detail-hero-action")}
        variant="primary"
        size="lg"
        title={presentation.title}
        disabled={!launchReady || Boolean(busy)}
        focusableWhenDisabled={launchReady && Boolean(busy)}
        aria-busy={launchReady && Boolean(busy)}
        onClick={() => {
          void actions.launch();
        }}
      >
        <Icon
          glyph={presentation.glyph}
          className={presentation.glyph === Play ? "fill-current" : ""}
        />
        {presentation.label}
      </Button>
      <StagedActivation version={stagedVersion} busy={busy} activate={actions.activate} />
    </div>
  );
}

function StagedActivation({
  version,
  busy,
  activate,
  primary = false,
}: {
  version?: string | undefined;
  busy?: string | undefined;
  activate: DetailActions["activate"];
  primary?: boolean;
}) {
  if (!version) return null;
  return (
    <Button
      data-focusable
      className="staged-action"
      variant={primary ? "primary" : "selected"}
      size="lg"
      disabled={Boolean(busy)}
      onClick={() => {
        void activate();
      }}
    >
      Apply update · {version}
    </Button>
  );
}

function useInstallAction({
  gameName,
  setupNote,
  externalData,
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
  gameName?: string | undefined;
  setupNote?: string | undefined;
  externalData?: boolean | undefined;
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
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const actionRegion = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    if (!choosing && restoreFocus.current) {
      restoreFocus.current = false;
      (ready ? reviewButton : chooseButton).current?.focus();
    }
  }, [choosing, ready, sourceReady, biosReady]);
  const pick = !sourceReady ? pickSource : pickBios;
  const inputId = !sourceReady ? sourceInputId : biosInputId;
  const chooseRequiredInput = () => {
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
  };
  return {
    gameName,
    setupNote,
    externalData,
    cancellations,
    ready,
    sourceReady,
    biosReady,
    plan,
    busy,
    install,
    review,
    dismiss,
    openLibraryStorage,
    portaled,
    reviewButton,
    reviewHeading,
    chooseButton,
    actionRegion,
    pick,
    inputId,
    chooseRequiredInput,
    choosing,
  };
}

export function InstallAction(props: Parameters<typeof useInstallAction>[0]) {
  return <InstallActionView {...useInstallAction(props)} />;
}

function InstallActionView({
  chooseButton,
  reviewButton,
  reviewHeading,
  actionRegion,
  ...model
}: ReturnType<typeof useInstallAction>) {
  if (!model.ready) {
    return (
      <MissingInstallAction
        sourceReady={model.sourceReady}
        biosReady={model.biosReady}
        pick={model.pick}
        inputId={model.inputId}
        choosing={model.choosing}
        busy={model.busy}
        buttonRef={chooseButton}
        onPick={model.chooseRequiredInput}
      />
    );
  }
  const action = model.plan ? installPlanActionLabel(model.plan.action) : undefined;
  return (
    <div ref={actionRegion} tabIndex={-1} role="group" aria-label="Installation actions">
      <div
        className={cn(
          model.plan ? "hidden" : "actions primary-actions mt-[16px] flex flex-wrap gap-[8px]",
          "[&.compact]:mt-[14px]",
        )}
      >
        <Button
          ref={reviewButton}
          data-focusable
          className={cn(model.plan ? "hidden" : "wide", "flex-1")}
          variant="primary"
          size="lg"
          disabled={Boolean(model.busy)}
          onClick={() => {
            void model.review();
          }}
        >
          <Icon glyph={ShieldCheck} />
          {model.busy === "review install" ? "Checking release…" : "Review installation"}
        </Button>
      </div>
      {model.plan && (
        <InstallReviewDialog
          {...{
            gameName: model.gameName,
            setupNote: model.setupNote,
            externalData: model.externalData,
            cancellations: model.cancellations,
            plan: model.plan,
            busy: model.busy,
            install: model.install,
            review: model.review,
            dismiss: model.dismiss,
            openLibraryStorage: model.openLibraryStorage,
            portaled: model.portaled,
            reviewButton: reviewButton,
            reviewHeading: reviewHeading,
            actionRegion: actionRegion,
            action,
          }}
        />
      )}
    </div>
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
    <div className="install-plan mt-[16px] grid grid-cols-1 [align-items:end] gap-[18px] rounded-pc-lg border border-pc-border bg-pc-surface p-[14px] @min-[30rem]/detail:grid-cols-[1fr_auto]">
      <div>
        <strong className="block text-[length:var(--text-sm)]">{plan.release.version}</strong>
        <span className="mt-[4px] block text-xs text-[var(--color-text-secondary)] capitalize">
          {releaseChannelPresentation(plan.channel).label} · {installPlanActionLabel(plan.action)}
        </span>
        {plan.bundled_runtime && (
          <span className="mt-[4px] block text-xs text-[var(--color-text-secondary)] capitalize">
            Required component included · {formatBytes(plan.bundled_runtime.asset.size)}
          </span>
        )}
        {(plan.auxiliary_downloads?.length ?? 0) > 0 && (
          <span className="mt-[4px] block text-xs text-[var(--color-text-secondary)]">
            Required build components included · Download may be reduced by cached files
          </span>
        )}
      </div>
      <div className="text-end">
        <strong className="block text-[length:var(--text-sm)]">
          {download ? formatBytes(plan.download_bytes) : "No download"}
        </strong>
        <span className="mt-[4px] block text-xs text-[var(--color-text-secondary)] capitalize">
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
            <p className="mt-[4px] text-xs text-[var(--color-text-secondary)]">
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
      : plan.action === "already_active"
        ? "Use current version"
        : (installPlanActionLabel(plan.action) ?? "Review installation");
  if (blocked) label = "Verify or replace the local copy before installing";
  else if (insufficientSpace) label = "Free space required";
  else if (busy === "install") label = "Installing…";
  return (
    <Button
      data-focusable
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

function VersionRollback({
  status,
  busy,
  rollback: apply,
}: {
  status?: PortStatus | undefined;
  busy?: string | undefined;
  rollback: AsyncAction;
}) {
  const rollback = portActionPresentation(status, "rollback");
  const canRollback = Boolean(status?.previous);
  return (
    <>
      <Button
        data-focusable
        variant="outline"
        disabled={!canRollback || rollback.blocked || Boolean(busy)}
        onClick={() => {
          void apply();
        }}
      >
        <Icon glyph={RotateCcw} />
        Restore previous version
      </Button>
      <p className="text-sm text-pc-muted-foreground">
        This switches game software and keeps current saved data. Older software may not understand
        newer saves or configuration. Saved-data restore is a separate reviewed action in Saves.
      </p>
      {rollback.blocked && (
        <p role="status" data-rollback-assessment>
          {rollback.reason}
        </p>
      )}
    </>
  );
}

function MaintenanceActions({
  port,
  reveal,
  libraryGeneration,
  status,
  verificationPrimary,
  busy,
  actions,
}: {
  port: PortDefinition;
  reveal: import("./DetailLayout").RevealDetailSection;
  libraryGeneration: number;
  status?: PortStatus | undefined;
  verificationPrimary: boolean;
  busy?: string | undefined;
  actions: DetailActions;
}) {
  return (
    <>
      {!verificationPrimary && (
        <ManagementRow
          title="Installed file checks"
          description="Checks the full recorded installation manifest without changing saved data."
        >
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void actions.verify()}
          >
            <Icon glyph={ShieldCheck} />
            Check installed files
          </Button>
        </ManagementRow>
      )}
      {verificationPrimary && (
        <ManagementRow
          title="Installed file checks"
          description="The recorded installation needs repair. Review its current requirements in Game files."
        >
          <Button variant="outline" onClick={() => reveal("files", "detail-game-actions")}>
            View file checks
          </Button>
        </ManagementRow>
      )}
      <div className="detail-danger-zone">
        <DetailGroup title="Remove from library">
          <p>Review the exact files to remove and the data to keep before confirming.</p>
          <RemovalControl
            key={`${port.id}:${libraryGeneration}`}
            port={port}
            status={status}
            generation={libraryGeneration}
            busy={Boolean(busy)}
            apply={actions.remove}
          />
        </DetailGroup>
      </div>
    </>
  );
}

function BackupCreateAction({
  busy,
  actions,
  presentation,
}: {
  busy?: string | undefined;
  actions: DetailActions;
  presentation: ReturnType<typeof backupCreatePresentation>;
}) {
  const { available, explanation } = presentation;
  return (
    <Button
      data-focusable
      variant="primary"
      title={explanation}
      aria-describedby="backup-create-explanation"
      disabled={Boolean(busy) || !available}
      onClick={() => {
        void actions.backup();
      }}
    >
      <Icon glyph={Save} />
      Back up now
    </Button>
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
  userSelectedRuntime: boolean;
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
  userSelectedRuntime,
}: DetailStateInput): DetailState {
  if (invalidInstallation && userSelectedRuntime)
    return {
      title: "Existing installation unavailable",
      description:
        "Check the selected executable and working directory. Complete any upstream setup, or use Edit launch details to choose the working copy. Your external files stay in place.",
      tone: "setup",
      icon: AlertTriangle,
    };
  if (invalidInstallation)
    return {
      title: "Installation needs repair",
      description:
        "Portcove couldn't verify the installed files. Choose Check installed files to check them.",
      tone: "setup",
      icon: AlertTriangle,
    };
  if (!installed)
    return availableInstallState(
      selectedRequirement,
      missingRequirement,
      externalRuntime,
      userSelectedRuntime,
    );
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
      title: "First-time setup needed",
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
      title: "First-time setup needed",
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
  userSelectedRuntime = false,
): DetailState {
  if (userSelectedRuntime)
    return {
      title: "Choose your existing installation",
      description:
        "Complete upstream setup, then choose the game executable, working directory and any required arguments. You or the upstream launcher manage setup and updates; Portcove saves these launch details.",
      tone: "available",
      icon: Wrench,
    };
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
      title: requirement === "Game files" ? "Needs game files" : `${requirement} needed`,
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
          "Check for updates. If none is available, check installed files for diagnostic details.",
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
        tone: "unknown",
        icon: Info,
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
          externalRuntime: usesExternalRuntimeRoute(port, status),
          userSelectedRuntime: usesUserSelectedRuntime(port, status),
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
    return readState?.status === "pending"
      ? "Checking your saved data…"
      : "Saved-data availability has not been checked.";
  }
  if (available) return "Back up saves and settings managed by Portcove.";
  if (!consistent) return unavailable;
  const reasons: Partial<
    Record<NonNullable<BackupInventory["create_assessment"]>["reason"], string>
  > = {
    missing_data:
      "No saves or settings managed by Portcove were found to back up. Other locations are not checked here.",
    recovery_required: "Restart Portcove to retry recovery, then check your backups again.",
    unsafe_data: "The saved-data location needs a safety check before this action.",
    assessment_incomplete: "The saved-data check did not finish. Your data is preserved.",
    unreadable_data: "Your saved data could not be read. Check its location, then retry.",
  };
  return assessment && Object.hasOwn(reasons, assessment.reason)
    ? reasons[assessment.reason]!
    : unavailable;
}

function needsManagedPreparation(
  port: PortDefinition,
  installed: boolean,
  status: PortStatus | undefined,
) {
  return Boolean(
    installed &&
    (status?.readiness?.preparation_mode != null ||
      ((port.adapter === "upstream-managed-setup" || port.adapter === "libultraship-portable") &&
        port.setup_output_paths.length)),
  );
}

function ExternalStatusActions(
  model: Pick<
    ReturnType<typeof useStatusActionsGroup> & {
      actionPresentation: ReturnType<typeof portActionPresentation>;
      trial: boolean;
    },
    | "hidePlay"
    | "port"
    | "status"
    | "sources"
    | "sourceReady"
    | "biosReady"
    | "launchReady"
    | "busy"
    | "libraryGeneration"
    | "onChanged"
    | "actions"
    | "actionPresentation"
    | "trial"
  >,
) {
  return (
    <section
      id="detail-game-actions"
      tabIndex={-1}
      aria-label="Game actions"
      className="grid gap-3"
    >
      <RetiredNotice port={model.port} />
      {model.status?.external_runtime && model.actionPresentation.blocked && (
        <p role="status">{model.actionPresentation.reason}</p>
      )}
      {model.status?.external_runtime?.shared_preferences?.contract ===
        "smb1r-1.1-stable-windows" &&
        model.status.readiness?.blockers.some(
          (blocker) => blocker === "preparation_required" || blocker === "invalid_installation",
        ) && (
          <p role="status">
            Copy your recognized Super Mario Bros. (World) NES original to{" "}
            <code>{model.status.external_runtime.shared_preferences.path}</code> as{" "}
            <code>baserom.nes</code>. If <code>settings.cfg</code> exists there, review it as
            ordinary data without Godot object or resource constructors and use only the BaseAssets
            resource pack. Move custom levels and autosaves, blueprints, custom characters, extra
            resource packs and Godot loader metadata elsewhere manually, preserving their files.
            Refresh afterward. Portcove does not seed, own, update, back up or delete this shared
            directory.
          </p>
        )}
      {model.status?.external_runtime && !model.hidePlay && (
        <PrimaryActions
          trial={model.trial}
          sources={model.sources}
          invalidInstallation={false}
          runtimeNeeded={false}
          runtimeUpdateAvailable={false}
          installed
          sourceReady={model.sourceReady}
          biosReady={model.biosReady}
          preparationRequired={false}
          launchReady={model.launchReady}
          pendingSetup={false}
          stagedVersion={undefined}
          busy={model.busy}
          actions={model.actions}
        />
      )}
      <ExternalRuntimeControl
        port={model.port}
        status={model.status}
        generation={model.libraryGeneration}
        busy={Boolean(model.busy)}
        onChanged={model.onChanged}
      />
    </section>
  );
}

function InstallReviewDialog({
  reviewButton,
  reviewHeading,
  actionRegion,
  openLibraryStorage,
  ...model
}: Pick<
  ReturnType<typeof useInstallAction> & { plan: InstallPlan; action: string | undefined },
  | "gameName"
  | "setupNote"
  | "externalData"
  | "cancellations"
  | "plan"
  | "busy"
  | "install"
  | "review"
  | "dismiss"
  | "openLibraryStorage"
  | "portaled"
  | "reviewButton"
  | "reviewHeading"
  | "actionRegion"
  | "action"
>) {
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !model.busy) model.dismiss();
      }}
    >
      <DialogContent
        initialFocus={reviewHeading}
        showCloseButton={false}
        finalFocus={() => (model.busy === "install" ? actionRegion.current : reviewButton.current)}
        portaled={model.portaled}
        reviewSize="standard"
        aria-describedby="install-review-description"
      >
        <DialogTitle
          ref={reviewHeading}
          tabIndex={-1}
          id="install-review-title"
          className="mb-2 text-xl"
        >
          Review installation
        </DialogTitle>
        <DialogDescription id="install-review-description" className="mb-4 leading-relaxed">
          {model.gameName && (
            <strong className="mb-2 block wrap-anywhere text-pc-foreground">
              {model.gameName}
            </strong>
          )}
          {model.plan.action === "download"
            ? "Review the version, download size, and install folder."
            : "Review the version and how this local release will be used."}{" "}
          Portcove manages these runtime files and their updates. Automatic updates follow your
          selected update policy. See the game instructions for setup and save locations.
        </DialogDescription>
        {(model.setupNote || model.externalData) && (
          <section className="mb-4 grid min-w-0 gap-2 wrap-anywhere" aria-label="Game setup">
            <h3 className="font-semibold">Game setup</h3>
            {model.setupNote && <p>{model.setupNote}</p>}
            {model.externalData && (
              <p>
                Some game data stays outside Portcove backups. See Files for the locations and
                supported exceptions.
              </p>
            )}
          </section>
        )}
        {model.action ? (
          <InstallPlanSummary plan={model.plan} />
        ) : (
          <p role="alert">
            This version of Portcove cannot display the installation plan. Review it again, or
            update Portcove if this continues.
          </p>
        )}
        {model.cancellations?.map((activity) => (
          <OperationCancellation
            key={activity.id}
            operationId={activity.id}
            state={activity.cancellation ?? undefined}
          />
        ))}
        {installSpaceBlocked(model.plan) && (
          <p role="status" className="mt-3">
            {usesLibraryOutput(model.plan)
              ? "This installation needs more free space in the Portcove library. Free space on its drive or review the library location in Settings."
              : "This installation needs more temporary free space in the install folder's drive."}
          </p>
        )}
        <DialogFooter className="mt-4">
          {model.busy === "install" && (
            <Button data-focusable variant="outline" onClick={model.dismiss}>
              Continue browsing
            </Button>
          )}
          {openLibraryStorage &&
            usesLibraryOutput(model.plan) &&
            installSpaceBlocked(model.plan) && (
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(model.busy)}
                onClick={() => {
                  model.dismiss();
                  openLibraryStorage();
                }}
              >
                Open Library and storage
              </Button>
            )}
          {model.action ? (
            <PlannedInstallButton plan={model.plan} busy={model.busy} install={model.install} />
          ) : (
            <Button
              data-focusable
              variant="primary"
              disabled={Boolean(model.busy)}
              onClick={() => {
                void model.review();
              }}
            >
              Review installation again
            </Button>
          )}
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(model.busy)}
            onClick={() => model.dismiss()}
          >
            Cancel review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UninstalledPrimaryActions(
  model: Pick<
    Parameters<typeof PrimaryActions>[0],
    | "installCancellations"
    | "sources"
    | "sourceReady"
    | "biosReady"
    | "launchReady"
    | "plan"
    | "busy"
    | "actions"
    | "openLibraryStorage"
  >,
) {
  return (
    <InstallAction
      gameName={gameIdentityLabel(model.sources.port)}
      setupNote={
        model.sources.port.presentation?.manual_setup?.steps[0]?.instruction ??
        (!model.sources.port.source_profile && !model.sources.port.bios_source_profile
          ? (model.sources.port.presentation?.manual_preparation ?? undefined)
          : undefined)
      }
      externalData={model.sources.port.presentation?.saves_and_settings === "external-user-owned"}
      cancellations={model.installCancellations}
      ready={model.launchReady}
      sourceReady={model.sourceReady}
      biosReady={model.biosReady}
      pickSource={model.sources.pickSource}
      pickBios={model.sources.pickBios}
      sourceInputId={
        model.sources.port.source_profile
          ? `source-${model.sources.port.source_profile}`
          : undefined
      }
      biosInputId={
        model.sources.port.bios_source_profile &&
        model.sources.biosProfile &&
        model.sources.setBiosPath
          ? `source-${model.sources.port.bios_source_profile}`
          : undefined
      }
      plan={model.plan}
      busy={model.busy}
      install={model.actions.install}
      review={model.actions.reviewInstall}
      dismiss={model.actions.dismissInstallReview}
      openLibraryStorage={model.openLibraryStorage}
    />
  );
}

function TechnicalCommandContinuity(
  model: Pick<
    Parameters<typeof TechnicalDetails>[0],
    "libraryGeneration" | "port" | "status" | "selectedChannel" | "sources"
  >,
) {
  return (
    <CliContinuity
      key={`${model.port.id}:${model.libraryGeneration}`}
      generation={model.libraryGeneration}
      port={model.port}
      status={model.status}
      channel={model.selectedChannel}
      sourcePath={model.sources.sourcePath || model.sources.source?.path || ""}
      biosPath={model.sources.biosPath || model.sources.bios?.path || ""}
    />
  );
}

function originalGameFilesLabel({
  port,
  source,
  manual,
  unavailable,
}: {
  port: PortDefinition;
  source: readonly { label: string }[] | undefined;
  manual: unknown;
  unavailable: boolean;
}) {
  if (unavailable) return "Recorded requirements unavailable";
  if (source?.length) return source.map((requirement) => requirement.label).join(" · ");
  if (port.source_profile) return "Requirements not specified";
  return manual ? "Follow the upstream first-launch setup" : "No original game files declared";
}

function requirementInstallationLabel({
  external,
  retained,
  setup,
  port,
}: {
  external: boolean;
  retained: boolean;
  setup: NonNullable<PortStatus["readiness"]>["setup_contract"] | undefined;
  port: PortDefinition;
}) {
  if (external) return "Externally maintained installation";
  if (!retained) return installationMethodLabel(port);
  return setup?.installation_method
    ? installationMethodLabels[setup.installation_method]
    : "Recorded setup method unavailable";
}

function detailRequirementContext(model: Parameters<typeof DetailBody>[0]) {
  const retained = Boolean(model.status?.active || model.status?.external_runtime);
  const setup = model.status?.readiness?.setup_contract;
  const context = retained ? setup : model.port.presentation;
  const requirements = context?.source_requirements;
  const source = requirements?.filter((requirement) => requirement.role !== "bios");
  const bios = requirements?.find((requirement) => requirement.role === "bios");
  const manual = context?.manual_setup || context?.manual_preparation;
  return { retained, setup, source, bios, manual };
}

function DetailRequirementsFacts({
  model,
  external,
}: {
  model: Parameters<typeof DetailBody>[0];
  external: boolean;
}) {
  const { retained, setup, source, bios, manual } = detailRequirementContext(model);
  return (
    <dl className="detail-facts">
      <div>
        <dt>Original game files</dt>
        <dd>
          {originalGameFilesLabel({
            port: model.port,
            source,
            manual,
            unavailable: retained && !setup,
          })}
        </dd>
      </div>
      {(model.port.bios_source_profile || bios) && (
        <div>
          <dt>BIOS</dt>
          <dd>{bios?.label ?? "Required BIOS not specified"}</dd>
        </div>
      )}
      <div>
        <dt>Runs on</dt>
        <dd>
          {(retained ? setup?.platforms : model.port.platforms)?.map(platformLabel).join(" · ") ||
            "Recorded package targets unavailable"}
        </dd>
      </div>
      <div>
        <dt>Installation</dt>
        <dd>{requirementInstallationLabel({ external, retained, setup, port: model.port })}</dd>
      </div>
      <div>
        <dt>Selected release channel</dt>
        <dd>{releaseChannelPresentation(model.selectedChannel).label}</dd>
      </div>
      <div>
        <dt>Readiness</dt>
        <dd>{model.state.title}</dd>
      </div>
    </dl>
  );
}

function DetailOverviewActions({
  model,
  reveal,
}: {
  model: Parameters<typeof DetailBody>[0];
  reveal: import("./DetailLayout").RevealDetailSection;
}) {
  return (
    <>
      <div className="detail-journey-links">
        <Button
          variant="ghost"
          className="grid min-h-22.5 items-start justify-start gap-x-3.5 gap-y-4.25 rounded-[0.625rem] border-pc-border bg-pc-surface p-4.5 text-start"
          onClick={() => reveal("files")}
        >
          <Icon glyph={FolderOpen} size="lg" />
          <span>
            <strong>Game files</strong>
            <small>{gameFilesPresentation(model.port, model.status).title}</small>
          </span>
          <Icon glyph={ArrowUpRight} />
        </Button>
        <Button
          variant="ghost"
          className="grid min-h-22.5 items-start justify-start gap-x-3.5 gap-y-4.25 rounded-[0.625rem] border-pc-border bg-pc-surface p-4.5 text-start"
          onClick={() => reveal("saves")}
        >
          <Icon glyph={Save} size="lg" />
          <span>
            <strong>Saves & backups</strong>
            <small>
              {model.status?.external_runtime
                ? "Managed outside Portcove"
                : model.backupReadState?.status === "current" &&
                    model.backupReadState.hasInventory &&
                    model.backupState === "healthy"
                  ? `${model.backups.length} ${model.backups.length === 1 ? "backup" : "backups"}`
                  : "Review backup history"}
            </small>
          </span>
          <Icon glyph={ArrowUpRight} />
        </Button>
      </div>
      {model.openActivity && (
        <div className="detail-history-resource">
          <Button variant="ghost" onClick={model.openActivity}>
            <Icon glyph={FileSearch} />
            <span>Activity and history</span>
            <Icon glyph={ArrowRight} />
          </Button>
        </div>
      )}
    </>
  );
}

function DetailOverviewSection({ model }: { model: Parameters<typeof DetailBody>[0] }) {
  return (
    <section className="detail-about" aria-label="About this port">
      <h3 className="mb-3 text-base">About this port</h3>
      <p className="m-0 max-w-prose leading-relaxed text-pc-muted-foreground">
        {model.port.summary}
      </p>
    </section>
  );
}

function DetailOverviewEvidence({ model }: { model: Parameters<typeof DetailBody>[0] }) {
  return (
    <section className="detail-evidence" aria-label="Project information and checks">
      <details className="mt-6">
        <summary data-focusable>Project status and release information</summary>
        <ProjectReleaseSummary port={model.port} />
        <dl className="detail-facts">
          <ListingMaintenanceFacts listing={model.displayPort?.listing} />
        </dl>
      </details>
      <details className="mt-4">
        <summary data-focusable>Compatibility qualifications</summary>
        <CompatibilitySummary port={model.port} />
      </details>
      <details className="mt-4">
        <summary data-focusable>Recorded checks</summary>
        <DetailQualificationSummary
          port={model.port}
          sourceInspection={model.sources.sourceInspection}
          biosInspection={model.sources.biosInspection}
        />
      </details>
    </section>
  );
}

function DetailFilesSection({
  model,
  managedPreparation,
}: {
  model: Parameters<typeof DetailBody>[0];
  managedPreparation: boolean;
}) {
  return (
    <div className="detail-files-workspace">
      <div className="detail-files-stack">
        <StatusActionsGroup
          hidePlay={model.installed && model.launchReady}

          installCancellations={model.installCancellations}
          port={model.port}
          status={model.status}
          stagedVersion={undefined}
          sources={model.sources}
          installed={model.installed}
          sourceReady={model.sourceReady}
          biosReady={model.biosReady}
          launchReady={model.launchReady}
          pendingSetup={model.pendingSetup}
          runtimeUpdateAvailable={model.runtimeUpdateAvailable}
          managedPreparation={managedPreparation}
          prepare={model.prepare}
          installPlan={model.installPlan}
          busy={model.busy}
          libraryGeneration={model.libraryGeneration}
          onChanged={model.externalRuntimeChanged}
          actions={model.actions}
          openLibraryStorage={model.openLibraryStorage}
        />
        <RequirementsGroup
          key={`requirements:${model.port.id}:${model.libraryGeneration}`}
          port={model.port}
          installed={model.installed}
          status={model.status}
          sources={model.sources}
          managedPreparation={managedPreparation}
          pendingSetup={model.pendingSetup}
          busy={model.busy}
        />
        {(model.port.presentation?.manual_setup || model.port.presentation?.manual_preparation) && (
          <SetupStatement
            portId={model.port.id}
            status={model.status}
            organization={model.organization}
          />
        )}
      </div>
      <aside className="detail-file-context" aria-label="Installation and file details">
        <h3>Installation</h3>
        <p>
          {model.status?.external_runtime
            ? "External installation"
            : model.installed
              ? "Managed by Portcove"
              : "Not installed"}
        </p>
        {(model.status?.active?.path || model.status?.external_runtime?.path) && (
          <p className="wrap-anywhere select-text">
            {model.status?.active?.path ?? model.status?.external_runtime?.path}
          </p>
        )}
        {model.hasFileObservations && (
          <details className="detail-file-observations">
            <summary data-focusable>File matching details</summary>
            {model.observations}
          </details>
        )}
      </aside>
    </div>
  );
}

function DetailManageSection({
  model,
  external,
  reveal,
}: {
  model: Parameters<typeof DetailBody>[0];
  external: boolean;
  reveal: import("./DetailLayout").RevealDetailSection;
}) {
  return (
    <>
      <CurrentStateSummary
        title={
          !model.status
            ? "Installation status unavailable"
            : model.status.active || model.status.external_runtime
              ? model.status.external_runtime
                ? "External installation"
                : "Managed installation"
              : "No active installation"
        }
      >
        {model.status?.active && (
          <div className="text-sm wrap-anywhere">
            <p className="my-1 select-text">{model.status.active.path}</p>
            <p className="m-0 text-pc-muted-foreground">
              Portcove manages this installation. Saved-data coverage is shown in Saves & backups.
            </p>
          </div>
        )}
        {model.status?.external_runtime && (
          <div className="text-sm wrap-anywhere">
            <p className="my-1 select-text">{model.status.external_runtime.path}</p>
            <p className="m-0 text-pc-muted-foreground">
              You maintain this folder and its updates.
            </p>
            <Button variant="outline" onClick={() => reveal("files", "detail-game-actions")}>
              Edit external launch details
            </Button>
          </div>
        )}
      </CurrentStateSummary>
      <ManagementRow
        title="Artwork"
        targetId="detail-artwork"
        description="Choose a cover or background image for this game."
      >
        <ArtworkControls
          key={`controls:${model.port.id}:${model.libraryGeneration}`}
          port={model.port}
        />
      </ManagementRow>
      {model.extraFiles}
      {!external && (
        <ManagementRow
          title="Steam shortcut"
          description="Add, repair or remove this game’s Steam shortcut."
        >
          <span id="detail-steam" tabIndex={-1} />
          <SteamEntryControl
            key={`steam:${model.port.id}:${model.libraryGeneration}`}
            port={model.port}
            generation={model.libraryGeneration}
            installed={model.installed}
            busy={Boolean(model.busy)}
          />
        </ManagementRow>
      )}
      {!external && model.installed && (
        <MaintenanceActions
          reveal={reveal}
          port={model.port}
          libraryGeneration={model.libraryGeneration}
          status={model.status}
          verificationPrimary={Boolean(
            model.status?.readiness?.blockers.includes("invalid_installation"),
          )}
          busy={model.busy}
          actions={model.actions}
        />
      )}
      {(!external || model.port.adapter === "native-portable") && (
        <FutureSetupDisclosure
          title="Folder for a future install"
          description="Choosing an output folder does not move or install a game."
        >
          <OutputLocationControl
            gameName={gameIdentityLabel(model.port)}
            key={model.port.id + ":" + model.libraryGeneration}
            portId={model.port.id}
            generation={model.libraryGeneration}
            busy={model.outputExternalBusy}
            onChanged={model.outputLocationChanged}
            onApplying={model.outputApplying}
          />
        </FutureSetupDisclosure>
      )}
      {(!external || hasRecordedChecks(model.port, model.sources)) && (
        <TechnicalDetails
          libraryGeneration={model.libraryGeneration}
          port={model.port}
          status={model.status}
          selectedChannel={model.selectedChannel}
          sources={model.sources}
        />
      )}
      <NavigationHints />
    </>
  );
}

function DetailSavesSection({
  model,
  external,
}: {
  model: Parameters<typeof DetailBody>[0];
  external: boolean;
}) {
  return (
    <>
      <ProtectionSummary
        portId={model.port.id}
        status={model.status}
        protection={model.backupProtection}
        inventoryState={model.backupState}
        problems={model.backupProblems}
        readState={model.backupReadState}
      />
      {external && (
        <CurrentStateSummary
          title={
            <span className="inline-flex items-center gap-2">
              <Icon glyph={FolderOpen} />
              External runtime and managed backup data
            </span>
          }
        >
          <section aria-label="Saved-data coverage">
            <p>
              Portcove does not collect this external runtime directory. Data written to Portcove’s
              managed backup folder can still be backed up and restored when Core permits it.
              External profiles and custom save locations remain outside Portcove’s managed backups;
              follow the port’s instructions to copy them separately.
            </p>
            <ProjectLink href={model.port.project_url}>
              Open upstream project <Icon glyph={ArrowRight} />
            </ProjectLink>
          </section>
        </CurrentStateSummary>
      )}
      <SavesStorageGroup
        port={model.port}
        status={model.status}
        installed={model.installed}
        deferSetupChoices={model.deferSetupChoices}
        backups={model.backups}
        backupProblems={model.backupProblems}
        backupState={model.backupState}
        backupCreateAssessment={model.backupCreateAssessment}
        backupRestoreAssessment={model.backupRestoreAssessment}
        backupReadState={model.backupReadState}
        retryBackupRead={model.retryBackupRead}
        libraryGeneration={model.libraryGeneration}
        busy={model.busy}
        outputExternalBusy={model.outputExternalBusy}
        outputLocationChanged={model.outputLocationChanged}
        outputApplying={model.outputApplying}
        actions={model.actions}
      />
    </>
  );
}

function DetailVersionsSection({
  model,
  external,
}: {
  model: Parameters<typeof DetailBody>[0];
  external: boolean;
}) {
  return (
    <div className="detail-versions-workspace">
      <div className="detail-version-main">
        {model.status?.external_runtime ? (
          <CurrentStateSummary
            title={
              <span className="inline-flex items-center gap-2">
                <Icon glyph={ExternalLink} />
                Updates managed externally
              </span>
            }
          >
            <p>
              Registered version {model.status.external_runtime.version}. You or the upstream
              launcher maintain this installation.
            </p>
            <ProjectLink href={model.port.project_url}>
              Open upstream project <Icon glyph={ArrowRight} />
            </ProjectLink>
          </CurrentStateSummary>
        ) : (
          <InstallationVersionSummary
            status={model.status}
            selectedChannel={model.selectedChannel}
            action={
              !external && model.stagedVersion ? (
                <StagedActivation
                  primary
                  version={model.stagedVersion}
                  busy={model.busy}
                  activate={model.actions.activate}
                />
              ) : undefined
            }
          />
        )}
        {!external && model.port.release.provider !== "user-prepared" && (
          <UpdatesGroup
            perform={model.perform}
            port={model.port}
            status={model.status}
            installed={model.installed}
            deferSetupChoices={model.deferSetupChoices}
            selectedChannel={model.selectedChannel}
            policy={model.policy}
            libraryGeneration={model.libraryGeneration}
            busy={model.busy}
            actions={model.actions}
          />
        )}

        {!external && (
          <>
            {model.installed && (
              <ManagementRow
                title="Previous version"
                description={
                  model.status?.previous
                    ? `Retained version ${model.status.previous.version}. Review rollback availability before switching.`
                    : "No previous version is recorded."
                }
              >
                <VersionRollback
                  status={model.status}
                  busy={model.busy}
                  rollback={model.actions.rollback}
                />
              </ManagementRow>
            )}
          </>
        )}
        {!external && model.port.release.provider === "user-prepared" && (
          <p className="mt-4">
            You or the upstream launcher manage updates for this installation.{" "}
            <ProjectLink href={model.port.project_url}>Open upstream project</ProjectLink>
          </p>
        )}
      </div>
      {!external && model.installed && model.organization && (
        <aside className="detail-version-options" aria-label="Update notice preferences">
          <UpdateNoticePreferences
            portId={model.port.id}
            status={model.status}
            organization={model.organization}
          />
        </aside>
      )}
    </div>
  );
}

function ManagedPreparationAction({
  gameActions,
  nextStep,
  model,
}: Pick<
  {
    model: Omit<ReturnType<typeof useStatusActionsGroup>, "gameActions" | "nextStep">;
    gameActions: ReturnType<typeof useStatusActionsGroup>["gameActions"];
    nextStep: ReturnType<typeof useStatusActionsGroup>["nextStep"];
  },
  "gameActions" | "nextStep" | "model"
>) {
  return (
    model.managedPreparation &&
    model.pendingSetup &&
    model.sources.sourceReady &&
    model.sources.biosReady && (
      <>
        <PreparationControl
          key={`${model.port.id}:${model.libraryGeneration}:${model.status?.active?.id}`}
          portId={model.port.id}
          taskLabel={`${gameTitle(model.port)}${gameProjectLabel(model.port) ? ` · Port: ${gameProjectLabel(model.port)}` : ""}`}
          generation={model.libraryGeneration}
          disabled={Boolean(model.busy) || !model.sources.sourceReady || !model.sources.biosReady}
          run={model.prepare}
          onPrepared={model.preparedFocus}
          focusFallback={() =>
            gameActions.current?.querySelector<HTMLElement>(
              "[data-confirmed-play]:not(:disabled)",
            ) ?? nextStep.current
          }
        />
      </>
    )
  );
}

function ManualSetupActions({
  model,
  manualSetup,
}: Pick<
  {
    model: Omit<ReturnType<typeof useStatusActionsGroup>, "gameActions" | "nextStep">;
    manualSetup: boolean;
  },
  "model" | "manualSetup"
>) {
  return (
    manualSetup && (
      <div className="grid gap-3">
        <p>Finish the game-file setup in the installed folder. Return here when it completes.</p>
        <div className="primary-actions flex flex-wrap gap-2">
          <Button
            data-focusable
            variant="primary"
            disabled={Boolean(model.busy) || !model.actions.openSetupFolder}
            onClick={() => void model.actions.openSetupFolder?.()}
          >
            Finish setup
          </Button>
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(model.busy) || !model.onChanged}
            onClick={() => model.onChanged?.()}
          >
            Check setup again
          </Button>
        </div>
        <AuthoredPreparationGuidance port={model.port} ownership="managed" />
      </div>
    )
  );
}

function DetailHeaderAction({
  model,
  busy,
}: Pick<{ model: Parameters<typeof DetailBody>[0]; busy: string | undefined }, "model" | "busy">) {
  return (
    <InstalledPlayActions
      hero
      compact
      trial={
        hasUnconfirmedLaunchInput(model.status, model.port) ||
        Boolean(
          selectedSourceRequirement(
            model.sources.source,
            model.sources.sourcePath,
            model.sources.bios,
            model.sources.biosPath,
          ),
        )
      }
      preparationRequired={false}
      launchReady={model.launchReady}
      pendingSetup={model.pendingSetup}
      stagedVersion={undefined}
      busy={busy}
      actions={model.actions}
    />
  );
}

function requirementsPresentation(
  port: PortDefinition,
  installed: boolean,
  sources: SourceControls,
  managedPreparation: boolean,
  pendingSetup: boolean,
) {
  const needsAttention =
    !installed ||
    !sources.sourceReady ||
    !sources.biosReady ||
    (managedPreparation && pendingSetup);
  const authoredSetup =
    Boolean(port.presentation?.manual_setup || port.presentation?.manual_preparation) &&
    (port.adapter === "native-portable" || (!port.source_profile && !port.bios_source_profile));
  if (installed && port.adapter === "native-portable" && pendingSetup)
    return { needsAttention, authoredSetup, hidden: true };
  if (!port.source_profile && !port.bios_source_profile && !managedPreparation && !authoredSetup)
    return { needsAttention, authoredSetup, hidden: true };
  return { needsAttention, authoredSetup, hidden: false };
}

function detailInstallationLabel(status: PortStatus | undefined, directInstall: boolean) {
  return status?.external_runtime
    ? "Registered external installation"
    : status?.active
      ? "Managed installation · " + status.active.version
      : directInstall
        ? "Portcove installs and updates this game. Complete upstream setup on first launch if prompted."
        : "Not installed";
}
