export class LatestRequestGeneration {
  private generation = 0;

  begin() {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number) {
    return generation === this.generation;
  }
}

export function addPendingOperation(
  operations: ReadonlyMap<number, string>,
  id: number,
  name: string,
) {
  const next = new Map(operations);
  next.set(id, name);
  return next;
}

export function removePendingOperation(
  operations: ReadonlyMap<number, string>,
  id: number,
) {
  const next = new Map(operations);
  next.delete(id);
  return next;
}

export function mostRecentPendingOperation(operations: ReadonlyMap<number, string>) {
  return [...operations].sort(([left], [right]) => right - left)[0]?.[1];
}
