import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

import { GitHubApiError } from "./github-operation.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import type { GitHubCredential, GitHubRequestPolicy } from "./github-client.mts";
import type { RoadmapRequestScope } from "./roadmap.mts";

/** One command owns this scope across quota windows and recreated SDK clients. */
export function createRoadmapRequestScope({
  allowMutations,
  milliseconds = 30 * 60000,
  maximumMetadataBytes = 64 * 1024 * 1024,
  credential,
  ghCommand,
  now = () => performance.now(),
}: {
  allowMutations: boolean;
  milliseconds?: number;
  maximumMetadataBytes?: number;
  credential?: GitHubCredential;
  ghCommand?: string | undefined;
  now?: () => number;
}) {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isSafeInteger(maximumMetadataBytes) ||
    maximumMetadataBytes < 1
  )
    throw new GitHubApiError("invalid_configuration", "Invalid Roadmap command bounds");
  const deadline = now() + milliseconds;
  let received = 0;
  return {
    credential: credential ?? localDeveloperCredential({ deadline, command: ghCommand }),
    deadline,
    now,
    allowMutations,
    failedReads: new Map<string, GitHubRequestPolicy>(),
    deferral: { primary: new Map<string, number>(), secondary: 0 },
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    reserve: () => {
      if (received >= maximumMetadataBytes)
        throw new GitHubApiError(
          "budget_exhausted",
          "Roadmap command metadata allowance exhausted",
        );
      return {
        consumeBytes(bytes: number) {
          received += bytes;
          if (received > maximumMetadataBytes)
            throw new GitHubApiError(
              "budget_exhausted",
              "Roadmap command metadata allowance exhausted",
            );
        },
        settle() {},
      };
    },
  } satisfies RoadmapRequestScope;
}

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
      while (now() < until) {
        const remaining = deadline === undefined ? Infinity : deadline - monotonicNow();
        if (remaining <= 0) return;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.ceil(Math.min(60000, until - now(), remaining))),
        );
      }
    },
    observe = () => {},
    identity,
    deadline,
    monotonicNow = () => performance.now(),
  }: {
    now?: () => number;
    wait?: (until: number) => Promise<void>;
    observe?: (error: unknown) => void;
    identity?: () => string;
    deadline?: number;
    monotonicNow?: () => number;
  } = {},
) {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new GitHubApiError("invalid_configuration", "Invalid Roadmap continuation deadline");
  const inputIdentity = identity?.();
  for (;;) {
    if (deadline !== undefined && monotonicNow() >= deadline)
      throw new GitHubApiError("deadline_exceeded", "Original Roadmap command deadline exhausted");
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
      if (deadline !== undefined && until - now() >= deadline - monotonicNow()) throw error;
      await wait(until);
      if (deadline !== undefined && monotonicNow() >= deadline) throw error;
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
