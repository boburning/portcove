import type { PortDefinition, PortStatus } from "../../types";
import { observedUpdateCandidate } from "./update-query-context";
import type { GameFileFilterContext } from "./game-file-query-context";

// These identifiers describe declared port facts, not installation eligibility.
const catalogQueryOptions = {
  platforms: ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64", "this-device"],
  channels: ["stable", "beta", "rolling"],
  installationMethods: [
    "portable-package",
    "portable-recompilation",
    "staged-game-files",
    "referenced-disc",
    "generated-game-data",
    "upstream-setup",
    "managed-recompilation",
    "user-prepared-runtime",
  ],
  membership: ["in-library", "not-in-library"],
  attention: ["missing-source", "missing-bios", "missing-runtime", "repair-needed", "finish-setup"],
  updates: ["available", "staged"],
  gameFiles: [
    "files_available",
    "files_missing",
    "needs_checking",
    "no_files_required",
    "unavailable_context",
  ],
} as const;

type Group = keyof typeof catalogQueryOptions;
export type CatalogQuery = { version: number } & Partial<Record<Group, readonly string[]>>;

export interface CatalogQueryContext {
  devicePlatform?: PortDefinition["platforms"][number];
  /** A supplied Core snapshot for this selected library; absent is not empty. */
  library?: { id: string; statuses: ReadonlyMap<string, PortStatus> };
  /** A completely covered, currently accepted Core route snapshot, never a readiness approximation. */
  gameFiles?: GameFileFilterContext;
}

export interface CatalogQueryResult {
  state: "matched" | "unresolved" | "unavailable";
  /** Retain the original value for correction; never drop unsupported predicates. */
  query: unknown;
  ports: PortDefinition[];
  counts: Record<Group, Record<string, number | null>>;
}

const groups = Object.keys(catalogQueryOptions) as Group[];

function supportedQuery(value: unknown): value is CatalogQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  return Object.entries(record).every(([key, values]) => {
    if (key === "version") return true;
    if (!Object.hasOwn(catalogQueryOptions, key) || !Array.isArray(values)) return false;
    const options: readonly string[] = catalogQueryOptions[key as Group];
    return values.every((value) => typeof value === "string" && options.includes(value));
  });
}

function available(
  group: Group,
  value: string,
  context: CatalogQueryContext,
  gameFilesAvailable: boolean,
): boolean {
  if (group === "gameFiles") return gameFilesAvailable;
  if (group === "membership" || group === "attention" || group === "updates")
    return Boolean(context.library?.id);
  return group !== "platforms" || value !== "this-device" || !!context.devicePlatform;
}

function matches(
  port: PortDefinition,
  group: Group,
  value: string,
  context: CatalogQueryContext,
): boolean {
  switch (group) {
    case "gameFiles":
      return context.gameFiles?.byPort.get(port.id)?.state === value;
    case "updates": {
      const candidate = observedUpdateCandidate(port.id, context.library?.statuses.get(port.id));
      return value === "available"
        ? candidate?.availableAtLastCheck === true
        : candidate?.matchingStaged === true;
    }
    case "platforms":
      return port.platforms.some(
        (platform) => platform === (value === "this-device" ? context.devicePlatform : value),
      );
    case "channels":
      return port.channels.some((channel) => channel === value);
    case "installationMethods":
      return port.presentation?.installation_method === value;
    case "membership": {
      const status = context.library?.statuses.get(port.id);
      const member =
        status?.port_id === port.id &&
        Boolean(status.active?.port_id === port.id || status.external_runtime?.port_id === port.id);
      return value === "in-library" ? member : !member;
    }
    case "attention": {
      const status = context.library?.statuses.get(port.id);
      // Core supplies readiness for the accepted installation. Unknown or
      // inconsistent records do not establish a positive attention reason.
      if (
        status?.port_id !== port.id ||
        (!status.active && !status.external_runtime) ||
        (status.active && status.active.port_id !== port.id) ||
        (status.external_runtime && status.external_runtime.port_id !== port.id)
      )
        return false;
      const readiness = status.readiness;
      if (
        !readiness ||
        typeof readiness.launchable !== "boolean" ||
        typeof readiness.pending_setup !== "boolean" ||
        !Array.isArray(readiness.blockers) ||
        !readiness.blockers.every((blocker) => typeof blocker === "string")
      )
        return false;
      switch (value) {
        case "missing-source":
          return readiness.blockers.includes("missing_source");
        case "missing-bios":
          return readiness.blockers.includes("missing_bios");
        case "missing-runtime":
          return readiness.blockers.includes("missing_runtime");
        case "repair-needed":
          return readiness.blockers.includes("invalid_installation");
        case "finish-setup":
          return readiness.pending_setup || readiness.blockers.includes("preparation_required");
        default:
          return false;
      }
    }
  }
}

/** Pure cached-snapshot evaluation. Search/view/readiness narrowing precedes this call.
 * Facts are port-level declarations, selected-library membership or Core installation
 * attention observations. In particular,
 * managed InstallRecord has no platform identity: this is not a route/build matcher.
 */
export function evaluateCatalogQuery(
  ports: readonly PortDefinition[],
  query: unknown,
  context: CatalogQueryContext = {},
): CatalogQueryResult {
  const gameFilesAvailable = Boolean(
    context.library?.id &&
    context.gameFiles?.libraryKey === context.library.id &&
    ports.every((port) => context.gameFiles?.byPort.has(port.id)),
  );
  const counts = Object.fromEntries(
    groups.map((group) => [
      group,
      Object.fromEntries(catalogQueryOptions[group].map((value) => [value, null])),
    ]),
  ) as CatalogQueryResult["counts"];
  const empty = (state: "unresolved" | "unavailable"): CatalogQueryResult => ({
    state,
    query,
    ports: [],
    counts,
  });
  if (!supportedQuery(query)) return empty("unresolved");
  if (
    groups.some((group) =>
      query[group]?.some((value) => !available(group, value, context, gameFilesAvailable)),
    )
  )
    return empty("unavailable");

  const seen = new Set<string>();
  const unique = ports.filter((port) => {
    if (seen.has(port.id)) return false;
    seen.add(port.id);
    return true;
  });
  const groupMatches = (port: PortDefinition, group: Group) =>
    !query[group]?.length || query[group].some((value) => matches(port, group, value, context));
  for (const group of groups) {
    const otherMatches = unique.filter((port) =>
      groups.every((other) => other === group || groupMatches(port, other)),
    );
    for (const value of catalogQueryOptions[group]) {
      counts[group][value] = available(group, value, context, gameFilesAvailable)
        ? otherMatches.filter((port) => matches(port, group, value, context)).length
        : null;
    }
  }
  return {
    state: "matched",
    query,
    counts,
    ports: unique.filter((port) => groups.every((group) => groupMatches(port, group))),
  };
}
