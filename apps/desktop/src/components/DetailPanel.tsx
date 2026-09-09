import { RemovalControl, type ApplyRemoval } from "./RemovalReview";
import type { ApplyBackupAction } from "./BackupReview";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { useState } from "react";
import { AlertTriangle, ArchiveX, CheckCircle2, ChevronDown, Clipboard, ClipboardCheck, Download, ExternalLink, FileArchive, FileSearch, FolderOpen, Gamepad2, HardDrive, RefreshCw, RotateCcw, Save, ShieldCheck, Wrench, X } from "lucide-react";
import { primaryCliCommand } from "../cli-command";
import { copyText } from "../clipboard";
import { useDialogFocus } from "../dialog";
import type { ActivityRecord, BackupInventory, BackupProblem, BackupRecord, InstallPlan, PortDefinition, PortStatus, ReleaseChannel, SourceHealth, SourceInspectionReport, SourceProfile, SourceRecord, UpdatePolicy } from "../types";
import { OperationCancellation } from "./OperationCancellation";
import { OutputLocationControl } from "./OutputLocation";
import { PreparationControl, type RunPreparation } from "./Preparation";
import { formatBytes, platformLabels } from "../view-model";
import { BackupHistory } from "./BackupHistory";
import { GameUpdateControl, UpdatePolicyControl } from "./GameUpdates";
import type { Perform } from "../use-portcove";
import { ExternalLink as ProjectLink } from "./ExternalLink";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { SourceIdentityPanel } from "./SourceIdentity";

export interface DetailActions {
  activate: () => void;
  backup: () => void;
  check: () => Promise<unknown>;
  close: () => void;
  deleteBackup: ApplyBackupAction;
  install: () => void;
  launch: () => void;
  openUserData: () => void;
  reviewInstall: () => void;
  restoreBackup: ApplyBackupAction;
  rollback: () => void;
  remove: ApplyRemoval;
  setChannel: (channel: ReleaseChannel) => Promise<PortStatus | undefined>;
  setPolicy: (policy: UpdatePolicy) => Promise<PortStatus | undefined>;
  verify: () => void;
}

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

function DetailDialog({ props, dialog }: { props: DetailPanelProps; dialog: ReturnType<typeof useDialogFocus> }) {
  const { port, status, installPlan, backups = [], backupProblems = [], backupState = "healthy", source, sourceInspection, sourceProfile, sourcePath, setSourcePath, pickSource, pickSourceArchive, bios, biosInspection, biosProfile, biosPath, setBiosPath, pickBios, busy, actions } = props;
  const [outputApplying, setOutputApplying] = useState(false);
  const effectiveBusy = busy ?? (outputApplying ? "storage location" : undefined);
  const selectedChannel = status?.channel ?? port.channels[0];
  const policy = status?.update_policy ?? "notify";
  const { sourceReady, biosReady, launchReady, installed, pendingSetup } = detailReadiness(port, status, source, sourcePath, bios, biosPath);
  const state = detailState(installed, launchReady, Boolean(status?.staged), pendingSetup, Boolean(status?.readiness?.blockers.includes("missing_runtime")), status?.readiness?.source, status?.readiness?.bios, Boolean(sourcePath.trim() || biosPath?.trim()));
  const sources: SourceControls = {
    port, source, sourceInspection, sourceProfile, sourcePath, setSourcePath, pickSource, pickSourceArchive,
    bios, biosInspection, biosProfile, biosPath, setBiosPath, pickBios, sourceReady, biosReady, openSourceEvidence: props.openSourceEvidence, inspectSource: props.inspectSource,
    sourceHealth: status?.readiness?.source, biosHealth: status?.readiness?.bios,
  };
  return <div className="scrim" onMouseDown={event => closeFromScrim(event, actions.close)}>
    <section ref={dialog} className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="port-detail-title">
      <button data-focusable className="close icon-button" aria-label="Close port details" onClick={actions.close}><Icon glyph={X} /></button>
      <DetailHero port={port} state={state} />
      {props.cancellableActivities?.map(activity => <OperationCancellation key={activity.id} operationId={activity.id} state={activity.cancellation ?? undefined} />)}
      <DetailBody perform={props.perform} prepare={props.prepare} port={port} status={status} state={state} sources={sources} installed={installed} launchReady={launchReady} pendingSetup={pendingSetup} installPlan={installPlan} selectedChannel={selectedChannel} policy={policy} backups={backups} backupProblems={backupProblems} backupState={backupState} busy={effectiveBusy} outputExternalBusy={busy} libraryGeneration={props.libraryGeneration ?? 0} outputLocationChanged={props.outputLocationChanged} outputApplying={setOutputApplying} actions={actions} />
    </section>
  </div>;
}

