import type { OperationEvent } from "./types";

export type OperationEventState = ReadonlyMap<string, OperationEvent>;

export function applyOperationEvent(
  current: OperationEventState,
  event: OperationEvent,
): OperationEventState {
  if (event.schema_version !== 1) return current;
  const existing = current.get(event.operation_id);
  if (existing && existing.sequence >= event.sequence) return current;
  const next = new Map(current);
  next.set(event.operation_id, event);
  return next;
}

export function mostRecentOperation(
  operations: OperationEventState,
): OperationEvent | undefined {
  return [...operations.values()].sort(
    (left, right) =>
      right.timestamp_ms - left.timestamp_ms || right.sequence - left.sequence,
  )[0];
}
