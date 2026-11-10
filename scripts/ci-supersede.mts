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
}

function runRefs(value: unknown): RunRef[] {
  const runs = isRecord(value) ? value.workflow_runs : undefined;
  if (!Array.isArray(runs)) throw new Error("Workflow run listing is malformed");
  return runs.map((run: unknown) => {
    if (!isRecord(run) || typeof run.id !== "number" || !Number.isSafeInteger(run.id))
      throw new Error("Workflow run omitted its integer identity");
    const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    return {
      id: run.id,
      pullRequests: pulls.flatMap((pull: unknown) =>
        isRecord(pull) && typeof pull.number === "number" ? [pull.number] : [],
      ),
    };
  });
}

/** Run IDs only increase, so runs older than this head's own run are never newer work. */
export function ownRunId(listing: unknown, pullRequest: number): number | undefined {
  const ids = runRefs(listing)
    .filter((run) => run.pullRequests.includes(pullRequest))
    .map((run) => run.id);
  return ids.length ? Math.max(...ids) : undefined;
}

export function supersededRunIds(
  listings: readonly unknown[],
  own: number,
  pullRequest: number,
): number[] {
  const ids = new Set<number>();
  for (const listing of listings)
    for (const run of runRefs(listing))
      if (run.id < own && run.pullRequests.includes(pullRequest)) ids.add(run.id);
  return [...ids].sort((left, right) => left - right);
}

async function main() {
  const token = process.env.GH_TOKEN ?? "";
  const pullRequest = Number(process.env.PR_NUMBER);
  const headSha = process.env.HEAD_SHA ?? "";
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
    own = ownRunId(await list(`head_sha=${headSha}`), pullRequest);
  }
  if (own === undefined) {
    console.log(`No CI run for ${headSha} yet; nothing to supersede`);
    return;
  }
  const listings: unknown[] = [];
  for (const status of activeStatuses) listings.push(await list(`status=${status}`));
  for (const run of supersededRunIds(listings, own, pullRequest)) {
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
    console.error(sanitizeOperationError(error).message);
    process.exitCode = 1;
  });