type DetailState = ReturnType<typeof detailState>;

function DetailHero({ port, state }: { port: PortDefinition; state: DetailState }) {
  return <div className={`detail-hero art-${port.support_tier}`}><span>{port.name.slice(0, 2).toUpperCase()}</span><div><p className="eyebrow">{port.platforms.map(platform => platformLabels[platform]).join(" · ")}</p><h2 id="port-detail-title">{port.name}</h2><span className={`hero-state ${state.tone}`}>{state.title}</span></div></div>;
}

function DetailBody({ perform, prepare, port, status, state, sources, installed, launchReady, pendingSetup, installPlan, selectedChannel, policy, backups, backupProblems, backupState, busy, outputExternalBusy, libraryGeneration, outputLocationChanged, outputApplying, actions }: {
  perform?: Perform; prepare?: RunPreparation; port: PortDefinition; status?: PortStatus; state: DetailState; sources: SourceControls; installed: boolean; launchReady: boolean; pendingSetup: boolean;
  installPlan?: InstallPlan; selectedChannel: ReleaseChannel; policy: UpdatePolicy; backups: BackupRecord[]; backupProblems: BackupProblem[]; backupState: BackupInventory["state"]; busy?: string; outputExternalBusy?: string; libraryGeneration: number; outputLocationChanged?: () => void; outputApplying: (applying: boolean) => void; actions: DetailActions;
}) {
  const managedPreparation = Boolean(installed && port.adapter === "upstream-managed-setup" && port.setup_output_paths.length);
  return <div className="detail-body"><p className="summary">{port.summary}</p>
    <NavigationHints />
    <RetiredNotice port={port} />
    <ReadinessCard state={state} />
    <SourceFields mode="missing" controls={sources} />
    <SourceIntakeActions controls={sources} busy={Boolean(busy)} />
    {managedPreparation && pendingSetup && <PreparationControl key={`${port.id}:${libraryGeneration}:${status?.active?.id}`} portId={port.id} generation={libraryGeneration} disabled={Boolean(busy) || !sources.sourceReady || !sources.biosReady} run={prepare} />}
    <PrimaryActions preparationRequired={managedPreparation && pendingSetup} runtimeNeeded={Boolean(status?.readiness?.blockers.includes("missing_runtime"))} installed={installed} launchReady={launchReady} pendingSetup={pendingSetup} plan={installPlan} busy={busy} actions={actions} />
    {status?.staged && <section aria-label="Activate staged update"><p>Staged update: <strong>{status.staged.version}</strong>. Activation uses this verified local copy without downloading and keeps the current version for rollback.</p><button data-focusable disabled={Boolean(busy)} onClick={actions.activate}>Activate staged update · {status.staged.version}</button></section>}
    {installed && <GameUpdateControl key={`${port.id}:${libraryGeneration}:${status?.active?.id}:${status?.staged?.id}:${selectedChannel}:${policy}`} portId={port.id} generation={libraryGeneration} policy={policy} busy={Boolean(busy)} perform={perform} />}
    <TrustStrip status={status} />
    <OutputLocationControl portId={port.id} generation={libraryGeneration} busy={outputExternalBusy} onChanged={outputLocationChanged} onApplying={outputApplying} />
    <AdvancedControls libraryGeneration={libraryGeneration} port={port} status={status} selectedChannel={selectedChannel} policy={policy} installed={installed} backups={backups} backupProblems={backupProblems} backupState={backupState} busy={busy} sources={sources} actions={actions} />
  </div>;
}

