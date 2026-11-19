/** Optional presentation capability. The existing route owner retains transition authority. */
export type CollectionDestination = {
  originKey?: string | undefined;
  portId?: string | undefined;
  groupKey?: string | undefined;
  scrollTop?: number | undefined;
  viewportTop?: number | undefined;
};
export type CollectionNavigation = {
  capture?: (() => CollectionDestination | undefined) | undefined;
  /** Mount, measure and apply requested scroll/anchor before acknowledging. */
  mount: (destination: CollectionDestination, current: () => boolean) => Promise<boolean>;
  prepareMove: (
    origin: HTMLElement,
    direction: "up" | "down" | "left" | "right",
    current: () => boolean,
  ) => Promise<boolean> | undefined;
};
const collections = new WeakMap<HTMLElement, CollectionNavigation>();

export function registerCollectionNavigation(
  element: HTMLElement,
  capability: CollectionNavigation,
) {
  collections.set(element, capability);
  return () => {
    collections.delete(element);
  };
}

export function hasCollectionNavigation(workspace: HTMLElement) {
  const root = workspace.querySelector<HTMLElement>("[data-virtual-collection]");
  return Boolean(root && collections.has(root));
}

export function captureCollectionDestination(workspace: HTMLElement | null) {
  const root = workspace?.querySelector<HTMLElement>("[data-virtual-collection]");
  return root ? collections.get(root)?.capture?.() : undefined;
}

export async function mountCollectionDestination(
  workspace: HTMLElement,
  destination: CollectionDestination,
  current: () => boolean,
) {
  const root = workspace.querySelector<HTMLElement>("[data-virtual-collection]");
  const capability = root && collections.get(root);
  if (!capability) return current();
  const accepted = await capability.mount(destination, current);
  // An accepted empty query removes the collection; the route still owns fallback focus.
  return accepted || (current() && !hasCollectionNavigation(workspace));
}

export function prepareCollectionMove(
  origin: HTMLElement | undefined,
  direction: "up" | "down" | "left" | "right",
  current: () => boolean,
) {
  const root = origin?.closest<HTMLElement>("[data-virtual-collection]");
  return root && origin
    ? collections.get(root)?.prepareMove(origin, direction, current)
    : undefined;
}

/** Entering a collection also resolves its logical first/last row, not its current DOM window. */
export function prepareCollectionEntry(
  target: HTMLElement,
  origin: HTMLElement | undefined,
  direction: "up" | "down" | "left" | "right",
  current: () => boolean,
) {
  const root = target.closest<HTMLElement>("[data-virtual-collection]");
  if (!root || !origin || root.contains(origin)) return;
  return collections.get(root)?.prepareMove(origin, direction, current);
}

/** Distant independently pinned rows cannot substitute for a logical neighbor. */
export function collectionMovementCandidates(
  candidates: HTMLElement[],
  origin: HTMLElement | undefined,
) {
  const row = origin?.closest<HTMLElement>("[data-collection-row]");
  const collection = row?.closest("[data-virtual-collection]");
  if (!row || !collection) return candidates;
  return candidates.filter((item) => {
    const other = item.closest<HTMLElement>("[data-collection-row]");
    return (
      !other ||
      other.closest("[data-virtual-collection]") !== collection ||
      Math.abs(Number(other.dataset.collectionRow) - Number(row.dataset.collectionRow)) <= 1
    );
  });
}
