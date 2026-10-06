import type { PortDefinition, PortStatus } from "../../types";

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
} as const;

type Group = keyof typeof catalogQueryOptions;
export type CatalogQuery = { version: number } & Partial<Record<Group, readonly string[]>>;

export interface CatalogQueryContext {
  devicePlatform?: PortDefinition["platforms"][number];
  /** A supplied Core snapshot for this selected library; absent is not empty. */
  library?: { id: string; statuses: ReadonlyMap<string, PortStatus> };
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

function available(group: Group, value: string, context: CatalogQueryContext): boolean {
  if (group === "membership") return Boolean(context.library?.id);
  return group !== "platforms" || value !== "this-device" || !!context.devicePlatform;
}

function matches(
  port: PortDefinition,
  group: Group,
  value: string,
  context: CatalogQueryContext,
): boolean {
  switch (group) {
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
  }
}

/** Pure cached-snapshot evaluation. Search/view/readiness narrowing precedes this call.
 * All facts are port-level declarations or selected-library membership. In particular,
 * managed InstallRecord has no platform identity: this is not a route/build matcher.
 */
export function evaluateCatalogQuery(
  ports: readonly PortDefinition[],
  query: unknown,
  context: CatalogQueryContext = {},
): CatalogQueryResult {
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
  if (groups.some((group) => query[group]?.some((value) => !available(group, value, context))))
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
      counts[group][value] = available(group, value, context)
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
