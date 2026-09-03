import type { DesktopError, PortDefinition, PortStatus, SourceProfile, SourceRecord, UpdateSnapshot } from "./types";

export type View = "library" | "catalog" | "updates" | "settings";
export type Filter = "all" | "ready" | "setup" | "stable" | "beta" | "rolling";
export type PortReadiness = "available" | "ready" | "source" | "bios" | "setup" | "staged";

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
  requiredBy: Array<{ portId: string; portName: string; role: "Game source" | "BIOS" }>;
}

export const platformLabels: Record<string, string> = {
  "windows-x86-64": "Windows", "linux-x86-64": "Linux",
  "macos-x86-64": "macOS Intel", "macos-aarch64": "Apple silicon",
};

export function indexStatuses(statuses: PortStatus[]) {
  return new Map(statuses.map(status => [status.port_id, status]));
}

export function filterOptions(view: View): Filter[] {
  return view === "library" ? ["all", "ready", "setup"] : ["all", "stable", "beta", "rolling"];
}

export function portReadiness(port: PortDefinition, status: PortStatus | undefined, registeredSources: ReadonlySet<string>): PortReadiness {
  if (!status?.active) return "available";
  const sourceMissing = status.readiness?.blockers.includes("missing_source")
    ?? Boolean(port.source_profile && !registeredSources.has(port.source_profile));
  const biosMissing = status.readiness?.blockers.includes("missing_bios")
    ?? Boolean(port.bios_source_profile && !registeredSources.has(port.bios_source_profile));
  if (sourceMissing && biosMissing) return "setup";
  if (sourceMissing) return "source";
  if (biosMissing) return "bios";
  if (status.readiness?.pending_setup) return "setup";
  if (status.staged) return "staged";
  return "ready";
}

export function summarizeLibrary(ports: PortDefinition[], statuses: Map<string, PortStatus>, registeredSources: ReadonlySet<string>): LibraryOverview {
  const installed = ports.filter(port => statuses.get(port.id)?.active);
  const states = installed.map(port => portReadiness(port, statuses.get(port.id), registeredSources));
  return {
    installed: installed.length,
    ready: states.filter(state => state === "ready" || state === "staged").length,
    needsSetup: states.filter(state => state === "source" || state === "bios" || state === "setup").length,
    staged: states.filter(state => state === "staged").length,
  };
}

export function mostRecentPort(ports: PortDefinition[], statuses: Map<string, PortStatus>): RecentPort | undefined {
  return ports.reduce<RecentPort | undefined>((recent, port) => {
    const status = statuses.get(port.id);
    if (!status?.active || !status.last_launched_at) return recent;
    if (!recent || status.last_launched_at > (recent.status.last_launched_at ?? 0)) return { port, status };
    return recent;
  }, undefined);
}

export function currentUpdateSnapshot(status: PortStatus | undefined): UpdateSnapshot | undefined {
  const snapshot = status?.last_update_check;
  if (!status?.active || !snapshot) return undefined;
  if (snapshot.check.channel !== status.channel) return undefined;
  if (snapshot.check.installed_version !== status.active.version) return undefined;
  if (snapshot.check.installed_artifact?.sha256 !== status.active.artifact.sha256) return undefined;
  return snapshot;
}

export function requiredSourceNeeds(ports: PortDefinition[], profiles: SourceProfile[], statuses: Map<string, PortStatus>, sources: SourceRecord[]): SourceRequirement[] {
  const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
  const registered = new Set(sources.map(source => source.profile_id));
  const requirements = new Map<string, SourceRequirement>();
  for (const port of ports.filter(candidate => statuses.get(candidate.id)?.active)) {
    addSourceNeed(requirements, profilesById, registered, port, port.source_profile, "Game source");
    addSourceNeed(requirements, profilesById, registered, port, port.bios_source_profile, "BIOS");
  }
  return [...requirements.values()].sort((left, right) => left.profile.label.localeCompare(right.profile.label));
}

function addSourceNeed(requirements: Map<string, SourceRequirement>, profiles: ReadonlyMap<string, SourceProfile>, registered: ReadonlySet<string>, port: PortDefinition, profileId: string | undefined, role: "Game source" | "BIOS") {
  if (!profileId || registered.has(profileId)) return;
  const profile = profiles.get(profileId);
  if (!profile) return;
  const requirement = requirements.get(profileId) ?? { profile, requiredBy: [] };
  requirement.requiredBy.push({ portId: port.id, portName: port.name, role });
  requirements.set(profileId, requirement);
}

export function filterPorts(ports: PortDefinition[], statuses: Map<string, PortStatus>, view: View, filter: Filter, query: string, registeredSources: ReadonlySet<string> = new Set()) {
  const normalizedQuery = query.trim().toLowerCase();
  return ports.filter(port => visibleInView(port, statuses, view)
    && matchesFilter(port, statuses.get(port.id), filter, registeredSources)
    && searchableText(port).includes(normalizedQuery));
}

function visibleInView(port: PortDefinition, statuses: Map<string, PortStatus>, view: View) {
  return view !== "library" || Boolean(statuses.get(port.id)?.active);
}

function matchesFilter(port: PortDefinition, status: PortStatus | undefined, filter: Filter, registeredSources: ReadonlySet<string>) {
  const readiness = portReadiness(port, status, registeredSources);
  if (filter === "ready") return readiness === "ready" || readiness === "staged";
  if (filter === "setup") return readiness === "source" || readiness === "bios" || readiness === "setup";
  if (filter === "stable" || filter === "beta" || filter === "rolling") return port.channels.includes(filter);
  return true;
}

function searchableText(port: PortDefinition) {
  return `${port.name} ${port.summary} ${port.id} ${port.adapter} ${port.platforms.join(" ")}`.toLowerCase();
}

export function errorText(error: unknown) {
  if (typeof error === "object" && error && "message" in error) return String((error as DesktopError).message);
  return String(error);
}

export function isCancellation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "cancelled";
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
