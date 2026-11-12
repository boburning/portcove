import type { CatalogEntry } from "./catalog-entry";
import { evaluateCatalogQuery, type CatalogQuery, type CatalogQueryContext } from "./catalog-query";
import { queryFromFilter } from "./CatalogFilters";
import { filterPorts, type Filter } from "../../view-model";
import type { PortStatus } from "../../types";
import { isQuickViewUpdateSelection, quickViewUpdates } from "./quick-view-updates";

/**
 * Library quick views are one exclusive choice. Each view narrows the same
 * base: library membership, search, the selected collection and any declared
 * filters other than the quick view itself. Counts never derive from another
 * view's already-narrowed result.
 */
export type LibraryQuickView = "all" | "favorites" | "attention" | "updates";

export function isUpdatesQuickView(filter: Filter | CatalogQuery) {
  return isQuickViewUpdateSelection(queryFromFilter(filter).updates);
}

/** Removes only the quick view's own update selection; custom filters remain. */
export function withoutUpdatesQuickView(filter: Filter | CatalogQuery): Filter | CatalogQuery {
  if (!isUpdatesQuickView(filter)) return filter;
  return { ...queryFromFilter(filter), updates: [] };
}

/** A player-chosen Observed updates filter that is not the Updates view itself. */
export function hasCustomUpdateFilter(filter: Filter | CatalogQuery) {
  const updates = queryFromFilter(filter).updates ?? [];
  return updates.length > 0 && !isUpdatesQuickView(filter);
}

/** Never overwrites a custom update filter; the Updates view is unavailable then. */
export function withUpdatesQuickView(filter: Filter | CatalogQuery): Filter | CatalogQuery {
  const query = queryFromFilter(filter);
  return query.version === 1 && !hasCustomUpdateFilter(filter)
    ? { ...query, updates: [...quickViewUpdates] }
    : filter;
}

/** The readiness value a view selection leaves behind. Ready stays a filter. */
export function readinessForQuickView(view: LibraryQuickView, current: string) {
  if (view === "attention") return "setup";
  return current === "setup" ? "all" : current;
}

/**
 * Returns the selected view, or undefined when constraints combine views or a
 * readiness value cannot be interpreted. Ready is an ordinary filter.
 */
export function activeLibraryQuickView({
  favoritesOnly,
  readiness,
  filter,
}: {
  favoritesOnly: boolean;
  readiness: string;
  filter: Filter | CatalogQuery;
}): LibraryQuickView | undefined {
  if (!["all", "ready", "setup"].includes(readiness)) return undefined;
  const active = [
    favoritesOnly && ("favorites" as const),
    readiness === "setup" && ("attention" as const),
    isUpdatesQuickView(filter) && ("updates" as const),
  ].filter((view): view is Exclude<LibraryQuickView, "all"> => Boolean(view));
  if (active.length > 1) return undefined;
  return active[0] ?? "all";
}

export type QuickViewCount = number | "unavailable";

export function libraryQuickViewCounts({
  base,
  filter,
  readiness,
  favoriteIds,
  statuses,
  context,
  scope,
}: {
  /** Library membership after search, before readiness, favorites and filters. */
  base: CatalogEntry[] | undefined;
  filter: Filter | CatalogQuery;
  /** Ready narrows every view except Needs attention, which replaces it. */
  readiness: string;
  favoriteIds: ReadonlySet<string> | undefined;
  statuses: Map<string, PortStatus>;
  context: CatalogQueryContext | undefined;
  /** Applies the selected collection or other non-view scope. */
  scope: (ports: CatalogEntry[]) => CatalogEntry[];
}): Record<LibraryQuickView, QuickViewCount> {
  const unavailable = {
    all: "unavailable",
    favorites: "unavailable",
    attention: "unavailable",
    updates: "unavailable",
  } as const;
  if (!base || !["all", "ready", "setup"].includes(readiness)) return unavailable;
  const baseFilter = queryFromFilter(withoutUpdatesQuickView(filter));
  const declared = evaluateCatalogQuery(base, baseFilter, context);
  if (declared.state !== "matched") return unavailable;
  const scoped = scope(declared.ports);
  const narrowed =
    readiness === "ready" ? filterPorts(scoped, statuses, "library", "ready", "") : scoped;
  const updates = hasCustomUpdateFilter(baseFilter)
    ? undefined
    : evaluateCatalogQuery(narrowed, withUpdatesQuickView(baseFilter), context);
  return {
    all: narrowed.length,
    favorites: favoriteIds
      ? narrowed.filter((port) => favoriteIds.has(port.id)).length
      : "unavailable",
    attention: filterPorts(scoped, statuses, "library", "setup", "").length,
    updates: updates?.state === "matched" ? updates.ports.length : "unavailable",
  };
}
