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
    schema_version: 2,
    operation_id: operationId,
    parent_operation_id: parentOperationId ?? null,
    target: null,
    sequence,
    timestamp_ms: timestampMs,
    operation: "synthetic",
    type: "progress",
    phase: "test",
    completed: sequence,
    total: null,
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
    state = new Map(
      applyOperationEvent(state, event("child", 0, 11, "parent")),
    );

    expect(state.get("child")?.parent_operation_id).toBe("parent");
  });

  it("bounds thousands of completed operations without evicting overlapping work", () => {
    let state: ReadonlyMap<string, OperationEvent> = new Map();
    state = applyOperationEvent(state, event("active-first", 2, 20));
    state = applyOperationEvent(state, event("active-second", 1, 30));
    for (let index = 0; index < 5_000; index++) {
      state = applyOperationEvent(state, {
        ...event(`finished-${index}`, 3, 100 + index),
        type: "finished",
        result: "succeeded",
      });
    }
    expect(state.size).toBeLessThanOrEqual(34);
    expect(state.has("active-first")).toBe(true);
    expect(state.has("active-second")).toBe(true);
    expect(state.has("finished-4999")).toBe(true);
    expect(state.has("finished-0")).toBe(false);
    expect(mostRecentOperation(state)?.operation_id).toBe("active-second");
  });

  it("pins completed ancestors only while their descendants remain active", () => {
    let state: ReadonlyMap<string, OperationEvent> = new Map();
    state = applyOperationEvent(state, event("parent", 0, 10));
    state = applyOperationEvent(state, event("child", 0, 11, "parent"));
    state = applyOperationEvent(state, {
      ...event("parent", 1, 12),
      type: "finished",
      result: "failed",
    });
    for (let index = 0; index < 64; index++) {
      state = applyOperationEvent(state, {
        ...event(`other-${index}`, 1, 100 + index),
        type: "finished",
        result: "succeeded",
      });
    }
    expect(state.size).toBe(34);
    expect(state.get("parent")?.result).toBe("failed");
    expect(mostRecentOperation(state)?.operation_id).toBe("child");
    state = applyOperationEvent(state, {
      ...event("child", 1, 200, "parent"),
      type: "finished",
      result: "cancelled",
    });
    expect(state.size).toBe(32);
    expect(state.has("parent")).toBe(false);
    expect(mostRecentOperation(state)?.result).toBe("cancelled");
  });

  it("keeps recent success, failure and cancellation without reviving completed work", () => {
    const initial = new Map<string, OperationEvent>();
    const completed = applyOperationEvent(initial, {
      ...event("completed", 4, 40),
      type: "finished",
      result: "failed",
    });
    expect(initial.size).toBe(0);
    expect(applyOperationEvent(completed, event("completed", 3, 50))).toBe(
      completed,
    );
    expect(applyOperationEvent(completed, event("completed", 5, 60))).toBe(
      completed,
    );
    let state = completed;
    for (const [index, result] of (
      ["succeeded", "failed", "cancelled"] as const
    ).entries()) {
      state = applyOperationEvent(state, {
        ...event(result, 1, 100 + index),
        type: "finished",
        result,
      });
    }
    expect(state.get("succeeded")?.result).toBe("succeeded");
    expect(state.get("failed")?.result).toBe("failed");
    expect(mostRecentOperation(state)?.result).toBe("cancelled");
    expect(completed.size).toBe(1);
  });

  it("evicts by event recency rather than delayed delivery and breaks parent cycles", () => {
    let state: ReadonlyMap<string, OperationEvent> = new Map();
    state = applyOperationEvent(state, event("cycle-a", 0, 10, "cycle-b"));
    state = applyOperationEvent(state, event("cycle-b", 0, 11, "cycle-a"));
    for (let index = 63; index >= 0; index--) {
      state = applyOperationEvent(state, {
        ...event(`finished-${index}`, 1, 100 + index),
        type: "finished",
        result: "succeeded",
      });
    }
    expect(state.size).toBe(34);
    expect(state.has("finished-63")).toBe(true);
    expect(state.has("finished-0")).toBe(false);
    expect(mostRecentOperation(state)?.operation_id).toBe("cycle-b");
  });
});
