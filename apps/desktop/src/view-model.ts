import { usesUserSelectedRuntime } from "./shared/external-runtime-trust";
import {
  evaluateCatalogQuery,
  type CatalogQuery,
  type CatalogQueryContext,
} from "./features/browsing/catalog-query";
import type { CatalogEntry } from "./features/browsing/catalog-entry";
import type {
  ActivityRecord,
  DesktopError,
  OperationEvent,
  PortDefinition,
  PortStatus,
  ReadinessBlocker,
  SourceProfile,
  SourceRecord,
  UpdateSnapshot,
} from "./types";
import { portActionPresentation } from "./features/port-actions/port-action-presentation";
import { gameTitle, gameIdentityLabel } from "./port-identity";

const unfinishedActivityAfterSeconds = 24 * 60 * 60;

export type ActivityPresentationState =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "running"
  | "unfinished"
  | "unknown";

export function activityPresentationState(
  activity: ActivityRecord,
  nowSeconds = Date.now() / 1000,
): ActivityPresentationState {
  if (activity.status !== "running") {
    if (["succeeded", "failed", "cancelled"].includes(activity.status)) return activity.status;
    return "unknown";
  }
  return nowSeconds - activity.started_at >= unfinishedActivityAfterSeconds
    ? "unfinished"
    : "running";
}

export type NavigationActivityState = "running" | "attention";

function navigationActivities(
  activities: ActivityRecord[],
  nowSeconds = Date.now() / 1000,
): ActivityRecord[] {
  const latestPreparationByTarget = new Map<string, ActivityRecord>();
  for (const activity of activities) {
    if (activity.operation !== "prepare") continue;
    const target = `${activity.target_kind}:${activity.target_id ?? ""}`;
    const current = latestPreparationByTarget.get(target);
    if (!current || activity.started_at > current.started_at)
      latestPreparationByTarget.set(target, activity);
  }
  return activities.filter((activity) => {
    const state = activityPresentationState(activity, nowSeconds);
    if (state === "running" || state === "unfinished") return true;
    if (activity.operation !== "prepare" || state !== "failed") return false;
    const target = `${activity.target_kind}:${activity.target_id ?? ""}`;
    return latestPreparationByTarget.get(target) === activity;
  });
}

export function navigationActivityState(
  activities: ActivityRecord[],
  nowSeconds = Date.now() / 1000,
): NavigationActivityState | undefined {
  const states = navigationActivities(activities, nowSeconds).map((activity) =>
    activityPresentationState(activity, nowSeconds),
  );
  if (states.includes("unfinished") || states.includes("failed")) return "attention";
  if (states.includes("running")) return "running";
  return undefined;
}

export function activityHistoryPreview(
  activities: ActivityRecord[],
  nowSeconds = Date.now() / 1000,
  protectedActivityIds: Iterable<string> = [],
): ActivityRecord[] {
  const important = new Set(navigationActivities(activities, nowSeconds));
  const protectedIds = new Set(protectedActivityIds);
  return activities.filter(
    (activity, index) => index < 8 || important.has(activity) || protectedIds.has(activity.id),
  );
}

/** Display bounds do not turn best-effort progress into a lifecycle outcome. */
export function progressPresentation(
  operation: OperationEvent | undefined,
  busy: string,
): {
  label: string;
  detail: string;
  range?: { current: number; total: number; percent: number };
} {
  const presentation = operationPresentation(
    operation?.type === "progress" ? operation.phase : (operation?.operation ?? busy),
  );
  const unknown = { label: presentation.label, detail: presentation.indeterminate };
  if (operation?.type === "message")
    return { label: presentation.label, detail: operation.message };
  if (operation?.type !== "progress") return unknown;
  const { completed, total } = operation;
  if (!Number.isSafeInteger(completed) || completed < 0) return unknown;
  if (completed === 0 && total === 0) return { label: presentation.label, detail: "" };
  if (total === null || !Number.isSafeInteger(total) || total <= 0) return unknown;
  const current = Math.min(completed, total);
  return {
    label: presentation.label,
    detail: progressDetail(completed, total, presentation.unit),
    range: { current, total, percent: (current / total) * 100 },
  };
}

type ProgressUnit = "bytes" | "ports";

type OperationPresentation = {
  label: string;
  unit?: ProgressUnit;
  indeterminate: string;
};

