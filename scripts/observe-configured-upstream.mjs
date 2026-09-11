import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mjs";
import {
  ObservationFailure,
  observationHash,
  observeUpstream,
  validateObserverConfig,
} from "./upstream-observer.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const checkpointLimit = 32 * 1024 * 1024;

function validateCheckpoint(checkpoint, config) {
  if (!checkpoint) return;
  if (
    Object.keys(checkpoint).sort().join(",") !==
    ["format", "config_sha256", "completed_runs", "first_complete_at", "last_complete", "exception"]
      .sort()
      .join(",")
  )
    throw new ObservationFailure("invalid-checkpoint", "checkpoint fields are invalid");
  if (checkpoint.format !== 1 || checkpoint.config_sha256 !== observationHash(config))
    throw new ObservationFailure(
      "invalid-checkpoint",
      "checkpoint belongs to a different observer configuration",
    );
  const prior = checkpoint.last_complete;
  if (
    prior &&
    (!prior.observation?.facts ||
      prior.observation.facts_sha256 !== observationHash(prior.observation.facts) ||
      prior.projection?.facts_sha256 !== prior.observation.facts_sha256 ||
      prior.observation.config_sha256 !== checkpoint.config_sha256 ||
      prior.observation.port_id !== config.port_id ||
      prior.projection.port_id !== config.port_id ||
      prior.projection.repository_id !== config.repository_id ||
      !Number.isFinite(Date.parse(prior.observation.completed_at)))
  )
    throw new ObservationFailure(
      "invalid-checkpoint",
      "checkpoint observation and core projection do not match",
    );
  if (
    !Number.isSafeInteger(checkpoint.completed_runs) ||
    checkpoint.completed_runs < 0 ||
    checkpoint.completed_runs === Number.MAX_SAFE_INTEGER
  )
    throw new ObservationFailure("invalid-checkpoint", "checkpoint run count is invalid");
  const exception = checkpoint.exception;
  if (
    exception &&
    (typeof exception.rule !== "string" ||
      !/^[a-z-]{1,80}$/.test(exception.rule) ||
      !Number.isSafeInteger(exception.occurrences) ||
      exception.occurrences < 1 ||
      !Number.isFinite(Date.parse(exception.first_seen)) ||
      !Number.isFinite(Date.parse(exception.last_seen)) ||
      (exception.retry_at !== null && !Number.isFinite(Date.parse(exception.retry_at))) ||
      exception.key !==
        observationHash({
          port_id: config.port_id,
          repository_id: config.repository_id,
          operation: "observe",
          rule: exception.rule,
        }))
  )
    throw new ObservationFailure(
      "invalid-checkpoint",
      "checkpoint exception identity or clocks are invalid",
    );
}

function exceptionFor(error, prior, config, clock) {
  const rule = error instanceof ObservationFailure ? error.rule : "core-or-observer-failure";
  const key = observationHash({
    port_id: config.port_id,
    repository_id: config.repository_id,
    operation: "observe",
    rule,
  });
  const repeated = prior?.key === key;
  return {
    key,
    rule,
    port_id: config.port_id,
    repository_id: config.repository_id,
    operation: "observe",
    first_seen: repeated ? prior.first_seen : clock,
    last_seen: clock,
    occurrences: repeated ? Math.min(prior.occurrences + 1, Number.MAX_SAFE_INTEGER) : 1,
    details:
      error instanceof ObservationFailure
        ? error.message
        : "Observation or core policy inspection failed; inspect this run's retained evidence.",
    retry_at: error instanceof ObservationFailure ? error.retryAt : null,
    resume_condition:
      rule === "rate-limit"
        ? "Provider retry clock has elapsed; the next scheduled bounded observation must complete."
        : "A complete bounded observation and matching core policy inspection must succeed.",
  };
}

