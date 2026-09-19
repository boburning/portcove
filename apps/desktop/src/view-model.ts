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
): ActivityRecord[] {
  const important = new Set(navigationActivities(activities, nowSeconds));
  return activities.filter((activity, index) => index < 8 || important.has(activity));
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
  if (completed === 0 && total === 0)
    return { label: presentation.label, detail: emptyProgressDetail(presentation.unit) };
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

function emptyProgressDetail(unit: ProgressUnit | undefined) {
  if (unit === "bytes") return "No bytes reported yet.";
  if (unit === "ports") return "No ports reported yet.";
  return "No work reported yet.";
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
export type Filter = "all" | "ready" | "setup" | "stable" | "beta" | "rolling";
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
  port: PortDefinition;
  status: PortStatus;
}

export interface SourceRequirement {
  profile: SourceProfile;
  requiredBy: Array<{
    portId: string;
    portName: string;
    role: "Game source" | "BIOS";
  }>;
}

const platformLabels: Record<string, string> = {
  "windows-x86-64": "Windows",
  "linux-x86-64": "Linux",
  "macos-x86-64": "macOS Intel",
  "macos-aarch64": "Apple silicon",
};

export function platformLabel(value: string) {
  return Object.hasOwn(platformLabels, value) ? platformLabels[value] : "Unknown platform";
}

const installationMethodLabels: Record<
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
};

export function installationMethodLabel(port: PortDefinition) {
  const method = port.presentation?.installation_method;
  return method && Object.hasOwn(installationMethodLabels, method)
    ? installationMethodLabels[method]
    : "Unavailable in this catalog";
}

const channelLabels: Record<string, string> = {
  stable: "Stable",
  beta: "Beta",
  rolling: "Rolling",
};

export function releaseChannelPresentation(value: string) {
  const known = Object.hasOwn(channelLabels, value);
  return {
    known,
    label: known ? channelLabels[value] : "Unknown channel",
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
  if (!status?.active) return "available";
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
  if (!assessment.launchable) return "blocked";
  if (status.staged) return "staged";
  return "ready";
}

const SOURCE_BLOCKERS: ReadinessBlocker[] = [
  "missing_source",
  "unreadable_source",
  "changed_source",
];
const BIOS_BLOCKERS: ReadinessBlocker[] = ["missing_bios", "unreadable_bios", "changed_bios"];

export function summarizeLibrary(
  ports: PortDefinition[],
  statuses: Map<string, PortStatus>,
): LibraryOverview {
  const installed = ports.filter((port) => statuses.get(port.id)?.active);
  const states = installed.map((port) => portReadiness(statuses.get(port.id)));
  return {
    installed: installed.length,
    ready: states.filter((state) => state === "ready" || state === "staged").length,
    needsSetup: states.filter(needsAttention).length,
    staged: states.filter((state) => state === "staged").length,
  };
}

export function mostRecentPort(
  ports: PortDefinition[],
  statuses: Map<string, PortStatus>,
): RecentPort | undefined {
  return ports.reduce<RecentPort | undefined>((recent, port) => {
    const status = statuses.get(port.id);
    if (!status?.active || !status.last_launched_at) return recent;
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
  for (const port of ports.filter((candidate) => statuses.get(candidate.id)?.active)) {
    addSourceNeed(requirements, profilesById, registered, port, port.source_profile, "Game source");
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
  role: "Game source" | "BIOS",
) {
  if (!profileId || registered.has(profileId)) return;
  const profile = profiles.get(profileId);
  if (!profile) return;
  const requirement = requirements.get(profileId) ?? {
    profile,
    requiredBy: [],
  };
  requirement.requiredBy.push({ portId: port.id, portName: port.name, role });
  requirements.set(profileId, requirement);
}

export function filterPorts(
  ports: PortDefinition[],
  statuses: Map<string, PortStatus>,
  view: View,
  filter: Filter,
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  return ports.filter(
    (port) =>
      visibleInView(port, statuses, view) &&
      matchesFilter(port, statuses.get(port.id), filter) &&
      searchableText(port).includes(normalizedQuery),
  );
}

function visibleInView(port: PortDefinition, statuses: Map<string, PortStatus>, view: View) {
  return view !== "library" || Boolean(statuses.get(port.id)?.active);
}

function needsAttention(readiness: PortReadiness) {
  return readiness !== "available" && readiness !== "ready" && readiness !== "staged";
}

function matchesFilter(port: PortDefinition, status: PortStatus | undefined, filter: Filter) {
  const readiness = portReadiness(status);
  if (filter === "ready") return readiness === "ready" || readiness === "staged";
  if (filter === "setup") return needsAttention(readiness);
  if (filter === "stable" || filter === "beta" || filter === "rolling")
    return port.channels.includes(filter);
  return true;
}

function searchableText(port: PortDefinition) {
  const installationMethod = port.presentation?.installation_method
    ? installationMethodLabel(port)
    : "";
  return `${port.name} ${port.summary} ${port.id} ${installationMethod} ${port.platforms.join(" ")} ${port.platforms.map(platformLabel).join(" ")}`.toLowerCase();
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