function ReadinessCard({ state }: { state: DetailState }) {
  return <div className={`readiness-card ${state.tone}`}><span><Icon glyph={state.icon} /></span><div><strong>{state.title}</strong><p>{state.description}</p></div></div>;
}

function TrustStrip({ status }: { status?: PortStatus }) {
  return <div className="trust-strip"><span><Icon glyph={HardDrive} size="sm" />Game files stay local</span>{status?.previous && <span><Icon glyph={RotateCcw} size="sm" />Previous version recorded · {status.previous.version}</span>}</div>;
}

function detailReadiness(port: PortDefinition, status: PortStatus | undefined, source: SourceRecord | undefined, sourcePath: string, bios: SourceRecord | undefined, biosPath: string | undefined) {
  const installed = Boolean(status?.active);
  const sourceReady = sourceRequirementReady(Boolean(port.source_profile), installed, status?.readiness?.source, Boolean(source || sourcePath.trim()));
  const biosReady = sourceRequirementReady(Boolean(port.bios_source_profile), installed, status?.readiness?.bios, Boolean(bios || biosPath?.trim()));
  const fallbackLaunchable = sourceReady && biosReady && !status?.readiness?.blockers.includes("missing_runtime");
  return {
    sourceReady,
    biosReady,
    launchReady: installed ? (status?.readiness?.launchable ?? fallbackLaunchable) : fallbackLaunchable,
    installed,
    pendingSetup: Boolean(status?.readiness?.pending_setup),
  };
}

function sourceRequirementReady(required: boolean, installed: boolean, health: SourceHealth | null | undefined, selected: boolean) {
  if (!required) return true;
  if (!installed || health == null) return selected;
  return health === "current";
}

type SourceControls = Pick<DetailPanelProps,
  "port" | "source" | "sourceInspection" | "sourceProfile" | "sourcePath" | "setSourcePath" | "pickSource" | "pickSourceArchive"
  | "bios" | "biosInspection" | "biosProfile" | "biosPath" | "setBiosPath" | "pickBios" | "openSourceEvidence" | "inspectSource"
> & {
  sourceReady: boolean;
  biosReady: boolean;
  sourceHealth?: SourceHealth | null;
  biosHealth?: SourceHealth | null;
};

function SourceFields({ mode, controls }: { mode: "missing" | "registered"; controls: SourceControls }) {
  return <>{originalSourceField(mode, controls)}{biosSourceField(mode, controls)}</>;
}

function SourceIntakeActions({ controls, busy }: { controls: SourceControls; busy: boolean }) {
  if (!controls.inspectSource || (!controls.sourceProfile && !controls.biosProfile)) return null;
  return <div className="source-intake-shortcuts" aria-label="Check game files">
    {controls.sourceProfile && <button data-focusable className="button-with-icon" type="button" disabled={busy} onClick={() => controls.inspectSource?.(controls.sourceProfile!)}><Icon glyph={FileSearch} />Check original game files</button>}
    {controls.biosProfile && <button data-focusable className="button-with-icon" type="button" disabled={busy} onClick={() => controls.inspectSource?.(controls.biosProfile!)}><Icon glyph={FileSearch} />Check required BIOS</button>}
  </div>;
}

function originalSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.source_profile;
  if (!profileId || controls.sourceReady !== (mode === "registered")) return null;
  return <SourceField heading="Original source" profileId={profileId} profile={controls.sourceProfile} source={controls.source} inspection={controls.sourceInspection} health={controls.sourceHealth} path={controls.sourcePath} setPath={controls.setSourcePath} pick={controls.pickSource} pickArchive={controls.pickSourceArchive} openEvidence={controls.openSourceEvidence} />;
}

function biosSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.bios_source_profile;
  if (!profileId || !controls.biosProfile || !controls.setBiosPath || controls.biosReady !== (mode === "registered")) return null;
  return <SourceField heading="Required BIOS" profileId={profileId} profile={controls.biosProfile} source={controls.bios} inspection={controls.biosInspection} health={controls.biosHealth} path={controls.biosPath ?? ""} setPath={controls.setBiosPath} pick={controls.pickBios} openEvidence={controls.openSourceEvidence} />;
}

function RetiredNotice({ port }: { port: PortDefinition }) {
  if (port.upstream_status !== "retired") return null;
  return <p className="retired-notice"><Icon glyph={ArchiveX} /> <span><strong>Retired upstream</strong>This pinned release receives no upstream fixes or support.</span></p>;
}

function closeFromScrim(event: React.MouseEvent<HTMLDivElement>, close: () => void) {
  if (event.currentTarget === event.target) close();
}

function AdvancedControls({ libraryGeneration, port, status, selectedChannel, policy, installed, backups, backupProblems, backupState, busy, sources, actions }: {
  libraryGeneration: number; port: PortDefinition; status?: PortStatus; selectedChannel: ReleaseChannel; policy: UpdatePolicy; installed: boolean; backups: BackupRecord[]; backupProblems: BackupProblem[]; backupState: BackupInventory["state"]; busy?: string; sources: SourceControls; actions: DetailActions;
}) {
  const persistentFiles = [...port.persistent_paths, ...(port.persistent_file_patterns ?? []).map(pattern => `${pattern.prefix}*${pattern.suffix}`)].join(" · ");
  return <details className="advanced-settings">
    <summary data-focusable className="advanced-summary">Release, sources &amp; maintenance <span className="advanced-summary-meta">Advanced controls</span><Icon glyph={ChevronDown} /></summary>
    <div className="advanced-body">
      <div className="detail-section"><ReleaseChannelControl key={`${port.id}:${libraryGeneration}`} channels={port.channels} selected={selectedChannel} busy={Boolean(busy)} change={actions.setChannel} refresh={actions.check} /></div>
      <div className="detail-section"><UpdatePolicyControl key={port.id} policy={policy} busy={Boolean(busy)} save={actions.setPolicy} /></div>
      <SourceFields mode="registered" controls={sources} />
      <div className="metadata"><span><small>Platforms</small>{port.platforms.map(value => platformLabels[value]).join(" · ")}</span><span><small>Installation method</small>{adapterPresentation[port.adapter]}</span><span><small>Automated evidence</small>{port.automated_tested_platforms.length ? port.automated_tested_platforms.map(value => platformLabels[value]).join(" · ") : "Qualification pending"}</span><span><small>Physical validation</small>{port.manually_validated_platforms.length ? port.manually_validated_platforms.map(value => platformLabels[value]).join(" · ") : "Deferred / not completed"}</span><span title={persistentFiles}><small>Persistent data root</small>{status?.user_data_root ?? "Created inside the selected library"}</span></div>
      <div className="upstream-link"><ProjectLink href={port.project_url}>Open upstream project <Icon glyph={ExternalLink} size="sm" /></ProjectLink><span>Portcove resolves releases from this reviewed upstream.</span></div>
      <CliContinuity port={port} status={status} channel={selectedChannel} sourcePath={sources.sourcePath} biosPath={sources.biosPath} />
      {(installed || backups.length > 0 || backupProblems.length > 0) && <BackupHistory key={`${port.id}:${libraryGeneration}`} generation={libraryGeneration} backups={backups} problems={backupProblems} state={backupState} busy={busy} restore={actions.restoreBackup} remove={actions.deleteBackup} />}
      {installed && <MaintenanceActions port={port} libraryGeneration={libraryGeneration} canRollback={Boolean(status?.previous)} busy={busy} actions={actions} />}
    </div>
  </details>;
}

