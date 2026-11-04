import { isRecord } from "./runtime-values.mts";
import { fileURLToPath } from "node:url";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
import type { GitHubClientOptions } from "./github-client.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";

const repository = "boburning/portcove";
const root = `repos/${repository}`;
// The hourly recovery sweep is intentionally limited to typical rerun attempts.
// All attempts, including higher ones, are supported by the exact-run event/manual path.
const recoveryAttempts = [1, 2, 3, 4] as const;

export interface CleanupOperations {
  artifacts(scope: { runId: number } | { attempt: number }): Promise<unknown[]>;
  jobs(runId: number, attempt: number): Promise<unknown[]>;
  run(id: number): Promise<unknown>;
  artifact(id: number): Promise<unknown>;
  removeArtifact(id: number): Promise<void>;
}

/** Transport stays private to this command; domain fakes implement operations. */
export async function createCleanupOperations(options: {
  token: string;
  fetch?: typeof globalThis.fetch;
  deadline?: number;
}): Promise<CleanupOperations> {
  let requests = 0,
    bytes = 0;
  const reserve: NonNullable<GitHubClientOptions["reserve"]> = () => {
    if (++requests > 512)
      throw new GitHubApiError("budget_exhausted", "Intel cleanup request budget exhausted");
    return {
      consumeBytes(count) {
        bytes += count;
        if (bytes > 64 * 1024 * 1024)
          throw new GitHubApiError("budget_exhausted", "Intel cleanup byte budget exhausted");
      },
      settle() {},
    };
  };
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token: options.token },
    deadline: options.deadline ?? performance.now() + 10 * 60_000,
    maxBytes: 16 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    allowRequest: (method, url) =>
      ["GET", "DELETE"].includes(method) && url.pathname.startsWith(`/${root}/actions/`),
    reserve,
  });
  const list = async (endpoint: string, key: "artifacts" | "jobs") => {
    const expected = new URL(endpoint, "https://api.github.com/");
    const values: unknown[] = [],
      ids = new Set<number>();
    let total: number | undefined;
    for await (const response of iterateGitHubPages(sdk, {
      url: expected.href,
      reserve(request) {
        const actual = request.url;
        const keys = [...actual.searchParams.keys()];
        if (
          actual.origin !== expected.origin ||
          actual.pathname !== expected.pathname ||
          new Set(keys).size !== keys.length ||
          keys.some(
            (name) =>
              name !== "page" && actual.searchParams.get(name) !== expected.searchParams.get(name),
          ) ||
          [...expected.searchParams].some(
            ([name, value]) => actual.searchParams.get(name) !== value,
          ) ||
          (actual.searchParams.has("page") &&
            !/^[1-9][0-9]*$/u.test(actual.searchParams.get("page") ?? ""))
        )
          throw new GitHubApiError(
            "request_refused",
            "Intel cleanup pagination escaped its collection",
          );
        return reserve(request);
      },
    })) {
      const body = object(response.data);
      const count = integer(body.total_count, "collection");
      if (count < 0 || (total !== undefined && total !== count) || !Array.isArray(body[key]))
        throw new Error("Intel transfer collection is incomplete or changed");
      total = count;
      for (const item of body[key]) {
        const id = integer(object(item).id, key);
        if (id <= 0 || ids.has(id))
          throw new Error("Intel transfer collection contains a duplicate or invalid ID");
        ids.add(id);
        values.push(item);
      }
      if (values.length > total) throw new Error("Intel transfer count exceeds reported total");
    }
    if (values.length !== total)
      throw new Error("Intel transfer count does not match reported total");
    return values;
  };
  const get = async (endpoint: string) =>
    (
      await sdk.request({
        method: "GET",
        url: endpoint,
        request: { portcove: { replay: "safe-read", attempts: 0 } },
      })
    ).data as unknown;
  return {
    artifacts: (scope) =>
      list(
        "runId" in scope
          ? `${root}/actions/runs/${scope.runId}/artifacts?per_page=100`
          : `${root}/actions/artifacts?name=intel-rust-tests-${scope.attempt}&per_page=100`,
        "artifacts",
      ),
    jobs: (id, attempt) =>
      list(`${root}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, "jobs"),
    run: (id) => get(`${root}/actions/runs/${id}`),
    artifact: (id) => get(`${root}/actions/artifacts/${id}`),
    async removeArtifact(id) {
      await sdk.request({
        method: "DELETE",
        url: `${root}/actions/artifacts/${id}`,
        request: { portcove: { replay: "once", attempts: 0 } },
      });
    },
  };
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

export async function cleanup(
  api: CleanupOperations,
  { apply = false, runId = null }: { apply?: boolean; runId?: number | null } = {},
) {
  if (runId !== null && (!Number.isSafeInteger(runId) || runId <= 0))
    throw new Error("Intel cleanup requires a positive safe workflow run ID");
  // GitHub retains Intel transfers for one day. Avoid the large and changing
  // repository-wide artifact collection: completion events inspect only their
  // own run; hourly/manual catch-up reads exact artifact names with full pagination.
  const artifacts: unknown[] = [];
  if (runId === null) {
    for (const attempt of recoveryAttempts) artifacts.push(...(await api.artifacts({ attempt })));
  } else artifacts.push(...(await api.artifacts({ runId })));
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
    const readRun = async () => object(await api.run(id));
    const run = await readRun();
    const attempt = integer(run.run_attempt, "run attempt");
    const jobs = await api.jobs(id, attempt);
    if (!consumedTransfer(artifact, run, jobs)) {
      result.preserved += 1;
      continue;
    }
    result.eligible.push(artifactId);
    if (!apply) continue;
    const current = object(await api.artifact(artifactId));
    const currentRun = await readRun();
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
      await api.removeArtifact(artifactId);
    } catch (error) {
      deletionFailure = { error };
    }
    try {
      await api.artifact(artifactId);
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
      JSON.stringify(
        await cleanup(
          await createCleanupOperations({
            token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
          }),
          options,
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      sanitizeOperationError(error, {
        secrets: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter((value): value is string =>
          Boolean(value),
        ),
      }).message,
    );
    process.exitCode = 1;
  }
}
