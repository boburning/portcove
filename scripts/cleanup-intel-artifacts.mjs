import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mjs";

const repository = "boburning/portcove";
const root = `repos/${repository}`;

export function consumedTransfer(artifact, run, jobs) {
  const match = /^intel-rust-tests-([1-9][0-9]*)$/u.exec(artifact?.name ?? "");
  if (!match || artifact.expired || !Number.isSafeInteger(artifact.id)) return false;
  if (run?.repository?.full_name !== repository || run.id !== artifact.workflow_run?.id)
    return false;
  if (run.status !== "completed" || run.run_attempt !== Number(match[1])) return false;
  if (!Array.isArray(jobs) || jobs.some((job) => job.run_id !== run.id)) return false;
  const producers = jobs.filter((job) => /(?:^| \/ )build-intel-tests$/u.test(job.name));
  if (producers.length !== 1) return false;
  const prefix = producers[0].name.slice(0, -"build-intel-tests".length);
  const names = [
    `${prefix}build-intel-tests`,
    `${prefix}native-rust (macos-x86_64, hash:1/2)`,
    `${prefix}native-rust (macos-x86_64, hash:2/2)`,
  ];
  return names.every((name) => {
    const matching = jobs.filter((job) => job.name === name);
    return (
      matching.length === 1 &&
      matching[0].status === "completed" &&
      matching[0].conclusion === "success"
    );
  });
}

export function cleanup(api, { apply = false, runId = null } = {}) {
  const artifacts = api.paginateRest(`${root}/actions/artifacts?per_page=100`, {
    select: (body) => body.artifacts,
    identity: (item) => String(item.id),
    totalCount: (body) => body.total_count,
    label: "Intel transfer artifact inventory",
  });
  const result = { repository, apply, deleted: [], eligible: [], preserved: 0 };
  for (const artifact of artifacts) {
    if (
      !/^intel-rust-tests-[1-9][0-9]*$/u.test(artifact.name) ||
      (runId !== null && artifact.workflow_run?.id !== runId)
    )
      continue;
    const id = artifact.workflow_run?.id;
    if (!Number.isSafeInteger(id)) throw new Error("artifact omitted its run identity");
    const readRun = () => api.request("GET", `${root}/actions/runs/${id}`).body;
    const run = readRun();
    const jobs = api.paginateRest(
      `${root}/actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      {
        select: (body) => body.jobs,
        identity: (job) => String(job.id),
        totalCount: (body) => body.total_count,
        label: "Intel consumer job inventory",
      },
    );
    if (!consumedTransfer(artifact, run, jobs)) {
      result.preserved += 1;
      continue;
    }
    result.eligible.push(artifact.id);
    if (!apply) continue;
    const current = api.request("GET", `${root}/actions/artifacts/${artifact.id}`).body;
    const currentRun = readRun();
    if (
      current.name !== artifact.name ||
      current.id !== artifact.id ||
      current.workflow_run?.id !== id ||
      !consumedTransfer(current, currentRun, jobs)
    )
      throw new Error("Intel transfer identity changed before deletion");
    // An uncertain DELETE is never retried. Readback establishes whether it applied.
    let deletionError = null;
    try {
      api.request("DELETE", `${root}/actions/artifacts/${artifact.id}`);
    } catch (error) {
      deletionError = error;
    }
    try {
      api.request("GET", `${root}/actions/artifacts/${artifact.id}`);
    } catch (error) {
      if (error.status === 404) {
        result.deleted.push(artifact.id);
        continue;
      }
      throw error;
    }
    throw deletionError ?? new Error("deleted transfer remained readable");
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--apply"))
      throw new Error("usage: cleanup-intel-artifacts.mjs [--apply]");
    if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository)
      throw new Error("cleanup is restricted to boburning/portcove");
    console.log(
      JSON.stringify(
        cleanup(new GitHubApiClient(createGitHubRunner()), { apply: args.includes("--apply") }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
