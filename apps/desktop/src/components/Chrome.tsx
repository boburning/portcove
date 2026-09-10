import { SourceRemovalControl } from "./SourceRemoval";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Boxes, Check, CheckCircle2, CircleMinus, CircleUserRound, Command, Download, FolderInput, HardDrive, Library, LoaderCircle, Search, Settings, ShieldCheck, Wrench, X } from "lucide-react";
import desktopPackage from "../../package.json";
import type { ThemeState, ThemePreference } from "../theme";
import type { PortDefinition, DoctorReport, GithubAuthStatus, GithubDeviceLogin, HostToolProbeResult, HostToolStatus, LibraryMetadataFile, LibrarySelection, OperationEvent, SourceInspectionReport, SourceProfile, SourceRecord, SourceVerificationOutcome, StorageSummary } from "../types";
import { errorText, failurePresentation, formatBytes, progressPresentation, type SourceRequirement, type View } from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { BrandAvatar, BrandMascot, BrandWordmark } from "./Brand";
import { ExternalLink } from "./ExternalLink";
import { LibraryMoveButton } from "./LibraryMove";
import { LibraryImportButton } from "./LibraryImport";
import { CatalogSettings } from "./CatalogUpdates";
import { SourceDiscoveryButton } from "./SourceDiscovery";
import { SourceIdentityPanel } from "./SourceIdentity";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { commandShortcut } from "../keyboard-shortcuts";

export function Sidebar({ view, setView, installedCount, updateCount, onAdopt, controller }: {
  view: View; setView: Dispatch<SetStateAction<View>>; installedCount: number; updateCount: number; onAdopt: () => void;
  controller?: string;
}) {
  const items = [
    { view: "library", label: "Library", icon: Library, shortcut: "1" },
    { view: "catalog", label: "Port catalog", icon: Boxes, shortcut: "2" },
    { view: "updates", label: "Updates", icon: Download, shortcut: "3" },
    { view: "settings", label: "Settings", icon: Settings, shortcut: "4" },
  ] satisfies Array<{ view: View; label: string; icon: typeof Library; shortcut: string }>;
  return <aside className="sidebar" data-focus-region="sidebar">
    <div className="brand"><BrandAvatar /><div><strong>Portcove</strong><small>Native ports, kept current</small></div></div>
    <nav aria-label="Primary navigation">{items.map(item =>
      <button data-focusable key={item.view} aria-current={view === item.view ? "page" : undefined} className={view === item.view ? "nav-item active" : "nav-item"} onClick={() => setView(item.view)}>
        <Icon glyph={item.icon} /><span>{item.label}</span>
        {item.view === "library" && <b aria-label={`${installedCount} installed`}>{installedCount}</b>}
        {item.view === "updates" && updateCount > 0 && <b aria-label={`${updateCount} updates available`}>{updateCount}</b>}
        <Shortcut>{commandShortcut(item.shortcut)}</Shortcut>
      </button>)}</nav>
    <div className="sidebar-footer">
      <button data-focusable className="secondary full button-with-icon" onClick={onAdopt}><Icon glyph={FolderInput} />Adopt an install</button>
      <NavigationHints controller={controller} workspace />
    </div>
  </aside>;
}

