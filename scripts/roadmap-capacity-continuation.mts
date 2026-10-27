import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

export function roadmapQuotaDeferred(
  phase: string,
  evidence: Record<string, unknown>,
  rate: { remaining: number; resetAt: string },
) {
  return Object.assign(
    new Error(`${phase} retains progress; continue after provider reset ${rate.resetAt}`),
    {
      code: "set_many_quota_deferred",
      operationStatus: "partial",
      operationEvidence: {
        phase,
        ...evidence,
        rate_limit: { remaining: rate.remaining, reset_at: rate.resetAt },
      },
    },
  );
}
/** Only positive pre-admission quota deferrals resume. HTTP/write failures never enter this loop. */
export async function continueRoadmapCapacity<T>(
  operation: () => Promise<T>,
  {
    now = Date.now,
    wait = async (until: number) => {
      while (Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, Math.min(60000, until - Date.now())));
    },
    observe = () => {},
    identity,
  }: {
    now?: () => number;
    wait?: (until: number) => Promise<void>;
    observe?: (error: unknown) => void;
    identity?: () => string;
  } = {},
) {
  const inputIdentity = identity?.();
  for (;;) {
    if (identity && identity() !== inputIdentity)
      throw new Error(
        "Roadmap specification or configuration changed while waiting; no further operation",
      );
    try {
      return await operation();
    } catch (error) {
      if (
        !isRecord(error) ||
        error.code !== "set_many_quota_deferred" ||
        !isRecord(error.operationEvidence) ||
        !isRecord(error.operationEvidence.rate_limit)
      )
        throw error;
      const reset = error.operationEvidence.rate_limit.reset_at;
      const until = typeof reset === "string" ? Date.parse(reset) : NaN;
      if (!Number.isFinite(until) || until <= now()) throw error;
      // The caller's operation has already released its per-operation lock.
      observe(error);
      await wait(until);
    }
  }
}
export function retainRoadmapQuotaDeferral(root: string, error: unknown) {
  const directory = path.join(root, "work/roadmap-diagnostics");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}-quota-deferral.json`);
  const evidence = isRecord(error) ? error.operationEvidence : null;
  writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      command: "set-many",
      observed_at: new Date().toISOString(),
      operation_evidence: evidence,
    }),
    { flag: "wx" },
  );
  // stderr stays diagnostic when stdout has a machine-readable final result.
  appendFileSync(
    process.stderr.fd,
    `Roadmap quota deferred; durable progress retained at ${file}. Lock released; waiting for the observed provider reset.\n`,
  );
}