const adapterPresentation: Record<PortDefinition["adapter"], string> = {
  "libultraship-portable": "Portable upstream package",
  "n64-recomp-portable": "Portable N64 recompilation",
  "staged-source-portable": "Prepared source beside the game",
  "referenced-disc": "Original disc referenced at launch",
  "generated-cache": "Generated game data",
  "upstream-managed-setup": "Upstream setup process",
  "psx-recomp-managed": "Managed PS1 recompilation",
};

function SourceField({ heading, profileId, profile, source, inspection, health, path, setPath, pick, pickArchive, openEvidence }: { heading: string; profileId: string; profile?: SourceProfile; source?: SourceRecord; inspection?: SourceInspectionReport; health?: SourceHealth | null; path: string; setPath: (path: string) => void; pick?: () => void; pickArchive?: () => void; openEvidence?: (evidenceId: string) => void }) {
  const copy = sourceFieldCopy(profile);
  const selectedOverride = Boolean(path.trim()) && (!source || path !== source.path);
  const sourceNote = selectedOverride ? "Selected path has not been checked. Portcove validates these files when you continue." : source ? sourceHealthNote(inspection?.health ?? health, source) : copy.note;
  const inputId = `source-${profileId}`;
  return <div className="detail-section"><label htmlFor={inputId}>{heading} · {profile?.label ?? profileId}</label>
    <div className="path-entry"><input data-focusable id={inputId} value={path} onChange={event => setPath(event.target.value)} placeholder={copy.placeholder} />
      {pick && <button data-focusable className="button-with-icon" type="button" onClick={pick}><Icon glyph={FolderOpen} />Browse</button>}
      {pickArchive && <button data-focusable className="button-with-icon" type="button" onClick={pickArchive}><Icon glyph={FileArchive} />ZIP</button>}</div>
    <small>{sourceNote}</small>
    {selectedOverride && source && health && health !== "current" && <small>{sourceHealthNote(health, source)}</small>}
    {!selectedOverride && inspection && <SourceIdentityPanel report={inspection} openEvidence={openEvidence} />}
  </div>;
}

function sourceHealthNote(health: SourceHealth | null | undefined, source: SourceRecord) {
  const hash = `${source.sha256.slice(0, 12)}…`;
  if (health === "current") return `Current registered bytes checked · ${hash}`;
  if (health === "changed") return "Registered source changed since it was added.";
  if (health === "missing") return "Registered source file is missing.";
  if (health === "unreadable") return "Registered source cannot be read.";
  if (health === "not_checked") return `Registered · current bytes not checked · ${hash}`;
  if (health === "not_baselined") return "Selected game files have no saved identity baseline.";
  return `Registered · ${hash}`;
}

function sourceFieldCopy(profile?: SourceProfile) {
  if (profile?.kind === "file-set") return {
    placeholder: "Choose or paste the folder or ZIP containing the required sources",
    note: "Select one exact source folder or ZIP; never uploaded.",
  };
  if (profile?.kind === "psx-disc" && (profile.disc?.discs?.length ?? 0) > 1) return {
    placeholder: "Choose or paste the folder containing the required sources",
    note: "Select one folder containing exactly the required source set; never uploaded.",
  };
  return { placeholder: "Choose or paste the full source file path", note: "Referenced in place; never uploaded." };
}

