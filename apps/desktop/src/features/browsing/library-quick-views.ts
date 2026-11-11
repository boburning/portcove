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

export function withUpdatesQuickView(filter: Filter | CatalogQuery): Filter | CatalogQuery {
  const query = queryFromFilter(filter);
  return query.version === 1 ? { ...query, updates: [...quickViewUpdates] } : filter;
}

/** Returns the selected view, or undefined when other constraints combine views. */
export function activeLibraryQuickView({
  favoritesOnly,
  readiness,
  filter,
}: {
  favoritesOnly: boolean;
  readiness: string;
  filter: Filter | CatalogQuery;
}): LibraryQuickView | undefined {
  const updates = isUpdatesQuickView(filter);
  const active = [
    favoritesOnly && ("favorites" as const),
    readiness === "setup" && ("attention" as const),
    updates && ("updates" as const),
  ].filter((view): view is Exclude<LibraryQuickView, "all"> => Boolean(view));
  if (active.length > 1) return undefined;
  if (active.length === 1) return active[0];
  return readiness === "all" ? "all" : undefined;
}

export type QuickViewCount = number | "unavailable";

export function libraryQuickViewCounts({
  base,
  filter,
  favoriteIds,
  statuses,
  context,
  scope,
}: {
  /** Library membership after search, before readiness, favorites and filters. */
  base: CatalogEntry[] | undefined;
  filter: Filter | CatalogQuery;
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
  if (!base) return unavailable;
  const baseFilter = queryFromFilter(withoutUpdatesQuickView(filter));
  const declared = evaluateCatalogQuery(base, baseFilter, context);
  if (declared.state !== "matched") return unavailable;
  const scoped = scope(declared.ports);
  const updates = evaluateCatalogQuery(scoped, withUpdatesQuickView(baseFilter), context);
  return {
    all: scoped.length,
    favorites: favoriteIds
      ? scoped.filter((port) => favoriteIds.has(port.id)).length
      : "unavailable",
    attention: filterPorts(scoped, statuses, "library", "setup", "").length,
    updates: updates.state === "matched" ? updates.ports.length : "unavailable",
  };
}
