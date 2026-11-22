import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMaterializedGameLifecycle } from "./game-lifecycle-core-worker.mts";
import { materializeGameLifecycleLibraries } from "./game-lifecycle-materializer.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { isRecord } from "./runtime-values.mts";
import { executeGameLifecycle } from "./game-lifecycle-execution.mts";
import { sealGameLifecycle } from "./game-lifecycle-seal.mts";

function readWorkflowIdentity(environment: NodeJS.ProcessEnv) {
  const run_id = environment.GITHUB_RUN_ID;
  const run_attempt = Number(environment.GITHUB_RUN_ATTEMPT);
  const source_commit = environment.GITHUB_SHA;
  if (
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_REPOSITORY_ID !== "1354613114" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    environment.GITHUB_WORKFLOW_REF !==
      "boburning/portcove/.github/workflows/game-lifecycle-qualification.yml@refs/heads/main" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !run_id ||
    !/^[1-9][0-9]{0,15}$/u.test(run_id) ||
    !Number.isSafeInteger(run_attempt) ||
    run_attempt < 1 ||
    !source_commit ||
    !/^[a-f0-9]{40}$/u.test(source_commit)
  )
    throw new Error("The appointed original protected-main workflow is required");
  return { run_id, run_attempt, source_commit };
}

/**
 * This workflow currently has no independently provisioned eligible hosted
 * libraries. Archive import alone cannot restore the exact restricted grants
 * and replay floors. An empty queue is attributable and has no predicate.
 */
async function noWork(
  directory: string,
  identity: ReturnType<typeof readWorkflowIdentity>,
  holds: readonly unknown[],
) {
  await mkdir(directory, { mode: 0o700 });
  const outcome = await executeGameLifecycle(
    { ...identity, job_id: "0", platform: "windows-x86-64" },
    undefined,
  );
  await writeFile(
    path.join(directory, "terminal.json"),
    JSON.stringify({
      ...identity,
      ...outcome,
      reason: "no-independently-admitted-hosted-library-pair",
      holds,
      native_platform: "windows-x86-64",
      other_platforms: "native-producer-scope-unavailable",
    }),
    { flag: "wx", mode: 0o600 },
  );
}

/** One bounded normal hosted worker. The approved input adapter is responsible
 * for establishing both disposable libraries before this job may launch a game. */
export async function executeGameLifecycleWorkflow(
  directory: string,
  identity: ReturnType<typeof readWorkflowIdentity>,
  provisioned?: {
    fixtures: Parameters<typeof materializeGameLifecycleLibraries>[0];
    environment: NodeJS.ProcessEnv;
  },
) {
  const materialized = provisioned
    ? await materializeGameLifecycleLibraries(provisioned.fixtures)
    : { work: [], holds: [] };
  if (materialized.work.length === 0) {
    await noWork(directory, identity, materialized.holds);
    return { predicate_ready: false, native_job_id: null };
  }
  const work = materialized.work[0];
  if (!work || materialized.work.length !== 1 || !provisioned)
    throw new Error("Expected exactly one authorized disposable game lifecycle pair");
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Original native job metadata reader required");
  const provider = await createReleaseCustodyProvider({
    token,
    deadline: performance.now() + 30000,
  });
  const listing = await provider.jobs(identity.run_id, identity.run_attempt, 1);
  if (
    listing.next ||
    !isRecord(listing.body) ||
    !Array.isArray(listing.body.jobs) ||
    listing.body.total_count !== listing.body.jobs.length
  )
    throw new Error("Original native job inventory is incomplete");
  const jobs: unknown[] = listing.body.jobs;
  const matches = jobs.filter(
    (job: unknown) =>
      isRecord(job) &&
      job.name === "Exact game lifecycle (Windows x64)" &&
      job.head_sha === identity.source_commit &&
      job.run_attempt === identity.run_attempt &&
      String(job.run_id) === identity.run_id &&
      job.status === "in_progress" &&
      Array.isArray(job.labels) &&
      job.labels.length === 1 &&
      job.labels[0] === "windows-2022",
  );
  const original = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(original) ||
    !/^[1-9][0-9]{0,15}$/u.test(String(original.id))
  )
    throw new Error("Original standard native job identity is unavailable");
  const job_id = String(original.id);
  await mkdir(directory, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PORTCOVE_PREFERENCES",
  ]) {
    if (provisioned.environment[name] !== undefined)
      environment[name] = provisioned.environment[name];
  }
  await runMaterializedGameLifecycle(
    {
      ...identity,
      job_id,
      platform: "windows-x86-64",
    },
    work,
    directory,
    environment,
  );
  return { predicate_ready: true, native_job_id: job_id };
}

async function main(argv: string[]) {
  const [mode, directory] = argv;
  if (argv.length !== 2) throw new Error("Two exact workflow arguments are required");
  const identity = readWorkflowIdentity(process.env);
  const output = process.env.GITHUB_OUTPUT;
  if (!directory || !path.isAbsolute(directory) || !output)
    throw new Error("The reviewed workflow's owned absolute output is required");
  if (mode === "execute") {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new Error("Expected hosted Windows x64 native worker");
    // An approved hosted input adapter has not yet been provisioned. A
    // dispatch supplies no libraries, packages, originals or raw receipts.
    const result = await executeGameLifecycleWorkflow(directory, identity);
    await appendFile(output, `predicate_ready=${result.predicate_ready}\n`);
    if (result.native_job_id) await appendFile(output, `native_job_id=${result.native_job_id}\n`);
  } else if (mode === "seal") {
    const job_id = process.env.GAME_LIFECYCLE_NATIVE_JOB_ID;
    if (!job_id) throw new Error("Original native job output is missing");
    await sealGameLifecycle(directory, { ...identity, job_id });
  } else {
    throw new Error("Expected reviewed game lifecycle execute or seal stage");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
