/** Fixed Actions upload routing only. Locators carry no admission authority.
 * The authenticated consumer still requires provider artifacts and own job
 * identity. A stopped producer never causes unused observation rounds to wait. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { releasePathContains, assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";
import { controlHandshakeArtifactName, inspectControlRound } from "./release-control-handshake.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Runtime budget metadata only, never proof of role authority. */
export function controlBridgeOriginalDeadline(
  raw: unknown,
  rawPhase: unknown,
  now = Date.now(),
  monotonic = performance.now(),
) {
  const phase = inspectReleaseControlPhase(rawPhase),
    profile = releaseControlPhaseProfile(phase);
  const milliseconds =
    phase === "payload"
      ? 570000
      : phase === "admission"
        ? 415000
        : phase === "coordinator"
          ? 170000
          : phase === "release-publication"
            ? 350000
            : phase === "site-publication"
              ? 290000
              : 115000;
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.jobs) ||
    raw.jobs.length < 1 ||
    raw.jobs.length > 100 ||
    raw.total_count !== raw.jobs.length
  )
    throw new Error("complete fixed readiness job inventory required");
  const ids = new Set<number>();
  for (const job of raw.jobs as unknown[]) {
    if (
      !isRecord(job) ||
      typeof job.id !== "number" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id)
    )
      throw new Error("fixed readiness job inventory duplicated or malformed");
    ids.add(job.id);
  }
  const matches = raw.jobs.filter(
      (job: unknown) => isRecord(job) && job.name === profile.reader_name,
    ),
    job: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    String(job.run_id) !== process.env.GITHUB_RUN_ID ||
    job.run_attempt !== 1 ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    job.head_sha !== process.env.GITHUB_SHA ||
    job.status !== "in_progress" ||
    typeof job.started_at !== "string"
  )
    throw new Error("original fixed readiness producer job unavailable");
  const left = Date.parse(job.started_at) + milliseconds - now;
  if (!Number.isFinite(left) || left <= 0 || left > milliseconds || !Number.isFinite(monotonic))
    throw new Error("original fixed readiness job deadline exhausted or future dated");
  return monotonic + left;
}
export function inspectControlStepReadiness(
  raw: unknown,
  expected: {
    phase: unknown;
    index: number;
    run_id: string;
    revision: string;
    ref: string;
  },
) {
  const phase = inspectReleaseControlPhase(expected.phase);
  if (
    !Number.isSafeInteger(expected.index) ||
    expected.index < 0 ||
    expected.index > 14 ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    !/^[a-f0-9]{40}$/u.test(expected.revision) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      expected.ref,
    )
  )
    throw new Error("fixed readiness routing expectation unavailable");
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      (expected.index === 0
        ? "facts_sha256,phase,producer,schema_version"
        : "facts_sha256,phase,producer,round,schema_version") ||
    raw.schema_version !== 1 ||
    raw.phase !== phase ||
    !isRecord(raw.producer) ||
    Object.keys(raw.producer).sort().join(",") !==
      "check_run_id,controller_ref,controller_revision,job_id,run_attempt,run_id,workflow" ||
    raw.producer.workflow !== productionControllerWorkflow ||
    raw.producer.controller_revision !== expected.revision ||
    raw.producer.controller_ref !== expected.ref ||
    String(raw.producer.run_id) !== expected.run_id ||
    raw.producer.run_attempt !== 1 ||
    ![raw.producer.job_id, raw.producer.check_run_id].every(
      (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0,
    ) ||
    typeof raw.facts_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.facts_sha256)
  )
    throw new Error("readiness route differs from the fixed phase invocation");
  const round = expected.index === 0 ? undefined : inspectControlRound(raw.round);
  if (round && round.index !== expected.index) throw new Error("readiness round differs");
  return {
    phase,
    round,
    name: controlHandshakeArtifactName("ready", {
      phase,
      controller_revision: expected.revision,
      controller_ref: expected.ref,
      run_id: expected.run_id,
      run_attempt: 1,
      ...(round ? { round } : {}),
    }),
    authority: "none" as const,
  };
}

/** Called after the trusted parent has frozen the ready file. No directory
 * search, imported transcript or caller-defined upload path is used. */