function operationPresentation(value: string): OperationPresentation {
  const presentations: Record<string, Omit<OperationPresentation, "indeterminate">> = {
    download: { label: "Downloading release", unit: "bytes" },
    download_package: { label: "Downloading upstream package", unit: "bytes" },
    copy: { label: "Copying game files", unit: "bytes" },
    "psx-toolchain-download": { label: "Downloading preparation tools", unit: "bytes" },
    "Checking installed ports": { label: "Checking installed ports", unit: "ports" },
    "Applying update policies": { label: "Applying update settings", unit: "ports" },
    install: { label: "Installing game" },
    update: { label: "Updating game" },
    prepare: { label: "Preparing game" },
    launch: { label: "Starting game" },
    verify: { label: "Checking files" },
    verify_install: { label: "Checking installed files" },
    verify_source: { label: "Checking game files" },
    verify_sources: { label: "Checking game files" },
    backup: { label: "Backup in progress" },
    restore: { label: "Restoring saved data" },
    rollback: { label: "Restoring previous version" },
    activate: { label: "Activating staged version" },
    adopt: { label: "Copying existing installation" },
    remove: { label: "Removing managed files" },
    move_library: { label: "Moving library" },
    import_library: { label: "Importing library" },
    import_source: { label: "Copying game files" },
    discover_sources: { label: "Searching for game files" },
    update_catalog: { label: "Updating port catalog" },
    "check installed": { label: "Checking for updates", unit: "ports" },
    check_installed: { label: "Checking for updates", unit: "ports" },
    reconcile_installed: { label: "Applying update settings", unit: "ports" },
  };
  const selected = presentations[value];
  const presentation: Omit<OperationPresentation, "indeterminate"> =
    Object.hasOwn(presentations, value) && selected ? selected : { label: "Working" };
  return {
    ...presentation,
    indeterminate:
      presentation.unit === "bytes"
        ? "Total size not yet known."
        : presentation.unit === "ports"
          ? "Port total not yet known."
          : "Progress total not yet known.",
  };
}

function progressDetail(completed: number, total: number, unit: ProgressUnit | undefined) {
  if (unit === "bytes") return `${formatBytes(completed)} of ${formatBytes(total)}`;
  const count = `${completed.toLocaleString()} of ${total.toLocaleString()}`;
  if (unit === "ports") return `${count} ${total === 1 ? "port" : "ports"}`;
  return count;
}

type CountMessages = Partial<Record<"one" | "two" | "few" | "many", string>> & {
  zero: string;
  other: string;
  unknown: string;
};

/** Complete messages use the UI language, currently English, for numbers and plurals. */
export function formatCountMessage(
  count: number | null | undefined,
  messages: CountMessages,
  locale = "en",
) {
  if (count == null || !Number.isSafeInteger(count) || count < 0) return messages.unknown;
  const category = count === 0 ? "zero" : new Intl.PluralRules(locale).select(count);
  const message = messages[category] ?? messages.other;
  return message.replaceAll("{count}", new Intl.NumberFormat(locale).format(count));
}

export type View = "library" | "catalog" | "updates" | "settings";
export type DetailDestination = "updates" | "saves" | "files";
export type Filter = "all" | "ready" | "setup" | "stable" | "beta" | "rolling";
export type CatalogSort = "catalog" | "name" | "name-desc" | "recent" | "installed-first";
export type PortReadiness =
  | "available"
  | "ready"
  | "source"
  | "bios"
  | "setup"
  | "staged"
  | "runtime"
  | "repair"
  | "unknown"
  | "blocked";

export interface LibraryOverview {
  installed: number;
  ready: number;
  needsSetup: number;
  staged: number;
}

export interface RecentPort {
  port: CatalogEntry;
  status: PortStatus;
}

export interface SourceRequirement {
  profile: SourceProfile;
  requiredBy: Array<{
    portId: string;
    portName: string;
    role: "Game files" | "BIOS";
  }>;
}

const platformLabels: Record<string, string> = {
  "windows-x86-64": "Windows",
  "linux-x86-64": "Linux",
  "macos-x86-64": "macOS Intel",
  "macos-aarch64": "Apple silicon",
};

export function platformLabel(value: string) {
  const label = Object.hasOwn(platformLabels, value) ? platformLabels[value] : undefined;
  return label ?? "Unknown platform";
}

export const installationMethodLabels: Record<
  NonNullable<PortDefinition["presentation"]>["installation_method"],
  string
> = {
  "portable-package": "Portable upstream package",
  "portable-recompilation": "Portable native recompilation",
  "staged-game-files": "Prepared game files beside the port",
  "referenced-disc": "Original disc referenced at launch",
  "generated-game-data": "Generated game data",
  "upstream-setup": "Managed upstream setup",
  "managed-recompilation": "Managed native recompilation",
  "user-prepared-runtime": "User-prepared external runtime",
};