/** Immutable input, replacement checkpoint: callers commit only this complete result. */
export async function advanceObservation(config, checkpoint, options) {
  validateObserverConfig(config);
  validateCheckpoint(checkpoint, config);
  const now = options.now ?? Date.now;
  const next = structuredClone(
    checkpoint ?? {
      format: 1,
      config_sha256: observationHash(config),
      completed_runs: 0,
      first_complete_at: null,
      last_complete: null,
      exception: null,
    },
  );
  let transition = "deferred";
  let changedException = false;
  let failedPolicyInput = null;
  const retryClock = next.exception?.retry_at ? Date.parse(next.exception.retry_at) : 0;
  if (!retryClock || now() >= retryClock) {
    try {
      const result = await observeUpstream(config, {
        ...options,
        cache: next.last_complete?.cache,
      });
      failedPolicyInput = result.observation;
      const projection = await options.project(result.observation);
      if (
        projection.format !== 1 ||
        projection.port_id !== config.port_id ||
        projection.repository_id !== config.repository_id ||
        projection.facts_sha256 !== result.observation.facts_sha256 ||
        !Array.isArray(projection.projections)
      )
        throw new ObservationFailure(
          "core-binding",
          "core policy output is not bound to the exact observed facts",
        );
      transition = !next.last_complete
        ? "initial-baseline"
        : next.last_complete.observation.facts_sha256 === result.observation.facts_sha256
          ? "unchanged"
          : "changed";
      next.last_complete = { ...result, projection };
      next.first_complete_at ??= result.observation.completed_at;
      next.completed_runs++;
      next.exception = null;
      failedPolicyInput = null;
    } catch (error) {
      const exception = exceptionFor(error, next.exception, config, new Date(now()).toISOString());
      changedException = exception.key !== next.exception?.key;
      next.exception = exception;
      transition = "failed";
    }
  }
  const previousComplete = next.last_complete?.observation.completed_at ?? null;
  const age = previousComplete ? now() - Date.parse(previousComplete) : null;
  const stale = age === null || age < 0 || age > config.stale_after_hours * 3_600_000;
  const unmonitored = (options.catalogIds ?? []).filter((id) => id !== config.port_id);
  const report = {
    format: 1,
    config_sha256: next.config_sha256,
    generated_at: new Date(now()).toISOString(),
    execution: options.execution ?? {
      kind: "local",
      source_commit: null,
      run_id: null,
      run_attempt: null,
    },
    transition,
    stale,
    last_complete_at: previousComplete,
    next_observation_due_at: new Date(
      (previousComplete ? Date.parse(previousComplete) : now()) + config.cadence_hours * 3_600_000,
    ).toISOString(),
    configured_scope: {
      port_id: config.port_id,
      repository: config.repository,
      repository_id: config.repository_id,
      cadence_hours: config.cadence_hours,
      stale_after_hours: config.stale_after_hours,
    },
    unmonitored_port_ids: unmonitored,
    observation: next.last_complete?.observation ?? null,
    policy: next.last_complete?.projection ?? null,
    exception: next.exception,
    failed_policy_input: failedPolicyInput,
    exception_age_ms: next.exception
      ? Math.max(0, now() - Date.parse(next.exception.first_seen))
      : null,
    fallback:
      next.exception && previousComplete
        ? {
            observed_at: previousComplete,
            facts_sha256: next.last_complete.observation.facts_sha256,
            scope: "last-complete-unverified-observation; current upstream state is unknown",
          }
        : null,
    clocks: {
      timezone: "UTC",
      first_complete_observation_at: next.first_complete_at,
      latest_complete_observation_at: previousComplete,
      protected_acceptance_at: null,
      definition_publication_at: null,
      compatible_client_availability_at: null,
    },
    availability_objective: {
      hours: 24,
      monitored_repositories: 1,
      unmonitored_ports: unmonitored.length,
      measured_end_to_end_samples: 0,
      baseline: "unknown",
      exclusions: [
        "initial historical inventory",
        "unmonitored upstreams",
        "protected acceptance and publication not yet integrated",
        "client availability unmeasured",
      ],
    },
    completed_runs: next.completed_runs,
  };
  return { checkpoint: next, report, notify_exception: changedException };
}

async function boundedJson(filename, maximum, optional = false) {
  let handle;
  try {
    handle = await open(filename, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum)
      throw new Error("JSON input must be a bounded regular file");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error("JSON input grew beyond its bound");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicJson(filename, value) {
  await assertOwnedUnlinkedPath(repositoryRoot, filename, "observer output");
  const temporary = `${filename}.${randomUUID()}.next`;
  const contents = JSON.stringify(value);
  if (Buffer.byteLength(contents) > checkpointLimit)
    throw new Error("observer checkpoint exceeds its byte budget");
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Never steal an interrupted coordinator's lock; preserve its checkpoint for recovery. */
export async function withCheckpointLock(statePath, operation) {
  const lockPath = await assertOwnedUnlinkedPath(
    path.join(repositoryRoot, "work"),
    `${statePath}.lock`,
    "observer coordinator lock",
  );
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
    );
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath);
  }
}

