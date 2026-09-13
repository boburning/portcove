import { describe, expect, it, vi } from "vitest";
import {
  addPendingOperation,
  CoalescedRequest,
  LatestRequestGeneration,
  mostRecentPendingOperation,
  removePendingOperation,
} from "./concurrency-state";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

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

  it("coalesces a same-turn burst into one request", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const requests = new CoalescedRequest();
    await Promise.all([requests.request(task), requests.request(task), requests.request(task)]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs one follow-up for requests that arrive during an in-flight request", async () => {
    const first = deferred();
    const task = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const requests = new CoalescedRequest();
    const initial = requests.request(task);
    await Promise.resolve();
    const followups = [requests.request(task), requests.request(task)];
    first.resolve();
    await Promise.all([initial, ...followups]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not lose a request that arrives while the queued follow-up is running", async () => {
    const first = deferred();
    const second = deferred();
    const task = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(undefined);
    const requests = new CoalescedRequest();
    const initial = requests.request(task);
    await Promise.resolve();
    const followup = requests.request(task);
    first.resolve();
    await initial;
    await Promise.resolve();
    const later = requests.request(task);
    second.resolve();

    await Promise.all([followup, later]);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("rejects a failed batch without retrying it and still drains a queued follow-up", async () => {
    const first = deferred();
    const error = new Error("unavailable");
    const task = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const requests = new CoalescedRequest();
    const failed = requests.request(task);
    await Promise.resolve();
    const followup = requests.request(task);
    first.reject(error);
    await expect(failed).rejects.toBe(error);
    await expect(followup).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