export function installationMethodLabel(port: CatalogEntry) {
  if (port.release && usesUserSelectedRuntime({ release: port.release }))
    return "Your existing installation";
  const method = port.presentation?.installation_method;
  return method && Object.hasOwn(installationMethodLabels, method)
    ? installationMethodLabels[method]
    : "Unavailable in this catalog";
}

const channelLabels: Record<string, string> = {
  stable: "Stable",
  beta: "Preview",
  rolling: "Rolling",
};

export function releaseChannelPresentation(value: string) {
  const known = Object.hasOwn(channelLabels, value);
  return {
    known,
    label: (known ? channelLabels[value] : undefined) ?? "Unknown channel",
    tone: known ? value : "unknown",
  };
}

export function indexStatuses(statuses: PortStatus[]) {
  return new Map(statuses.map((status) => [status.port_id, status]));
}

export function filterOptions(view: View): Filter[] {
  return view === "library" ? ["all", "ready", "setup"] : ["all", "stable", "beta", "rolling"];
}

export function portReadiness(status: PortStatus | undefined): PortReadiness {
  if (!status?.active && !status?.external_runtime) return "available";
  const assessment = status.readiness;
  if (!assessment || typeof assessment.launchable !== "boolean") return "unknown";
  if (assessment.blockers.includes("invalid_installation")) return "repair";
  const sourceMissing = assessment.blockers.some((blocker) => SOURCE_BLOCKERS.includes(blocker));
  const biosMissing = assessment.blockers.some((blocker) => BIOS_BLOCKERS.includes(blocker));
  if (sourceMissing && biosMissing) return "setup";
  if (sourceMissing) return "source";
  if (biosMissing) return "bios";
  if (assessment.blockers.includes("missing_runtime")) return "runtime";
  if (assessment.pending_setup) return "setup";
  if (!assessment.launchable || portActionPresentation(status, "launch").blocked) return "blocked";
  if (status.staged) return "staged";
  return "ready";
}

/** Presentation only. Core still owns whether a launch is permitted. */
export function hasUnconfirmedLaunchInput(status: PortStatus | undefined, port?: CatalogEntry) {
  if (status?.external_runtime?.user_selected) return false;
  const readiness = status?.readiness;
  return (["source", "bios"] as const).some((role) => {
    const required = role === "source" ? port?.source_profile : port?.bios_source_profile;
    if (!required && readiness?.[role] == null) return false;
    const assessment =
      role === "source" ? readiness?.source_assessment : readiness?.bios_assessment;
    return (
      assessment?.health !== "current" ||
      assessment.classification.state !== "recognized" ||
      assessment.contract.state !== "supported" ||
      assessment.admission.state !== "admitted" ||
      assessment.admission.mode !== "exact_identity"
    );
  });
}

export const SOURCE_BLOCKERS: ReadinessBlocker[] = [
  "missing_source",
  "unreadable_source",
  "changed_source",
  "incompatible_source",
];
export const BIOS_BLOCKERS: ReadinessBlocker[] = [
  "missing_bios",
  "unreadable_bios",
  "changed_bios",
  "incompatible_bios",
];

export function summarizeLibrary(
  ports: CatalogEntry[],
  statuses: Map<string, PortStatus>,
): LibraryOverview {
  const installed = ports.filter((port) => {
    const status = statuses.get(port.id);
    return status?.active || status?.external_runtime || port.pendingSetup;
  });
  const states = installed.map((port) =>
    port.pendingSetup ? "setup" : portReadiness(statuses.get(port.id)),
  );
  return {
    installed: installed.length,
    ready: states.filter((state) => state === "ready" || state === "staged").length,
    needsSetup: states.filter(needsAttention).length,
    staged: states.filter((state) => state === "staged").length,
  };
}

export function mostRecentPort(
  ports: CatalogEntry[],
  statuses: Map<string, PortStatus>,
): RecentPort | undefined {
  return ports.reduce<RecentPort | undefined>((recent, port) => {
    const status = statuses.get(port.id);
    if (
      (!status?.active && !status?.external_runtime) ||
      !status.last_launched_at ||
      port.pendingSetup ||
      status.readiness?.launchable !== true ||
      status.readiness.blockers.length > 0 ||
      portActionPresentation(status, "launch").blocked
    )
      return recent;
    if (!recent || status.last_launched_at > (recent.status.last_launched_at ?? 0))
      return { port, status };
    return recent;
  }, undefined);
}

