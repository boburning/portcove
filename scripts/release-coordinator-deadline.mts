/** One role's remaining execution budget across existing coordinator calls.
 * This carries no evidence, credential, grant, retry or journal state. */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

// Keep the original execution deadline separate from the temporary command
// collection cap. A nested readback must never turn an extended cap into a
// fresh execution deadline or another thirty seconds.
const deadlines = new AsyncLocalStorage<{ execution: number; command: number }>();

export function coordinatorCommandTimeout(maximum = 30000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("coordinator command timeout is invalid");
  const deadline = deadlines.getStore()?.command;
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
  const selected = Math.min(deadline, deadlines.getStore()?.execution ?? Infinity);
  return deadlines.run({ execution: selected, command: selected }, async () => {
    checkCoordinatorDeadline();
    const result = await work();
    checkCoordinatorDeadline();
    return result;
  });
}

/** Synchronous collection ONLY in the fixed transport's already-attempted CAS
 * tuple query. That transport independently refuses every mutation and other
 * route after execution expiry. This is the existing absolute30s allowance,
 * never a retry, execution extension or renewable/nestable clock. */
export function withCoordinatorReadback<T>(original: number, read: () => T): T {
  const inherited = deadlines.getStore()?.execution;
  if (
    !Number.isFinite(original) ||
    (inherited !== undefined && original > inherited) ||
    original - performance.now() > 120000 ||
    performance.now() >= original + 30000
  )
    throw new Error("coordinator readback original deadline or collection bound differs");
  return deadlines.run({ execution: original, command: original + 30000 }, read);
}
