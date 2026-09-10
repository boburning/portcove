import type { OperationEvent } from "./types";

export type OperationEventState = ReadonlyMap<string, OperationEvent>;

const RECENT_TERMINAL_LIMIT = 32;

function compareRecency(left: OperationEvent, right: OperationEvent): number {
  return (
    right.timestamp_ms - left.timestamp_ms ||
    right.sequence - left.sequence ||
    left.operation_id.localeCompare(right.operation_id)
  );
}

export function applyOperationEvent(
  current: OperationEventState,
  event: OperationEvent,
): OperationEventState {
  if (event.schema_version !== 2) return current;
  const existing = current.get(event.operation_id);
  if (existing && existing.sequence >= event.sequence) return current;
  if (existing?.type === "finished" && event.type !== "finished")
    return current;
  const next = new Map(current);
  next.set(event.operation_id, event);

  // Keep the available ancestry of live work even if a parent finished first.
  const activeContext = new Set<string>();
  for (const operation of next.values()) {
    if (operation.type === "finished") continue;
    let id: string | null | undefined = operation.operation_id;
    while (id && !activeContext.has(id)) {
      activeContext.add(id);
      id = next.get(id)?.parent_operation_id;
    }
  }
  const terminal = [...next.values()]
    .filter(
      (operation) =>
        operation.type === "finished" &&
        !activeContext.has(operation.operation_id),
    )
    .sort(compareRecency);
  for (const operation of terminal.slice(RECENT_TERMINAL_LIMIT)) {
    next.delete(operation.operation_id);
  }
  return next;
}

export function mostRecentOperation(
  operations: OperationEventState,
): OperationEvent | undefined {
  return [...operations.values()].sort(
    (left, right) =>
      Number(left.type === "finished") - Number(right.type === "finished") ||
      compareRecency(left, right),
  )[0];
}