export function currentUpdateSnapshot(status: PortStatus | undefined): UpdateSnapshot | undefined {
  const snapshot = status?.last_update_check;
  if (!status?.active || !snapshot) return undefined;
  if (snapshot.check.channel !== status.channel) return undefined;
  if (snapshot.check.installed_version !== status.active.version) return undefined;
  if (snapshot.check.installed_artifact?.sha256 !== status.active.artifact.sha256) return undefined;
  if (
    JSON.stringify(snapshot.check.installed_runtime ?? null) !==
    JSON.stringify(status.active.runtime ?? null)
  )
    return undefined;
  return snapshot;
}

export function requiredSourceNeeds(
  ports: PortDefinition[],
  profiles: SourceProfile[],
  statuses: Map<string, PortStatus>,
  sources: SourceRecord[],
): SourceRequirement[] {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const registered = new Set(sources.map((source) => source.profile_id));
  const requirements = new Map<string, SourceRequirement>();
  for (const port of ports.filter((candidate) => {
    const status = statuses.get(candidate.id);
    return status?.active || (status?.external_runtime && !status.external_runtime.user_selected);
  })) {
    addSourceNeed(requirements, profilesById, registered, port, port.source_profile, "Game files");
    addSourceNeed(requirements, profilesById, registered, port, port.bios_source_profile, "BIOS");
  }
  return [...requirements.values()].sort((left, right) =>
    left.profile.label.localeCompare(right.profile.label),
  );
}

function addSourceNeed(
  requirements: Map<string, SourceRequirement>,
  profiles: ReadonlyMap<string, SourceProfile>,
  registered: ReadonlySet<string>,
  port: PortDefinition,
  profileId: string | null | undefined,
  role: "Game files" | "BIOS",
) {
  if (!profileId || registered.has(profileId)) return;
  const profile = profiles.get(profileId);
  if (!profile) return;
  const requirement = requirements.get(profileId) ?? {
    profile,
    requiredBy: [],
  };
  requirement.requiredBy.push({ portId: port.id, portName: gameIdentityLabel(port), role });
  requirements.set(profileId, requirement);
}

export function filterPorts(
  ports: CatalogEntry[],
  statuses: Map<string, PortStatus>,
  view: View,
  filter: Filter | CatalogQuery,
  query: string,
  catalogSort: CatalogSort = "catalog",
  context: CatalogQueryContext = {},
) {
  const selectedStatuses =
    typeof filter !== "string" && context.library ? context.library.statuses : statuses;
  const normalizedQuery = normalizeGameSearchText(query.trim());
  const legacyFilter = typeof filter === "string" ? filter : "all";
  const structuredQuery =
    typeof filter !== "string"
      ? filter
      : {
          version: 1,
          channels: ["stable", "beta", "rolling"].includes(filter) ? [filter] : [],
        };
  const candidates = ports.filter(
    (port) =>
      visibleInView(port, selectedStatuses, view) &&
      matchesFilter(selectedStatuses.get(port.id), legacyFilter, Boolean(port.pendingSetup)),
  );
  const visible = evaluateCatalogQuery(candidates, structuredQuery, {
    ...context,
    catalogUniverse: context.catalogUniverse ?? ports,
  }).ports.filter((port) => searchableText(port).includes(normalizedQuery));
  if (
    (view !== "catalog" && view !== "library") ||
    (catalogSort === "catalog" && !context.devicePlatform)
  )
    return visible;
  return visible
    .map((port, index) => ({ port, index }))
    .sort((left, right) => {
      const comparison =
        catalogSort === "catalog"
          ? catalogRank(left.port, selectedStatuses.get(left.port.id), context.devicePlatform) -
            catalogRank(right.port, selectedStatuses.get(right.port.id), context.devicePlatform)
          : catalogSort === "name" || catalogSort === "name-desc"
            ? (catalogSort === "name-desc" ? -1 : 1) *
              gameTitle(left.port).localeCompare(gameTitle(right.port), "en", {
                sensitivity: "base",
              })
            : catalogSort === "recent"
              ? (selectedStatuses.get(right.port.id)?.last_launched_at ?? 0) -
                (selectedStatuses.get(left.port.id)?.last_launched_at ?? 0)
              : Number(
                  Boolean(
                    selectedStatuses.get(right.port.id)?.active ||
                    selectedStatuses.get(right.port.id)?.external_runtime,
                  ),
                ) -
                Number(
                  Boolean(
                    selectedStatuses.get(left.port.id)?.active ||
                    selectedStatuses.get(left.port.id)?.external_runtime,
                  ),
                );
      return comparison || left.index - right.index;
    })
    .map(({ port }) => port);
}

