import { errorMessage, isRecord } from "./runtime-values.mts";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";

const repository = "boburning/portcove";
const root = `repos/${repository}`;
// The hourly recovery sweep is intentionally limited to typical rerun attempts.
// All attempts, including higher ones, are supported by the exact-run event/manual path.
const recoveryAttempts = [1, 2, 3, 4] as const;

interface CleanupApi {
  paginateRest(
    endpoint: string,
    options: Parameters<GitHubApiClient["paginateRest"]>[1],
  ): unknown[];
  request(method: string, endpoint: string): { body: unknown };
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Intel transfer provider returned a malformed object");
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${label} omitted its integer identity`);
  return value;
}
export function consumedTransfer(artifact: unknown, run: unknown, jobs: unknown) {
  if (!isRecord(artifact) || !isRecord(run)) return false;
  const match =
    typeof artifact.name === "string"
      ? /^intel-rust-tests-([1-9][0-9]*)$/u.exec(artifact.name)
      : null;
  if (!match || artifact.expired !== false || !Number.isSafeInteger(artifact.id)) return false;
  if (
    !isRecord(run.repository) ||
    run.repository.full_name !== repository ||
    !isRecord(artifact.workflow_run) ||
    run.id !== artifact.workflow_run.id
  )
    return false;
  if (run.status !== "completed" || run.run_attempt !== Number(match[1])) return false;
  if (!Array.isArray(jobs)) return false;
  const entries: unknown[] = jobs;
  const valid = entries.filter(isRecord);
  if (valid.length !== entries.length || valid.some((job) => job.run_id !== run.id)) return false;
  const producers = valid.filter(
    (job) => typeof job.name === "string" && /(?:^| \/ )build-intel-tests$/u.test(job.name),
  );
  const producer = producers[0];
  if (producers.length !== 1 || !producer || typeof producer.name !== "string") return false;
  const prefix = producer.name.slice(0, -"build-intel-tests".length);
  const names = [
    `${prefix}build-intel-tests`,
    `${prefix}native-rust (macos-x86_64, hash:1/2)`,
    `${prefix}native-rust (macos-x86_64, hash:2/2)`,
  ];
  return names.every((name) => {
    const matching = valid.filter((job) => job.name === name);
    const job = matching[0];
    return matching.length === 1 && job?.status === "completed" && job.conclusion === "success";
  });
}

export function cleanup(
  api: CleanupApi,
  { apply = false, runId = null }: { apply?: boolean; runId?: number | null } = {},
) {
  if (runId !== null && (!Number.isSafeInteger(runId) || runId <= 0))
    throw new Error("Intel cleanup requires a positive safe workflow run ID");
  // GitHub retains Intel transfers for one day. Avoid the large and changing
  // repository-wide artifact collection: completion events inspect only their
  // own run; hourly/manual catch-up reads exact artifact names with full pagination.
  const endpoints =
    runId === null
      ? recoveryAttempts.map(
          (attempt) => `${root}/actions/artifacts?name=intel-rust-tests-${attempt}&per_page=100`,
        )
      : [`${root}/actions/runs/${runId}/artifacts?per_page=100`];
  const artifacts = endpoints.flatMap((endpoint) =>
    api.paginateRest(endpoint, {
      select: (body) => object(body).artifacts,
      identity: (item) => String(integer(object(item).id, "artifact")),
      totalCount: (body) => integer(object(body).total_count, "collection"),
      label: "Intel transfer artifact inventory",
    }),
  );
  // Complete every collection and reject overlap before considering a DELETE.
  const seen = new Set<number>();
  for (const candidate of artifacts) {
    const id = integer(object(candidate).id, "artifact");
    if (seen.has(id)) throw new Error("Intel transfer inventory contains a duplicate artifact");
    seen.add(id);
  }
  const result: {
    repository: string;
    apply: boolean;
    deleted: number[];
    eligible: number[];
    preserved: number;
  } = { repository, apply, deleted: [], eligible: [], preserved: 0 };
  for (const raw of artifacts) {
    const artifact = object(raw);
    if (
      runId !== null &&
      (isRecord(artifact.workflow_run) ? artifact.workflow_run.id : undefined) !== runId
    )
      throw new Error("Intel transfer artifact does not belong to the selected run");
    if (
      typeof artifact.name !== "string" ||
      !/^intel-rust-tests-[1-9][0-9]*$/u.test(artifact.name) ||
      (runId !== null &&
        (isRecord(artifact.workflow_run) ? artifact.workflow_run.id : undefined) !== runId)
    )
      continue;
    const id = integer(
      isRecord(artifact.workflow_run) ? artifact.workflow_run.id : undefined,
      "artifact run",
    );
    const artifactId = integer(artifact.id, "artifact");
    const readRun = () => object(api.request("GET", `${root}/actions/runs/${id}`).body);
    const run = readRun();
    const attempt = integer(run.run_attempt, "run attempt");
    const jobs = api.paginateRest(
      `${root}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
      {
        select: (body) => object(body).jobs,
        identity: (job) => String(integer(object(job).id, "job")),
        totalCount: (body) => integer(object(body).total_count, "collection"),
        label: "Intel consumer job inventory",
      },
    );
    if (!consumedTransfer(artifact, run, jobs)) {
      result.preserved += 1;
      continue;
    }
    result.eligible.push(artifactId);
    if (!apply) continue;
    const current = object(api.request("GET", `${root}/actions/artifacts/${artifactId}`).body);
    const currentRun = readRun();
    if (
      current.name !== artifact.name ||
      current.id !== artifact.id ||
      (isRecord(current.workflow_run) ? current.workflow_run.id : undefined) !== id ||
      !consumedTransfer(current, currentRun, jobs)
    )
      throw new Error("Intel transfer identity changed before deletion");
    // An uncertain DELETE is never retried. Readback establishes whether it applied.
    let deletionFailure: { error: unknown } | undefined;
    try {
      api.request("DELETE", `${root}/actions/artifacts/${artifactId}`);
    } catch (error) {
      deletionFailure = { error };
    }
    try {
      api.request("GET", `${root}/actions/artifacts/${artifactId}`);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        result.deleted.push(artifactId);
        continue;
      }
      throw error;
    }
    if (deletionFailure) {
      // Preserve the provider's exact rejection, including null/undefined, after readable readback.
      throw deletionFailure.error;
    }
    throw new Error("deleted transfer remained readable");
  }
  return result;
}

export function parseCleanupArgs(args: readonly string[]) {
  let apply = false;
  let runId: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply" && !apply) {
      apply = true;
    } else if (arg === "--run-id" && runId === null) {
      const raw = args[++index];
      if (!raw || !/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new Error("run ID must be a positive safe integer");
      runId = Number(raw);
    } else {
      throw new Error("usage: cleanup-intel-artifacts.mts [--apply] [--run-id ID]");
    }
  }
  return { apply, runId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCleanupArgs(process.argv.slice(2));
    if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository)
      throw new Error("cleanup is restricted to boburning/portcove");
    console.log(
      JSON.stringify(cleanup(new GitHubApiClient(createGitHubRunner()), options), null, 2),
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
