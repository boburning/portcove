import { useState } from "react";
import { AlertTriangle, ArchiveX, CheckCircle2, ChevronDown, Clipboard, ClipboardCheck, Download, ExternalLink, FileArchive, FolderOpen, Gamepad2, HardDrive, PackageCheck, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { primaryCliCommand } from "../cli-command";
import { copyText } from "../clipboard";
import { useDialogFocus } from "../dialog";
import type { ActivityRecord, BackupInventory, BackupProblem, BackupRecord, InstallPlan, PortDefinition, PortStatus, ReleaseChannel, SourceHealth, SourceProfile, SourceRecord, UpdatePolicy } from "../types";
import { OperationCancellation } from "./OperationCancellation";
import { formatBytes, platformLabels } from "../view-model";
import { BackupHistory } from "./BackupHistory";
import { ChoiceMenu } from "./ChoiceMenu";
import { ExternalLink as ProjectLink } from "./ExternalLink";
import { Icon, NavigationHints, Shortcut } from "./ui";

export interface DetailActions {
  activate: () => void;
  backup: () => void;
  check: () => void;
  close: () => void;
  deleteBackup: (backup: BackupRecord) => void;
  install: () => void;
  launch: () => void;
  openUserData: () => void;
  reviewInstall: () => void;
  restoreBackup: (backup: BackupRecord) => void;
  rollback: () => void;
  remove: () => Promise<void>;
  setChannel: (channel: ReleaseChannel) => void;
  setPolicy: (policy: UpdatePolicy) => void;
  update: () => void;
  verify: () => void;
}

interface DetailPanelProps {
  cancellableActivities?: ActivityRecord[];
  port: PortDefinition;
  status?: PortStatus;
  installPlan?: InstallPlan;
  backups?: BackupRecord[];
  backupProblems?: BackupProblem[];
  backupState?: BackupInventory["state"];
  source?: SourceRecord;
  sourceProfile?: SourceProfile;
  sourcePath: string;
  setSourcePath: (path: string) => void;
  pickSource?: () => void;
  pickSourceArchive?: () => void;
  bios?: SourceRecord;
  biosProfile?: SourceProfile;
  biosPath?: string;
  setBiosPath?: (path: string) => void;
  pickBios?: () => void;
  busy?: string;
  actions: DetailActions;
}

export function DetailPanel(props: DetailPanelProps) {
  const dialog = useDialogFocus(props.actions.close);
  return <DetailDialog props={props} dialog={dialog} />;
}

function DetailDialog({ props, dialog }: { props: DetailPanelProps; dialog: ReturnType<typeof useDialogFocus> }) {
  const { port, status, installPlan, backups = [], backupProblems = [], backupState = "healthy", source, sourceProfile, sourcePath, setSourcePath, pickSource, pickSourceArchive, bios, biosProfile, biosPath, setBiosPath, pickBios, busy, actions } = props;
  const selectedChannel = status?.channel ?? port.channels[0];
  const policy = status?.update_policy ?? "notify";
  const { sourceReady, biosReady, launchReady, installed, pendingSetup } = detailReadiness(port, status, source, sourcePath, bios, biosPath);
  const state = detailState(installed, launchReady, Boolean(status?.staged), pendingSetup, Boolean(status?.readiness?.blockers.includes("missing_runtime")), status?.readiness?.source, status?.readiness?.bios);
  const sources: SourceControls = {
    port, source, sourceProfile, sourcePath, setSourcePath, pickSource, pickSourceArchive,
    bios, biosProfile, biosPath, setBiosPath, pickBios, sourceReady, biosReady,
    sourceHealth: status?.readiness?.source, biosHealth: status?.readiness?.bios,
  };
  return <div className="scrim" onMouseDown={event => closeFromScrim(event, actions.close)}>
    <section ref={dialog} className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="port-detail-title">
      <button data-focusable className="close icon-button" aria-label="Close port details" onClick={actions.close}><Icon glyph={X} /></button>
      <DetailHero port={port} state={state} />
      {props.cancellableActivities?.map(activity => <OperationCancellation key={activity.id} operationId={activity.id} state={activity.cancellation} />)}
      <DetailBody port={port} status={status} state={state} sources={sources} installed={installed} launchReady={launchReady} pendingSetup={pendingSetup} installPlan={installPlan} selectedChannel={selectedChannel} policy={policy} backups={backups} backupProblems={backupProblems} backupState={backupState} busy={busy} actions={actions} />
    </section>
  </div>;
}

type DetailState = ReturnType<typeof detailState>;

function DetailHero({ port, state }: { port: PortDefinition; state: DetailState }) {
  return <div className={`detail-hero art-${port.support_tier}`}><span>{port.name.slice(0, 2).toUpperCase()}</span><div><p className="eyebrow">{port.adapter.replaceAll("-", " ")}</p><h2 id="port-detail-title">{port.name}</h2><span className={`hero-state ${state.tone}`}>{state.title}</span></div></div>;
}

function DetailBody({ port, status, state, sources, installed, launchReady, pendingSetup, installPlan, selectedChannel, policy, backups, backupProblems, backupState, busy, actions }: {
  port: PortDefinition; status?: PortStatus; state: DetailState; sources: SourceControls; installed: boolean; launchReady: boolean; pendingSetup: boolean;
  installPlan?: InstallPlan; selectedChannel: ReleaseChannel; policy: UpdatePolicy; backups: BackupRecord[]; backupProblems: BackupProblem[]; backupState: BackupInventory["state"]; busy?: string; actions: DetailActions;
}) {
  return <div className="detail-body"><p className="summary">{port.summary}</p>
    <NavigationHints />
    <RetiredNotice port={port} />
    <ReadinessCard state={state} />
    <SourceFields mode="missing" controls={sources} />
    <PrimaryActions runtimeNeeded={Boolean(status?.readiness?.blockers.includes("missing_runtime"))} installed={installed} launchReady={launchReady} pendingSetup={pendingSetup} hasStaged={Boolean(status?.staged)} plan={installPlan} busy={busy} actions={actions} />
    <TrustStrip />
    <AdvancedControls port={port} status={status} selectedChannel={selectedChannel} policy={policy} installed={installed} backups={backups} backupProblems={backupProblems} backupState={backupState} busy={busy} sources={sources} actions={actions} />
  </div>;
}

function ReadinessCard({ state }: { state: DetailState }) {
  return <div className={`readiness-card ${state.tone}`}><span><Icon glyph={state.icon} /></span><div><strong>{state.title}</strong><p>{state.description}</p></div></div>;
}

function TrustStrip() {
  return <div className="trust-strip"><span><Icon glyph={ShieldCheck} size="sm" />Verified releases</span><span><Icon glyph={HardDrive} size="sm" />Sources stay local</span><span><Icon glyph={RotateCcw} size="sm" />Rollback retained</span></div>;
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

function sourceRequirementReady(required: boolean, installed: boolean, health: SourceHealth | undefined, selected: boolean) {
  if (!required) return true;
  if (!installed || health === undefined) return selected;
  return health === "current";
}

type SourceControls = Pick<DetailPanelProps,
  "port" | "source" | "sourceProfile" | "sourcePath" | "setSourcePath" | "pickSource" | "pickSourceArchive"
  | "bios" | "biosProfile" | "biosPath" | "setBiosPath" | "pickBios"
> & {
  sourceReady: boolean;
  biosReady: boolean;
  sourceHealth?: SourceHealth;
  biosHealth?: SourceHealth;
};

function SourceFields({ mode, controls }: { mode: "missing" | "registered"; controls: SourceControls }) {
  return <>{originalSourceField(mode, controls)}{biosSourceField(mode, controls)}</>;
}

function originalSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.source_profile;
  if (!profileId || controls.sourceReady !== (mode === "registered")) return null;
  return <SourceField heading="Original source" profileId={profileId} profile={controls.sourceProfile} source={controls.source} health={controls.sourceHealth} path={controls.sourcePath} setPath={controls.setSourcePath} pick={controls.pickSource} pickArchive={controls.pickSourceArchive} />;
}

function biosSourceField(mode: "missing" | "registered", controls: SourceControls) {
  const profileId = controls.port.bios_source_profile;
  if (!profileId || !controls.biosProfile || !controls.setBiosPath || controls.biosReady !== (mode === "registered")) return null;
  return <SourceField heading="Required BIOS" profileId={profileId} profile={controls.biosProfile} source={controls.bios} health={controls.biosHealth} path={controls.biosPath ?? ""} setPath={controls.setBiosPath} pick={controls.pickBios} />;
}

function RetiredNotice({ port }: { port: PortDefinition }) {
  if (port.upstream_status !== "retired") return null;
  return <p className="retired-notice"><Icon glyph={ArchiveX} /> <span><strong>Retired upstream</strong>This pinned release receives no upstream fixes or support.</span></p>;
}

function closeFromScrim(event: React.MouseEvent<HTMLDivElement>, close: () => void) {
  if (event.currentTarget === event.target) close();
}

function AdvancedControls({ port, status, selectedChannel, policy, installed, backups, backupProblems, backupState, busy, sources, actions }: {
  port: PortDefinition; status?: PortStatus; selectedChannel: ReleaseChannel; policy: UpdatePolicy; installed: boolean; backups: BackupRecord[]; backupProblems: BackupProblem[]; backupState: BackupInventory["state"]; busy?: string; sources: SourceControls; actions: DetailActions;
}) {
  const persistentFiles = [...port.persistent_paths, ...(port.persistent_file_patterns ?? []).map(pattern => `${pattern.prefix}*${pattern.suffix}`)].join(" · ");
  return <details className="advanced-settings" open={!installed}>
    <summary data-focusable className="advanced-summary">Release, sources &amp; maintenance <span className="advanced-summary-meta">Advanced controls</span><Icon glyph={ChevronDown} /></summary>
    <div className="advanced-body">
      <div className="detail-section"><label>Release channel</label><div className="segmented">{port.channels.map(channel =>
        <button data-focusable disabled={Boolean(busy)} className={selectedChannel === channel ? "active" : ""} key={channel} onClick={() => actions.setChannel(channel)}>{channel}</button>)}</div></div>
      <div className="detail-section"><ChoiceMenu label="Update policy" value={policy} disabled={Boolean(busy)} onChange={actions.setPolicy}
        options={[{ value: "notify", label: "Notify me" }, { value: "stage", label: "Download and stage" }, { value: "automatic", label: "Install automatically" }]} /></div>
      <SourceFields mode="registered" controls={sources} />
      <div className="metadata"><span><small>Platforms</small>{port.platforms.map(value => platformLabels[value]).join(" · ")}</span><span><small>Automated evidence</small>{port.automated_tested_platforms.length ? port.automated_tested_platforms.map(value => platformLabels[value]).join(" · ") : "Qualification pending"}</span><span><small>Physical validation</small>{port.manually_validated_platforms.length ? port.manually_validated_platforms.map(value => platformLabels[value]).join(" · ") : "Deferred / not completed"}</span><span title={persistentFiles}><small>Persistent data root</small>{status?.user_data_root ?? "Created inside the selected library"}</span></div>
      <div className="upstream-link"><ProjectLink href={port.project_url}>Open upstream project <Icon glyph={ExternalLink} size="sm" /></ProjectLink><span>Portcove resolves releases from this reviewed upstream.</span></div>
      <CliContinuity port={port} status={status} channel={selectedChannel} sourcePath={sources.sourcePath} biosPath={sources.biosPath} />
      {(installed || backups.length > 0 || backupProblems.length > 0) && <BackupHistory backups={backups} problems={backupProblems} state={backupState} busy={busy} restore={actions.restoreBackup} remove={actions.deleteBackup} />}
      {installed && <MaintenanceActions canRollback={Boolean(status?.previous)} busy={busy} actions={actions} />}
    </div>
  </details>;
}

function SourceField({ heading, profileId, profile, source, health, path, setPath, pick, pickArchive }: { heading: string; profileId: string; profile?: SourceProfile; source?: SourceRecord; health?: SourceHealth; path: string; setPath: (path: string) => void; pick?: () => void; pickArchive?: () => void }) {
  const copy = sourceFieldCopy(profile);
  const sourceNote = source ? sourceHealthNote(health, source) : copy.note;
  const inputId = `source-${profileId}`;
  return <div className="detail-section"><label htmlFor={inputId}>{heading} · {profile?.label ?? profileId}</label>
    <div className="path-entry"><input data-focusable id={inputId} value={path} onChange={event => setPath(event.target.value)} placeholder={copy.placeholder} />
      {pick && <button data-focusable className="button-with-icon" type="button" onClick={pick}><Icon glyph={FolderOpen} />Browse</button>}
      {pickArchive && <button data-focusable className="button-with-icon" type="button" onClick={pickArchive}><Icon glyph={FileArchive} />ZIP</button>}</div>
    <small>{sourceNote}</small>
  </div>;
}

function sourceHealthNote(health: SourceHealth | undefined, source: SourceRecord) {
  const hash = `${source.sha256.slice(0, 12)}…`;
  if (health === "current") return `Current registered bytes checked · ${hash}`;
  if (health === "changed") return "Registered source changed since it was added.";
  if (health === "missing") return "Registered source file is missing.";
  if (health === "unreadable") return "Registered source cannot be read.";
  if (health === "not_checked") return `Registered · current bytes not checked · ${hash}`;
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

function PrimaryActions({ runtimeNeeded, installed, launchReady, pendingSetup, hasStaged, plan, busy, actions }: { runtimeNeeded: boolean; installed: boolean; launchReady: boolean; pendingSetup: boolean; hasStaged: boolean; plan?: InstallPlan; busy?: string; actions: DetailActions }) {
  if (runtimeNeeded) return <InstallAction ready plan={plan} busy={busy} install={actions.update} review={actions.reviewInstall} />;
  if (!installed) return <InstallAction ready={launchReady} plan={plan} busy={busy} install={actions.install} review={actions.reviewInstall} />;
  return <div className="actions primary-actions">
    <button data-focusable className="primary wide button-with-icon" title={launchReady ? "Launch this port" : "Register every required source before launching"} disabled={!launchReady || Boolean(busy)} onClick={actions.launch}><Icon glyph={!launchReady ? AlertTriangle : pendingSetup ? Wrench : Gamepad2} />{!launchReady ? "Choose required source" : pendingSetup ? "Complete setup and play" : "Play now"}</button>
    {hasStaged && <button data-focusable className="staged-action button-with-icon" disabled={Boolean(busy)} onClick={actions.activate}><Icon glyph={PackageCheck} />Activate staged update</button>}
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

function MaintenanceActions({ canRollback, busy, actions }: { canRollback: boolean; busy?: string; actions: DetailActions }) {
  return <div className="actions maintenance-actions">
    <button data-focusable className="button-with-icon" title="Create a versioned snapshot of persistent data" disabled={Boolean(busy)} onClick={actions.backup}><Icon glyph={Save} />Back up data</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.openUserData}><Icon glyph={FolderOpen} />Open data folder</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.check}><Icon glyph={RefreshCw} />Check update</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.update}><Icon glyph={Download} />Update</button>
    <button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={actions.verify}><Icon glyph={ShieldCheck} />Verify</button>
    <button data-focusable className="button-with-icon" disabled={!canRollback || Boolean(busy)} onClick={actions.rollback}><Icon glyph={RotateCcw} />Rollback</button>
    <button data-focusable className="danger button-with-icon" disabled={Boolean(busy)} onClick={() => { void actions.remove(); }}><Icon glyph={Trash2} />Remove managed files</button>
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

function detailState(installed: boolean, launchReady: boolean, staged: boolean, pendingSetup: boolean, runtimeNeeded: boolean, sourceHealth?: SourceHealth, biosHealth?: SourceHealth) {
  if (!installed) return { title: "Available to install", description: "Portcove will verify the release before it becomes active.", tone: "available", icon: Download };
  if (runtimeNeeded) return { title: "Verified runtime required", description: "Review the update to install this port with its required runtime. Existing saves stay in your library.", tone: "setup", icon: Wrench };
  const sourceIssue = sourceHealthState("Original source", sourceHealth);
  if (sourceIssue) return sourceIssue;
  const biosIssue = sourceHealthState("Required BIOS", biosHealth);
  if (biosIssue) return biosIssue;
  if (!launchReady) return { title: "Finish setup", description: "Register the required original source or BIOS to unlock Play.", tone: "setup", icon: Wrench };
  if (pendingSetup) return { title: "First launch setup", description: "The source is registered. Portcove will run and verify the upstream setup before play.", tone: "setup", icon: Wrench };
  if (staged) return { title: "Ready · update staged", description: "Play the current version or activate the verified staged release.", tone: "staged", icon: RefreshCw };
  return { title: "Ready to launch", description: "The active version and every required local source are available.", tone: "ready", icon: CheckCircle2 };
}

function sourceHealthState(label: string, health?: SourceHealth) {
  if (health === "changed") return { title: `${label} changed`, description: `Choose and register ${label.toLowerCase()} again before play.`, tone: "setup", icon: AlertTriangle };
  if (health === "missing") return { title: `${label} missing`, description: `Choose and register ${label.toLowerCase()} again before play.`, tone: "setup", icon: AlertTriangle };
  if (health === "unreadable") return { title: `${label} unreadable`, description: `Restore access to ${label.toLowerCase()} or register it again before play.`, tone: "setup", icon: AlertTriangle };
  return undefined;
}
