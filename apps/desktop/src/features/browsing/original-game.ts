import { canonicalIdentityId } from "../identity/identity-style";
import type { CatalogEntry } from "./catalog-entry";

export function originalGame(port: CatalogEntry) {
  return port.presentation?.original_game ?? port.listing?.original_game;
}

/** Unknown titles stay separate; display names never become persistent identity. */
export function gameGroupId(port: CatalogEntry): string {
  const identity = originalGame(port);
  return identity ? `game:${identity.id}` : `port:${port.id}`;
}

export function originalSystems(port: CatalogEntry): string[] {
  const editions = originalGame(port)?.source_editions;
  const systems =
    editions?.map((edition) =>
      edition.system ? canonicalIdentityId(edition.system) : "not-specified",
    ) ?? [];
  return [...new Set(systems.length ? systems : ["not-specified"])];
}

export interface GameGroup {
  id: string;
  ports: CatalogEntry[];
  matchingPorts: CatalogEntry[];
}

export function groupCatalog(
  all: readonly CatalogEntry[],
  matching: readonly CatalogEntry[] = all,
): GameGroup[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const port of all) {
    const id = gameGroupId(port);
    const entries = groups.get(id) ?? [];
    if (!entries.some((entry) => entry.id === port.id)) entries.push(port);
    groups.set(id, entries);
  }
  const visible = new Map<string, GameGroup>();
  for (const port of matching) {
    const id = gameGroupId(port);
    const group = visible.get(id) ?? { id, ports: groups.get(id) ?? [port], matchingPorts: [] };
    if (!group.matchingPorts.some((entry) => entry.id === port.id)) group.matchingPorts.push(port);
    visible.set(id, group);
  }
  return [...visible.values()];
}

export function groupCountLabel(groups: readonly GameGroup[]): string {
  const games = groups.filter((group) => group.id.startsWith("game:")).length;
  const unknown = groups.length - games;
  const parts = [];
  if (games || !unknown) parts.push(`${games} ${games === 1 ? "game" : "games"}`);
  if (unknown) parts.push(`${unknown} ungrouped ${unknown === 1 ? "project" : "projects"}`);
  return parts.join(" + ");
}
