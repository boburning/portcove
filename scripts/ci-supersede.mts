import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";

const repository = "boburning/portcove";
const root = `https://api.github.com/repos/${repository}/actions`;
const activeStatuses = ["queued", "in_progress", "waiting"] as const;

interface RunRef {
  id: number;
  pullRequests: number[];
  headBranch: string | undefined;
  headRepository: string | undefined;
}

/** The pull request a run belongs to; runs GitHub left without `pull_requests` match by head branch and repository. */
export interface PullRequestIdentity {
  number: number;
  headRef?: string | undefined;
  headRepository?: string | undefined;
}

function belongs(run: RunRef, pull: PullRequestIdentity) {
  if (run.pullRequests.includes(pull.number)) return true;
  return (
    run.pullRequests.length === 0 &&
    pull.headRef !== undefined &&
    pull.headRepository !== undefined &&
    run.headBranch === pull.headRef &&
    run.headRepository === pull.headRepository
  );
}

function runRefs(value: unknown): RunRef[] {
  const runs = isRecord(value) ? value.workflow_runs : undefined;
  if (!Array.isArray(runs)) throw new Error("Workflow run listing is malformed");
  return runs.map((run: unknown) => {
    if (!isRecord(run) || typeof run.id !== "number" || !Number.isSafeInteger(run.id))
      throw new Error("Workflow run omitted its integer identity");
    const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const repository = isRecord(run.head_repository) ? run.head_repository.full_name : undefined;
    return {
      id: run.id,
      pullRequests: pulls.flatMap((pull: unknown) =>
        isRecord(pull) && typeof pull.number === "number" ? [pull.number] : [],
      ),
      headBranch: typeof run.head_branch === "string" ? run.head_branch : undefined,
      headRepository: typeof repository === "string" ? repository : undefined,
    };
  });
}

/** Run IDs only increase, so runs older than this head's own run are never newer work. */
export function ownRunId(listing: unknown, pull: PullRequestIdentity): number | undefined {
  const ids = runRefs(listing)
    .filter((run) => belongs(run, pull))
    .map((run) => run.id);
  return ids.length ? Math.max(...ids) : undefined;
}

export function supersededRunIds(
  listings: readonly unknown[],
  own: number,
  pull: PullRequestIdentity,
): number[] {
  const ids = new Set<number>();
  for (const listing of listings)
    for (const run of runRefs(listing)) if (run.id < own && belongs(run, pull)) ids.add(run.id);
  return [...ids].sort((left, right) => left - right);
}

/**
 * True when a CI run deferred its Windows partitions for a draft: the required rust result failed,
 * the Windows build succeeded and every partition job was skipped. Anything else is left alone.
 */
export function deferredWindowsRun(listing: unknown): boolean {
  const jobs = isRecord(listing) ? listing.jobs : undefined;
  if (!Array.isArray(jobs)) throw new Error("Workflow job listing is malformed");
  const records = jobs.filter(isRecord);
  const named = (name: string) => records.filter((job) => job.name === name);
  const partitions = records.filter(
    // A matrix job skipped before expansion may keep its template name or fall back to its key.
    (job) =>
      typeof job.name === "string" &&
      (job.name.startsWith("fast-rust-test (windows-x86_64,") || job.name === "fast_rust_tests"),
  );
  const [gate] = named("rust");
  const [build] = named("fast-rust-build (windows-x86_64)");
  return (
    named("rust").length === 1 &&
    gate?.status === "completed" &&
    gate.conclusion === "failure" &&
    named("fast-rust-build (windows-x86_64)").length === 1 &&
    build?.status === "completed" &&
    build.conclusion === "success" &&
    partitions.length > 0 &&
    partitions.every((job) => job.status === "completed" && job.conclusion === "skipped")
  );
}

