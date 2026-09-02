import { describe, expect, it } from "vitest";
import { applyOperationEvent, mostRecentOperation } from "./operation-state";
import type { OperationEvent } from "./types";

function event(
  operationId: string,
  sequence: number,
  timestampMs: number,
  parentOperationId?: string,
): OperationEvent {
  return {
    schema_version: 1,
    operation_id: operationId,
    parent_operation_id: parentOperationId,
    sequence,
    timestamp_ms: timestampMs,
    operation: "synthetic",
    type: "progress",
    phase: "test",
    completed: sequence,
  };
}

describe("operation event state", () => {
  it("keeps overlapping operations independent and rejects stale delivery", () => {
    let state = new Map<string, OperationEvent>();
    state = new Map(applyOperationEvent(state, event("first", 2, 20)));
    state = new Map(applyOperationEvent(state, event("second", 1, 30)));
    state = new Map(applyOperationEvent(state, event("first", 1, 40)));

    expect(state.get("first")?.sequence).toBe(2);
    expect(state.get("second")?.sequence).toBe(1);
    expect(mostRecentOperation(state)?.operation_id).toBe("second");
  });

  it("retains nested operation correlation", () => {
    let state = new Map<string, OperationEvent>();
    state = new Map(applyOperationEvent(state, event("parent", 0, 10)));
    state = new Map(applyOperationEvent(state, event("child", 0, 11, "parent")));

    expect(state.get("child")?.parent_operation_id).toBe("parent");
  });
});
