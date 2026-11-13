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

export const deferralMarkerStep = "Defer Windows test partitions for draft";

/**
 * What a ready_for_review event should do with the head's own CI run. The classifier records its
 * decision as the deferral marker step (success: deferred; skipped: not deferred), so an active
 * run is decided as soon as it is classified, even while its Windows build is still pending and no
 * partition job exists yet. A run that has not classified yet reads the live (ready) state itself.
 * Heads without the marker fall back conservatively: a Rust build that is still pending is
 * cancelled and re-run. A completed run uses the job-outcome detector.
 */
export function readyForReviewAction(
  run: unknown,
  listing: unknown,
): "wait" | "none" | "rerun" | "cancel-and-rerun" {
  const status = isRecord(run) ? run.status : undefined;
  if (status === "completed") return deferredWindowsRun(listing) ? "rerun" : "none";
  const jobs =
    isRecord(listing) && Array.isArray(listing.jobs) ? listing.jobs.filter(isRecord) : [];
  const classify = jobs.filter((job) => job.name === "classify-ci-plan");
  const classified = classify[0];
  if (classify.length !== 1 || classified?.status !== "completed") return "wait";
  if (classified.conclusion !== "success") return "none";
  const steps = Array.isArray(classified.steps) ? classified.steps.filter(isRecord) : [];
  const marker = steps.filter((step) => step.name === deferralMarkerStep);
  if (marker.length === 1) {
    if (marker[0]?.conclusion === "success") return "cancel-and-rerun";
    if (marker[0]?.conclusion === "skipped") return "none";
    return "wait";
  }
  // Without the marker: deferral shows only after the build, through skipped partitions.
  const partitions = jobs.filter(
    (job) =>
      typeof job.name === "string" &&
      (job.name.startsWith("fast-rust-test (windows-x86_64,") || job.name === "fast_rust_tests"),
  );
  const builds = jobs.filter((job) => job.name === "fast-rust-build (windows-x86_64)");
  const build = builds[0];
  if (builds.length !== 1 || build?.conclusion === "skipped") return "none";
  if (build?.status !== "completed") return partitions.length ? "none" : "cancel-and-rerun";
  return build.conclusion === "success" &&
    partitions.length > 0 &&
    partitions.every((job) => job.status === "completed" && job.conclusion === "skipped")
    ? "cancel-and-rerun"
    : "none";
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
  const clientDeadline = performance.now() + 4 * 60_000;
  // Leave room for the cancel/re-run requests after any wait.
  const waitUntil = clientDeadline - 20_000;
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: clientDeadline,
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
    let action: ReturnType<typeof readyForReviewAction> = "wait";
    while (action === "wait") {
      action = readyForReviewAction(
        await get(`${root}/runs/${own}`),
        await get(`${root}/runs/${own}/jobs?filter=latest&per_page=100`),
      );
      if (action !== "wait") break;
      if (performance.now() + 10_000 > waitUntil)
        throw new Error(`Run ${own} did not classify in time; re-run all jobs if it deferred`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    if (action === "none") {
      console.log(`Run ${own} is not deferred (or ran its partitions); leaving it to finish`);
      return;
    }
    if (action === "cancel-and-rerun") {
      console.log(`Cancelling deferred run ${own} so its new attempt starts at once`);
      await sdk.request({
        method: "POST",
        url: `${root}/runs/${own}/cancel`,
        request: { portcove: { replay: "once", attempts: 0 } },
      });
      // Cancelled runs still start their always() gate jobs, so allow the remaining budget.
      for (;;) {
        const run = await get(`${root}/runs/${own}`);
        if (isRecord(run) && run.status === "completed") break;
        if (performance.now() + 10_000 > waitUntil)
          throw new Error(
            `Run ${own} did not finish cancelling; re-run all jobs to run the partitions`,
          );
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
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