export async function retainControlStepLocator(filename: string, phase: unknown, index: number) {
  const root = process.env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root) || !releasePathContains(root, filename))
    throw new Error("readiness locator is outside the fixed runner temporary root");
  await assertOwnedUnlinkedPath(root, filename, "control ready file");
  const bytes = await readControllerToolFile(filename, 16384);
  const inspected = inspectControlStepReadiness(JSON.parse(bytes.toString("utf8")), {
    phase,
    index,
    run_id: process.env.GITHUB_RUN_ID ?? "",
    revision: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF ?? "",
  });
  const target = path.join(root, `control-step-ready-${inspected.phase}-r${index}.json`);
  const file = await open(target, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ path: filename, sha256: hash(bytes) }));
    await file.sync();
  } finally {
    await file.close();
  }
  return target;
}

export async function controlReadyUploadRoute(
  root: string,
  phase: unknown,
  index: number,
  deadline: number,
) {
  const selected = inspectReleaseControlPhase(phase);
  if (
    !path.isAbsolute(root) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 14 ||
    !Number.isFinite(deadline) ||
    deadline > performance.now() + 600000
  )
    throw new Error("fixed readiness bridge fields unavailable");
  for (;;) {
    if (performance.now() >= deadline)
      throw new Error("readiness bridge deadline exhausted; retain original attempt");
    try {
      const ended: unknown = JSON.parse(
        (
          await readControllerToolFile(
            path.join(root, `release-control-${selected}-process-ended.json`),
            4096,
          )
        ).toString("utf8"),
      );
      if (
        !isRecord(ended) ||
        Object.keys(ended).sort().join(",") !== "exit_code" ||
        !Number.isInteger(ended.exit_code)
      )
        throw new Error("fixed producer settlement unavailable");
      return { ready: false as const, producer_exit_code: ended.exit_code };
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    let locator: unknown;
    try {
      locator = JSON.parse(
        (
          await readControllerToolFile(
            path.join(root, `control-step-ready-${selected}-r${index}.json`),
            4096,
          )
        ).toString("utf8"),
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
      continue;
    }
    if (
      !isRecord(locator) ||
      Object.keys(locator).sort().join(",") !== "path,sha256" ||
      typeof locator.path !== "string" ||
      /[\r\n]/u.test(locator.path) ||
      !releasePathContains(root, locator.path) ||
      path.basename(locator.path) !== `ready-${selected}.json`
    )
      throw new Error("fixed readiness locator changed or escaped");
    await assertOwnedUnlinkedPath(root, locator.path, "control ready route");
    const bytes = await readControllerToolFile(locator.path, 16384);
    if (hash(bytes) !== locator.sha256) throw new Error("frozen readiness bytes changed");
    const inspected = inspectControlStepReadiness(JSON.parse(bytes.toString("utf8")), {
      phase: selected,
      index,
      run_id: process.env.GITHUB_RUN_ID ?? "",
      revision: process.env.GITHUB_SHA ?? "",
      ref: process.env.GITHUB_REF ?? "",
    });
    if (performance.now() >= deadline)
      throw new Error("readiness routing arrived after its deadline");
    return { ready: true as const, path: locator.path, name: inspected.name };
  }
}
if (
  process.argv[1] &&
  /^release-control-step-bridge[.](?:mts|mjs)$/u.test(path.basename(process.argv[1])) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4 || !process.env.RUNNER_TEMP || !process.env.GITHUB_OUTPUT)
      throw new Error("fixed readiness bridge requires phase/ordinal and Actions output");
    if (
      !/^[1-9][0-9]{0,15}$/u.test(process.env.GITHUB_RUN_ID ?? "") ||
      !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")
    )
      throw new Error("fixed readiness current source/run required");
    const runnerRoot = process.env.RUNNER_TEMP;
    const api = new GitHubApiClient((args, body) =>
      createGitHubRunner({
        cwd: runnerRoot,
        timeoutMs: 15000,
        maxBuffer: 2 * 1024 ** 2,
      })([...args, "--hostname", "github.com"], body),
    );
    const response = api.request(
      "GET",
      `repos/boburning/portcove/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`,
    );
    if (response.status !== 200) throw new Error("original readiness job observation unavailable");
    const deadline = controlBridgeOriginalDeadline(response.body, process.argv[2]);
    const route = await controlReadyUploadRoute(
      process.env.RUNNER_TEMP,
      process.argv[2],
      Number(process.argv[3]),
      deadline,
    );
    await appendFile(
      process.env.GITHUB_OUTPUT,
      route.ready ? `ready=true\npath=${route.path}\nname=${route.name}\n` : "ready=false\n",
    );
  } catch {
    console.error("fixed readiness upload refused; retain original attempt");
    process.exitCode = 2;
  }
}
