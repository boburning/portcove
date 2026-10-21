/** One role's remaining execution budget across existing coordinator calls.
 * This carries no evidence, credential, grant, retry or journal state. */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const deadlines = new AsyncLocalStorage<number>();

export function coordinatorCommandTimeout(maximum = 30000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("coordinator command timeout is invalid");
  const deadline = deadlines.getStore();
  const remaining =
    deadline === undefined ? maximum : Math.floor(Math.min(maximum, deadline - performance.now()));
  if (remaining < 1) throw new Error("coordinator role phase deadline exhausted");
  return remaining;
}

export function checkCoordinatorDeadline() {
  coordinatorCommandTimeout();
}

/** Nested work may tighten the caller's budget, never restart or extend it. */
export async function withCoordinatorDeadline<T>(
  deadline: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(deadline) || deadline <= performance.now())
    throw new Error("coordinator role phase deadline exhausted");
  const selected = Math.min(deadline, deadlines.getStore() ?? Infinity);
  return deadlines.run(selected, async () => {
    checkCoordinatorDeadline();
    const result = await work();
    checkCoordinatorDeadline();
    return result;
  });
}