function PrimaryActions({ preparationRequired, runtimeNeeded, installed, launchReady, pendingSetup, plan, busy, actions }: { preparationRequired: boolean; runtimeNeeded: boolean; installed: boolean; launchReady: boolean; pendingSetup: boolean; plan?: InstallPlan; busy?: string; actions: DetailActions }) {
  if (runtimeNeeded) return <p>Review the game update below to install the required runtime.</p>;
  if (!installed) return <InstallAction ready={launchReady} plan={plan} busy={busy} install={actions.install} review={actions.reviewInstall} />;
  return <div className="actions primary-actions">
    <button data-focusable className="primary wide button-with-icon" title={preparationRequired ? "Prepare game data before playing" : launchReady ? "Launch this port" : "Register every required source before launching"} disabled={preparationRequired || !launchReady || Boolean(busy)} onClick={actions.launch}><Icon glyph={!launchReady ? AlertTriangle : pendingSetup ? Wrench : Gamepad2} />{preparationRequired ? "Prepare game data first" : !launchReady ? "Choose required source" : pendingSetup ? "Complete setup and play" : "Play now"}</button>
  </div>;
}

function InstallAction({ ready, plan, busy, install, review }: { ready: boolean; plan?: InstallPlan; busy?: string; install: () => void; review: () => void }) {
  if (!ready) return <div className="actions primary-actions"><button data-focusable className="primary wide button-with-icon" title="Choose every required source before installing" disabled><Icon glyph={AlertTriangle} />Choose required source</button></div>;
  if (!plan) return <div className="actions primary-actions"><button data-focusable className="primary wide button-with-icon" disabled={Boolean(busy)} onClick={review}><Icon glyph={ShieldCheck} />{busy === "review install" ? "Checking release…" : "Review install"}</button></div>;
  return <><InstallPlanSummary plan={plan} /><PlannedInstallButton plan={plan} busy={busy} install={install} /></>;
}

function InstallPlanSummary({ plan }: { plan: InstallPlan }) {
  const download = plan.action === "download";
  return <div className="install-plan">
    <div><p className="eyebrow">INSTALL PLAN</p><strong>{plan.release.version}</strong><span>{plan.channel} · {installPlanActionLabel(plan.action)}</span>{plan.bundled_runtime && <span>Includes verified runtime · {formatBytes(plan.bundled_runtime.asset.size)}</span>}</div>
    <div><strong>{download ? formatBytes(plan.download_bytes) : "No download"}</strong><span>{download ? `${formatBytes(plan.storage.volume_available_bytes)} available` : "Verified local release"}</span></div>
  </div>;
}

function PlannedInstallButton({ plan, busy, install }: { plan: InstallPlan; busy?: string; install: () => void }) {
  const blocked = plan.action === "blocked_unverified";
  const insufficientSpace = plan.action === "download" && plan.download_bytes > plan.storage.volume_available_bytes;
  let label = plan.action === "download" ? `Install · ${formatBytes(plan.download_bytes)}` : "Use verified release";
  if (blocked) label = "Unverified copy blocks install";
  else if (insufficientSpace) label = "Free space required";
  else if (busy === "install") label = "Installing…";
  return <div className="actions primary-actions"><button data-focusable className="primary wide button-with-icon" disabled={blocked || insufficientSpace || Boolean(busy)} onClick={install}><Icon glyph={Download} />{label}</button></div>;
}

function installPlanActionLabel(action: InstallPlan["action"]) {
  const labels: Record<InstallPlan["action"], string> = {
    already_active: "Already active",
    use_staged: "Use staged release",
    reuse_retained: "Reuse retained release",
    blocked_unverified: "Unverified local copy",
    download: "Download verified release",
  };
  return labels[action];
}

function MaintenanceActions({ port, libraryGeneration, canRollback, busy, actions }: { port: PortDefinition; libraryGeneration: number; canRollback: boolean; busy?: string; actions: DetailActions }) {
  return <div className="actions maintenance-actions">
    <button data-focusable className="button-with-icon" title="Create a versioned snapshot of persistent data" disabled={Boolean(busy)} onClick={actions.backup}><Icon glyph={Save} />Back up data</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.openUserData}><Icon glyph={FolderOpen} />Open data folder</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.check}><Icon glyph={RefreshCw} />Check update</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.verify}><Icon glyph={ShieldCheck} />Verify</button>
    <button data-focusable className="button-with-icon" disabled={!canRollback || Boolean(busy)} onClick={actions.rollback}><Icon glyph={RotateCcw} />Rollback</button>
    <RemovalControl key={`${port.id}:${libraryGeneration}`} port={port} generation={libraryGeneration} busy={Boolean(busy)} apply={actions.remove} />
  </div>;
}

