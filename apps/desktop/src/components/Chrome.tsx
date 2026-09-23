import { SourceRemovalControl } from "./SourceRemoval";
import { desktopApi } from "../api";
import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  CircleMinus,
  CircleUserRound,
  Command,
  Download,
  FolderInput,
  HardDrive,
  Library,
  LoaderCircle,
  Search,
  Settings,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import desktopPackage from "../../package.json";
import type { ThemeState, ThemePreference } from "../theme";
import type {
  ActivityRecord,
  PortDefinition,
  ApplicationUpdateNoticeSnapshot,
  DoctorReport,
  GithubAuthStatus,
  GithubDeviceLogin,
  HostToolProbeResult,
  HostToolStatus,
  LibraryMetadataFile,
  LibrarySelection,
  OperationEvent,
  SourceInspectionReport,
  SourceProfile,
  SourceRecord,
  SourceVerificationOutcome,
  StorageSummary,
} from "../types";
import {
  errorText,
  failurePresentation,
  formatBytes,
  formatCountMessage,
  navigationActivityState,
  progressPresentation,
  type NavigationActivityState,
  type SourceRequirement,
  type View,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { BrandAvatar, BrandMascot, BrandWordmark } from "./Brand";
import { ExternalLink } from "./ExternalLink";
import { LibraryMoveButton } from "./LibraryMove";
import { LibraryImportButton } from "./LibraryImport";
import { CatalogSettings } from "./CatalogUpdates";
import { ApplicationUpdateSettings } from "../features/application-update/ApplicationUpdates";
import type { ApplicationUpdatePreferencesState } from "../features/application-update/use-application-update-preferences";
import { SourceDiscoveryButton } from "./SourceDiscovery";
import { SourceIdentityPanel } from "./SourceIdentity";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { commandShortcut } from "../keyboard-shortcuts";
import { LanguageSettings } from "./LanguageSettings";

export function Sidebar({
  view,
  setView,
  installedCount,
  updateCount,
  activities,
  onAdopt,
  controller,
}: {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  installedCount: number;
  updateCount: number;
  activities: ActivityRecord[];
  onAdopt: () => void;
  controller?: string;
}) {
  const activityState = navigationActivityState(activities);
  const items = [
    { view: "library", label: "Library", icon: Library, shortcut: "1" },
    { view: "catalog", label: "Port catalog", icon: Boxes, shortcut: "2" },
    { view: "updates", label: "Updates", icon: Download, shortcut: "3" },
    { view: "settings", label: "Settings", icon: Settings, shortcut: "4" },
  ] satisfies Array<{
    view: View;
    label: string;
    icon: typeof Library;
    shortcut: string;
  }>;
  return (
    <aside className="sidebar" data-focus-region="sidebar">
      <div className="brand">
        <BrandAvatar />
        <div>
          <strong>Portcove</strong>
          <small>Native ports, kept current</small>
        </div>
      </div>
      <nav aria-label="Primary navigation">
        {items.map((item) => (
          <Button
            data-focusable
            key={item.view}
            aria-current={view === item.view ? "page" : undefined}
            variant={view === item.view ? "selected" : "ghost"}
            size="lg"
            className="nav-item"
            onClick={() => setView(item.view)}
          >
            <Icon glyph={item.icon} />
            <span>{item.label}</span>
            {item.view === "library" && (
              <b aria-label={`${installedCount} installed`}>{installedCount}</b>
            )}
            {item.view === "updates" && (updateCount > 0 || activityState) && (
              <NavigationStatus updateCount={updateCount} activityState={activityState} />
            )}
            <Shortcut>{commandShortcut(item.shortcut)}</Shortcut>
          </Button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <Button
          data-focusable
          variant="outline"
          size="lg"
          className="w-full whitespace-normal"
          onClick={onAdopt}
        >
          <Icon glyph={FolderInput} />
          Copy existing installation
        </Button>
        <NavigationHints controller={controller} workspace />
      </div>
    </aside>
  );
}

function NavigationStatus({
  updateCount,
  activityState,
}: {
  updateCount: number;
  activityState?: NavigationActivityState;
}) {
  const activityLabel =
    activityState === "running"
      ? "Activity in progress"
      : activityState === "attention"
        ? "Activity needs attention"
        : undefined;
  const updateLabel =
    updateCount > 0
      ? formatCountMessage(updateCount, {
          zero: "No updates available",
          one: "1 update available",
          other: "{count} updates available",
          unknown: "Update count unavailable",
        })
      : undefined;
  const label = [activityLabel, updateLabel].filter(Boolean).join(", ");
  return (
    <b
      className={`nav-status${activityState ? ` ${activityState}` : ""}`}
      aria-label={label}
      title={label}
    >
      {activityState && (
        <Icon glyph={activityState === "running" ? LoaderCircle : AlertTriangle} size="sm" />
      )}
      {updateCount > 0 && <span aria-hidden="true">{updateCount}</span>}
    </b>
  );
}

export function PageHeader({
  view,
  query,
  setQuery,
  portCount,
  onOpenCommands,
}: {
  view: View;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  portCount?: number;
  onOpenCommands?: () => void;
}) {
  const copy = pageCopy(view, portCount ?? 0);
  return (
    <header>
      <div>
        <h1>{copy.title}</h1>
        {copy.description && <p className="page-description">{copy.description}</p>}
      </div>
      <div className="header-tools" data-focus-group>
        {(view === "library" || view === "catalog") && (
          <label className="search" htmlFor="port-search">
            <Icon glyph={Search} />
            <span className="sr-only">Search ports</span>
            <input
              id="port-search"
              data-focusable
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search ports"
            />
            <Shortcut>/</Shortcut>
          </label>
        )}
        <Button
          data-focusable
          data-detail-origin={`command-trigger:${view}`}
          variant="outline"
          size="lg"
          className="command-trigger"
          onClick={onOpenCommands}
          aria-label="Open command palette"
        >
          <Icon glyph={Command} />
          <span>Commands</span>
          <Shortcut>{commandShortcut("K")}</Shortcut>
        </Button>
      </div>
    </header>
  );
}

function pageCopy(view: View, portCount: number) {
  const copy: Record<View, { title: string; description?: string }> = {
    library: {
      title: "Your library",
    },
    catalog: {
      title: "Port catalog",
      description: `Browse ${portCount} native game ${portCount === 1 ? "port" : "ports"}.`,
    },
    updates: {
      title: "Updates",
    },
    settings: {
      title: "Settings",
    },
  };
  return copy[view];
}

export function StatusLayer({
  error,
  clearError,
  operation,
  busy,
  updateNotice,
  updateChoiceRequired,
  productionTransitionRequired,
  productionTransitionBusy,
  reviewUpdate,
  dismissUpdate,
  dismissUpdateChoice,
  useStable,
  keepPreview,
  dismissProductionTransition,
}: {
  error?: unknown;
  clearError: () => void;
  operation?: OperationEvent;
  busy?: string;
  updateNotice?: ApplicationUpdateNoticeSnapshot["notice"];
  updateChoiceRequired?: boolean;
  productionTransitionRequired?: boolean;
  productionTransitionBusy?: boolean;
  reviewUpdate?: () => void;
  dismissUpdate?: () => Promise<void>;
  dismissUpdateChoice?: () => void;
  useStable?: () => void;
  keepPreview?: () => void;
  dismissProductionTransition?: () => void;
}) {
  return (
    <>
      {error != null && <ErrorNotice error={error} clearError={clearError} />}
      {updateNotice && (
        <ApplicationUpdateNoticeBanner
          notice={updateNotice}
          review={reviewUpdate}
          dismiss={dismissUpdate}
        />
      )}
      {!updateNotice && updateChoiceRequired && (
        <ApplicationUpdateChoiceBanner review={reviewUpdate} dismiss={dismissUpdateChoice} />
      )}
      {!updateNotice && !updateChoiceRequired && productionTransitionRequired && (
        <ApplicationUpdateProductionTransitionBanner
          busy={Boolean(productionTransitionBusy)}
          useStable={useStable}
          keepPreview={keepPreview}
          dismiss={dismissProductionTransition}
        />
      )}
      {busy && (
        <OperationProgress
          operation={operation?.type === "finished" ? undefined : operation}
          busy={busy}
        />
      )}
    </>
  );
}

function ApplicationUpdateProductionTransitionBanner({
  busy,
  useStable,
  keepPreview,
  dismiss,
}: {
  busy: boolean;
  useStable?: () => void;
  keepPreview?: () => void;
  dismiss?: () => void;
}) {
  return (
    <section
      className="error-banner application-update-consent-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={busy}
    >
      <span className="error-icon">
        <Icon glyph={ShieldCheck} />
      </span>
      <div>
        <strong>Choose your production channel</strong>
        <p>
          Stable is recommended and waits for an eligible production release newer than this
          installation; it never downgrades Portcove. Keep Preview to continue receiving eligible
          test releases. Your update mode and pause setting stay unchanged.
        </p>
      </div>
      <div className="error-actions">
        <Button data-focusable variant="primary" size="sm" disabled={busy} onClick={useStable}>
          Use Stable
        </Button>
        <Button data-focusable variant="outline" size="sm" disabled={busy} onClick={keepPreview}>
          Keep Preview
        </Button>
        <Button data-focusable variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
          Not now
        </Button>
      </div>
    </section>
  );
}

function ApplicationUpdateChoiceBanner({
  review,
  dismiss,
}: {
  review?: () => void;
  dismiss?: () => void;
}) {
  return (
    <section
      className="error-banner application-update-consent-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="error-icon">
        <Icon glyph={Settings} />
      </span>
      <div>
        <strong>Choose how Portcove updates</strong>
        <p>
          Automatic updates are recommended. During public beta, Preview receives eligible test
          releases. Portcove verifies updates and waits for a safe exit or an explicit restart
          before applying them.
        </p>
      </div>
      <div className="error-actions">
        <Button data-focusable variant="primary" size="sm" onClick={review}>
          Review options
        </Button>
        <Button data-focusable variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </section>
  );
}

function ApplicationUpdateNoticeBanner({
  notice,
  review,
  dismiss,
}: {
  notice: NonNullable<ApplicationUpdateNoticeSnapshot["notice"]>;
  review?: () => void;
  dismiss?: () => Promise<void>;
}) {
  const candidate = notice.result.candidate;
  if (!candidate) return null;
  const channel = candidate.channel === "preview" ? "Preview" : "Stable";
  return (
    <section
      className="error-banner application-update-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="error-icon">
        <Icon glyph={Download} />
      </span>
      <div>
        <strong>
          {notice.result.staged
            ? `Portcove ${candidate.version} is ready to install`
            : `Portcove ${candidate.version} is available`}
        </strong>
        <p>
          {notice.result.staged
            ? `${channel} update verified (${formatBytes(candidate.bytes)}). Review it in Settings and restart when convenient.`
            : `${channel} update found (${formatBytes(candidate.bytes)}). Review it in Settings before downloading.`}
        </p>
      </div>
      <div className="error-actions">
        <Button data-focusable variant="primary" size="sm" onClick={review}>
          Review update
        </Button>
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss application update notice"
          onClick={() => void dismiss?.()}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </section>
  );
}

function ErrorNotice({ error, clearError }: { error: unknown; clearError: () => void }) {
  const presentation = failurePresentation(error);
  const code =
    typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return (
    <section className="error-banner" role={presentation?.tone === "neutral" ? "status" : "alert"}>
      <span className="error-icon">
        <Icon glyph={presentation?.tone === "neutral" ? CircleMinus : AlertTriangle} />
      </span>
      <div>
        <strong>
          {presentation?.tone === "neutral"
            ? "Operation cancelled"
            : "Portcove couldn’t finish that action"}
        </strong>
        <p>{errorText(error)}</p>
        {presentation && <FailureDetails presentation={presentation} code={code} />}
      </div>
      <div className="error-actions">
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss error"
          onClick={clearError}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </section>
  );
}

function OperationProgress({ operation, busy }: { operation?: OperationEvent; busy: string }) {
  const { label, detail, range } = progressPresentation(operation, busy);
  return (
    <div className="operation-bar">
      <span className="operation-icon">
        <Icon glyph={LoaderCircle} />
      </span>
      <div className="operation-copy">
        <strong role="status" aria-live="polite" aria-atomic="true">
          {label}
        </strong>
        <span>{detail}</span>
      </div>
      <div
        className={`progress-track${range ? "" : " indeterminate"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={range ? 0 : undefined}
        aria-valuemax={range?.total}
        aria-valuenow={range?.current}
        aria-valuetext={detail}
      >
        <i style={range ? { width: `${range.percent}%` } : undefined} />
      </div>
    </div>
  );
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
  const labels = {
    anonymous: "Anonymous",
    environment: "Environment variable",
    credential_store: "Operating-system credential store",
  };
  const connected = Boolean(status?.authenticated);
  const source =
    status && Object.hasOwn(labels, status.source)
      ? labels[status.source]
      : "Sign-in source unavailable";
  const connectionStatus = !status
    ? "Connection status unavailable"
    : connected
      ? status.login?.trim()
        ? `Connected as ${status.login}`
        : "Connected to GitHub"
      : "Not signed in";
  const stateClass = connected ? "auth-state connected" : "auth-state";
  const StateIcon = connected ? CheckCircle2 : CircleUserRound;
  return (
    <>
      <div className="settings-title">
        <h2>GitHub connection</h2>
        <span className={stateClass}>
          <Icon glyph={StateIcon} size="sm" />
          {connectionStatus}
        </span>
      </div>
      {!status ? (
        <p>Refresh status to check the GitHub connection.</p>
      ) : (
        !connected && <p>Not signed in. Signing in increases the limit for release checks.</p>
      )}
      <details className="github-connection-details">
        <summary>Connection details</summary>
        <p>Sign-in source: {source}.</p>
        <p>{githubQuota(status)}.</p>
        <p>
          Repeated checks for an unchanged GitHub release may not use the primary request limit.
        </p>
      </details>
    </>
  );
}

function githubQuota(status?: GithubAuthStatus) {
  if (!status?.rate_limit) return "GitHub request limit unavailable";
  return `${status.rate_limit.remaining.toLocaleString()} of ${status.rate_limit.limit.toLocaleString()} GitHub requests remaining`;
}

function DeviceLogin({ login }: { login?: GithubDeviceLogin }) {
  if (!login) return null;
  return (
    <div className="device-login">
      <strong>Enter {login.user_code}</strong>
      <span>
        at <ExternalLink href={login.verification_uri}>{login.verification_uri}</ExternalLink>
      </span>
      <small>Portcove is waiting for GitHub.</small>
    </div>
  );
}

function TokenEntry({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  if (!github?.status || github.status.authenticated || github.status.source === "environment")
    return null;
  return (
    <div className="token-entry-group">
      {github?.status?.device_login_available && <p>Use a token instead</p>}
      <label htmlFor="github-personal-access-token">Personal access token</label>
      <div className="token-entry">
        <Input
          id="github-personal-access-token"
          data-focusable
          className="flex-1"
          type="password"
          autoComplete="off"
          value={github?.token ?? ""}
          onChange={(event) => github?.setToken(event.target.value)}
        />
        <Button
          data-focusable
          variant="primary"
          size="sm"
          disabled={busy || !github?.token.trim()}
          onClick={() => {
            void github?.saveToken();
          }}
        >
          Save token
        </Button>
      </div>
    </div>
  );
}

function GithubActions({ github, busy }: { github?: GithubSettingsActions; busy: boolean }) {
  const status = github?.status;
  return (
    <div className="actions compact">
      {!status?.authenticated &&
        status?.source !== "environment" &&
        status?.device_login_available && (
          <Button
            data-focusable
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => {
              void github?.beginDeviceLogin();
            }}
          >
            Sign in with GitHub
          </Button>
        )}
      {status?.source === "credential_store" && (
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            void github?.logout();
          }}
        >
          Sign out
        </Button>
      )}
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void github?.refresh();
        }}
      >
        Refresh status
      </Button>
    </div>
  );
}

function GithubNotes({ status }: { status?: GithubAuthStatus }) {
  if (status?.source === "environment")
    return (
      <small>
        {status.authenticated
          ? "The active token is managed outside Portcove through an environment variable."
          : "GitHub rejected the environment token. Replace or remove it outside Portcove, then restart Portcove."}
      </small>
    );
  if (status?.source === "credential_store" && !status.authenticated)
    return (
      <small>
        GitHub no longer accepts the saved sign-in. Sign in again, or sign out to continue
        anonymously.
      </small>
    );
  if (status && !status.device_login_available && !status.authenticated)
    return (
      <small>
        This version of Portcove does not support GitHub device sign-in. Continue anonymously or use
        a personal access token.
      </small>
    );
  return null;
}

function GithubSettings({ github, busy }: { github?: GithubSettingsActions; busy?: string }) {
  return (
    <article className="settings-card github-auth" data-focus-group>
      <p className="eyebrow">GITHUB</p>
      <GithubConnection status={github?.status} />
      {github?.status?.device_login_available && <DeviceLogin login={github.deviceLogin} />}
      <TokenEntry github={github} busy={!!busy} />
      <GithubActions github={github} busy={!!busy} />
      <GithubNotes status={github?.status} />
    </article>
  );
}

type SourceRequirementsState = "loading" | "available" | "unavailable";

function SourceRequirements({
  requirements,
  state,
  installedCount,
  busy,
  add,
}: {
  requirements: SourceRequirement[];
  state: SourceRequirementsState;
  installedCount: number;
  busy?: string;
  add?: (profile: SourceProfile, archive: boolean) => void;
}) {
  if (state === "loading")
    return (
      <div className="source-requirements">
        <strong>Checking required game files…</strong>
      </div>
    );
  if (state === "unavailable")
    return (
      <div className="source-requirements">
        <strong>Required game files could not be checked.</strong>
        <small>Retry loading the library before changing saved locations.</small>
      </div>
    );
  if (requirements.length === 0)
    return (
      <div className={`source-requirements${installedCount > 0 ? " complete" : ""}`}>
        <strong>
          {installedCount > 0
            ? "Required game files have been added for your installed ports."
            : "No ports installed yet. Game-file requirements for installed ports will appear here."}
        </strong>
      </div>
    );
  return (
    <div className="source-requirements">
      <div className="source-requirements-heading">
        <strong>
          {requirements.length} game-file{" "}
          {requirements.length === 1 ? "requirement" : "requirements"}{" "}
          {requirements.length === 1 ? "needs" : "need"} attention
        </strong>
        <small>Required by installed ports</small>
      </div>
      {requirements.map((requirement) => (
        <div className="source-requirement" key={requirement.profile.id}>
          <div>
            <strong>{requirement.profile.label}</strong>
            <small>
              {requirement.requiredBy.map((use) => `${use.portName} · ${use.role}`).join("  /  ")}
            </small>
          </div>
          <div className="source-health-actions">
            <Button
              data-focusable
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => add?.(requirement.profile, false)}
            >
              Add source
            </Button>
            {requirement.profile.kind === "file-set" && (
              <Button
                data-focusable
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => add?.(requirement.profile, true)}
              >
                Add ZIP
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceHealth({
  generation,
  ports,
  sources,
  requirements,
  requirementsState,
  installedCount,
  outcomes,
  inspections,
  busy,
  verify,
  replace,
  add,
  profiles,
  onAdded,
  openEvidence,
}: {
  generation: number;
  ports: PortDefinition[];
  sources: SourceRecord[];
  outcomes: SourceVerificationOutcome[];
  busy?: string;
  verify?: () => void;
  replace?: (source: SourceRecord) => void;
  requirements: SourceRequirement[];
  requirementsState: SourceRequirementsState;
  installedCount: number;
  add?: (profile: SourceProfile, archive: boolean) => void;
  profiles: SourceProfile[];
  inspections: ReadonlyMap<string, SourceInspectionReport>;
  onAdded?: () => Promise<unknown>;
  openEvidence?: (evidenceId: string) => void;
}) {
  const byProfile = new Map(outcomes.map((outcome) => [outcome.profile_id, outcome]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  return (
    <article className="settings-card source-health" data-focus-group>
      <p className="eyebrow">SOURCES</p>
      <div className="settings-title">
        <h2>Game-file verification</h2>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={!!busy || sources.length === 0}
          onClick={verify}
        >
          Verify sources
        </Button>
      </div>
      <SourceRequirements
        requirements={requirements}
        state={requirementsState}
        installedCount={installedCount}
        busy={busy}
        add={add}
      />
      <SourceDiscoveryButton
        profiles={profiles}
        disabled={Boolean(busy) || requirementsState !== "available"}
        onAdded={onAdded}
      />
      {requirementsState === "available" &&
        (sources.length === 0 ? (
          <p>No source files are registered yet.</p>
        ) : (
          <div className="source-health-list">
            {sources.map((source, index) => (
              <SourceHealthRow
                key={`${source.profile_id}:${generation}`}
                source={source}
                sourcePosition={index + 1}
                sourceCount={sources.length}
                profile={profilesById.get(source.profile_id)}
                generation={generation}
                ports={ports}
                onRemoved={onAdded}
                report={inspections.get(source.profile_id)}
                outcome={byProfile.get(source.profile_id)}
                busy={busy}
                replace={replace}
                openEvidence={openEvidence}
              />
            ))}
          </div>
        ))}
      <p>
        Portcove checks files locally and never uploads or changes them. When you choose a new
        location, Portcove confirms that the file is an exact match before saving the new path.
      </p>
    </article>
  );
}

function SourceHealthRow({
  source,
  sourcePosition,
  sourceCount,
  profile,
  generation,
  ports,
  onRemoved,
  report,
  outcome,
  busy,
  replace,
  openEvidence,
}: {
  generation: number;
  ports: PortDefinition[];
  onRemoved?: () => Promise<unknown>;
  source: SourceRecord;
  sourcePosition: number;
  sourceCount: number;
  profile?: SourceProfile;
  report?: SourceInspectionReport;
  outcome?: SourceVerificationOutcome;
  busy?: string;
  replace?: (source: SourceRecord) => void;
  openEvidence?: (evidenceId: string) => void;
}) {
  return (
    <div className="source-health-row" data-source-profile={source.profile_id}>
      <div>
        <strong>
          {report?.expected_identity?.label ??
            profile?.label ??
            "Saved game-file requirement unavailable"}
        </strong>
        <code>{source.path}</code>
      </div>
      <div className="source-health-actions">
        <SourceState report={report} outcome={outcome} profileAvailable={Boolean(profile)} />
        {profile && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => replace?.(source)}
          >
            Relink source
          </Button>
        )}
        <SourceRemovalControl
          source={source}
          generation={generation}
          ports={ports}
          disabled={Boolean(busy)}
          onRemoved={onRemoved}
        />
      </div>
      {!profile && (
        <div>
          <p>
            This saved game-file requirement is no longer present in the current catalog. Update the
            catalog or remove the saved location.
          </p>
          <details>
            <summary
              data-focusable
              aria-label={`Technical details for saved game-file location ${source.path}, saved reference ${sourcePosition} of ${sourceCount}`}
            >
              Technical details
            </summary>
            <small>
              Catalog profile ID: <code className="source-profile-id">{source.profile_id}</code>
            </small>
          </details>
        </div>
      )}
      {outcome?.error && (
        <div>
          <p>{errorText(outcome.error)}</p>
          <FailureDetails presentation={outcome.error.presentation} code={outcome.error.code} />
        </div>
      )}
      {report ? (
        <SourceIdentityPanel report={report} openEvidence={openEvidence} />
      ) : profile ? (
        <p className="source-inspection-loading" role="status">
          Checking identity…
        </p>
      ) : null}
    </div>
  );
}

function SourceState({
  report,
  outcome,
  profileAvailable = true,
}: {
  report?: SourceInspectionReport;
  outcome?: SourceVerificationOutcome;
  profileAvailable?: boolean;
}) {
  if (!profileAvailable)
    return (
      <span className="source-state failed">
        <Icon glyph={AlertTriangle} size="sm" />
        Needs attention
      </span>
    );
  if (report) {
    if (report.state_code === "recognized_exact")
      return (
        <span className="source-state verified">
          <Icon glyph={Check} size="sm" />
          Exact match
        </span>
      );
    if (
      [
        "known_mismatch",
        "source_changed",
        "source_missing",
        "source_could_not_be_checked",
      ].includes(report.state_code)
    )
      return (
        <span className="source-state failed">
          <Icon glyph={AlertTriangle} size="sm" />
          Needs attention
        </span>
      );
    return (
      <span className="source-state">
        <Icon glyph={CircleMinus} size="sm" />
        {report.summary}
      </span>
    );
  }
  if (!outcome) return <span className="source-state">Not checked</span>;
  if (outcome.ok)
    return (
      <span className="source-state verified">
        <Icon glyph={Check} size="sm" />
        Source check passed
      </span>
    );
  return (
    <span className="source-state failed">
      <Icon glyph={AlertTriangle} size="sm" />
      Needs attention
    </span>
  );
}

function AppearanceSettings({ appearance }: { appearance?: ThemeState }) {
  const preference = appearance?.preference ?? "system";
  const resolvedTheme = appearance?.resolvedTheme ?? "dark";
  const options: ThemePreference[] = ["system", "dark", "light"];
  const resolvedLabel = resolvedTheme === "light" ? "Light" : "Dark";
  const status =
    preference === "system"
      ? `Following system · currently ${resolvedLabel}`
      : `Always ${resolvedLabel}`;
  return (
    <article className="settings-card appearance-card" data-focus-group>
      <p className="eyebrow">THEME</p>
      <h2>Color theme</h2>
      <div className="segmented appearance-options" role="group" aria-label="Color theme">
        {options.map((option) => (
          <ThemeOption
            key={option}
            option={option}
            selected={preference === option}
            select={appearance?.setPreference}
          />
        ))}
      </div>
      <p>{status}.</p>
    </article>
  );
}

function AboutCard() {
  return (
    <article className="settings-card about-card" data-focus-group>
      <div className="about-art">
        <BrandWordmark />
        <BrandMascot decorative />
      </div>
      <div className="about-copy">
        <p className="eyebrow">ABOUT &amp; CREDITS</p>
        <h2>One harbor for native ports</h2>
        <p>
          Portcove keeps the desktop and CLI in sync across the catalog, game files, installed
          versions, and recovery history.
        </p>
        <dl className="about-facts">
          <div>
            <dt>Version</dt>
            <dd>{desktopPackage.version}</dd>
          </div>
          <div>
            <dt>Built with</dt>
            <dd>Tauri 2 · Rust · React</dd>
          </div>
          <div>
            <dt>License</dt>
            <dd>MIT or Apache-2.0</dd>
          </div>
        </dl>
        <ExternalLink
          className="small-control button-link"
          href="https://github.com/boburning/portcove"
        >
          Open project repository
        </ExternalLink>
      </div>
    </article>
  );
}

function DiagnosticsCard({
  busy,
  createSupportBundle,
  refreshing,
  stale = true,
  failure,
  refresh,
  hasSnapshot,
}: {
  busy?: string;
  createSupportBundle?: () => Promise<string | undefined>;
  refreshing?: boolean;
  stale?: boolean;
  failure?: unknown;
  refresh?: () => Promise<unknown>;
  hasSnapshot?: boolean;
}) {
  const [bundlePath, setBundlePath] = useState<string>();
  const create = async () => {
    const path = await createSupportBundle?.();
    if (path) setBundlePath(path);
  };
  return (
    <article className="settings-card diagnostics-card" data-focus-group>
      <p className="eyebrow">DIAGNOSTICS</p>
      <h2>
        <Icon glyph={ShieldCheck} />
        Create support bundle
      </h2>
      <p>
        Collect recent logs, operation history, and system details without game-file contents or
        saved credentials.
      </p>
      <details>
        <summary>Review what can remain before sharing</summary>
        <p>
          Paths, file names, port and tool identifiers, timestamps, and other system metadata can
          remain after sensitive values are redacted. Review the bundle before sharing it.
        </p>
      </details>
      <p role="status">
        {refreshing
          ? "Checking current host and library diagnostics…"
          : failure
            ? hasSnapshot
              ? "The last diagnostic snapshot is retained, but the current check failed."
              : "Diagnostics could not be checked."
            : stale
              ? "Diagnostics may be out of date."
              : "Diagnostics are current."}
      </p>
      {failure ? <p role="alert">{errorText(failure)}</p> : null}
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={Boolean(busy) || refreshing || !refresh}
        onClick={() => void refresh?.()}
      >
        {failure ? "Retry diagnostics" : "Refresh diagnostics"}
      </Button>
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={Boolean(busy) || !createSupportBundle}
        onClick={() => {
          void create();
        }}
      >
        Create support bundle
      </Button>
      {bundlePath && (
        <p role="status">
          Saved to <code>{bundlePath}</code>
        </p>
      )}
    </article>
  );
}

function ThemeOption({
  option,
  selected,
  select,
}: {
  option: ThemePreference;
  selected: boolean;
  select?: (preference: ThemePreference) => void;
}) {
  return (
    <Button
      data-focusable
      variant={selected ? "selected" : "ghost"}
      size="sm"
      className="flex-1 capitalize"
      aria-pressed={selected}
      onClick={() => select?.(option)}
    >
      {option[0].toUpperCase() + option.slice(1)}
    </Button>
  );
}

export function SettingsView({
  generation = 0,
  ports = [],
  libraryRoot = "",
  librarySelection,
  chooseLibrary,
  switchLibrary,
  resetLibrary,
  doctor,
  storage,
  github,
  busy,
  sources = [],
  sourceNeeds = [],
  sourceRequirementsState = "loading",
  installedCount = 0,
  sourceOutcomes = [],
  sourceInspections = new Map(),
  verifySources,
  replaceSource,
  addSource,
  appearance,
  createSupportBundle,
  exportMetadata,
  sourceProfiles = [],
  onSourceAdded,
  onCatalogChanged,
  hostToolActions,
  openSourceEvidence,
  applicationUpdateNotice,
  applicationUpdatePreferences,
  diagnosticsRefreshing,
  diagnosticsStale,
  diagnosticFailure,
  refreshDiagnostics,
}: {
  generation?: number;
  ports?: PortDefinition[];
  libraryRoot?: string;
  doctor?: DoctorReport;
  storage?: StorageSummary;
  github?: GithubSettingsActions;
  busy?: string;
  sources?: SourceRecord[];
  librarySelection?: LibrarySelection;
  chooseLibrary?: (currentPath: string) => Promise<string | null>;
  switchLibrary?: (path: string) => Promise<void>;
  resetLibrary?: () => Promise<void>;
  sourceNeeds?: SourceRequirement[];
  sourceRequirementsState?: SourceRequirementsState;
  installedCount?: number;
  sourceOutcomes?: SourceVerificationOutcome[];
  verifySources?: () => void;
  replaceSource?: (source: SourceRecord) => void;
  sourceInspections?: ReadonlyMap<string, SourceInspectionReport>;
  openSourceEvidence?: (evidenceId: string) => void;
  addSource?: (profile: SourceProfile, archive: boolean) => void;
  appearance?: ThemeState;
  createSupportBundle?: () => Promise<string | undefined>;
  exportMetadata?: () => Promise<LibraryMetadataFile | undefined>;
  sourceProfiles?: SourceProfile[];
  onSourceAdded?: () => Promise<unknown>;
  onCatalogChanged?: () => Promise<unknown>;
  hostToolActions?: HostToolActions;
  applicationUpdateNotice?: ApplicationUpdateNoticeSnapshot["notice"];
  applicationUpdatePreferences?: ApplicationUpdatePreferencesState;
  diagnosticsRefreshing?: boolean;
  diagnosticsStale?: boolean;
  diagnosticFailure?: unknown;
  refreshDiagnostics?: () => Promise<unknown>;
}) {
  return (
    <section className="settings-grid">
      <SettingsSection
        id="appearance"
        eyebrow="DISPLAY"
        title="Appearance"
        description="Choose how Portcove looks on this device."
      >
        <AppearanceSettings appearance={appearance} />
        <LanguageSettings />
      </SettingsSection>
      <SettingsSection
        id="library-storage"
        eyebrow="STORAGE LOCATIONS"
        title="Library & Storage"
        description="Choose which Portcove library opens at startup. Each game’s install folder is reviewed separately from its game page."
      >
        <LibrarySelectionCard
          selection={librarySelection}
          busy={busy}
          choose={chooseLibrary}
          switchLibrary={switchLibrary}
          reset={resetLibrary}
        />
        <StorageCard
          libraryRoot={storage?.library_root ?? libraryRoot}
          storage={storage}
          busy={busy}
          exportMetadata={exportMetadata}
        />
      </SettingsSection>
      <SettingsSection
        id="game-files"
        eyebrow="GAME FILES"
        title="Game Files"
        description="Review local game-file sources and the optional disc tools used to verify or prepare them."
      >
        <SourceHealth
          generation={generation}
          ports={ports}
          sources={sources}
          requirements={sourceNeeds}
          requirementsState={sourceRequirementsState}
          installedCount={installedCount}
          outcomes={sourceOutcomes}
          inspections={sourceInspections}
          busy={busy}
          verify={verifySources}
          replace={replaceSource}
          add={addSource}
          profiles={sourceProfiles}
          onAdded={onSourceAdded}
          openEvidence={openSourceEvidence}
        />
        <HostReadiness
          doctor={doctor}
          busy={busy}
          actions={hostToolActions}
          refreshing={diagnosticsRefreshing}
          refresh={refreshDiagnostics}
          stale={diagnosticsStale}
          failure={diagnosticFailure}
        />
      </SettingsSection>
      <SettingsSection
        id="updates"
        eyebrow="UPDATES"
        title="Updates"
        description="Manage verified Portcove application and catalog updates."
        layout="stacked"
      >
        <ApplicationUpdateSettings
          currentVersion={desktopPackage.version}
          generation={generation}
          disabled={Boolean(busy)}
          automaticNotice={applicationUpdateNotice}
          preferencesState={applicationUpdatePreferences}
        />
        <CatalogSettings
          provenance={doctor?.catalog_provenance}
          disabled={Boolean(busy)}
          onChanged={onCatalogChanged}
        />
      </SettingsSection>
      <SettingsSection
        id="integrations"
        eyebrow="INTEGRATIONS"
        title="Integrations"
        description="Connect optional services without changing ordinary local play."
      >
        <GithubSettings github={github} busy={busy} />
      </SettingsSection>
      <SettingsSection
        id="advanced"
        eyebrow="ADVANCED"
        title="Advanced"
        description="Inspect diagnostics, support information, privacy boundaries, and application details."
      >
        <DiagnosticsCard
          busy={busy}
          createSupportBundle={createSupportBundle}
          refreshing={diagnosticsRefreshing}
          stale={diagnosticsStale}
          failure={diagnosticFailure}
          refresh={refreshDiagnostics}
          hasSnapshot={Boolean(doctor)}
        />
        <article className="settings-card privacy-card">
          <p className="eyebrow">PRIVACY</p>
          <h2>Original game files stay local</h2>
          <p>
            Portcove checks original game files locally and does not upload them or collect
            telemetry. Use their current location, copy them into Portcove, or explicitly move them
            after reviewing the consequences. A completed move removes the original after its
            verified copy is registered.
          </p>
        </article>
        <AboutCard />
      </SettingsSection>
    </section>
  );
}

function SettingsSection({
  id,
  eyebrow,
  title,
  description,
  layout = "grid",
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  layout?: "grid" | "stacked";
  children: ReactNode;
}) {
  const headingId = `settings-${id}-heading`;
  return (
    <section className="settings-section" data-settings-group={id} aria-labelledby={headingId}>
      <div className="settings-section-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={headingId}>{title}</h2>
        <p>{description}</p>
      </div>
      <div
        className={`settings-section-content${layout === "stacked" ? " settings-section-content-stacked" : ""}`}
      >
        {children}
      </div>
    </section>
  );
}

export function LibrarySelectionCard({
  selection,
  busy,
  choose,
  switchLibrary,
  reset,
}: {
  selection?: LibrarySelection;
  busy?: string;
  choose?: (currentPath: string) => Promise<string | null>;
  switchLibrary?: (path: string) => Promise<void>;
  reset?: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<{ kind: "switch" | "reset"; path: string }>();
  const [pending, setPending] = useState(false);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const focusReturn = useRef<"switch" | "reset">("switch");
  const chooseCandidate = async () => {
    setError(undefined);
    setPending(true);
    try {
      const path = await choose?.(selection?.root ?? "");
      if (path && path !== selection?.root) {
        focusReturn.current = "switch";
        setReview({ kind: "switch", path });
      }
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(false);
    }
  };
  const cancelReview = () => {
    setReview(undefined);
  };
  const reviewDefault = async () => {
    setError(undefined);
    setPending(true);
    try {
      const path = await desktopApi.defaultLibraryRoot();
      if (!path.trim()) throw new Error("The default library location is unavailable.");
      focusReturn.current = "reset";
      setReview({ kind: "reset", path });
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(false);
    }
  };
  const applyReview = async () => {
    if (!review) return;
    setError(undefined);
    setPending(true);
    try {
      if (review.kind === "switch") await switchLibrary?.(review.path);
      else await reset?.();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(false);
      setReview(undefined);
    }
  };
  const source =
    selection?.source === "saved"
      ? "Saved library"
      : selection?.source === "invocation"
        ? "This launch only"
        : selection?.source === "platform_default"
          ? "Default library"
          : "Selection unavailable";
  return (
    <article className="settings-card" data-focus-group>
      <p className="eyebrow">WHOLE PORTCOVE LIBRARY</p>
      <h2>Library at startup</h2>
      <code>{selection?.root ?? "Unavailable"}</code>
      <p>
        {source}. Opening another library does not move your files. The library you open uses its
        own game install folder settings.
      </p>
      <div className="button-row">
        <Button
          ref={switchTrigger}
          data-library-selection-trigger="switch"
          data-focusable
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || pending || !choose || !switchLibrary}
          onClick={() => {
            void chooseCandidate();
          }}
        >
          Choose another library
        </Button>
        <Button
          ref={resetTrigger}
          data-library-selection-trigger="reset"
          data-focusable
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || pending || !reset}
          onClick={() => {
            void reviewDefault();
          }}
        >
          Use default library
        </Button>
      </div>
      {review && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !pending) cancelReview();
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={() =>
              (focusReturn.current === "reset" ? resetTrigger.current : null) ??
              switchTrigger.current
            }
            className="w-[min(620px,90vw)] max-w-none gap-0 p-8 sm:max-w-none"
            aria-describedby="library-selection-review-description"
          >
            <DialogTitle id="library-selection-review-title" className="mb-2 text-xl">
              {review.kind === "switch"
                ? "Switch whole Portcove library"
                : "Open the default library?"}
            </DialogTitle>
            <DialogDescription
              id="library-selection-review-description"
              className="mb-4 leading-relaxed"
            >
              {review.kind === "switch"
                ? "Portcove will open this library and save it for future launches. A launch override can still select another library for one launch. Existing files stay in place. The library you open uses its own game install folder settings."
                : "Portcove will open the default library shown below and clear the saved library choice. If host preferences are damaged or from a newer format, this also resets saved language and tool paths. Files in the current library will stay where they are. The default library uses its own game install folder settings."}
            </DialogDescription>
            <code className="block break-all">{review.path}</code>
            <DialogFooter className="mt-4">
              <Button
                data-focusable
                variant="primary"
                disabled={pending}
                onClick={() => {
                  void applyReview();
                }}
              >
                {pending
                  ? "Switching…"
                  : review.kind === "switch"
                    ? "Switch whole library"
                    : "Open default library"}
              </Button>
              <Button
                data-focusable
                data-autofocus
                variant="outline"
                disabled={pending}
                onClick={cancelReview}
              >
                Keep current library
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

function HostReadiness({
  doctor,
  busy,
  actions,
  refreshing,
  refresh,
  stale,
  failure,
}: {
  doctor?: DoctorReport;
  busy?: string;
  actions?: HostToolActions;
  refreshing?: boolean;
  refresh?: () => Promise<unknown>;
  stale?: boolean;
  failure?: unknown;
}) {
  return (
    <article className="settings-card host-readiness">
      <p className="eyebrow">HOST</p>
      <h2>
        <Icon glyph={Wrench} />
        Disc tools
      </h2>
      {Boolean(failure) && <p role="alert">Couldn’t check disc tools.</p>}
      {doctor ? (
        <>
          {(stale || Boolean(failure)) && (
            <p role="status">Showing the last successful host check.</p>
          )}
          <p className="host-summary">
            <code>{doctor.platform}</code>
            <span>
              {doctor.catalog_port_count} ports · {doctor.installed_port_count} installed ·{" "}
              {doctor.registered_source_count} sources
            </span>
          </p>
          <div className="host-tool-list">
            {doctor.host_tools.map((tool) => (
              <HostToolRow key={tool.id} tool={tool} busy={Boolean(busy)} actions={actions} />
            ))}
          </div>
        </>
      ) : failure ? (
        <p>Disc-tool status is unavailable until the check succeeds.</p>
      ) : (
        <p>Checking disc-tool availability…</p>
      )}
      {Boolean(failure) && (
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || Boolean(refreshing) || !refresh}
          onClick={() => void refresh?.()}
        >
          {refreshing ? "Checking disc tools…" : "Check disc tools again"}
        </Button>
      )}
      <p>
        These optional tools are used only when Portcove must check, extract, or convert supported
        compressed disc formats.
      </p>
    </article>
  );
}

export function HostToolRow({
  tool,
  busy,
  actions,
  showTechnicalId = true,
}: {
  tool: HostToolStatus;
  busy: boolean;
  actions?: HostToolActions;
  showTechnicalId?: boolean;
}) {
  const [pending, setPending] = useState<string>();
  const [outcome, setOutcome] = useState<HostToolProbeResult>();
  const [error, setError] = useState<string>();
  const run = async (
    name: string,
    operation: () => Promise<HostToolProbeResult | void | undefined> | undefined,
  ) => {
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
  const location = tool.path ?? `Environment variable: ${tool.configuration_variable}`;
  const configured = tool.source === "saved";
  const source =
    tool.source === "saved"
      ? "Saved preference"
      : tool.source === "environment"
        ? "Environment override"
        : tool.source === "discovery"
          ? "Host discovery"
          : "Not resolved";
  return (
    <div className="host-tool-row" data-focus-group>
      <div className="host-tool-heading">
        <strong>{tool.display_name}</strong>
        <span className={`host-tool-state ${tool.state}`}>
          <Icon glyph={state.icon} size="sm" />
          {state.label}
        </span>
      </div>
      <small>{tool.purpose}</small>
      {tool.state === "missing" && (
        <p>{tool.display_name} was not found. Choose its executable to continue.</p>
      )}
      {tool.state === "misconfigured" &&
        (tool.source === "environment" ? (
          <p>Update this tool’s environment override outside Portcove, restart, then recheck it.</p>
        ) : (
          <p>Portcove couldn’t use this executable. Choose it again to continue.</p>
        ))}
      <div className="button-row">
        {tool.source !== "environment" && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={busy || Boolean(pending) || !actions}
            onClick={() => {
              void run("locate", () => actions?.locate(tool));
            }}
          >
            {pending === "locate" ? "Checking…" : `Locate ${tool.display_name}…`}
          </Button>
        )}
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={busy || Boolean(pending) || !actions || !tool.path}
          onClick={() => {
            void run("recheck", () => actions?.recheck(tool.id));
          }}
        >
          {pending === "recheck" ? "Checking…" : "Recheck"}
        </Button>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={busy || Boolean(pending) || !actions}
          onClick={() => {
            void run("site", () => actions?.openOfficial(tool.id));
          }}
        >
          Official site
        </Button>
        {configured && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={busy || Boolean(pending) || !actions}
            onClick={() => {
              void run("clear", () => actions?.clear(tool.id));
            }}
          >
            Clear custom path
          </Button>
        )}
      </div>
      <details className="host-tool-details">
        <summary>Tool details</summary>
        <code title={location}>{location}</code>
        <small>
          {source}
          {showTechnicalId && (
            <>
              {" "}
              · Technical ID: <code>{tool.id}</code>
            </>
          )}
        </small>
      </details>
      {outcome && <p role="status">{outcome.message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function StorageCard({
  libraryRoot,
  storage,
  busy,
  exportMetadata,
}: {
  libraryRoot: string;
  storage?: StorageSummary;
  busy?: string;
  exportMetadata?: () => Promise<LibraryMetadataFile | undefined>;
}) {
  const [exported, setExported] = useState<LibraryMetadataFile>();
  const total = storage?.volume_total_bytes;
  const available = storage?.volume_available_bytes;
  const measurable =
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total > 0 &&
    available >= 0 &&
    available <= total;
  return (
    <article className="settings-card storage-card" data-focus-group>
      <p className="eyebrow">CURRENT LIBRARY</p>
      <h2>
        <Icon glyph={HardDrive} />
        Files and capacity
      </h2>
      <code>{libraryRoot || "Loading…"}</code>
      {measurable ? (
        <div className="storage-capacity">
          <div>
            <strong>{formatBytes(available)} available</strong>
            <span>{formatBytes(total)} total storage capacity</span>
          </div>
          <div
            className="storage-meter"
            role="meter"
            aria-label="Available capacity on the library volume"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={available}
          >
            <i style={{ width: `${(available / total) * 100}%` }} />
          </div>
        </div>
      ) : (
        <p>Storage capacity is unavailable for this location.</p>
      )}
      <p>
        <Icon glyph={ShieldCheck} size="sm" /> Installed application files are kept separate from
        saves and settings.
      </p>
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={Boolean(busy) || !exportMetadata}
        onClick={() => {
          void exportMetadata?.().then(setExported);
        }}
      >
        Export metadata
      </Button>
      <p>
        Export saved game-file locations and installed-version settings. Game files, saves, backups,
        toolchains, and credentials are not included.
      </p>
      {exported && (
        <p role="status">
          Exported to <code>{exported.path}</code>
        </p>
      )}
      <LibraryMoveButton disabled={Boolean(busy)} />
      <LibraryImportButton disabled={Boolean(busy) || !libraryRoot} libraryRoot={libraryRoot} />
    </article>
  );
}