async function main() {
  const token = process.env.GH_TOKEN ?? "";
  const pullRequest = Number(process.env.PR_NUMBER);
  const headSha = process.env.HEAD_SHA ?? "";
  const pull: PullRequestIdentity = {
    number: pullRequest,
    headRef: process.env.HEAD_REF || undefined,
    headRepository: process.env.HEAD_REPO || undefined,
  };
  if (
    !token ||
    !Number.isSafeInteger(pullRequest) ||
    pullRequest <= 0 ||
    !/^[0-9a-f]{40}$/u.test(headSha)
  )
    throw new Error("Missing or malformed pull request identity");
  let requests = 0;
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 4 * 60_000,
    maxBytes: 8 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    environmentProxy: true,
    allowRequest: (method, url) =>
      (method === "GET" || method === "POST") &&
      url.origin === "https://api.github.com" &&
      url.pathname.startsWith(`/repos/${repository}/actions/`),
    reserve: () => {
      if (++requests > 64)
        throw new GitHubApiError("budget_exhausted", "Supersede request budget exhausted");
      return { consumeBytes() {}, settle() {} };
    },
  });
  const list = async (query: string) =>
    (
      await sdk.request({
        method: "GET",
        url: `${root}/workflows/ci.yml/runs?event=pull_request&${query}&per_page=100`,
        request: { portcove: { replay: "safe-read", attempts: 0 } },
      })
    ).data as unknown;
  let own: number | undefined;
  for (let attempt = 0; attempt < 6 && own === undefined; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5000));
    own = ownRunId(await list(`head_sha=${headSha}`), pull);
  }
  if (own === undefined) {
    console.log(`No CI run for ${headSha} yet; nothing to supersede`);
    return;
  }
  if (process.env.EVENT_ACTION === "ready_for_review") {
    // No new CI run starts for this head: re-run its deferred draft run so the same run, with a
    // new attempt, executes the Windows partitions. The classifier reads the draft state live.
    const get = async (url: string) =>
      (
        await sdk.request({
          method: "GET",
          url,
          request: { portcove: { replay: "safe-read", attempts: 0 } },
        })
      ).data as unknown;
    let cancelled = false;
    for (let wait = 0; ; wait += 1) {
      const run = await get(`${root}/runs/${own}`);
      const status = isRecord(run) ? run.status : undefined;
      if (status === "completed") break;
      if (wait === 0) {
        console.log(`Cancelling run ${own} so its draft attempt can be re-run`);
        await sdk.request({
          method: "POST",
          url: `${root}/runs/${own}/cancel`,
          request: { portcove: { replay: "once", attempts: 0 } },
        });
        cancelled = true;
      }
      if (wait >= 15)
        throw new Error(`Run ${own} did not finish; re-run it to execute the Windows partitions`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    // A run cancelled here never completed its plan, so it is always re-run.
    if (
      !cancelled &&
      !deferredWindowsRun(await get(`${root}/runs/${own}/jobs?filter=latest&per_page=100`))
    ) {
      console.log(`Run ${own} did not defer its Windows partitions; nothing to re-run`);
      return;
    }
    console.log(`Re-running run ${own} to execute its deferred Windows partitions`);
    await sdk.request({
      method: "POST",
      url: `${root}/runs/${own}/rerun`,
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    return;
  }
  const listings: unknown[] = [];
  for (const status of activeStatuses) listings.push(await list(`status=${status}`));
  for (const run of supersededRunIds(listings, own, pull)) {
    console.log(`Cancelling superseded run ${run}`);
    try {
      await sdk.request({
        method: "POST",
        url: `${root}/runs/${run}/cancel`,
        request: { portcove: { replay: "once", attempts: 0 } },
      });
    } catch (error) {
      // A finished or already-cancelled run only costs a refusal here.
      console.log(`Run ${run} was not cancelled: ${sanitizeOperationError(error).message}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error: unknown) => {
    const message = sanitizeOperationError(error).message;
    // The workflow step is best effort, so surface a failure as an annotation instead of letting it pass unseen.
    console.log(
      `::warning title=Superseded CI runs were not cancelled::${message.replaceAll(/[\r\n]+/gu, " ")}`,
    );
    console.error(message);
    process.exitCode = 1;
  });
