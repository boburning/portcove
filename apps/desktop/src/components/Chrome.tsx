import { useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Boxes, Check, CheckCircle2, CircleMinus, CircleUserRound, Command, Download, FolderInput, HardDrive, Library, LoaderCircle, Search, Settings, ShieldCheck, Wrench, X } from "lucide-react";
import desktopPackage from "../../package.json";
import { copyText } from "../clipboard";
import type { ThemeState, ThemePreference } from "../theme";
import type { DoctorReport, GithubAuthStatus, GithubDeviceLogin, HostToolStatus, OperationEvent, SourceProfile, SourceRecord, SourceVerificationOutcome, StorageSummary } from "../types";
import { formatBytes, type SourceRequirement, type View } from "../view-model";
import { BrandAvatar, BrandMascot, BrandWordmark } from "./Brand";
import { Icon, Shortcut } from "./ui";

export function Sidebar({ view, setView, installedCount, updateCount, onAdopt }: {
  view: View; setView: Dispatch<SetStateAction<View>>; installedCount: number; updateCount: number; onAdopt: () => void;
}) {
  const items = [
    { view: "library", label: "Library", icon: Library, shortcut: "1" },
    { view: "catalog", label: "Port catalog", icon: Boxes, shortcut: "2" },
    { view: "updates", label: "Updates", icon: Download, shortcut: "3" },
    { view: "settings", label: "Settings", icon: Settings, shortcut: "4" },
  ] satisfies Array<{ view: View; label: string; icon: typeof Library; shortcut: string }>;
  return <aside className="sidebar">
    <div className="brand"><BrandAvatar /><div><strong>Portcove</strong><small>Native ports, kept current</small></div></div>
    <nav aria-label="Primary navigation">{items.map(item =>
      <button data-focusable key={item.view} aria-current={view === item.view ? "page" : undefined} className={view === item.view ? "nav-item active" : "nav-item"} onClick={() => setView(item.view)}>
        <Icon glyph={item.icon} /><span>{item.label}</span>
        {item.view === "library" && <b aria-label={`${installedCount} installed`}>{installedCount}</b>}
        {item.view === "updates" && updateCount > 0 && <b aria-label={`${updateCount} updates available`}>{updateCount}</b>}
        <Shortcut>Ctrl {item.shortcut}</Shortcut>
      </button>)}</nav>
    <div className="sidebar-footer">
      <button data-focusable className="secondary full button-with-icon" onClick={onAdopt}><Icon glyph={FolderInput} />Adopt an install</button>
      <div className="controller-hint"><span>Ⓐ Select</span><span>Ⓑ Back</span></div>
    </div>
  </aside>;
}

export function PageHeader({ view, query, setQuery, portCount, onOpenCommands }: {
  view: View; query: string; setQuery: Dispatch<SetStateAction<string>>; portCount?: number; onOpenCommands?: () => void;
}) {
  const copy = pageCopy(view, portCount ?? 0);
  return <header>
    <div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p className="page-description">{copy.description}</p></div>
    <div className="header-tools">
      {(view === "library" || view === "catalog") && <label className="search" htmlFor="port-search"><Icon glyph={Search} /><span className="sr-only">Search ports</span><input id="port-search" data-focusable value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ports" /><Shortcut>/</Shortcut></label>}
      <button data-focusable className="command-trigger button-with-icon" onClick={onOpenCommands} aria-label="Open command palette"><Icon glyph={Command} /><span>Commands</span><Shortcut>Ctrl K</Shortcut></button>
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
  error?: string; clearError: () => void; operation?: OperationEvent; busy?: string;
}) {
  return <>
    {error && <ErrorNotice error={error} clearError={clearError} />}
    {operation && busy && <OperationProgress operation={operation} busy={busy} />}
  </>;
}

