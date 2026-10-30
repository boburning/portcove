import {
  SidebarCollections,
  type Organization,
} from "../features/organization/OrganizationControls";
import { OperationProgress } from "./OperationProgress";
import { cn } from "cn";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { controlFocus } from "./ui/control-style";
import { ActionRow, Notice, SettingsRow } from "./ui/patterns";
import { SourceRemovalControl } from "./SourceRemoval";
import { SupportBundleExport } from "./SupportBundleExport";
import { desktopApi } from "../api";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  AlertTriangle,
  Compass,
  Check,
  CheckCircle2,
  CircleMinus,
  CircleUserRound,
  Command,
  Download,
  HardDrive,
  Keyboard,
  Gamepad2,
  Library,
  LoaderCircle,
  Monitor,
  Moon,
  Sun,
  Menu as MenuIcon,
  Settings,
  Search,
  Palette,
  Plus,
  FolderOpen,
  Plug,
  Info,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import desktopPackage from "../../package.json";
import type { ThemeState, ThemePreference } from "../theme";
import { InterfaceSizeSettings } from "../InterfaceSize";
import type {
  ActivityRecord,
  PortDefinition,
  PortStatus,
  DesktopSupportBundleExport,
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
  type NavigationActivityState,
  type SourceRequirement,
  type View,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import type { SourceInspectionReadState } from "../features/source-health/use-source-health";
import { BrandAvatar, BrandMascot } from "./Brand";
import { ExternalLink } from "./ExternalLink";
import { LibraryRecovery } from "./LibraryRecovery";
import { CatalogOrigin, CatalogSettings } from "./CatalogUpdates";
import { SourceDiscoveryButton } from "./SourceDiscovery";
import { invocationFailure, type InvocationRecord } from "../features/operations/invocation-state";
import { GameFileLibraries } from "./GameFileLibraries";
import { SourceIdentityPanel } from "./SourceIdentity";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { commandShortcut } from "../keyboard-shortcuts";
import { scrollWorkspaceTo, workspaceScrollTop } from "../workspace-scroll";
import { SteamBatchEntryDialog, SteamEntryDialog } from "./SteamEntry";
import { LanguageSettings } from "./LanguageSettings";
import {
  settingsCategories,
  type SettingsCategory,
} from "../features/app-shell/settings-categories";

export function Sidebar({
  view,
  setView,
  installedCount,
  updateCount,
  activities,
  controller,
  organization,
  collectionView = "all",
  onSelectCollection,
  libraryRoot,
  collectionActions,
}: {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  installedCount: number;
  updateCount: number;
  activities: ActivityRecord[];
  controller?: string | undefined;
  organization?: Organization | undefined;
  collectionView?: string;
  onSelectCollection?: ((id: string) => void) | undefined;
  libraryRoot?: string | undefined;
  collectionActions?: ReactNode;
}) {
  const activityState = navigationActivityState(activities);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const desktopNavigation = useRef<HTMLElement>(null);
  const sheetNavigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 42rem)");
    const closeOnDesktop = () => {
      if (desktop.matches) setNavigationOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const items = [
    { view: "library", label: "Library", icon: Library, shortcut: "1" },
    { view: "catalog", label: "Discover", icon: Compass, shortcut: "2" },
    { view: "updates", label: "Activity", icon: Download, shortcut: "3" },
    { view: "settings", label: "Settings", icon: Settings, shortcut: "4" },
  ] satisfies Array<{
    view: View;
    label: string;
    icon: typeof Library;
    shortcut: string;
  }>;
  const renderNavigationItem = (item: (typeof items)[number], sheet: boolean) => (
    <Tooltip label={`${item.label} · ${commandShortcut(item.shortcut)}`} disabled={sheet}>
      <Button
        data-focusable
        aria-current={view === item.view ? "page" : undefined}
        variant={view === item.view ? "selected" : "ghost"}
        size="lg"
        className={cn(
          "group/nav nav-item flex h-auto min-h-[var(--control-height-lg)] w-full items-center gap-2 border-transparent p-[var(--space-2)_var(--space-3)] text-start font-normal whitespace-normal after:hidden",
          view !== item.view && "text-pc-muted-foreground",
        )}
        onClick={() => {
          setView(item.view);
          setNavigationOpen(false);
        }}
      >
        <Icon glyph={item.icon} />
        <span className="nav-label min-w-0 flex-1">{item.label}</span>
        {item.view === "library" && (
          <b
            className="rounded-pc-sm border border-pc-border px-1 py-0.5 text-xs font-normal text-pc-muted-foreground"
            aria-label={`${installedCount} in library`}
          >
            {installedCount}
          </b>
        )}
        {item.view === "updates" && (updateCount > 0 || activityState) && (
          <NavigationStatus updateCount={updateCount} activityState={activityState} />
        )}
        <Shortcut className="hidden">{commandShortcut(item.shortcut)}</Shortcut>
      </Button>
    </Tooltip>
  );
  const renderNavigation = (sheet = false) => (
    <nav
      ref={sheet ? sheetNavigation : desktopNavigation}
      className="sidebar-navigation flex min-h-0 flex-1 flex-col gap-2"
      aria-label="Primary navigation"
    >
      {items.slice(0, 3).map((item) => (
        <div key={item.view}>{renderNavigationItem(item, sheet)}</div>
      ))}
      {!sheet && organization && onSelectCollection && (
        <SidebarCollections
          organization={organization}
          selected={view === "library" ? collectionView : ""}
          onSelect={onSelectCollection}
        >
          {collectionActions}
        </SidebarCollections>
      )}
      <div className={sheet ? undefined : "sidebar-bottom mt-auto"}>
        {!sheet && libraryRoot && (
          <div className="sidebar-library" title={libraryRoot}>
            <span className="sidebar-library-dot" aria-hidden="true" />
            <span>
              My library<small>On this computer</small>
            </span>
            <Icon glyph={HardDrive} size="sm" />
          </div>
        )}
        {renderNavigationItem(items[3]!, sheet)}
      </div>
    </nav>
  );
  return (
    <aside
      className="sidebar flex min-h-0 flex-col overflow-y-auto bg-[var(--color-bg-navigation)] p-[var(--space-6)_var(--space-3)_var(--space-4)] [border-inline-end:1px_solid_var(--color-border)] max-[65rem]:px-3"
      data-focus-region="sidebar"
    >
      <div className="sidebar-compact-header items-center gap-3">
        <Tooltip label="Navigation">
          <Button
            ref={navigationTrigger}
            data-focusable
            variant="ghost"
            size="icon"
            className="shrink-0 text-pc-muted-foreground"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen(true)}
          >
            <Icon glyph={MenuIcon} />
          </Button>
        </Tooltip>
        <BrandAvatar />
        <span className="min-w-0 flex-1 truncate font-semibold">
          {items.find((item) => item.view === view)?.label}
        </span>
      </div>
      <div className="sidebar-desktop">
        <div className="brand flex items-center gap-3 p-[0_var(--space-2)_var(--space-7)]">
          <BrandAvatar />
          <div>
            <span className="sr-only">Portcove</span>
            <strong
              aria-hidden="true"
              className="block text-[length:var(--text-lg)] tracking-[-0.05em]"
            >
              portcove<span className="text-[var(--color-primary)]">.</span>
            </strong>
          </div>
        </div>
        {renderNavigation()}
        {controller && (
          <div className="sidebar-footer mt-auto">
            <NavigationHints controller={controller} workspace />
          </div>
        )}
      </div>
      <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
        <DialogContent
          className="navigation-sheet top-0 left-0 h-dvh max-h-dvh w-[min(22rem,calc(100%-1rem))] max-w-none translate-x-0 translate-y-0 content-start gap-5 rounded-none sm:max-w-none rtl:right-0 rtl:left-auto"
          aria-describedby={undefined}
          initialFocus={() =>
            sheetNavigation.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? false
          }
          finalFocus={() =>
            window.matchMedia("(min-width: 42rem)").matches
              ? (desktopNavigation.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
                false)
              : navigationTrigger.current
          }
        >
          <DialogTitle>Navigation</DialogTitle>
          {renderNavigation(true)}
          {controller && <NavigationHints controller={controller} workspace />}
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function NavigationStatus({
  updateCount,
  activityState,
}: {
  updateCount: number;
  activityState?: NavigationActivityState | undefined;
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
      className={cn(
        "nav-status inline-flex min-w-5 items-center justify-center gap-1 rounded-pc-md bg-pc-warning-subtle px-2 py-0.5 text-xs text-pc-warning-foreground",
        activityState === "running" && "bg-pc-selection text-pc-selection-foreground",
      )}
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
  portCount,
  libraryCount,
  onOpenCommands,
  onAddGames,
}: {
  view: View;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  portCount?: number;
  libraryCount?: number | undefined;
  onOpenCommands?: () => void;
  onAddGames?: (() => void) | undefined;
}) {
  const copy = pageCopy(view, portCount ?? 0);
  return (
    <header
      data-library-header={view === "library" || undefined}
      data-search-header={view === "catalog" || undefined}
      className={cn(
        "page-header mb-5 flex flex-wrap items-start justify-between gap-4",
        view === "settings" && "mb-8",
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 tabIndex={-1}>{copy.title}</h1>
        {view === "library" && libraryCount !== undefined && (
          <p className="mt-2 mb-0 text-sm text-pc-muted-foreground">
            {libraryCount} library {libraryCount === 1 ? "entry" : "entries"}
          </p>
        )}
        {copy.description && (
          <p className="page-description m-[7px_0_0] max-w-[620px] text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-[var(--color-text-muted)]">
            {copy.description}
          </p>
        )}
      </div>
      <div
        className="header-tools flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2 max-[75rem]:ms-auto"
        data-focus-group
      >
        {onAddGames && (
          <Button
            data-focusable
            data-add-games-trigger
            variant="outline"
            className="max-[42rem]:min-h-8 max-[42rem]:px-2 max-[42rem]:text-xs"
            onClick={onAddGames}
          >
            <Icon glyph={Plus} />
            Add games
          </Button>
        )}
        {onOpenCommands && (
          <Tooltip label={`Commands · ${commandShortcut("K")}`}>
            <Button
              data-focusable
              data-detail-origin={`command-trigger:${view}`}
              variant="ghost"
              size="sm"
              className="command-trigger whitespace-nowrap text-pc-muted-foreground max-[48rem]:size-9 max-[48rem]:shrink-0 max-[48rem]:p-0"
              onClick={onOpenCommands}
              aria-label={`Search games and pages ${commandShortcut("K")}: open command palette`}
            >
              <Icon glyph={Command} />
              <span className="max-[65rem]:hidden">Search games and pages </span>
              <span className="ms-1 text-xs max-[48rem]:hidden">{commandShortcut("K")}</span>
            </Button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

export function WorkspaceToolbar({
  view,
  detailTitle,
  onOpenCommands,
}: {
  view: View;
  detailTitle?: string | undefined;
  onOpenCommands: () => void;
}) {
  const label = {
    library: "Library",
    catalog: "Discover",
    updates: "Activity",
    settings: "Settings",
  }[view];
  return (
    <div className="workspace-toolbar flex min-w-0 items-center justify-between gap-3 border-b border-pc-border text-xs text-pc-muted-foreground">
      <div className="flex min-w-0 items-center gap-3" role="group" aria-label="Current location">
        <span className="max-[42rem]:hidden">Portcove</span>
        <span className="max-[42rem]:hidden" aria-hidden="true">
          /
        </span>
        <span>{label}</span>
        {detailTitle && (
          <>
            <span aria-hidden="true">/</span>
            <span className="truncate">{detailTitle}</span>
          </>
        )}
      </div>
      <Button
        data-focusable
        data-detail-origin={`command-trigger:${view}`}
        variant="outline"
        size="sm"
        className="command-trigger shrink-0 gap-2 font-normal text-pc-muted-foreground"
        onClick={onOpenCommands}
        aria-label={`Search games and pages ${commandShortcut("K")}: open command palette`}
      >
        <Icon glyph={Search} />
        <span className="max-[65rem]:hidden">Search games and pages</span>{" "}
        <Shortcut className="max-[42rem]:hidden">{commandShortcut("K")}</Shortcut>
      </Button>
    </div>
  );
}

function pageCopy(view: View, portCount: number) {
  const copy: Record<View, { title: string; description?: string }> = {
    library: {
      title: "Your library",
    },
    catalog: {
      title: "Discover",
      description: `Browse ${portCount} native game ${portCount === 1 ? "port" : "ports"}.`,
    },
    updates: {
      title: "Activity",
    },
    settings: {
      title: "Settings",
      description: "App preferences and library settings.",
    },
  };
  return copy[view];
}

export function StatusLayer({
  error,
  clearError,
  reviewPreparation,
  reviewCurrentState,
  operation,
  busy,
  featureNotices,
  invocations,
  operationEvents,
  dismissInvocation,
  openActivity,
  preparationRecovery,
}: {
  error?: unknown;
  clearError: () => void;
  reviewPreparation?: (() => void) | undefined;
  reviewCurrentState?: (() => unknown) | undefined;
  operation?: OperationEvent | undefined;
  busy?: string | undefined;
  featureNotices?: ReactNode;
  invocations?: ReadonlyMap<number, InvocationRecord>;
  operationEvents?: ReadonlyMap<string, OperationEvent>;
  dismissInvocation?: (id: number) => void;
  openActivity?: (id?: string) => void;
  preparationRecovery?: (record: InvocationRecord) => (() => void) | undefined;
}) {
  const acknowledgedSuccess = useRef(new Set<number>());
  const [latestSuccess, setLatestSuccess] = useState<number>();
  useLayoutEffect(() => {
    let newest: number | undefined;
    for (const record of invocations?.values() ?? []) {
      if (
        record.phase !== "settled" ||
        record.outcome !== "succeeded" ||
        invocationFailure(record) !== undefined ||
        acknowledgedSuccess.current.has(record.id)
      )
        continue;
      acknowledgedSuccess.current.add(record.id);
      newest = record.id;
    }
    if (newest !== undefined) setLatestSuccess(newest);
  }, [invocations]);
  return (
    <>
      {invocations
        ? [...invocations.values()].map((record) => (
            <div
              key={record.id}
              role="group"
              aria-label={`${record.context.action} · ${record.context.target.label}`}
              data-invocation-id={record.id}
              className={
                record.phase === "settled" &&
                invocationFailure(record) === undefined &&
                record.id !== latestSuccess
                  ? "sr-only"
                  : "mb-3 min-w-0"
              }
            >
              {invocationFailure(record) !== undefined && (
                <ErrorNotice
                  error={invocationFailure(record)}
                  clearError={() => dismissInvocation?.(record.id)}
                  reviewPreparation={preparationRecovery?.(record)}
                  reviewCurrentState={reviewCurrentState}
                  invocation={record}
                  openActivity={openActivity}
                />
              )}
              {record.phase === "pending" ? (
                <>
                  <p className="mb-1 text-sm font-semibold [overflow-wrap:anywhere]">
                    {record.context.action} · {record.context.target.label}
                  </p>
                  <OperationProgress
                    // Invocation and event identities are distinct. Only an actual
                    // explicitly owned ID permits this progress association.
                    operation={
                      record.context.activityId
                        ? operationEvents?.get(record.context.activityId)
                        : undefined
                    }
                    busy={record.outcome ? "refresh current state" : record.name}
                  />
                  {openActivity && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => openActivity(record.context.activityId)}
                    >
                      {record.context.activityId ? "View task in Activity" : "Open Activity"}
                    </Button>
                  )}
                </>
              ) : (
                invocationFailure(record) === undefined &&
                (record.id === latestSuccess ? (
                  <Notice intent="success" className="mb-0 items-center">
                    <p data-slot="notice-body" role="status">
                      {record.context.action} · {record.context.target.label}: finished.
                    </p>
                    <div data-slot="notice-actions">
                      {record.context.activityId && openActivity && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openActivity(record.context.activityId)}
                        >
                          View in Activity
                        </Button>
                      )}
                      {dismissInvocation && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Dismiss completion for ${record.context.action}`}
                          onClick={() => dismissInvocation(record.id)}
                        >
                          Dismiss
                        </Button>
                      )}
                    </div>
                  </Notice>
                ) : record.outcome === "cancelled" ? (
                  <p role="status" className="sr-only">
                    {record.context.action} · {record.context.target.label}: cancelled.
                  </p>
                ) : null)
              )}
            </div>
          ))
        : error != null && (
            <ErrorNotice
              error={error}
              clearError={clearError}
              reviewPreparation={reviewPreparation}
              reviewCurrentState={reviewCurrentState}
            />
          )}
      {featureNotices}
      {!invocations && busy && (
        <OperationProgress
          operation={operation?.type === "finished" ? undefined : operation}
          busy={busy}
        />
      )}
    </>
  );
}

function ErrorNotice({
  error,
  clearError,
  reviewPreparation,
  reviewCurrentState,
  invocation,
  openActivity,
}: {
  error: unknown;
  clearError: () => void;
  reviewPreparation?: (() => void) | undefined;
  reviewCurrentState?: (() => unknown) | undefined;
  invocation?: InvocationRecord | undefined;
  openActivity?: ((id?: string) => void) | undefined;
}) {
  const { presentation, committed, neutral, summary, code, cancelled, readbackOnly } =
    noticePresentation(error, invocation);
  const renderFailureDetails = () => (
    <div>
      {invocation && (
        <p className="mb-1 font-semibold [overflow-wrap:anywhere]">
          {invocation.context.action} · {invocation.context.target.label}
        </p>
      )}
      <strong>
        {readbackOnly
          ? "Action finished; current state could not be refreshed"
          : committed
            ? "Change saved; review the current state"
            : neutral
              ? "Operation cancelled"
              : cancelled
                ? presentation?.mutation_state === "recovery_required"
                  ? "Cancelled operation needs recovery review"
                  : "Cancellation outcome needs review"
                : "Portcove couldn’t finish that action"}
      </strong>
      {!((neutral || committed || cancelled) && summary === "The operation was cancelled.") && (
        <p>{summary}</p>
      )}
      {presentation && (
        <FailureDetails
          presentation={presentation}
          code={code}
          showMutationSummary={!readbackOnly}
        />
      )}
      {invocation?.failure !== undefined && invocation.refreshFailure !== undefined && (
        <p>
          Refreshing the current state also failed: {errorText(invocation.refreshFailure)}. The
          original action result above is retained.
        </p>
      )}
    </div>
  );
  return (
    <Notice
      intent={neutral ? "neutral" : "danger"}
      className=""
      role={neutral ? "status" : "alert"}
    >
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={neutral ? CircleMinus : AlertTriangle} />
      </span>
      <div data-slot="notice-body">{renderFailureDetails()}</div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        {openActivity && invocation && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            onClick={() => openActivity(invocation.context.activityId)}
          >
            {invocation.context.activityId ? "View task in Activity" : "Open Activity"}
          </Button>
        )}
        {reviewCurrentState && presentation?.recovery_actions.includes("review_current_state") && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            onClick={() => void reviewCurrentState()}
          >
            Review current state
          </Button>
        )}
        {reviewPreparation && (
          <Button
            data-focusable
            data-detail-origin="error:preparation-review"
            variant="outline"
            size="sm"
            onClick={reviewPreparation}
          >
            Review setup
          </Button>
        )}
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          aria-label={neutral ? "Dismiss notice" : "Dismiss error"}
          disabled={invocation?.phase === "pending"}
          onClick={clearError}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </Notice>
  );
}

interface GithubSettingsActions {
  status?: GithubAuthStatus | undefined;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
  deviceLogin?: GithubDeviceLogin | undefined;
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

function GithubConnection({ status }: { status?: GithubAuthStatus | undefined }) {
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
  const stateClass = `inline-flex items-center gap-1 rounded-full border px-[9px] py-[5px] text-xs ${
    connected
      ? "border-[var(--color-success-border)] bg-pc-success-subtle text-pc-success-foreground"
      : "border-[var(--color-border-strong)] text-pc-muted-foreground"
  }`;
  const StateIcon = connected ? CheckCircle2 : CircleUserRound;
  return (
    <>
      <div className="settings-title flex items-center justify-between gap-[12px]">
        <h2 className="m-0 flex items-center gap-2">GitHub connection</h2>
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
      <details className="mt-3 text-sm text-pc-muted-foreground">
        <summary className="cursor-pointer font-semibold">Connection details</summary>
        <p className="mt-2 mb-0">Sign-in source: {source}.</p>
        <p className="mt-2 mb-0">{githubQuota(status)}.</p>
        <p className="mt-2 mb-0">
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

function DeviceLogin({ login }: { login?: GithubDeviceLogin | undefined }) {
  if (!login) return null;
  return (
    <div className="flex items-center gap-3 rounded-pc-md border border-[var(--color-warning-border)] bg-pc-warning-subtle p-3">
      <strong className="tracking-[0.12em] text-pc-warning-foreground">
        Enter {login.user_code}
      </strong>
      <span className="text-pc-muted-foreground">
        at{" "}
        <ExternalLink
          className="text-[var(--color-interactive-text)] hover:text-[var(--color-interactive-text-strong)]"
          href={login.verification_uri}
        >
          {login.verification_uri}
        </ExternalLink>
      </span>
      <small className="ml-auto text-pc-muted-foreground">Portcove is waiting for GitHub.</small>
    </div>
  );
}

function TokenEntry({
  github,
  busy,
}: {
  github?: GithubSettingsActions | undefined;
  busy: boolean;
}) {
  if (!github?.status || github.status.authenticated || github.status.source === "environment")
    return null;
  return (
    <div className="mt-4">
      {github?.status?.device_login_available && <p className="mt-0 mb-2">Use a token instead</p>}
      <label className="block font-semibold" htmlFor="github-personal-access-token">
        Personal access token
      </label>
      <div className="mt-2 flex gap-2">
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

function GithubActions({
  github,
  busy,
}: {
  github?: GithubSettingsActions | undefined;
  busy: boolean;
}) {
  const status = github?.status;
  return (
    <div className="actions compact mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
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

function GithubNotes({ status }: { status?: GithubAuthStatus | undefined }) {
  const noteClass = "mt-2.5 block text-pc-muted-foreground";
  if (status?.source === "environment")
    return (
      <small className={noteClass}>
        {status.authenticated
          ? "The active token is managed outside Portcove through an environment variable."
          : "GitHub rejected the environment token. Replace or remove it outside Portcove, then restart Portcove."}
      </small>
    );
  if (status?.source === "credential_store" && !status.authenticated)
    return (
      <small className={noteClass}>
        GitHub no longer accepts the saved sign-in. Sign in again, or sign out to continue
        anonymously.
      </small>
    );
  if (status && !status.device_login_available && !status.authenticated)
    return (
      <small className={noteClass}>
        This version of Portcove does not support GitHub device sign-in. Continue without signing in
        or use a personal access token.
      </small>
    );
  return null;
}

function GithubSettings({
  github,
  busy,
}: {
  github?: GithubSettingsActions | undefined;
  busy?: string | undefined;
}) {
  return (
    <SettingsRow className="col-span-full" data-focus-group>
      <GithubConnection status={github?.status} />
      {github?.status?.device_login_available && <DeviceLogin login={github.deviceLogin} />}
      <TokenEntry github={github} busy={!!busy} />
      <GithubActions github={github} busy={!!busy} />
      <GithubNotes status={github?.status} />
    </SettingsRow>
  );
}

type SourceRequirementsState = "loading" | "available" | "unavailable";
const sourceRequirementsBase = "source-requirements mt-4 mb-5 rounded-pc-lg border p-3.5";
const sourceRequirementsClass = `${sourceRequirementsBase} grid gap-2 border-[var(--color-warning-border)] bg-pc-warning-subtle`;

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
  busy?: string | undefined;
  add?: ((profile: SourceProfile, archive: boolean) => void) | undefined;
}) {
  if (state === "loading")
    return (
      <div className={sourceRequirementsClass}>
        <strong>Checking required game files…</strong>
      </div>
    );
  if (state === "unavailable")
    return (
      <div className={sourceRequirementsClass}>
        <strong>Required game files could not be checked.</strong>
        <small>Retry loading the library before changing saved locations.</small>
      </div>
    );
  if (requirements.length === 0)
    return (
      <div
        className={
          installedCount > 0
            ? "source-requirements complete text-sm font-normal text-pc-muted-foreground [&_strong]:font-normal"
            : sourceRequirementsClass
        }
      >
        <strong>
          {installedCount > 0
            ? "No missing game-file requirements are recorded. Check each game for current file and launch status."
            : "No ports in your library yet. File requirements will appear here after you add a port."}
        </strong>
      </div>
    );
  return (
    <div className={sourceRequirementsClass}>
      <div className="source-requirements-heading flex items-center justify-between gap-3">
        <strong>
          {requirements.length} game-file{" "}
          {requirements.length === 1 ? "requirement" : "requirements"}{" "}
          {requirements.length === 1 ? "needs" : "need"} attention
        </strong>
        <small className="text-[length:var(--text-2xs)] tracking-[0.06em] text-pc-warning-foreground uppercase">
          Required by ports in your library
        </small>
      </div>
      {requirements.map((requirement) => (
        <div
          className="source-requirement flex items-center justify-between gap-4 rounded-pc-md bg-pc-surface p-2.5"
          data-source-profile={requirement.profile.id}
          tabIndex={-1}
          key={requirement.profile.id}
        >
          <div className="min-w-0">
            <strong className="block">{requirement.profile.label}</strong>
            <small className="mt-1 block overflow-hidden text-[length:var(--text-2xs)] text-ellipsis whitespace-nowrap text-pc-muted-foreground">
              {requirement.requiredBy.map((use) => `${use.portName} · ${use.role}`).join("  /  ")}
            </small>
          </div>
          <div className="source-health-actions flex flex-wrap items-center gap-2.5">
            <Button
              data-focusable
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => add?.(requirement.profile, false)}
            >
              {requirement.requiredBy.every((use) => use.role === "BIOS")
                ? "Add BIOS file"
                : "Add game files"}
            </Button>
            {(requirement.profile.kind === "file-set" ||
              requirement.profile.kind === "relative-file-set") && (
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

type SourceInspectionReadback = {
  reports: ReadonlyMap<string, SourceInspectionReport>;
  reads: ReadonlyMap<string, SourceInspectionReadState>;
  retry: (profileId: string) => Promise<void>;
};

function SourceHealth({
  generation,
  ports,
  sources,
  requirements,
  requirementsState,
  installedCount,
  outcomes,
  inspections: inspectionInput,
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
  busy?: string | undefined;
  verify?: (() => void) | undefined;
  replace?: ((source: SourceRecord) => void) | undefined;
  requirements: SourceRequirement[];
  requirementsState: SourceRequirementsState;
  installedCount: number;
  add?: ((profile: SourceProfile, archive: boolean) => void) | undefined;
  profiles: SourceProfile[];
  inspections: ReadonlyMap<string, SourceInspectionReport> | SourceInspectionReadback;
  onAdded?: (() => Promise<unknown>) | undefined;
  openEvidence?: ((evidenceId: string) => void) | undefined;
}) {
  const inspection =
    "reports" in inspectionInput
      ? inspectionInput
      : {
          reports: inspectionInput,
          reads: new Map<string, SourceInspectionReadState>(),
          retry: undefined,
        };
  const byProfile = new Map(outcomes.map((outcome) => [outcome.profile_id, outcome]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  return (
    <SettingsRow className="source-health col-span-full min-h-0" data-focus-group>
      <div className="settings-title flex items-center justify-between gap-[12px]">
        <h2 className="m-0 flex items-center gap-2">Game files and BIOS</h2>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={!!busy || sources.length === 0}
          onClick={verify}
        >
          Check saved files
        </Button>
      </div>
      <SourceRequirements
        requirements={requirements}
        state={requirementsState}
        installedCount={installedCount}
        busy={busy}
        add={add}
      />
      <div className="justify-self-start">
        <SourceDiscoveryButton
          profiles={profiles}
          disabled={Boolean(busy) || requirementsState !== "available"}
          onAdded={onAdded}
        />
      </div>
      {requirementsState === "available" &&
        (sources.length === 0 ? (
          <p>No game files or BIOS files have been added yet.</p>
        ) : (
          <div className="source-health-list my-4 grid gap-2">
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
                report={inspection.reports.get(source.profile_id)}
                inspectionRead={inspection.reads.get(source.profile_id)}
                retryInspection={inspection.retry}
                outcome={byProfile.get(source.profile_id)}
                busy={busy}
                replace={replace}
                openEvidence={openEvidence}
              />
            ))}
          </div>
        ))}
      <p>
        File checks run locally without uploading or changing your originals. Copying or moving
        files requires a separate review. When you choose a replacement location, Portcove confirms
        that the file is an exact match before saving the new path.
      </p>
    </SettingsRow>
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
  inspectionRead,
  retryInspection,
  outcome,
  busy,
  replace,
  openEvidence,
}: {
  generation: number;
  ports: PortDefinition[];
  onRemoved?: (() => Promise<unknown>) | undefined;
  source: SourceRecord;
  sourcePosition: number;
  sourceCount: number;
  profile?: SourceProfile | undefined;
  report?: SourceInspectionReport | undefined;
  inspectionRead?: SourceInspectionReadState | undefined;
  retryInspection?: ((profileId: string) => Promise<void>) | undefined;
  outcome?: SourceVerificationOutcome | undefined;
  busy?: string | undefined;
  replace?: ((source: SourceRecord) => void) | undefined;
  openEvidence?: ((evidenceId: string) => void) | undefined;
}) {
  return (
    <div
      className="source-health-row grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-pc-border py-4 last:border-b-0"
      data-source-profile={source.profile_id}
      tabIndex={-1}
    >
      <div className="min-w-0">
        <strong>
          {report?.expected_identity?.label ??
            profile?.label ??
            "Saved game-file requirement unavailable"}
        </strong>
        <code className="mt-1 block overflow-hidden bg-transparent p-0 text-ellipsis whitespace-nowrap text-pc-muted-foreground">
          {source.path}
        </code>
      </div>
      <div className="source-health-actions flex flex-wrap items-center gap-2.5">
        <SourceInspectionState
          read={inspectionRead}
          report={report}
          outcome={outcome}
          profileAvailable={Boolean(profile)}
        />
        {profile && (
          <Button
            data-focusable
            data-settings-control="relink-source"
            variant="outline"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => replace?.(source)}
          >
            Update file location
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
        <div className="min-w-0">
          <p>
            This saved file requirement is no longer present in the current catalog. Update the
            catalog or remove the saved location.
          </p>
          <details>
            <summary
              data-focusable
              aria-label={`Technical details for saved file location ${source.path}, saved reference ${sourcePosition} of ${sourceCount}`}
            >
              Technical details
            </summary>
            <small>
              Catalog profile ID:{" "}
              <code className="source-profile-id mt-1 block bg-transparent p-0 [overflow-wrap:anywhere] text-pc-muted-foreground">
                {source.profile_id}
              </code>
            </small>
          </details>
        </div>
      )}
      {outcome?.error && (
        <div className="min-w-0">
          <p className="text-pc-danger-foreground">Saved-file check did not pass.</p>
          <FailureDetails
            presentation={outcome.error.presentation}
            code={outcome.error.code}
            showMutationSummary={false}
          />
        </div>
      )}
      {(profile || report) && (
        <SourceInspectionPresentation
          read={inspectionRead}
          report={report}
          profileId={source.profile_id}
          retry={retryInspection}
          disabled={Boolean(busy)}
          openEvidence={openEvidence}
        />
      )}
    </div>
  );
}

function SourceInspectionState({
  read,
  ...props
}: {
  read?: SourceInspectionReadState | undefined;
  report?: SourceInspectionReport | undefined;
  outcome?: SourceVerificationOutcome | undefined;
  profileAvailable: boolean;
}) {
  if (!props.profileAvailable || !read || read.status === "current")
    return <SourceState {...props} />;
  const label =
    read.status === "idle"
      ? "Not checked"
      : read.status === "pending"
        ? "Checking"
        : read.status === "cancelled"
          ? "Check cancelled"
          : "Check unavailable";
  return (
    <span className="source-state inline-flex items-center gap-1 text-xs text-pc-muted-foreground">
      {label}
    </span>
  );
}

function SourceInspectionPresentation({
  read,
  report,
  profileId,
  retry,
  disabled,
  openEvidence,
}: {
  read?: SourceInspectionReadState | undefined;
  report?: SourceInspectionReport | undefined;
  profileId: string;
  retry?: ((profileId: string) => Promise<void>) | undefined;
  disabled: boolean;
  openEvidence?: ((evidenceId: string) => void) | undefined;
}) {
  const currentReport = !read || read.status === "current" ? report : undefined;
  const message = sourceInspectionMessage(read);
  return (
    <div className="col-span-full min-w-0">
      <div>
        {currentReport ? (
          <SourceIdentityPanel report={currentReport} openEvidence={openEvidence} />
        ) : (
          <p
            className={
              read?.status === "pending"
                ? "source-inspection-loading text-[var(--color-text-muted)]"
                : undefined
            }
            role="status"
          >
            {message}
          </p>
        )}
        {read?.failure && (
          <FailureDetails
            presentation={read.failure}
            code={read.code}
            showMutationSummary={false}
          />
        )}
      </div>
      {read && retry && (
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={disabled || read.status === "pending"}
          onClick={() => void retry(profileId)}
        >
          {read.status === "idle"
            ? "Check file"
            : read.status === "failed" || read.status === "cancelled"
              ? "Retry file check"
              : "Check file again"}
        </Button>
      )}
    </div>
  );
}

function SourceState({
  report,
  outcome,
  profileAvailable = true,
}: {
  report?: SourceInspectionReport | undefined;
  outcome?: SourceVerificationOutcome | undefined;
  profileAvailable?: boolean;
}) {
  const base = "source-state inline-flex items-center gap-1 text-xs";
  const neutral = `${base} text-pc-muted-foreground`;
  const verified = `${base} verified text-pc-success-foreground`;
  const failed = `${base} failed text-pc-danger-foreground`;
  if (!profileAvailable)
    return (
      <span className={failed}>
        <Icon glyph={AlertTriangle} size="sm" />
        Needs attention
      </span>
    );
  if (report) {
    if (report.state_code === "recognized_exact")
      return (
        <span className={verified}>
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
        <span className={failed}>
          <Icon glyph={AlertTriangle} size="sm" />
          Needs attention
        </span>
      );
    return (
      <span className={neutral}>
        <Icon glyph={CircleMinus} size="sm" />
        {report.summary}
      </span>
    );
  }
  if (!outcome) return <span className={neutral}>Not checked</span>;
  if (outcome.ok)
    return (
      <span className={verified}>
        <Icon glyph={Check} size="sm" />
        File check passed
      </span>
    );
  return (
    <span className={failed}>
      <Icon glyph={AlertTriangle} size="sm" />
      Needs attention
    </span>
  );
}

function AppearanceSettings({ appearance }: { appearance?: ThemeState | undefined }) {
  const preference = appearance?.preference ?? "system";
  const resolvedTheme = appearance?.resolvedTheme ?? "dark";
  const options: ThemePreference[] = ["dark", "light", "system"];
  const resolvedLabel = resolvedTheme === "light" ? "Light" : "Dark";
  const status =
    preference === "system"
      ? `Following system · currently ${resolvedLabel}`
      : `Always ${resolvedLabel}`;
  return (
    <SettingsRow className="appearance-card" data-focus-group>
      <h3>Color theme</h3>
      <p>{status}.</p>
      <RadioGroup
        value={preference}
        onValueChange={(value) => {
          if (options.includes(value)) appearance?.setPreference(value);
        }}
        className="appearance-options grid w-full max-w-[40.625rem] grid-cols-3 gap-3"
        aria-label="Color theme"
      >
        {options.map((option) => (
          <ThemeOption key={option} option={option} />
        ))}
      </RadioGroup>
    </SettingsRow>
  );
}

function AboutCard({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  return (
    <div className="about-card" data-focus-group>
      <SettingsRow className="settings-field-row mb-4 gap-5 rounded-[7px] border border-pc-border bg-pc-surface p-6">
        <div className="settings-field-copy">
          <h3>Portcove {desktopPackage.version}</h3>
          <p>Tauri 2 · Rust · React</p>
          <p>Licensed under MIT or Apache-2.0.</p>
        </div>
        <ExternalLink
          className="settings-field-control inline-flex min-h-10 items-center rounded-pc-md border border-pc-border px-3 py-2 text-sm no-underline hover:bg-pc-secondary"
          href="https://github.com/boburning/portcove"
        >
          Open project repository
        </ExternalLink>
      </SettingsRow>
      <SettingsRow className="settings-field-row mb-4 gap-5 rounded-[7px] border border-pc-border bg-pc-surface p-6">
        <div className="settings-field-copy">
          <h3>Support</h3>
          <p>Review diagnostics or create a support bundle.</p>
        </div>
        <Button
          data-focusable
          variant="outline"
          className="settings-field-control justify-self-start"
          onClick={onOpenDiagnostics}
        >
          Open diagnostics
        </Button>
      </SettingsRow>
    </div>
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
  busy?: string | undefined;
  createSupportBundle?: (() => Promise<DesktopSupportBundleExport | undefined>) | undefined;
  refreshing?: boolean | undefined;
  stale?: boolean | undefined;
  failure?: unknown;
  refresh?: (() => Promise<unknown>) | undefined;
  hasSnapshot?: boolean | undefined;
}) {
  return (
    <SettingsRow className="diagnostics-card" data-focus-group>
      <h2 className="flex items-center gap-2">
        <Icon glyph={ShieldCheck} />
        Create support bundle
      </h2>
      <p role="status">
        {refreshing
          ? "Checking current host and library diagnostics…"
          : failure
            ? hasSnapshot
              ? "Couldn't refresh diagnostics. Showing the last results."
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
        className="justify-self-start"
        onClick={() => void refresh?.()}
      >
        {failure ? "Retry diagnostics" : "Refresh diagnostics"}
      </Button>
      <SupportBundleExport disabled={Boolean(busy)} createSupportBundle={createSupportBundle} />
    </SettingsRow>
  );
}

function ThemeOption({ option }: { option: ThemePreference }) {
  return (
    <Radio.Root
      data-focusable
      value={option}
      className={`theme-option grid min-w-0 cursor-pointer justify-items-start gap-2 rounded-pc-md border-2 border-pc-border p-2 text-sm font-normal text-pc-muted-foreground data-checked:border-pc-interactive data-checked:text-pc-foreground ${controlFocus}`}
    >
      <span className="theme-preview" data-preview={option} aria-hidden="true">
        <i />
        <span>
          <b />
          <b />
          <b />
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 text-start">
        <Icon glyph={option === "dark" ? Moon : option === "light" ? Sun : Monitor} size="sm" />
        <span className="min-w-0">
          {option === "system" ? "Follow system" : option.charAt(0).toUpperCase() + option.slice(1)}
        </span>
        <Radio.Indicator className="ms-auto shrink-0">
          <Icon glyph={Check} size="sm" />
        </Radio.Indicator>
      </span>
    </Radio.Root>
  );
}

type SettingsViewProps = {
  steamPorts?: PortDefinition[];
  category?: SettingsCategory | undefined;
  onCategoryChange?: ((category: SettingsCategory) => void) | undefined;
  generation?: number;
  ports?: PortDefinition[];
  statuses?: ReadonlyMap<string, PortStatus>;
  libraryRoot?: string;
  doctor?: DoctorReport | undefined;
  storage?: StorageSummary | undefined;
  github?: GithubSettingsActions | undefined;
  busy?: string | undefined;
  sources?: SourceRecord[];
  workspaceRefreshFailed?: boolean;
  librarySelection?: LibrarySelection | undefined;
  chooseLibrary?: (currentPath: string) => Promise<string | null>;
  switchLibrary?: ((path: string) => Promise<void>) | undefined;
  resetLibrary?: () => Promise<void>;
  sourceNeeds?: SourceRequirement[];
  sourceRequirementsState?: SourceRequirementsState;
  installedCount?: number;
  sourceOutcomes?: SourceVerificationOutcome[];
  verifySources?: () => void;
  replaceSource?: (source: SourceRecord) => void;
  sourceInspections?: ReadonlyMap<string, SourceInspectionReport> | SourceInspectionReadback;
  openSourceEvidence?: (evidenceId: string) => void;
  addSource?: (profile: SourceProfile, archive: boolean) => void;
  appearance?: ThemeState | undefined;
  createSupportBundle?: (() => Promise<DesktopSupportBundleExport | undefined>) | undefined;
  exportMetadata?: (() => Promise<LibraryMetadataFile | undefined>) | undefined;
  sourceProfiles?: SourceProfile[];
  onSourceAdded?: () => Promise<unknown>;
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  setupSource?: SourceRecord | undefined;
  setSetupSource?: (source?: SourceRecord) => void;
  onCatalogChanged?: () => Promise<unknown>;
  onOpenGameUpdates?: () => void;
  onOpenActivity?: () => void;
  onReviewSaves?: (portId: string, origin: string) => void;
  hostToolActions?: HostToolActions | undefined;
  applicationUpdates?: ReactNode;
  diagnosticsRefreshing?: boolean;
  diagnosticsStale?: boolean;
  diagnosticFailure?: unknown;
  refreshDiagnostics?: () => Promise<unknown>;
};

export function SettingsView(props: SettingsViewProps) {
  const {
    category,
    onCategoryChange,
    steamPorts = [],
    generation = 0,
    ports = [],
    statuses = new Map(),
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
    workspaceRefreshFailed = false,
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
    onOpenPort,
    setupSource,
    setSetupSource,
    onCatalogChanged,
    onOpenGameUpdates,
    onOpenActivity,
    onReviewSaves,
    hostToolActions,
    openSourceEvidence,
    applicationUpdates,
    diagnosticsRefreshing,
    diagnosticsStale,
    diagnosticFailure,
    refreshDiagnostics,
  } = props;

  const [localCategory, setLocalCategory] = useState<SettingsCategory>("appearance");
  const selectedCategory = category ?? localCategory;
  const [steamOpen, setSteamOpen] = useState(false);

  const renderCategoryNavigation = () => (
    <nav
      className="settings-section-index sticky top-0 z-10 flex min-w-0 flex-nowrap items-start gap-1 overflow-x-auto bg-pc-background py-2 min-[56.3125rem]:flex-col min-[56.3125rem]:overflow-visible"
      aria-label="Settings categories"
      data-focus-group
    >
      {settingsCategories.map(({ id, label }) => (
        <Button
          key={id}
          data-focusable
          variant={selectedCategory === id ? "selected" : "ghost"}
          size="sm"
          className={cn(
            "max-w-full shrink-0 justify-start gap-2.5 border-transparent text-start font-normal whitespace-nowrap after:hidden min-[56.3125rem]:w-full min-[56.3125rem]:whitespace-normal",
            selectedCategory !== id && "text-pc-muted-foreground",
          )}
          aria-current={selectedCategory === id ? "page" : undefined}
          aria-controls={`settings-${id}`}
          onClick={() => {
            (onCategoryChange ?? setLocalCategory)(id);
            jumpToSettingsSection(id);
          }}
        >
          <Icon
            glyph={
              {
                appearance: Palette,
                "library-storage": HardDrive,
                "game-files": FolderOpen,
                updates: Download,
                integrations: Plug,
                controls: Keyboard,
                advanced: Wrench,
                about: Info,
              }[id]
            }
          />
          {label}
        </Button>
      ))}
    </nav>
  );
  const renderStorageSettings = () => (
    <SettingsSection
      id="library-storage"
      active={selectedCategory === "library-storage"}
      title="Library and storage"
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
        showLocation={
          !librarySelection?.root ||
          librarySelection.root !== (storage?.library_root ?? libraryRoot)
        }
      />
      <LibraryRecovery
        key={generation}
        libraryRoot={storage?.library_root ?? libraryRoot}
        ports={ports}
        statuses={statuses}
        busy={busy}
        exportMetadata={exportMetadata}
        onOpenActivity={onOpenActivity}
        onReviewSaves={onReviewSaves}
      />
    </SettingsSection>
  );
  const renderGameFileSettings = () => (
    <SettingsSection
      id="game-files"
      active={selectedCategory === "game-files"}
      title="Game files"
      description="Review saved file locations and the optional disc tools used to check or prepare files."
    >
      <GameFileLibraries
        key={generation}
        generation={generation}
        ports={ports}
        statuses={statuses}
        profiles={sourceProfiles}
        registeredSources={sources}
        workspaceRefreshFailed={workspaceRefreshFailed}
        onAdded={onSourceAdded}
        onOpenPort={onOpenPort}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
      />
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
  );
  const renderAdvancedSettings = () => (
    <SettingsSection
      id="advanced"
      active={selectedCategory === "advanced"}
      title="Advanced"
      description="Review custom catalog sources, diagnostic tools and privacy information."
    >
      <CatalogSettings
        provenance={doctor?.catalog_provenance}
        disabled={Boolean(busy)}
        onChanged={onCatalogChanged}
      />
      <DiagnosticsCard
        busy={busy}
        createSupportBundle={createSupportBundle}
        refreshing={diagnosticsRefreshing}
        stale={diagnosticsStale}
        failure={diagnosticFailure}
        refresh={refreshDiagnostics}
        hasSnapshot={Boolean(doctor)}
      />
      <SettingsRow className="privacy-card">
        <h2>Original game files stay local</h2>
        <p>
          Portcove checks game files locally and does not upload them or collect telemetry. Use
          their current location, copy them into Portcove, or explicitly move them after reviewing
          the consequences. A completed move removes the original after its verified copy is
          registered.
        </p>
      </SettingsRow>
    </SettingsSection>
  );
  const renderUpdateSettings = () => (
    <SettingsSection
      id="updates"
      active={selectedCategory === "updates"}
      title="Portcove & catalog updates"
      description="Manage verified Portcove application and catalog updates here. Open Updates in Activity for game updates."
      action={
        onOpenGameUpdates && (
          <Button data-focusable variant="link" size="xs" onClick={onOpenGameUpdates}>
            Open game updates in Activity
          </Button>
        )
      }
    >
      {applicationUpdates}
      <SettingsRow>
        <h2>Game catalog</h2>
        <CatalogOrigin provenance={doctor?.catalog_provenance} />
        <p>
          Portcove ships with a built-in catalog. Application updates may include new games and port
          information. A signed catalog you explicitly install can replace it.
        </p>
        <Button
          data-focusable
          variant="link"
          onClick={() => {
            (onCategoryChange ?? setLocalCategory)("advanced");
            jumpToSettingsSection("advanced");
          }}
        >
          Manage custom catalog sources
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
  return (
    <section className="settings-grid grid max-w-[62rem] items-start gap-8 min-[56.3125rem]:grid-cols-[11.875rem_minmax(0,47.5rem)]">
      {renderCategoryNavigation()}
      <div className="min-w-0">
        <SettingsSection
          id="appearance"
          active={selectedCategory === "appearance"}
          title="Appearance"
          description="Choose how Portcove looks on this device."
        >
          <AppearanceSettings appearance={appearance} />
          <InterfaceSizeSettings />
          <LanguageSettings />
        </SettingsSection>
        {renderStorageSettings()}
        {renderGameFileSettings()}
        {renderUpdateSettings()}
        <SettingsSection
          id="integrations"
          active={selectedCategory === "integrations"}
          title="Integrations"
          description="Connect optional services. You don't need an account to play."
        >
          <SettingsRow>
            <h2>Steam shortcuts</h2>
            <p>
              Add installed games to Steam to launch them from your Steam library. Review each
              shortcut before making changes.
            </p>
            {steamPorts.length > 0 ? (
              <Button data-focusable variant="outline" onClick={() => setSteamOpen(true)}>
                <Icon glyph={Gamepad2} />
                Choose games for Steam…
              </Button>
            ) : (
              <p>Install a game to add a Steam shortcut.</p>
            )}
            {steamOpen && steamPorts.length === 1 && steamPorts[0] ? (
              <SteamEntryDialog
                port={steamPorts[0]}
                installed
                generation={generation}
                close={() => setSteamOpen(false)}
              />
            ) : steamOpen ? (
              <SteamBatchEntryDialog
                ports={steamPorts}
                generation={generation}
                close={() => setSteamOpen(false)}
              />
            ) : null}
          </SettingsRow>
          <GithubSettings github={github} busy={busy} />
        </SettingsSection>
        <SettingsSection
          id="controls"
          active={selectedCategory === "controls"}
          title="Keyboard and controller"
          description="Move around Portcove without reaching for a mouse."
        >
          <SettingsRow>
            <h2>Keyboard shortcuts</h2>
            <dl className="divide-y divide-pc-border">
              {[
                ["Search games and pages", commandShortcut("K")],
                ["Search the current Library or Discover view", commandShortcut("F")],
                ["Open Library", commandShortcut("1")],
                ["Open Discover", commandShortcut("2")],
                ["Open Activity", commandShortcut("3")],
                ["Open Settings", commandShortcut("4")],
              ].map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between gap-4 py-3 text-sm">
                  <dt>{label}</dt>
                  <dd className="shrink-0">
                    <Shortcut>{keys}</Shortcut>
                  </dd>
                </div>
              ))}
            </dl>
          </SettingsRow>
          <SettingsRow>
            <h2>Controller navigation</h2>
            <p>
              Connect a controller to navigate Portcove. Use the D-pad or stick to move, the confirm
              button to select, and the back button to go back or open navigation. Shoulder buttons
              switch sections.
            </p>
            <p>
              Controller navigation is available automatically while Portcove is in focus. In-game
              controls are managed by each game.
            </p>
          </SettingsRow>
        </SettingsSection>
        {renderAdvancedSettings()}
        <SettingsSection
          id="about"
          active={selectedCategory === "about"}
          title="Portcove"
          headingLabel="About Portcove"
          identity={<BrandMascot className="mb-5 size-14" decorative transparent />}
          description="Install, update, and play native game ports."
        >
          <AboutCard
            onOpenDiagnostics={() => {
              (onCategoryChange ?? setLocalCategory)("advanced");
              jumpToSettingsSection("advanced");
            }}
          />
        </SettingsSection>
      </div>
    </section>
  );
}

function SettingsSection({
  active = true,
  id,
  title,
  description,
  headingLabel,
  identity,
  action,
  children,
}: {
  active?: boolean;
  id: string;
  title: string;
  description: string;
  headingLabel?: string;
  identity?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `settings-${id}-heading`;
  return (
    <section
      id={`settings-${id}`}
      hidden={!active}
      className={cn(
        "settings-section @container/section",
        identity ? "gap-0" : "gap-6",
        active ? "grid" : "hidden",
      )}
      data-settings-group={id}
      aria-labelledby={headingId}
    >
      <div className={cn("settings-section-heading", identity ? "about-identity" : "py-2")}>
        {identity}
        <h2
          id={headingId}
          tabIndex={-1}
          aria-label={headingLabel}
          className={cn(
            "scroll-mt-3 focus:outline-3 focus:outline-offset-3 focus:outline-pc-ring focus:outline-solid",
            identity ? "m-0 text-[2.2rem] tracking-[-0.035em]" : "mb-1 text-[1.25rem]",
          )}
        >
          {title}
        </h2>
        <p
          className={cn(
            "settings-section-description leading-[var(--leading-relaxed)] text-pc-muted-foreground",
            identity ? "mt-4 max-w-[24.375rem] text-xs" : "m-0 max-w-[52rem]",
          )}
        >
          {description}
        </p>
        {action}
      </div>
      <div className="settings-section-content min-w-0">{children}</div>
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
  selection?: LibrarySelection | undefined;
  busy?: string | undefined;
  choose?: ((currentPath: string) => Promise<string | null>) | undefined;
  switchLibrary?: ((path: string) => Promise<void>) | undefined;
  reset?: (() => Promise<void>) | undefined;
}) {
  const [error, setError] = useState<unknown>();
  const presentation = failurePresentation(error);
  const [review, setReview] = useState<{ kind: "switch" | "reset"; path: string }>();
  const [pending, setPending] = useState(false);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const keepLibraryButton = useRef<HTMLButtonElement>(null);
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
      setError(value);
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
      setError(value);
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
      setError(value);
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
    <SettingsRow className="" data-focus-group>
      <h2>Library at startup</h2>
      <p className="m-0 text-sm text-pc-muted-foreground">Entire library · {source}</p>
      <code className="block rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-3 text-xs [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
        {selection?.root ?? "Unavailable"}
      </code>
      <p>
        Opening another library does not move your files. The library you open uses its own game
        install folder settings.
      </p>
      <ActionRow>
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
      </ActionRow>
      {review && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !pending) cancelReview();
          }}
        >
          <DialogContent
            initialFocus={keepLibraryButton}
            showCloseButton={false}
            finalFocus={() =>
              (focusReturn.current === "reset" ? resetTrigger.current : null) ??
              switchTrigger.current
            }
            className="w-[min(620px,90vw)] max-w-none gap-0 p-8 sm:max-w-none"
            aria-describedby="library-selection-review-description"
          >
            <DialogTitle id="library-selection-review-title" className="mb-2 text-xl">
              {review.kind === "switch" ? "Switch libraries?" : "Open the default library?"}
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
                    ? "Switch library"
                    : "Open default library"}
              </Button>
              <Button
                data-focusable
                ref={keepLibraryButton}
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
      {error !== undefined && (
        <div role="alert">
          <p>{errorText(error)}</p>
          {presentation && <FailureDetails presentation={presentation} />}
        </div>
      )}
    </SettingsRow>
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
  doctor?: DoctorReport | undefined;
  busy?: string | undefined;
  actions?: HostToolActions | undefined;
  refreshing?: boolean | undefined;
  refresh?: (() => Promise<unknown>) | undefined;
  stale?: boolean | undefined;
  failure?: unknown;
}) {
  return (
    <SettingsRow className="col-span-full min-h-0">
      <h2 className="flex items-center gap-2" id="disc-tools-heading" tabIndex={-1}>
        <Icon glyph={Wrench} />
        Disc tools
      </h2>
      <p className="m-0 text-sm text-pc-muted-foreground">On this device</p>
      {Boolean(failure) && <p role="alert">Couldn’t check disc tools.</p>}
      {doctor ? (
        <>
          {(stale || Boolean(failure)) && (
            <p role="status">Showing the last successful host check.</p>
          )}
          <p className="host-summary mb-3 flex items-center justify-between gap-3">
            <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-pc-muted-foreground">
              {doctor.platform}
            </code>
            <span className="text-end text-xs text-pc-muted-foreground">
              {doctor.catalog_port_count} ports · {doctor.installed_port_count} installed ·{" "}
              {doctor.registered_source_count} sources
            </span>
          </p>
          <div className="mb-4 grid grid-cols-1 gap-2 @min-[32rem]/section:grid-cols-2">
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
    </SettingsRow>
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
  actions?: HostToolActions | undefined;
  showTechnicalId?: boolean;
}) {
  const [pending, setPending] = useState<string>();
  const identity = JSON.stringify([tool.id, tool.path, tool.source, tool.state]);
  const current = useRef({ identity, tool, revision: 0 });
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [feedback, setFeedback] = useState<{
    identity: string;
    outcome?: HostToolProbeResult;
    error?: string;
  }>();
  useLayoutEffect(() => {
    const changed = current.current.identity !== identity;
    const revision = current.current.revision + Number(changed);
    current.current = { identity, tool, revision };
    if (changed) setFeedback(undefined);
  }, [identity, tool]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visibleFeedback = feedback?.identity === identity ? feedback : undefined;
  const run = async (
    name: string,
    operation: () => Promise<HostToolProbeResult | void | undefined> | undefined,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const started = current.current;
    setPending(name);
    setFeedback(undefined);
    try {
      const result = await operation();
      const observed = current.current;
      const ownLocatedPath =
        name === "locate" &&
        result?.state === "success" &&
        result.persisted &&
        result.tool_id === started.tool.id &&
        observed.tool.id === result.tool_id &&
        observed.tool.path === result.path &&
        observed.tool.source === "saved" &&
        observed.tool.state === "available";
      if (mounted.current && result && (observed.revision === started.revision || ownLocatedPath))
        setFeedback({ identity: observed.identity, outcome: result });
    } catch (value) {
      if (mounted.current && current.current.revision === started.revision)
        setFeedback({
          identity: started.identity,
          error: errorText(value),
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(undefined);
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
    <div
      className="host-tool-row grid min-w-0 gap-1 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-3"
      data-focus-group
      data-host-tool-id={tool.id}
      tabIndex={-1}
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{tool.display_name}</strong>
        <span
          className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${
            tool.state === "available"
              ? "text-pc-success-foreground"
              : tool.state === "misconfigured"
                ? "text-pc-danger-foreground"
                : "text-pc-muted-foreground"
          }`}
        >
          <Icon glyph={state.icon} size="sm" />
          {state.label}
        </span>
      </div>
      <small className="text-[var(--color-text-secondary)]">{tool.purpose}</small>
      {tool.state === "missing" && (
        <p>{tool.display_name} was not found. Choose its executable to continue.</p>
      )}
      {tool.state === "misconfigured" &&
        (tool.source === "environment" ? (
          <p>Update this tool’s environment override outside Portcove, restart, then recheck it.</p>
        ) : (
          <p>Portcove couldn’t use this executable. Choose it again to continue.</p>
        ))}
      <ActionRow>
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
      </ActionRow>
      <details className="host-tool-details mt-1 min-w-0">
        <summary className="cursor-pointer text-sm text-[var(--color-text-secondary)]">
          Tool details
        </summary>
        <code
          className="mt-2 block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-pc-muted-foreground"
          title={location}
        >
          {location}
        </code>
        <small className="mt-2 block text-[var(--color-text-secondary)]">
          {source}
          {showTechnicalId && (
            <>
              {" "}
              · Technical ID: <code className="text-pc-muted-foreground">{tool.id}</code>
            </>
          )}
        </small>
      </details>
      {visibleFeedback?.outcome && <p role="status">{visibleFeedback.outcome.message}</p>}
      {visibleFeedback?.error && <p role="alert">{visibleFeedback.error}</p>}
    </div>
  );
}

function StorageCard({
  libraryRoot,
  storage,
  showLocation = true,
}: {
  showLocation?: boolean;
  libraryRoot: string;
  storage?: StorageSummary | undefined;
}) {
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
    <SettingsRow className="storage-card" data-focus-group>
      <h2 className="flex items-center gap-2">
        <Icon glyph={HardDrive} />
        Files and capacity
      </h2>
      {showLocation && (
        <>
          <p className="m-0 text-sm text-pc-muted-foreground">Current library</p>
          <code className="block text-xs [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
            {libraryRoot || "Library location unavailable"}
          </code>
        </>
      )}
      {measurable ? (
        <div className="mb-[15px] grid gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <strong className="text-xs">{formatBytes(available)} available</strong>
            <span className="text-xs text-pc-muted-foreground">
              {formatBytes(total)} total storage capacity
            </span>
          </div>
          <div
            className="h-[6px] overflow-hidden rounded-[var(--radius-round)] border border-pc-border bg-[var(--color-bg-inset)]"
            role="meter"
            aria-label="Available capacity on the library volume"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={available}
          >
            <i
              className="block h-full rounded-[inherit] bg-[var(--color-success)]"
              style={{ width: `${(available / total) * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <p>Storage capacity is unavailable for this location.</p>
      )}
      <p className="flex items-start gap-2 [&_svg]:mt-0.5">
        <Icon glyph={ShieldCheck} size="sm" /> Installed application files are kept separate from
        saves and settings.
      </p>
    </SettingsRow>
  );
}

function jumpToSettingsSection(id: string) {
  window.requestAnimationFrame(() => {
    const heading = document.getElementById(`settings-${id}-heading`);
    if (!heading || heading.closest("[hidden]")) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "nearest", inline: "nearest" });
    const navigation = heading
      .closest(".settings-grid")
      ?.querySelector<HTMLElement>(".settings-section-index");
    const workspace = heading.closest<HTMLElement>('[data-focus-region="workspace"]');
    if (!navigation || !workspace || getComputedStyle(navigation).position !== "sticky") return;
    const target = heading.getBoundingClientRect();
    const strip = navigation.getBoundingClientRect();
    // Wide category navigation sits beside the heading. Only a sticky strip
    // above the same reading column can cover its focus outline.
    if (target.left >= strip.right || target.right <= strip.left) return;
    const focusStyle = getComputedStyle(heading);
    const outlineRoom =
      Math.max(0, Number.parseFloat(focusStyle.outlineWidth)) +
      Math.max(0, Number.parseFloat(focusStyle.outlineOffset));
    const covered = strip.bottom + outlineRoom - target.top;
    if (covered > 0 && strip.top < target.bottom)
      scrollWorkspaceTo(workspace, workspaceScrollTop(workspace) - covered);
  });
}

function sourceInspectionMessage(read: SourceInspectionReadState | undefined) {
  return read?.status === "idle"
    ? "Check this file to see its current identity and compatibility."
    : read?.status === "pending"
      ? "Checking file…"
      : read?.status === "cancelled"
        ? "File check cancelled."
        : (read?.failure?.summary ?? "File check is unavailable. Try checking it again.");
}

function noticePresentation(error: unknown, invocation: InvocationRecord | undefined) {
  const presentation = failurePresentation(error);
  const committed = presentation?.mutation_state === "committed";
  const neutral =
    presentation?.tone === "neutral" &&
    (presentation.mutation_state === "not_started" || presentation.mutation_state === "no_changes");
  const summary = errorText(error);
  const code =
    typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  const cancelled = code === "cancelled";
  const readbackOnly = invocation?.outcome === "succeeded" && invocation.failure === undefined;
  return { presentation, committed, neutral, summary, code, cancelled, readbackOnly };
}
