import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityRefreshScheduler,
  addPendingOperation,
  CoalescedRequest,
  LatestRequestGeneration,
  mostRecentPendingOperation,
  removePendingOperation,
} from "./concurrency-state";

afterEach(() => vi.useRealTimers());

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
    await expect(followup).resolves.toBe("completed");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("settles queued and in-flight callers as disposed when their lifecycle closes", async () => {
    const first = deferred();
    const task = vi.fn().mockReturnValue(first.promise);
    const requests = new CoalescedRequest();
    const active = requests.request(task);
    await Promise.resolve();
    const queued = requests.request(task);

    requests.close();

    await expect(active).resolves.toBe("disposed");
    await expect(queued).resolves.toBe("disposed");
    await expect(requests.request(task)).resolves.toBe("disposed");
    first.resolve();
    await first.promise;
    expect(task).toHaveBeenCalledOnce();
  });

  it("bounds separate-turn progress reads without starving sustained progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ActivityRefreshScheduler(task, 500);

    await scheduler.request("progress");
    for (let elapsed = 100; elapsed <= 2_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      void scheduler.request("progress");
    }

    expect(task).toHaveBeenCalledTimes(5);
    scheduler.close();
  });

  it("coalesces event, poll, and focus hints and flushes boundaries promptly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ActivityRefreshScheduler(task, 500);

    await Promise.all([
      scheduler.request("prompt"),
      scheduler.request("prompt"),
      scheduler.request("progress"),
    ]);
    expect(task).toHaveBeenCalledOnce();

    vi.setSystemTime(100);
    const delayed = scheduler.request("progress");
    vi.setSystemTime(150);
    await scheduler.request("prompt");
    await expect(delayed).resolves.toBe("completed");
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.close();
  });

  it("keeps slow overlapping reads to one in flight plus one follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = deferred();
    const task = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const scheduler = new ActivityRefreshScheduler(task, 500);

    const initial = scheduler.request("progress");
    await Promise.resolve();
    for (let elapsed = 100; elapsed <= 1_500; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      void scheduler.request("progress");
    }
    expect(task).toHaveBeenCalledOnce();
    first.resolve();
    await initial;
    await vi.runAllTimersAsync();
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.close();
  });

  it("does not retry failed reads and disposes delayed waiters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const error = new Error("activity read failed");
    const task = vi.fn().mockRejectedValue(error);
    const scheduler = new ActivityRefreshScheduler(task, 500);

    await expect(scheduler.request("progress")).rejects.toBe(error);
    vi.setSystemTime(100);
    const delayed = scheduler.request("progress");
    scheduler.close();

    await expect(delayed).resolves.toBe("disposed");
    await vi.runAllTimersAsync();
    expect(task).toHaveBeenCalledOnce();
  });
});