function ErrorNotice({ error, clearError }: { error: string; clearError: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyError = () => {
    void copyText(error)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  };
  return <section className="error-banner" role="alert">
      <span className="error-icon"><Icon glyph={AlertTriangle} /></span>
      <div><strong>Portcove couldn’t finish that action</strong><p>{error}</p></div>
      <div className="error-actions"><button data-focusable onClick={copyError}>{copied ? "Copied" : "Copy details"}</button><button data-focusable className="icon-button" aria-label="Dismiss error" onClick={clearError}><Icon glyph={X} /></button></div>
    </section>;
}

function OperationProgress({ operation, busy }: { operation: OperationEvent; busy: string }) {
  const label = operation.message ?? operation.phase ?? operation.operation ?? busy;
  if (operation.total && operation.total > 0 && operation.completed !== undefined) {
    return <DeterminateProgress operation={operation} label={label} total={operation.total} completed={operation.completed} />;
  }
  return <div className="operation-bar" aria-live="polite">
    <span className="operation-icon"><Icon glyph={LoaderCircle} /></span>
    <div className="operation-copy"><strong>{operationLabel(label)}</strong><span>Working…</span></div>
    <div className="progress-track indeterminate" role="progressbar" aria-label={label}><i /></div>
  </div>;
}

function DeterminateProgress({ operation, label, total, completed }: { operation: OperationEvent; label: string; total: number; completed: number }) {
  const progress = Math.min(100, (completed / total) * 100);
  return <div className="operation-bar" aria-live="polite">
      <span className="operation-icon"><Icon glyph={LoaderCircle} /></span>
      <div className="operation-copy"><strong>{operationLabel(label)}</strong><span>{completed.toLocaleString()} of {total.toLocaleString()}</span></div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={operation.total} aria-valuenow={operation.completed}><i style={{ width: `${progress}%` }} /></div>
    </div>;
}

function operationLabel(value: string) {
  return value.replaceAll("_", " ").replace(/^\w/, letter => letter.toUpperCase());
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

function GithubConnection({ status }: { status?: GithubAuthStatus }) {
  const labels = { anonymous: "Anonymous", environment: "Environment variable", credential_store: "Operating-system credential store" };
  const connected = Boolean(status?.authenticated);
  const source = labels[status?.source ?? "anonymous"];
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
  return <div className="device-login"><strong>Enter {login.user_code}</strong><span>at <a data-focusable href={login.verification_uri} target="_blank" rel="noreferrer">{login.verification_uri}</a></span><small>Portcove is waiting for GitHub.</small></div>;
}

function TokenEntry({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  if (github?.status?.authenticated) return null;
  return <div className="token-entry"><input data-focusable type="password" autoComplete="off" aria-label="GitHub personal access token" placeholder="Personal access token" value={github?.token ?? ""} onChange={event => github?.setToken(event.target.value)} /><button data-focusable className="interactive-button" disabled={busy || !github?.token.trim()} onClick={() => { void github?.saveToken(); }}>Save token</button></div>;
}

function GithubActions({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  const status = github?.status;
  return <div className="actions compact">
    {!status?.authenticated && <button data-focusable disabled={busy || !status?.device_login_available} onClick={() => { void github?.beginDeviceLogin(); }}>Sign in with GitHub</button>}
    {status?.source === "credential_store" && <button data-focusable disabled={busy} onClick={() => { void github?.logout(); }}>Log out</button>}
    <button data-focusable disabled={busy} onClick={() => { void github?.refresh(); }}>Refresh status</button>
  </div>;
}

function GithubNotes({ status }: { status?: GithubAuthStatus }) {
  if (status?.source === "environment") return <small>The active token is managed outside Portcove through an environment variable.</small>;
  if (!status?.device_login_available && !status?.authenticated) return <small>Device login needs a Portcove GitHub App client ID in this build. Token and anonymous modes remain available.</small>;
  return null;
}

function GithubSettings({ github, busy }: { github?: GithubSettingsActions; busy?: string }) {
  return <article className="settings-card github-auth">
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

function SourceHealth({ sources, requirements, outcomes, busy, verify, replace, add }: {
  sources: SourceRecord[]; outcomes: SourceVerificationOutcome[]; busy?: string; verify?: () => void;
  replace?: (source: SourceRecord) => void; requirements: SourceRequirement[]; add?: (profile: SourceProfile, archive: boolean) => void;
}) {
  const byProfile = new Map(outcomes.map(outcome => [outcome.profile_id, outcome]));
  return <article className="settings-card source-health">
    <p className="eyebrow">SOURCES</p>
    <div className="settings-title"><h2>Integrity</h2><button data-focusable className="small-control" disabled={!!busy || sources.length === 0} onClick={verify}>Verify sources</button></div>
    <SourceRequirements requirements={requirements} busy={busy} add={add} />
    {sources.length === 0
      ? <p>No source files are registered yet.</p>
      : <div className="source-health-list">{sources.map(source => <SourceHealthRow key={source.profile_id} source={source} outcome={byProfile.get(source.profile_id)} busy={busy} replace={replace} />)}</div>}
    <p>Verification is local and read-only. Replace file validates a new path before updating only Portcove's reference; neither operation changes the source itself.</p>
  </article>;
}

function SourceHealthRow({ source, outcome, busy, replace }: { source: SourceRecord; outcome?: SourceVerificationOutcome; busy?: string; replace?: (source: SourceRecord) => void }) {
  return <div className="source-health-row">
    <div><strong>{source.profile_id}</strong><code>{source.path}</code></div>
    <div className="source-health-actions"><SourceState outcome={outcome} />
      <button data-focusable className="small-control" disabled={Boolean(busy)} onClick={() => replace?.(source)}>Replace file</button></div>
    {outcome?.error && <small>{outcome.error.message}</small>}
  </div>;
}

function SourceState({ outcome }: { outcome?: SourceVerificationOutcome }) {
  if (!outcome) return <span className="source-state">Not checked</span>;
  if (outcome.ok) return <span className="source-state verified"><Icon glyph={Check} size="sm" />Verified</span>;
  return <span className="source-state failed"><Icon glyph={AlertTriangle} size="sm" />Needs attention</span>;
}

function AppearanceSettings({ appearance }: { appearance?: ThemeState }) {
  const preference = appearance?.preference ?? "system";
  const resolvedTheme = appearance?.resolvedTheme ?? "dark";
  const options: ThemePreference[] = ["system", "dark", "light"];
  const resolvedLabel = resolvedTheme === "light" ? "Light" : "Dark";
  const status = preference === "system" ? `Following system · currently ${resolvedLabel}` : `Always ${resolvedLabel}`;
  return <article className="settings-card appearance-card">
    <p className="eyebrow">APPEARANCE</p><h2>Hardware light, software color</h2>
    <div className="segmented appearance-options" role="group" aria-label="Color theme">
      {options.map(option => <ThemeOption key={option} option={option} selected={preference === option} select={appearance?.setPreference} />)}
    </div>
    <p>{status}. Portcove keeps the N64-inspired interaction hierarchy in either theme.</p>
  </article>;
}

function AboutCard() {
  return <article className="settings-card about-card">
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
      <a data-focusable className="small-control button-link" href="https://github.com/boburning/portcove" target="_blank" rel="noreferrer">Open project repository</a>
    </div>
  </article>;
}

function DiagnosticsCard({ busy, createSupportBundle }: { busy?: string; createSupportBundle?: () => Promise<string | undefined> }) {
  const [bundlePath, setBundlePath] = useState<string>();
  const create = async () => {
    const path = await createSupportBundle?.();
    if (path) setBundlePath(path);
  };
  return <article className="settings-card diagnostics-card">
    <p className="eyebrow">DIAGNOSTICS</p><h2><Icon glyph={ShieldCheck} />Redacted support bundle</h2>
    <p>Collect rotated desktop logs, recent operation records, and host readiness without game sources or stored credentials.</p>
    <button data-focusable className="small-control" disabled={Boolean(busy) || !createSupportBundle} onClick={() => { void create(); }}>Create support bundle</button>
    {bundlePath && <p role="status">Saved to <code>{bundlePath}</code></p>}
  </article>;
}

function ThemeOption({ option, selected, select }: { option: ThemePreference; selected: boolean; select?: (preference: ThemePreference) => void }) {
  return <button data-focusable className={selected ? "active" : ""} aria-pressed={selected} onClick={() => select?.(option)}>{option[0].toUpperCase() + option.slice(1)}</button>;
}

export function SettingsView({ libraryRoot = "", doctor, storage, github, busy, sources = [], sourceNeeds = [], sourceOutcomes = [], verifySources, replaceSource, addSource, appearance, createSupportBundle }: {
  libraryRoot?: string; doctor?: DoctorReport; storage?: StorageSummary; github?: GithubSettingsActions; busy?: string; sources?: SourceRecord[];
  sourceNeeds?: SourceRequirement[]; sourceOutcomes?: SourceVerificationOutcome[]; verifySources?: () => void; replaceSource?: (source: SourceRecord) => void;
  addSource?: (profile: SourceProfile, archive: boolean) => void; appearance?: ThemeState; createSupportBundle?: () => Promise<string | undefined>;
}) {
  return <section className="settings-grid">
    <GithubSettings github={github} busy={busy} />
    <SourceHealth sources={sources} requirements={sourceNeeds} outcomes={sourceOutcomes} busy={busy} verify={verifySources} replace={replaceSource} add={addSource} />
    <StorageCard libraryRoot={storage?.library_root ?? libraryRoot} storage={storage} />
    <AppearanceSettings appearance={appearance} />
    <HostReadiness doctor={doctor} />
    <DiagnosticsCard busy={busy} createSupportBundle={createSupportBundle} />
    <AboutCard />
    <article className="settings-card"><p className="eyebrow">UPDATES</p><h2>Safe by default</h2><p>Stable is the default channel. Beta and rolling releases are always an explicit per-port choice.</p></article>
    <article className="settings-card"><p className="eyebrow">PRIVACY</p><h2>Local and source-safe</h2><p>Portcove does not upload game sources or collect telemetry. Source files remain where you keep them.</p></article>
  </section>;
}

function HostReadiness({ doctor }: { doctor?: DoctorReport }) {
  return <article className="settings-card host-readiness">
    <p className="eyebrow">HOST</p><h2><Icon glyph={Wrench} />Source tools</h2>
    {doctor
      ? <><p className="host-summary"><code>{doctor.platform}</code><span>{doctor.catalog_port_count} ports · {doctor.installed_port_count} installed · {doctor.registered_source_count} sources</span></p>
        <div className="host-tool-list">{doctor.host_tools.map(tool => <HostToolRow key={tool.id} tool={tool} />)}</div></>
      : <p>Checking source-tool readiness…</p>}
    <p>Optional tools are required only when a matching compressed disc format needs validation or materialization.</p>
  </article>;
}

function HostToolRow({ tool }: { tool: HostToolStatus }) {
  const states = {
    available: { label: "Ready", icon: CheckCircle2 },
    missing: { label: "Not found", icon: CircleMinus },
    misconfigured: { label: "Check path", icon: AlertTriangle },
  };
  const state = states[tool.state];
  const location = tool.path ?? `Set ${tool.configuration_variable}`;
  return <div className="host-tool-row">
    <div className="host-tool-heading"><strong>{hostToolName(tool.id)}</strong><span className={`host-tool-state ${tool.state}`}><Icon glyph={state.icon} size="sm" />{state.label}</span></div>
    <small>{tool.purpose}</small>
    <code title={location}>{location}</code>
  </div>;
}

function hostToolName(id: string) {
  if (id === "dolphin_tool") return "DolphinTool";
  if (id === "chdman") return "chdman";
  return id.replaceAll("_", " ");
}

function StorageCard({ libraryRoot, storage }: { libraryRoot: string; storage?: StorageSummary }) {
  const total = storage?.volume_total_bytes ?? 0;
  const available = storage?.volume_available_bytes ?? 0;
  const availablePercent = total > 0 ? Math.min(100, available / total * 100) : 0;
  return <article className="settings-card storage-card">
    <p className="eyebrow">LIBRARY</p><h2><Icon glyph={HardDrive} />Managed files</h2><code>{libraryRoot || "Loading…"}</code>
    {storage && <div className="storage-capacity">
      <div><strong>{formatBytes(available)} available</strong><span>{formatBytes(total)} volume</span></div>
      <div className="storage-meter" role="meter" aria-label="Available library storage" aria-valuemin={0} aria-valuemax={total} aria-valuenow={available}><i style={{ width: `${availablePercent}%` }} /></div>
    </div>}
    <p><Icon glyph={ShieldCheck} size="sm" /> Application versions are isolated from saves, configuration, mods, and original sources.</p>
  </article>;
}
