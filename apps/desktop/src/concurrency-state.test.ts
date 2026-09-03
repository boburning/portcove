import { describe, expect, it } from "vitest";
import { addPendingOperation, LatestRequestGeneration, mostRecentPendingOperation, removePendingOperation } from "./concurrency-state";

describe("overlapping desktop work", () => {
  it("accepts only the newest refresh when requests finish in reverse order", () => {
    const generations = new LatestRequestGeneration();
    const older = generations.begin();
    const newer = generations.begin();

    expect(generations.isCurrent(newer)).toBe(true);
    expect(generations.isCurrent(older)).toBe(false);
  });

  it("tracks each pending operation until that exact operation finishes", () => {
    let pending: ReadonlyMap<number, string> = new Map();
    pending = addPendingOperation(pending, 1, "install");
    pending = addPendingOperation(pending, 2, "verify sources");
    expect(mostRecentPendingOperation(pending)).toBe("verify sources");

    pending = removePendingOperation(pending, 2);
    expect(mostRecentPendingOperation(pending)).toBe("install");
    pending = removePendingOperation(pending, 1);
    expect(mostRecentPendingOperation(pending)).toBeUndefined();
  });
});