function catalogRank(port: CatalogEntry, status: PortStatus | undefined, platform?: string) {
  if (status?.active || status?.external_runtime || port.pendingSetup) return 0;
  if (port.release && !portActionPresentation(status, "install").blocked) return 1;
  if (port.listing?.availability === "unavailable" || port.listing?.availability === "source-only")
    return 5;
  if (port.platforms.some((candidate) => candidate === platform)) return 2;
  return port.platforms.length ? 4 : 3;
}

function visibleInView(port: CatalogEntry, statuses: ReadonlyMap<string, PortStatus>, view: View) {
  const status = statuses.get(port.id);
  return (
    view !== "library" || Boolean(status?.active || status?.external_runtime || port.pendingSetup)
  );
}

function needsAttention(readiness: PortReadiness) {
  return readiness !== "available" && readiness !== "ready" && readiness !== "staged";
}

function matchesFilter(status: PortStatus | undefined, filter: Filter, pendingSetup = false) {
  if (pendingSetup) return filter !== "ready";
  const readiness = portReadiness(status);
  if (filter === "ready") return readiness === "ready" || readiness === "staged";
  if (filter === "setup") return needsAttention(readiness);
  return true;
}

function searchableText(port: CatalogEntry) {
  const installationMethod = port.presentation?.installation_method
    ? installationMethodLabel(port)
    : "";
  return normalizeGameSearchText(
    `${gameTitle(port)} ${port.name} ${port.presentation?.variant_label ?? ""} ${port.summary} ${port.id} ${installationMethod} ${port.platforms.join(" ")} ${port.platforms.map(platformLabel).join(" ")}`,
  );
}

function normalizeGameSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function errorText(error: unknown) {
  const presentation = failurePresentation(error);
  if (presentation) return presentation.summary;
  if (typeof error === "object" && error && "message" in error)
    return String((error as DesktopError).message);
  return String(error);
}

/** Display accepts future outcome names without asserting a known mutation result. */
export type FailureDisplay = {
  [Key in keyof DesktopError["presentation"]]: Key extends "mutation_state"
    ? string
    : DesktopError["presentation"][Key];
};

export function failurePresentation(error: unknown): FailureDisplay | undefined {
  if (typeof error !== "object" || !error || !("presentation" in error)) return undefined;
  const value = error.presentation as Partial<DesktopError["presentation"]> | null;
  if (
    !value ||
    typeof value.summary !== "string" ||
    typeof value.technical_message !== "string" ||
    !value.technical_context ||
    !Array.isArray(value.recovery_actions)
  )
    return undefined;
  return {
    ...value,
    tone: value.tone === "neutral" ? "neutral" : "error",
    mutation_state: typeof value.mutation_state === "string" ? value.mutation_state : "unknown",
  } as FailureDisplay;
}

/** Read-only navigation within the current workspace, never recovery permission. */
export function preparationRecoveryPort(
  error: unknown,
  ports: readonly PortDefinition[],
  statuses: readonly PortStatus[],
): string | undefined {
  const presentation = failurePresentation(error);
  const target: unknown = presentation?.recovery_target;
  if (
    !presentation?.recovery_actions.includes("review_preparation") ||
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !("kind" in target) ||
    target.kind !== "preparation" ||
    !("port_id" in target) ||
    typeof target.port_id !== "string" ||
    !/^[a-z0-9-]+$/.test(target.port_id)
  )
    return undefined;
  const id = target.port_id;
  return ports.filter((port) => port.id === id).length === 1 &&
    statuses.filter((status) => status.port_id === id).length === 1
    ? id
    : undefined;
}

export function isCancellation(error: unknown) {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "cancelled"
  );
}

export function formatBytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Size unknown";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
/** Core catalog validation requires an offered channel and platform. Reject a
 * malformed projection instead of inventing a selection at the UI boundary. */
export function defaultReleaseChannel(port: PortDefinition) {
  const channel = port.channels[0];
  if (channel === undefined) throw new Error(`Port ${port.id} has no release channels`);
  return channel;
}

export function defaultPortPlatform(port: PortDefinition) {
  const platform = port.platforms[0];
  if (platform === undefined) throw new Error(`Port ${port.id} has no platforms`);
  return platform;
}