function CliContinuity({ port, status, channel, sourcePath, biosPath }: { port: PortDefinition; status?: PortStatus; channel: ReleaseChannel; sourcePath: string; biosPath?: string }) {
  const [copied, setCopied] = useState(false);
  const command = primaryCliCommand(port, status, channel, sourcePath, biosPath ?? "");
  const label = status?.active ? "Launch command" : "Install command";
  return <div className="cli-continuity">
    <div><label>{label}</label><span>The desktop and CLI use the same catalog and local state.</span></div>
    <div className="command-line"><code>{command}</code><button data-focusable className="icon-button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void copyText(command).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setCopied(false)); }}><Icon glyph={copied ? ClipboardCheck : Clipboard} /></button></div>
    <small><Shortcut>portcove</Shortcut> can also be called by Playnite, LaunchBox, RetroBat, EmuDeck, Batocera, and other frontends.</small>
  </div>;
}

function detailState(installed: boolean, launchReady: boolean, staged: boolean, pendingSetup: boolean, runtimeNeeded: boolean, sourceHealth?: SourceHealth | null, biosHealth?: SourceHealth | null, selectedPath = false) {
  if (!installed) return { title: "Available to install", description: selectedPath ? "Selected game files have not been checked. Portcove validates them when you continue installation." : "Portcove will check required game files and verify the release before it becomes active.", tone: "available", icon: Download };
  if (runtimeNeeded) return { title: "Verified runtime required", description: "Review the update to install this port with its required runtime. Existing saves stay in your library.", tone: "setup", icon: Wrench };
  const sourceIssue = sourceHealthState("Original source", sourceHealth);
  if (sourceIssue) return sourceIssue;
  const biosIssue = sourceHealthState("Required BIOS", biosHealth);
  if (biosIssue) return biosIssue;
  if (pendingSetup && !launchReady && sourceHealth !== "unregistered" && biosHealth !== "unregistered") return { title: "Prepare game data", description: "Review the default setup below. Play becomes available after preparation succeeds.", tone: "setup", icon: Wrench };
  if (!launchReady) return { title: "Finish setup", description: "Register the required original source or BIOS to unlock Play.", tone: "setup", icon: Wrench };
  if (selectedPath) return { title: "Game files need checking", description: "The selected path has not been checked. Portcove validates it before starting the game.", tone: "setup", icon: Wrench };
  if (pendingSetup) return { title: "First launch setup", description: "The source is registered. Portcove will run and verify the upstream setup before play.", tone: "setup", icon: Wrench };
  if (staged) return { title: "Ready · update staged", description: "Play the current version or activate the verified staged release.", tone: "staged", icon: RefreshCw };
  return { title: "Ready to launch", description: "The active version and every required local source are available.", tone: "ready", icon: CheckCircle2 };
}

function sourceHealthState(label: string, health?: SourceHealth | null) {
  if (health === "changed") return { title: `${label} changed`, description: `Choose and register ${label.toLowerCase()} again before play.`, tone: "setup", icon: AlertTriangle };
  if (health === "missing") return { title: `${label} missing`, description: `Choose and register ${label.toLowerCase()} again before play.`, tone: "setup", icon: AlertTriangle };
  if (health === "unreadable") return { title: `${label} unreadable`, description: `Restore access to ${label.toLowerCase()} or register it again before play.`, tone: "setup", icon: AlertTriangle };
  return undefined;
}
