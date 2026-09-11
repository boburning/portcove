import type {
  DesktopError,
  OperationEvent,
  PortDefinition,
  PortStatus,
  ReadinessBlocker,
  SourceProfile,
  SourceRecord,
  UpdateSnapshot,
} from "./types";

/** Display bounds do not turn best-effort progress into a lifecycle outcome. */
export function progressPresentation(
  operation: OperationEvent | undefined,
  busy: string,
): {
  label: string;
  detail: string;
  range?: { current: number; total: number; percent: number };
} {
  const label = operationLabel(
    operation?.type === "progress" ? operation.phase : (operation?.operation ?? busy),
  );
  const unknown = { label, detail: "Working… Total not yet known." };
  if (operation?.type === "message") return { label, detail: operation.message };
  if (operation?.type !== "progress") return unknown;
  const { completed, total } = operation;
  if (!Number.isSafeInteger(completed) || completed < 0) return unknown;
  if (completed === 0 && total === 0) return { label, detail: "No work reported yet." };
  if (total === null || !Number.isSafeInteger(total) || total <= 0) return unknown;
  const current = Math.min(completed, total);
  return {
    label,
    detail: `${completed.toLocaleString()} of ${total.toLocaleString()}`,
    range: { current, total, percent: (current / total) * 100 },
  };
}

function operationLabel(value: string) {
  const labels: Record<string, string> = {
    download: "Downloading files",
    copy: "Copying files",
    "psx-toolchain-download": "Downloading preparation tools",
    install: "Installing game",
    update: "Updating game",
    prepare: "Preparing game",
    launch: "Starting game",
    verify: "Checking files",
    verify_install: "Checking installed files",
    verify_source: "Checking game files",
    backup: "Backup in progress",
    restore: "Restoring saved data",
    rollback: "Restoring previous version",
    activate: "Activating staged version",
    adopt: "Copying existing installation",
    remove: "Removing managed files",
    move_library: "Moving library",
    import_library: "Importing library",
    import_source: "Copying game files",
    discover_sources: "Searching for game files",
    update_catalog: "Updating port catalog",
    "check installed": "Checking for updates",
  };
  return Object.hasOwn(labels, value) ? labels[value] : "Working";
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
  return `${port.name} ${port.summary} ${port.id} ${port.adapter} ${port.platforms.join(" ")}`.toLowerCase();
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
