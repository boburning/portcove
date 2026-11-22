import type { GameGroup } from "./original-game";
import type { CollectionDestination } from "../../collection-navigation";

export function discoverRows(groups: readonly GameGroup[], columns: number) {
  const width = Math.max(1, columns);
  return Array.from({ length: Math.ceil(groups.length / width) }, (_, index) => {
    const members = groups.slice(index * width, (index + 1) * width);
    return { key: JSON.stringify(members.map(({ id }) => id)), groups: members };
  });
}

export function discoverDestinationIndex(
  groups: readonly GameGroup[],
  target: CollectionDestination,
) {
  return groups.findIndex(
    (group) =>
      group.id === target.groupKey ||
      group.ports.some(
        (port) =>
          port.id === target.portId ||
          target.originKey === `catalog:card:${port.id}` ||
          target.originKey?.startsWith(`catalog:card:${port.id}:`) ||
          target.originKey === `library:card:${port.id}` ||
          target.originKey?.startsWith(`library:card:${port.id}:`) ||
          target.originKey === `library:card-more:${port.id}` ||
          target.originKey === `library:alternative:${port.id}`,
      ),
  );
}

/** Computed grid tracks already include the CSS breakpoints and interface scale. */
export function resolvedGridColumns(template: string) {
  return Math.max(
    1,
    template
      .trim()
      .split(/\s+/u)
      .filter((track) => /^\d+(?:\.\d+)?px$/u.test(track)).length,
  );
}

/** Account for fractional native scroll positions at rounded CSSOM boundaries. */
export function collectionAnchorAligned(delta: number, scrollTop: number, limit: number) {
  const destination = scrollTop + delta;
  return (
    Math.abs(delta) < 0.5 ||
    (destination < 0 && scrollTop === 0) ||
    (destination > limit && Math.abs(scrollTop - limit) <= 1)
  );
}
