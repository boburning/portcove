import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "./runtime-values.mts";

// A reader may temporarily deny DELETE sharing on Windows. Retry only this
// already prepared rename; never unlink either path or rewrite prepared bytes.
function remainingSharingWait(error: unknown, attempt: number, deadline: number) {
  const remaining = deadline - performance.now();
  if (
    process.platform !== "win32" ||
    !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "") ||
    attempt >= 40 ||
    remaining <= 0
  )
    throw error;
  return Math.min(25, remaining);
}

export function replacePreparedFileSync(prepared: string, target: string) {
  const deadline = performance.now() + 1000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(prepared, target);
      return;
    } catch (error) {
      Atomics.wait(waiter, 0, 0, remainingSharingWait(error, attempt, deadline));
    }
  }
}

export async function replacePreparedFile(prepared: string, target: string) {
  const deadline = performance.now() + 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(prepared, target);
      return;
    } catch (error) {
      await delay(remainingSharingWait(error, attempt, deadline));
    }
  }
}