export function PageHeader({ view, query, setQuery, portCount, onOpenCommands }: {
  view: View; query: string; setQuery: Dispatch<SetStateAction<string>>; portCount?: number; onOpenCommands?: () => void;
}) {
  const copy = pageCopy(view, portCount ?? 0);
  return <header>
    <div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p className="page-description">{copy.description}</p></div>
    <div className="header-tools" data-focus-group>
      {(view === "library" || view === "catalog") && <label className="search" htmlFor="port-search"><Icon glyph={Search} /><span className="sr-only">Search ports</span><input id="port-search" data-focusable value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ports" /><Shortcut>/</Shortcut></label>}
      <button data-focusable className="command-trigger button-with-icon" onClick={onOpenCommands} aria-label="Open command palette"><Icon glyph={Command} /><span>Commands</span><Shortcut>{commandShortcut("K")}</Shortcut></button>
    </div>
  </header>;
}

function pageCopy(view: View, portCount: number) {
  const copy: Record<View, { eyebrow: string; title: string; description: string }> = {
    library: { eyebrow: "LIBRARY", title: "Your native library", description: "Launch installed ports, finish source setup, and see what needs attention." },
    catalog: { eyebrow: "PORT CATALOG", title: "Find a native port", description: `Explore ${portCount} curated decomps and recompilations with explicit release provenance.` },
    updates: { eyebrow: "UPDATES", title: "Keep every port current", description: "See every version decision, staged release, and failure in one place." },
    settings: { eyebrow: "SETTINGS", title: "Portcove settings", description: "Control appearance, authentication, source integrity, and local storage boundaries." },
  };
  return copy[view];
}

export function StatusLayer({ error, clearError, operation, busy }: {
  error?: unknown; clearError: () => void; operation?: OperationEvent; busy?: string;
}) {
  return <>
    {error != null && <ErrorNotice error={error} clearError={clearError} />}
    {busy && <OperationProgress operation={operation?.type === "finished" ? undefined : operation} busy={busy} />}
  </>;
}

function ErrorNotice({ error, clearError }: { error: unknown; clearError: () => void }) {
  const presentation = failurePresentation(error);
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return <section className="error-banner" role={presentation?.tone === "neutral" ? "status" : "alert"}>
      <span className="error-icon"><Icon glyph={presentation?.tone === "neutral" ? CircleMinus : AlertTriangle} /></span>
      <div><strong>{presentation?.tone === "neutral" ? "Operation cancelled" : "Portcove couldn’t finish that action"}</strong><p>{errorText(error)}</p>
        {presentation && <FailureDetails presentation={presentation} code={code} />}</div>
      <div className="error-actions"><button data-focusable className="icon-button" aria-label="Dismiss error" onClick={clearError}><Icon glyph={X} /></button></div>
    </section>;
}

function OperationProgress({ operation, busy }: { operation?: OperationEvent; busy: string }) {
  const { label, detail, range } = progressPresentation(operation, busy);
  return <div className="operation-bar">
    <span className="operation-icon"><Icon glyph={LoaderCircle} /></span>
    <div className="operation-copy"><strong role="status" aria-live="polite" aria-atomic="true">{label}</strong><span>{detail}</span></div>
    <div className={`progress-track${range ? "" : " indeterminate"}`} role="progressbar" aria-label={label}
      aria-valuemin={range ? 0 : undefined} aria-valuemax={range?.total}
      aria-valuenow={range?.current} aria-valuetext={detail}>
      <i style={range ? { width: `${range.percent}%` } : undefined} />
    </div>
  </div>;
}

export interface GithubSettingsActions {
  status?: GithubAuthStatus;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
  deviceLogin?: GithubDeviceLogin;
  saveToken: () => Promise<void>;
  logout: () => Promise<void>;
  beginDeviceLogin: () => Promise<void>;
  refresh: () => Promise<void>;
}

export interface HostToolActions {
  locate: (tool: HostToolStatus) => Promise<HostToolProbeResult | undefined>;
  clear: (toolId: string) => Promise<void>;
  recheck: (toolId: string) => Promise<HostToolProbeResult>;
  openOfficial: (toolId: string) => Promise<void>;
}

function GithubConnection({ status }: { status?: GithubAuthStatus }) {
  const labels = { anonymous: "Anonymous", environment: "Environment variable", credential_store: "Operating-system credential store" };
  const connected = Boolean(status?.authenticated);
  const source = status && Object.hasOwn(labels, status.source) ? labels[status.source] : "Sign-in source unavailable";
  const title = connected ? `Connected as ${status?.login}` : "Optional authentication";
  const stateClass = connected ? "auth-state connected" : "auth-state";
  const StateIcon = connected ? CheckCircle2 : CircleUserRound;
  return <>
    <div className="settings-title"><h2>{title}</h2><span className={stateClass}><Icon glyph={StateIcon} size="sm" />{source}</span></div>
    <p>{githubQuota(status)}. Authentication raises GitHub's allowance and makes unchanged conditional checks free of the primary limit.</p>
  </>;
}

function githubQuota(status?: GithubAuthStatus) {
  if (!status?.rate_limit) return "Rate allowance unavailable";
  return `${status.rate_limit.remaining.toLocaleString()} of ${status.rate_limit.limit.toLocaleString()} requests remaining`;
}

function DeviceLogin({ login }: { login?: GithubDeviceLogin }) {
  if (!login) return null;
  return <div className="device-login"><strong>Enter {login.user_code}</strong><span>at <ExternalLink href={login.verification_uri}>{login.verification_uri}</ExternalLink></span><small>Portcove is waiting for GitHub.</small></div>;
}

function TokenEntry({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  if (github?.status?.authenticated || github?.status?.source === "environment") return null;
  return <div className="token-entry"><input data-focusable type="password" autoComplete="off" aria-label="GitHub personal access token" placeholder="Personal access token" value={github?.token ?? ""} onChange={event => github?.setToken(event.target.value)} /><button data-focusable className="interactive-button" disabled={busy || !github?.token.trim()} onClick={() => { void github?.saveToken(); }}>Save token</button></div>;
}

function GithubActions({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  const status = github?.status;
  return <div className="actions compact">
    {!status?.authenticated && status?.source !== "environment" && <button data-focusable disabled={busy || !status?.device_login_available} onClick={() => { void github?.beginDeviceLogin(); }}>Sign in with GitHub</button>}
    {status?.source === "credential_store" && <button data-focusable disabled={busy} onClick={() => { void github?.logout(); }}>Log out</button>}
    <button data-focusable disabled={busy} onClick={() => { void github?.refresh(); }}>Refresh status</button>
  </div>;
}

function GithubNotes({ status }: { status?: GithubAuthStatus }) {
  if (status?.source === "environment") return <small>{status.authenticated ? "The active token is managed outside Portcove through an environment variable." : "GitHub rejected the environment token. Replace or remove it outside Portcove, then restart Portcove."}</small>;
  if (status?.source === "credential_store" && !status.authenticated) return <small>GitHub no longer accepts the saved sign-in. Sign in again, or log out to continue anonymously.</small>;
  if (!status?.device_login_available && !status?.authenticated) return <small>Device login needs a Portcove GitHub App client ID in this build. Token and anonymous modes remain available.</small>;
  return null;
}

function GithubSettings({ github, busy }: { github?: GithubSettingsActions; busy?: string }) {
  return <article className="settings-card github-auth" data-focus-group>
    <p className="eyebrow">GITHUB</p>
    <GithubConnection status={github?.status} />
    <DeviceLogin login={github?.deviceLogin} />
    <TokenEntry github={github} busy={!!busy} />
    <GithubActions github={github} busy={!!busy} />
    <GithubNotes status={github?.status} />
  </article>;
}

function SourceRequirements({ requirements, busy, add }: { requirements: SourceRequirement[]; busy?: string; add?: (profile: SourceProfile, archive: boolean) => void }) {
  if (requirements.length === 0) return <div className="source-requirements complete"><strong>Installed ports have every required source reference.</strong></div>;
  return <div className="source-requirements">
    <div className="source-requirements-heading"><strong>{requirements.length} source {requirements.length === 1 ? "requirement needs" : "requirements need"} attention</strong><small>Required by installed ports</small></div>
    {requirements.map(requirement => <div className="source-requirement" key={requirement.profile.id}>
      <div><strong>{requirement.profile.label}</strong><small>{requirement.requiredBy.map(use => `${use.portName} · ${use.role}`).join("  /  ")}</small></div>
      <div className="source-health-actions"><button data-focusable className="small-control" disabled={!!busy} onClick={() => add?.(requirement.profile, false)}>Add source</button>
        {requirement.profile.kind === "file-set" && <button data-focusable className="small-control" disabled={!!busy} onClick={() => add?.(requirement.profile, true)}>Add ZIP</button>}</div>
    </div>)}
  </div>;
}

function SourceHealth({ generation, ports, sources, requirements, outcomes, inspections, busy, verify, replace, add, profiles, onAdded, openEvidence }: {
  generation: number; ports: PortDefinition[]; sources: SourceRecord[]; outcomes: SourceVerificationOutcome[]; busy?: string; verify?: () => void;
  replace?: (source: SourceRecord) => void; requirements: SourceRequirement[]; add?: (profile: SourceProfile, archive: boolean) => void;
  profiles: SourceProfile[]; inspections: ReadonlyMap<string, SourceInspectionReport>; onAdded?: () => Promise<void>; openEvidence?: (evidenceId: string) => void;
}) {
  const byProfile = new Map(outcomes.map(outcome => [outcome.profile_id, outcome]));
  return <article className="settings-card source-health" data-focus-group>
    <p className="eyebrow">SOURCES</p>
    <div className="settings-title"><h2>Integrity</h2><button data-focusable className="small-control" disabled={!!busy || sources.length === 0} onClick={verify}>Verify sources</button></div>
    <SourceRequirements requirements={requirements} busy={busy} add={add} />
    <SourceDiscoveryButton profiles={profiles} disabled={Boolean(busy)} onAdded={onAdded} />
    {sources.length === 0
      ? <p>No source files are registered yet.</p>
      : <div className="source-health-list">{sources.map(source => <SourceHealthRow key={`${source.profile_id}:${generation}`} source={source} generation={generation} ports={ports} onRemoved={onAdded} report={inspections.get(source.profile_id)} outcome={byProfile.get(source.profile_id)} busy={busy} replace={replace} openEvidence={openEvidence} />)}</div>}
    <p>Verification is local and read-only. Relink source checks the current source requirements and confirms identical content at the new location before updating Portcove's reference. Your source files stay untouched.</p>
  </article>;
}

function SourceHealthRow({ source, generation, ports, onRemoved, report, outcome, busy, replace, openEvidence }: { generation: number; ports: PortDefinition[]; onRemoved?: () => Promise<void>; source: SourceRecord; report?: SourceInspectionReport; outcome?: SourceVerificationOutcome; busy?: string; replace?: (source: SourceRecord) => void; openEvidence?: (evidenceId: string) => void }) {
  return <div className="source-health-row" data-source-profile={source.profile_id}>
    <div><strong>{report?.expected_identity?.label ?? source.profile_id}</strong><code>{source.path}</code></div>
    <div className="source-health-actions"><SourceState report={report} outcome={outcome} />
      <button data-focusable className="small-control" disabled={Boolean(busy)} onClick={() => replace?.(source)}>Relink source</button><SourceRemovalControl source={source} generation={generation} ports={ports} disabled={Boolean(busy)} onRemoved={onRemoved} /></div>
    {outcome?.error && <div><p>{errorText(outcome.error)}</p><FailureDetails presentation={outcome.error.presentation} code={outcome.error.code} /></div>}
    {report ? <SourceIdentityPanel report={report} openEvidence={openEvidence} /> : <p className="source-inspection-loading" role="status">Checking identity…</p>}
  </div>;
}

function SourceState({ report, outcome }: { report?: SourceInspectionReport; outcome?: SourceVerificationOutcome }) {
  if (report) {
    if (report.state_code === "recognized_exact") return <span className="source-state verified"><Icon glyph={Check} size="sm" />Exact match</span>;
    if (["known_mismatch", "source_changed", "source_missing", "source_could_not_be_checked"].includes(report.state_code)) return <span className="source-state failed"><Icon glyph={AlertTriangle} size="sm" />Needs attention</span>;
    return <span className="source-state"><Icon glyph={CircleMinus} size="sm" />{report.summary}</span>;
  }
  if (!outcome) return <span className="source-state">Not checked</span>;
  if (outcome.ok) return <span className="source-state verified"><Icon glyph={Check} size="sm" />Source check passed</span>;
  return <span className="source-state failed"><Icon glyph={AlertTriangle} size="sm" />Needs attention</span>;
}

function AppearanceSettings({ appearance }: { appearance?: ThemeState }) {
  const preference = appearance?.preference ?? "system";
  const resolvedTheme = appearance?.resolvedTheme ?? "dark";
  const options: ThemePreference[] = ["system", "dark", "light"];
  const resolvedLabel = resolvedTheme === "light" ? "Light" : "Dark";
  const status = preference === "system" ? `Following system · currently ${resolvedLabel}` : `Always ${resolvedLabel}`;
  return <article className="settings-card appearance-card" data-focus-group>
    <p className="eyebrow">APPEARANCE</p><h2>Color theme</h2>
    <div className="segmented appearance-options" role="group" aria-label="Color theme">
      {options.map(option => <ThemeOption key={option} option={option} selected={preference === option} select={appearance?.setPreference} />)}
    </div>
    <p>{status}.</p>
  </article>;
}

function AboutCard() {
  return <article className="settings-card about-card" data-focus-group>
    <div className="about-art"><BrandWordmark /><BrandMascot decorative /></div>
    <div className="about-copy">
      <p className="eyebrow">ABOUT &amp; CREDITS</p>
      <h2>One harbor for native ports</h2>
      <p>Portcove keeps the desktop and CLI on the same reviewed catalog, local sources, managed versions, and recovery-safe history.</p>
      <dl className="about-facts">
        <div><dt>Version</dt><dd>{desktopPackage.version}</dd></div>
        <div><dt>Built with</dt><dd>Tauri 2 · Rust · React</dd></div>
        <div><dt>License</dt><dd>MIT or Apache-2.0</dd></div>
      </dl>
      <ExternalLink className="small-control button-link" href="https://github.com/boburning/portcove">Open project repository</ExternalLink>
    </div>
  </article>;
}

function DiagnosticsCard({ busy, createSupportBundle }: { busy?: string; createSupportBundle?: () => Promise<string | undefined> }) {
  const [bundlePath, setBundlePath] = useState<string>();
  const create = async () => {
    const path = await createSupportBundle?.();
    if (path) setBundlePath(path);
  };
  return <article className="settings-card diagnostics-card" data-focus-group>
    <p className="eyebrow">DIAGNOSTICS</p><h2><Icon glyph={ShieldCheck} />Redacted support bundle</h2>
    <p>Collect rotated desktop logs, recent operation records, and host readiness without game sources or stored credentials.</p>
    <button data-focusable className="small-control" disabled={Boolean(busy) || !createSupportBundle} onClick={() => { void create(); }}>Create support bundle</button>
    {bundlePath && <p role="status">Saved to <code>{bundlePath}</code></p>}
  </article>;
}

function ThemeOption({ option, selected, select }: { option: ThemePreference; selected: boolean; select?: (preference: ThemePreference) => void }) {
  return <button data-focusable className={selected ? "active" : ""} aria-pressed={selected} onClick={() => select?.(option)}>{option[0].toUpperCase() + option.slice(1)}</button>;
}

export function SettingsView({ generation = 0, ports = [], libraryRoot = "", librarySelection, chooseLibrary, switchLibrary, resetLibrary, doctor, storage, github, busy, sources = [], sourceNeeds = [], sourceOutcomes = [], sourceInspections = new Map(), verifySources, replaceSource, addSource, appearance, createSupportBundle, exportMetadata, sourceProfiles = [], onSourceAdded, onCatalogChanged, hostToolActions, openSourceEvidence }: {
  generation?: number; ports?: PortDefinition[]; libraryRoot?: string; doctor?: DoctorReport; storage?: StorageSummary; github?: GithubSettingsActions; busy?: string; sources?: SourceRecord[];
  librarySelection?: LibrarySelection; chooseLibrary?: (currentPath: string) => Promise<string | null>; switchLibrary?: (path: string) => Promise<void>; resetLibrary?: () => Promise<void>;
  sourceNeeds?: SourceRequirement[]; sourceOutcomes?: SourceVerificationOutcome[]; verifySources?: () => void; replaceSource?: (source: SourceRecord) => void;
  sourceInspections?: ReadonlyMap<string, SourceInspectionReport>; openSourceEvidence?: (evidenceId: string) => void;
  addSource?: (profile: SourceProfile, archive: boolean) => void; appearance?: ThemeState; createSupportBundle?: () => Promise<string | undefined>;
  exportMetadata?: () => Promise<LibraryMetadataFile | undefined>;
  sourceProfiles?: SourceProfile[]; onSourceAdded?: () => Promise<void>; onCatalogChanged?: () => Promise<void>;
  hostToolActions?: HostToolActions;
}) {
  return <section className="settings-grid">
    <div className="settings-section-heading"><p className="eyebrow">STORAGE LOCATIONS</p><h2>Whole-library storage</h2><p>Choose which Portcove library opens at startup. Each game’s Export / install folder is reviewed separately from its game page.</p></div>
    <LibrarySelectionCard selection={librarySelection} busy={busy} choose={chooseLibrary} switchLibrary={switchLibrary} reset={resetLibrary} />
    <StorageCard libraryRoot={storage?.library_root ?? libraryRoot} storage={storage} busy={busy} exportMetadata={exportMetadata} />
    <GithubSettings github={github} busy={busy} />
    <SourceHealth generation={generation} ports={ports} sources={sources} requirements={sourceNeeds} outcomes={sourceOutcomes} inspections={sourceInspections} busy={busy} verify={verifySources} replace={replaceSource} add={addSource} profiles={sourceProfiles} onAdded={onSourceAdded} openEvidence={openSourceEvidence} />
    <AppearanceSettings appearance={appearance} />
    <CatalogSettings provenance={doctor?.catalog_provenance} disabled={Boolean(busy)} onChanged={onCatalogChanged} />
    <HostReadiness doctor={doctor} busy={busy} actions={hostToolActions} />
    <DiagnosticsCard busy={busy} createSupportBundle={createSupportBundle} />
    <AboutCard />
    <article className="settings-card"><p className="eyebrow">UPDATES</p><h2>Safe by default</h2><p>Stable is the default channel. Beta and rolling releases are always an explicit per-port choice.</p></article>
    <article className="settings-card"><p className="eyebrow">PRIVACY</p><h2>Local and source-safe</h2><p>Portcove does not upload game sources or collect telemetry. Source files remain where you keep them.</p></article>
  </section>;
}

export function LibrarySelectionCard({ selection, busy, choose, switchLibrary, reset }: { selection?: LibrarySelection; busy?: string; choose?: (currentPath: string) => Promise<string | null>; switchLibrary?: (path: string) => Promise<void>; reset?: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<{ kind: "switch"; path: string } | { kind: "reset" }>();
  const [pending, setPending] = useState(false);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const run = async (operation: () => Promise<void>) => {
    setError(undefined);
    setPending(true);
    try { await operation(); } catch (value) { setError(errorText(value)); }
    finally { setPending(false); }
  };
  const chooseCandidate = async () => {
    setError(undefined);
    setPending(true);
    try {
      const path = await choose?.(selection?.root ?? "");
      if (path && path !== selection?.root) setReview({ kind: "switch", path });
    } catch (value) { setError(errorText(value)); }
    finally { setPending(false); }
  };
  const cancelReview = () => {
    const trigger = review?.kind === "reset" ? resetTrigger : switchTrigger;
    setReview(undefined);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  const applyReview = async () => {
    if (!review) return;
    await run(async () => {
      if (review.kind === "switch") await switchLibrary?.(review.path);
      else await reset?.();
      setReview(undefined);
    });
  };
  const source = selection?.source === "saved" ? "Saved host preference" : selection?.source === "invocation" ? "One-run override" : "Platform default";
  return <article className="settings-card" data-focus-group>
    <p className="eyebrow">WHOLE PORTCOVE LIBRARY</p><h2>Startup selection</h2>
    <code>{selection?.root ?? "Unavailable"}</code>
    <p>{source}. Switching opens another existing empty folder or Portcove library. It does not move files or change any game’s Export / install folder.</p>
    <div className="button-row">
      <button ref={switchTrigger} data-focusable className="small-control" disabled={Boolean(busy) || pending || !choose || !switchLibrary} onClick={() => { void chooseCandidate(); }}>Review library switch</button>
      <button ref={resetTrigger} data-focusable className="small-control" disabled={Boolean(busy) || pending || !reset} onClick={() => setReview({ kind: "reset" })}>Review platform default</button>
    </div>
    {review && <div className="library-selection-review" role="group" aria-labelledby="library-selection-review-title">
      <strong id="library-selection-review-title">{review.kind === "switch" ? "Switch whole Portcove library" : "Use the platform-default library"}</strong>
      {review.kind === "switch" && <code>{review.path}</code>}
      <p>Portcove will close this library and open the reviewed selection. Existing files stay in place, and per-game Export / install folders do not change.</p>
      <div className="button-row">
        <button data-focusable data-autofocus className="small-control" disabled={pending} onClick={() => { void applyReview(); }}>{pending ? "Switching…" : review.kind === "switch" ? "Switch whole library" : "Use platform default"}</button>
        <button data-focusable className="small-control" disabled={pending} onClick={cancelReview}>Keep current library</button>
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </article>;
}

function HostReadiness({ doctor, busy, actions }: { doctor?: DoctorReport; busy?: string; actions?: HostToolActions }) {
  return <article className="settings-card host-readiness">
    <p className="eyebrow">HOST</p><h2><Icon glyph={Wrench} />Disc tools</h2>
    {doctor
      ? <><p className="host-summary"><code>{doctor.platform}</code><span>{doctor.catalog_port_count} ports · {doctor.installed_port_count} installed · {doctor.registered_source_count} sources</span></p>
        <div className="host-tool-list">{doctor.host_tools.map(tool => <HostToolRow key={tool.id} tool={tool} busy={Boolean(busy)} actions={actions} />)}</div></>
      : <p>Checking disc-tool readiness…</p>}
    <p>For some compressed disc formats, Portcove needs a disc tool to check or convert the image.</p>
  </article>;
}

export function HostToolRow({ tool, busy, actions, showTechnicalId = true }: { tool: HostToolStatus; busy: boolean; actions?: HostToolActions; showTechnicalId?: boolean }) {
  const [pending, setPending] = useState<string>();
  const [outcome, setOutcome] = useState<HostToolProbeResult>();
  const [error, setError] = useState<string>();
  const run = async (name: string, operation: () => Promise<HostToolProbeResult | void | undefined> | undefined) => {
    setPending(name);
    setError(undefined);
    setOutcome(undefined);
    try {
      const result = await operation();
      if (result) setOutcome(result);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  const states = {
    available: { label: "Ready", icon: CheckCircle2 },
    missing: { label: "Not found", icon: CircleMinus },
    misconfigured: { label: "Check path", icon: AlertTriangle },
    unsupported: { label: "Unsupported", icon: CircleMinus },
  };
  const state = states[tool.state];
  const location = tool.path ?? `Set ${tool.configuration_variable}`;
  const configured = tool.source === "saved";
  const source = tool.source === "saved" ? "Saved preference" : tool.source === "environment" ? "Environment override" : tool.source === "discovery" ? "Host discovery" : "Not resolved";
  return <div className="host-tool-row" data-focus-group>
    <div className="host-tool-heading"><strong>{tool.display_name}</strong><span className={`host-tool-state ${tool.state}`}><Icon glyph={state.icon} size="sm" />{state.label}</span></div>
    <small>{tool.purpose}</small>
    <code title={location}>{location}</code>
    <small>{source}{showTechnicalId && <> · Technical ID: <code>{tool.id}</code></>}</small>
    <div className="button-row">
      <button data-focusable className="small-control" disabled={busy || Boolean(pending) || !actions} onClick={() => { void run("site", () => actions?.openOfficial(tool.id)); }}>Official site</button>
      <button data-focusable className="small-control" disabled={busy || Boolean(pending) || !actions} onClick={() => { void run("locate", () => actions?.locate(tool)); }}>{pending === "locate" ? "Checking…" : "Locate executable…"}</button>
      <button data-focusable className="small-control" disabled={busy || Boolean(pending) || !actions || !tool.path} onClick={() => { void run("recheck", () => actions?.recheck(tool.id)); }}>{pending === "recheck" ? "Checking…" : "Recheck"}</button>
      {configured && <button data-focusable className="small-control" disabled={busy || Boolean(pending) || !actions} onClick={() => { void run("clear", () => actions?.clear(tool.id)); }}>Clear custom path</button>}
    </div>
    {outcome && <p role="status">{outcome.message}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function StorageCard({ libraryRoot, storage, busy, exportMetadata }: { libraryRoot: string; storage?: StorageSummary; busy?: string; exportMetadata?: () => Promise<LibraryMetadataFile | undefined> }) {
  const [exported, setExported] = useState<LibraryMetadataFile>();
  const total = storage?.volume_total_bytes;
  const available = storage?.volume_available_bytes;
  const measurable = typeof total === "number" && typeof available === "number" && Number.isSafeInteger(total) && Number.isSafeInteger(available) && total > 0 && available >= 0 && available <= total;
  return <article className="settings-card storage-card" data-focus-group>
    <p className="eyebrow">CURRENT LIBRARY</p><h2><Icon glyph={HardDrive} />Files and capacity</h2><code>{libraryRoot || "Loading…"}</code>
    {measurable ? <div className="storage-capacity">
      <div><strong>{formatBytes(available)} available</strong><span>{formatBytes(total)} volume</span></div>
      <div className="storage-meter" role="meter" aria-label="Available library storage" aria-valuemin={0} aria-valuemax={total} aria-valuenow={available}><i style={{ width: `${available / total * 100}%` }} /></div>
    </div> : <p>Storage capacity is unavailable for this location.</p>}
    <p><Icon glyph={ShieldCheck} size="sm" /> Application versions are isolated from saves, configuration, mods, and original sources.</p>
    <button data-focusable className="small-control" disabled={Boolean(busy) || !exportMetadata} onClick={() => { void exportMetadata?.().then(setExported); }}>Export metadata</button>
    <p>Export source references and version settings. Game files, saves, backups, toolchains, and credentials are not included.</p>
    {exported && <p role="status">Exported to <code>{exported.path}</code></p>}
    <LibraryMoveButton disabled={Boolean(busy)} />
    <LibraryImportButton disabled={Boolean(busy) || !libraryRoot} libraryRoot={libraryRoot} />
  </article>;
}