async function main(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--config", "--state", "--report", "--cli"].includes(args[index]) ||
      !args[index + 1] ||
      parsed.has(args[index])
    )
      throw new Error(
        "usage: observe-configured-upstream.mjs --cli EXECUTABLE [--config FILE] [--state FILE] [--report FILE]",
      );
    parsed.set(args[index], args[index + 1]);
  }
  if (!parsed.has("--cli")) throw new Error("the reviewed standalone core-backed CLI is required");
  const configPath = await assertOwnedUnlinkedPath(
    repositoryRoot,
    path.resolve(
      parsed.get("--config") ?? path.join(repositoryRoot, "release/upstream-observer.json"),
    ),
    "observer configuration",
  );
  const config = validateObserverConfig(await boundedJson(configPath, 16_384));
  const directory = path.join(repositoryRoot, "work/upstream-observer", observationHash(config));
  const workRoot = path.join(repositoryRoot, "work");
  await mkdir(workRoot, { recursive: true });
  const statePath = await assertOwnedUnlinkedPath(
    workRoot,
    path.resolve(parsed.get("--state") ?? path.join(directory, "checkpoint.json")),
    "observer checkpoint",
  );
  const reportPath = await assertOwnedUnlinkedPath(
    workRoot,
    path.resolve(parsed.get("--report") ?? path.join(directory, "report.json")),
    "observer report",
  );
  const destinations = [statePath, `${statePath}.lock`, reportPath, configPath].map((value) =>
    process.platform === "win32" ? value.toLowerCase() : value,
  );
  if (new Set(destinations).size !== destinations.length)
    throw new Error("observer configuration, checkpoint, lock and report must have distinct paths");
  await withCheckpointLock(statePath, async () => {
    const checkpoint = await boundedJson(statePath, checkpointLimit, true);
    const priorReport = await boundedJson(reportPath, checkpointLimit, true);
    if (
      priorReport &&
      (priorReport.format !== 1 || priorReport.config_sha256 !== observationHash(config))
    )
      throw new Error("existing report belongs to another operation or configuration");
    const catalog = await boundedJson(
      path.join(repositoryRoot, "crates/portcove-core/catalog/catalog.json"),
      4 * 1024 * 1024,
    );
    const port = catalog.ports.find((port) => port.id === config.port_id);
    if (
      !port ||
      (port.release.provider ?? "github") !== "github" ||
      port.release.repository !== config.repository
    )
      throw new Error("configured upstream differs from the existing catalog owner");
    const cli = path.resolve(parsed.get("--cli"));
    const project = async (observation) => {
      const input = path.join(path.dirname(statePath), `observation-${randomUUID()}.json`);
      await mkdir(path.dirname(input), { recursive: true });
      try {
        await writeFile(input, JSON.stringify(observation), { flag: "wx" });
        const output = execFileSync(
          cli,
          [
            "--json",
            "catalog",
            "inspect-observation",
            config.port_id,
            input,
            "--repository-id",
            String(config.repository_id),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const envelope = JSON.parse(output);
        if (envelope.command !== "catalog.inspect-observation" || envelope.ok !== true)
          throw new ObservationFailure(
            "core-policy",
            "core did not return a successful observation inspection",
          );
        return envelope.data;
      } finally {
        await rm(input, { force: true });
      }
    };
    const execution = {
      kind: ["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)
        ? process.env.GITHUB_EVENT_NAME
        : "local",
      source_commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
        ? process.env.GITHUB_SHA
        : null,
      run_id: /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : null,
      run_attempt: /^\d{1,8}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
        ? process.env.GITHUB_RUN_ATTEMPT
        : null,
    };
    const result = await advanceObservation(config, checkpoint, {
      token: process.env.GITHUB_TOKEN,
      project,
      execution,
      catalogIds: catalog.ports.map((port) => port.id),
    });
    await atomicJson(statePath, result.checkpoint);
    await atomicJson(reportPath, result.report);
    console.log(
      JSON.stringify({
        transition: result.report.transition,
        stale: result.report.stale,
        facts_sha256: result.report.observation?.facts_sha256 ?? null,
        exception: result.report.exception?.rule ?? null,
        report: path.relative(repositoryRoot, reportPath),
      }),
    );
    if (result.notify_exception) process.exitCode = 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
