/** Original fixed Pages job budget only; provider job metadata is not admission. */
import { performance } from "node:perf_hooks";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
export function siteOriginalJobDeadline(
  raw: unknown,
  identity: { run_id: string; controller_revision: string },
  now = Date.now(),
  monotonic = performance.now(),
) {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.jobs) ||
    raw.total_count !== raw.jobs.length ||
    raw.jobs.length < 1 ||
    raw.jobs.length > 100
  )
    throw new Error("complete site job inventory required");
  const ids = new Set<number>();
  for (const job of raw.jobs as unknown[]) {
    if (
      !isRecord(job) ||
      typeof job.id !== "number" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id)
    )
      throw new Error("site job inventory identity unavailable or duplicated");
    ids.add(job.id);
  }
  const matches = raw.jobs.filter(
    (job: unknown) => isRecord(job) && job.name === "Publish authenticated application site",
  );
  const job: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    String(job.run_id) !== identity.run_id ||
    job.run_attempt !== 1 ||
    job.head_sha !== identity.controller_revision ||
    job.status !== "in_progress" ||
    typeof job.started_at !== "string"
  )
    throw new Error("actual fixed site job start unavailable");
  const left = Date.parse(job.started_at) + 290000 - now;
  if (!Number.isFinite(left) || left <= 0 || left > 290000 || !Number.isFinite(monotonic))
    throw new Error("original site job budget exhausted or future dated");
  return monotonic + left;
}
export function currentSiteJobDeadline(
  identity: {
    run_id: string;
    run_attempt: number;
    controller_revision: string;
    controller_ref: string;
  },
  parent: string,
  processDeadline: number,
) {
  if (
    !/^[1-9][0-9]{0,15}$/u.test(identity.run_id) ||
    !/^[a-f0-9]{40}$/u.test(identity.controller_revision) ||
    identity.run_attempt !== 1 ||
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("site invocation is not its original fixed job");
  const remaining = () => {
    const left = Math.floor(processDeadline - performance.now());
    if (!Number.isFinite(left) || left < 1) throw new Error("original site job budget exhausted");
    return Math.min(left, 15000);
  };
  const api = new GitHubApiClient((args, body) =>
    createGitHubRunner({ cwd: parent, timeoutMs: remaining(), maxBuffer: 2 * 1024 ** 2 })(
      [...args, "--hostname", "github.com"],
      body,
    ),
  );
  const response = api.request(
    "GET",
    `repos/boburning/portcove/actions/runs/${identity.run_id}/attempts/1/jobs?per_page=100`,
  );
  remaining();
  if (response.status !== 200) throw new Error("original site job observation unavailable");
  return Math.min(processDeadline, siteOriginalJobDeadline(response.body, identity));
}
