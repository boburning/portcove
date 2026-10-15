import type {
  PortDefinition,
  PortStatus,
  CatalogBrowsingSnapshot,
  CatalogBrowsingContext,
} from "../../types";
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
  devicePlatform?: PortDefinition["platforms"][number] | undefined;
  /** A supplied Core snapshot for this selected library; absent is not empty. */
  library?: { id: string; statuses: ReadonlyMap<string, PortStatus> };
  /** A completely covered, currently accepted Core route snapshot, never a readiness approximation. */
  gameFiles?: GameFileFilterContext | undefined;
  /** Ephemeral Core facts accepted atomically with this library's workspace. */
  browsing?: CatalogBrowsingSnapshot | undefined;
}

export interface CatalogQueryResult {
  state: "matched" | "unresolved" | "unavailable";
  /** Retain the original value for correction; never drop unsupported predicates. */
  query: unknown;
  ports: PortDefinition[];
  counts: Record<Group, Record<string, number | null>>;
  matchingContexts: ReadonlyMap<string, readonly CatalogBrowsingContext[]>;
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

function validAttentionReadiness(
  readiness: PortStatus["readiness"] | undefined,
): readiness is NonNullable<PortStatus["readiness"]> {
  return !(
    !readiness ||
    typeof readiness.launchable !== "boolean" ||
    typeof readiness.pending_setup !== "boolean" ||
    !Array.isArray(readiness.blockers) ||
    !readiness.blockers.every((blocker) => typeof blocker === "string")
  );
}

function attentionMatches(port: PortDefinition, value: string, context: CatalogQueryContext) {
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
  if (!validAttentionReadiness(readiness)) return false;
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
    case "attention":
      return attentionMatches(port, value, context);
  }
}

type Match = boolean | undefined;
function any(values: Match[]): Match {
  return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
}
function all(values: Match[]): Match {
  return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
}

function contextActionMatches(
  port: PortDefinition,
  fact: CatalogBrowsingContext,
  group: Group,
  value: string,
  context: CatalogQueryContext,
) {
  if (!fact.member_context) return false;
  const status = context.library?.statuses.get(port.id);
  const instance =
    fact.route === "managed_launch"
      ? status?.active
      : fact.route === "external_launch"
        ? status?.external_runtime
        : undefined;
  if (!instance || instance.id !== fact.installation_id) return undefined;
  if (group === "attention" && status?.active && fact.route === "external_launch") return undefined;
  if (group === "updates" && fact.route !== "managed_launch") return false;
  return matches(port, group, value, context);
}

function contextGameFilesMatch(
  port: PortDefinition,
  fact: CatalogBrowsingContext,
  value: string,
  context: CatalogQueryContext,
) {
  const observed = context.gameFiles?.byPort.get(port.id);
  if (
    !observed ||
    !context.browsing ||
    context.gameFiles?.library.id !== context.browsing.library.id ||
    context.gameFiles.library.root !== context.browsing.library.root
  )
    return undefined;
  if (observed.route !== fact.route) return false;
  if (fact.platform === null || fact.channel === null) return undefined;
  if (observed.platform !== fact.platform || observed.channel !== fact.channel) return false;
  if (
    !fact.definition_sha256 ||
    observed.route_definition_sha256 !== fact.definition_sha256 ||
    (observed.route_instance_sha256 ?? null) !== fact.instance_sha256
  )
    return undefined;
  return observed.state === value;
}

function contextMatches(
  port: PortDefinition,
  fact: CatalogBrowsingContext,
  group: Group,
  value: string,
  context: CatalogQueryContext,
): Match {
  switch (group) {
    case "platforms":
      return fact.platform === null
        ? undefined
        : fact.platform === (value === "this-device" ? context.browsing?.host_platform : value);
    case "channels":
      return fact.channel === null ? undefined : fact.channel === value;
    case "installationMethods":
      return fact.installation_method === null ? undefined : fact.installation_method === value;
    case "membership":
      return value === "not-in-library" ? !fact.port_member : fact.member_context;
    case "attention":
    case "updates":
      return contextActionMatches(port, fact, group, value, context);
    case "gameFiles":
      return contextGameFilesMatch(port, fact, value, context);
  }
}

