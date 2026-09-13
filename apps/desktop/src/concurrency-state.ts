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

export type CoalescedRequestOutcome = "completed" | "disposed";

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
