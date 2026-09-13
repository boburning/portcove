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

type Deferred = {
  resolve: (outcome: CoalescedRequestOutcome) => void;
  reject: (error: unknown) => void;
  task: () => Promise<void>;
};

type CoalescedRequestOutcome = "completed" | "disposed";

export type ActivityRefreshPriority = "progress" | "prompt";

/** Coalesces same-turn requests and permits at most one queued follow-up. */
class CoalescedBatch {
  private pending: Deferred[] = [];
  private active = new Set<Deferred>();
  private scheduled = false;
  private running = false;
  private closed = false;

  request(task: () => Promise<void>) {
    if (this.closed) return Promise.resolve<CoalescedRequestOutcome>("disposed");
    const result = new Promise<CoalescedRequestOutcome>((resolve, reject) => {
      this.pending.push({ resolve, reject, task });
    });
    if (!this.scheduled && !this.running) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.drain();
      });
    }
    return result;
  }

  close() {
    this.closed = true;
    const unsettled = [...this.pending.splice(0), ...this.active];
    this.active.clear();
    for (const request of unsettled) request.resolve("disposed");
  }

  private async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const batch = this.pending.splice(0);
        for (const request of batch) this.active.add(request);
        try {
          await batch.at(-1)!.task();
          if (!this.closed) for (const request of batch) request.resolve("completed");
        } catch (error) {
          if (!this.closed) for (const request of batch) request.reject(error);
        } finally {
          for (const request of batch) this.active.delete(request);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Keeps coalescing independent across request-authority generations. */
export class CoalescedRequest {
  private readonly batches = new Map<number, CoalescedBatch>();
  private closed = false;

  request(task: () => Promise<void>, scope = 0) {
    if (this.closed) return Promise.resolve<CoalescedRequestOutcome>("disposed");
    let batch = this.batches.get(scope);
    if (!batch) {
      batch = new CoalescedBatch();
      this.batches.set(scope, batch);
    }
    return batch.request(task);
  }

  close() {
    this.closed = true;
    for (const batch of this.batches.values()) batch.close();
    this.batches.clear();
  }
}

export function closeCoalescedRequest(request: CoalescedRequest) {
  request.close();
}

type ScheduledWaiter = {
  resolve: (outcome: CoalescedRequestOutcome) => void;
  reject: (error: unknown) => void;
};

/**
 * Keeps durable activity reads bounded while visual operation events remain immediate.
 * Prompt boundaries flush a pending progress read; progress uses a non-resetting budget.
 */
export class ActivityRefreshScheduler {
  private readonly requests = new CoalescedRequest();
  private readonly scheduled: ScheduledWaiter[] = [];
  private lastSubmittedAt = Number.NEGATIVE_INFINITY;
  private submissionTurnOpen = false;
  private unsettledSubmissions = 0;
  private turnResult: Promise<CoalescedRequestOutcome> | undefined;
  private latestResult: Promise<CoalescedRequestOutcome> | undefined;
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly task: () => Promise<void>,
    readonly progressBudgetMs = 500,
    private readonly now: () => number = Date.now,
  ) {}

  request(priority: ActivityRefreshPriority) {
    if (this.closed) return Promise.resolve<CoalescedRequestOutcome>("disposed");
    if (priority === "prompt") return this.submit();
    if (this.unsettledSubmissions >= 2 && this.latestResult) return this.latestResult;
    const now = this.now();
    if (this.submissionTurnOpen) return this.submit();
    const delay = Math.max(0, this.lastSubmittedAt + this.progressBudgetMs - now);
    if (delay === 0) return this.submit();
    const result = new Promise<CoalescedRequestOutcome>((resolve, reject) => {
      this.scheduled.push({ resolve, reject });
    });
    if (this.timer === undefined)
      this.timer = globalThis.setTimeout(() => {
        this.timer = undefined;
        void this.submit();
      }, delay);
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiter of this.scheduled.splice(0)) waiter.resolve("disposed");
    this.requests.close();
  }

  private submit() {
    if (this.closed) return Promise.resolve<CoalescedRequestOutcome>("disposed");
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    const scheduled = this.scheduled.splice(0);
    if (this.submissionTurnOpen && this.turnResult) {
      this.settleScheduled(scheduled, this.turnResult);
      return this.turnResult;
    }
    this.lastSubmittedAt = this.now();
    const result = this.requests.request(this.task);
    this.submissionTurnOpen = true;
    this.turnResult = result;
    this.latestResult = result;
    this.unsettledSubmissions += 1;
    queueMicrotask(() => {
      this.submissionTurnOpen = false;
      this.turnResult = undefined;
    });
    void result.then(
      () => {
        this.unsettledSubmissions -= 1;
      },
      () => {
        this.unsettledSubmissions -= 1;
      },
    );
    this.settleScheduled(scheduled, result);
    return result;
  }

  private settleScheduled(scheduled: ScheduledWaiter[], result: Promise<CoalescedRequestOutcome>) {
    void result.then(
      (outcome) => {
        for (const waiter of scheduled) waiter.resolve(outcome);
      },
      (error: unknown) => {
        for (const waiter of scheduled) waiter.reject(error);
      },
    );
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

export function removePendingOperation(operations: ReadonlyMap<number, string>, id: number) {
  const next = new Map(operations);
  next.delete(id);
  return next;
}

export function mostRecentPendingOperation(operations: ReadonlyMap<number, string>) {
  return [...operations].sort(([left], [right]) => right - left)[0]?.[1];
}