/** Pure cached-snapshot evaluation. Positive groups share one Core context;
 * unknown retained facts stay unavailable rather than becoming negative facts.
 * Public declaration-only queries retain their offline evaluator.
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
    matchingContexts: new Map(),
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
  const activeGroups = groups.filter((group) => query[group]?.length);
  const privateGroups: Group[] = ["membership", "attention", "updates", "gameFiles"];
  const requiresContexts =
    activeGroups.length > 1 && activeGroups.some((group) => privateGroups.includes(group));
  const browsing = context.browsing;
  const coherent = Boolean(
    browsing &&
    browsing.schema_version === 1 &&
    context.library?.id === browsing.library.root &&
    /^[a-f0-9]{64}$/.test(browsing.workspace_binding_sha256) &&
    new Set(browsing.contexts.map((fact) => fact.context_id)).size === browsing.contexts.length &&
    unique.every((port) => browsing.contexts.some((fact) => fact.port_id === port.id)),
  );
  if (requiresContexts && !coherent) return empty("unavailable");
  if (coherent && browsing) {
    const byPort = new Map<string, CatalogBrowsingContext[]>();
    for (const fact of browsing.contexts) {
      const facts = byPort.get(fact.port_id) ?? [];
      facts.push(fact);
      byPort.set(fact.port_id, facts);
    }
    const matching = (port: PortDefinition, override?: [Group, string]) => {
      const selected = groups.filter((group) => query[group]?.length || override?.[0] === group);
      return (byPort.get(port.id) ?? []).map((fact) => ({
        fact,
        match: all(
          selected.map((group) =>
            any(
              (override?.[0] === group ? [override[1]] : (query[group] ?? [])).map((value) =>
                contextMatches(port, fact, group, value, context),
              ),
            ),
          ),
        ),
      }));
    };
    for (const group of groups) {
      for (const value of catalogQueryOptions[group]) {
        if (!available(group, value, context, gameFilesAvailable)) continue;
        const outcomes = unique.map((port) =>
          any(matching(port, [group, value]).map((entry) => entry.match)),
        );
        counts[group][value] = outcomes.includes(undefined)
          ? null
          : outcomes.filter((match) => match === true).length;
      }
    }
    const outcomes = unique.map((port) => ({ port, matches: matching(port) }));
    if (outcomes.some((outcome) => any(outcome.matches.map((entry) => entry.match)) === undefined))
      return empty("unavailable");
    const matchingContexts = new Map(
      outcomes.map(({ port, matches }) => [
        port.id,
        matches.filter((entry) => entry.match === true).map((entry) => entry.fact),
      ]),
    );
    return {
      state: "matched",
      query,
      counts,
      ports: unique.filter((port) => matchingContexts.get(port.id)?.length),
      matchingContexts,
    };
  }
  const groupMatches = (port: PortDefinition, group: Group) =>
    !query[group]?.length || query[group].some((value) => matches(port, group, value, context));
  for (const group of groups) {
    const facetGroups = [...activeGroups.filter((active) => active !== group), group];
    const facetRequiresContexts =
      facetGroups.length > 1 && facetGroups.some((active) => privateGroups.includes(active));
    const otherMatches = unique.filter((port) =>
      groups.every((other) => other === group || groupMatches(port, other)),
    );
    for (const value of catalogQueryOptions[group]) {
      counts[group][value] =
        !facetRequiresContexts && available(group, value, context, gameFilesAvailable)
          ? otherMatches.filter((port) => matches(port, group, value, context)).length
          : null;
    }
  }
  return {
    state: "matched",
    query,
    counts,
    ports: unique.filter((port) => groups.every((group) => groupMatches(port, group))),
    matchingContexts: new Map(),
  };
}
