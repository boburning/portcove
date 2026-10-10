import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFailure, summarizeReport } from "./report-summary.mjs";

// Diagnostics only: never acquire resources, execute commands or supply acceptance.
export function createCiMetrics({
  environment = process.env,
  now = () => performance.now(),
  write = writeFileSync,
  warn = console.error,
} = {}) {
  const directory = environment.PORTCOVE_CI_METRICS_DIR;
  const started = now();
  let plan = null;
  try {
    plan = JSON.parse(environment.PORTCOVE_PLAN_JSON ?? "null");
  } catch {
    /* Unknown is reported explicitly. */
  }
  const context = {
    source: plan?.identities?.head ?? environment.PORTCOVE_HEAD_SHA ?? null,
    checkout: plan?.identities?.checkout ?? environment.GITHUB_SHA ?? null,
    run: environment.GITHUB_RUN_ID ?? null,
    attempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    job: environment.GITHUB_JOB ?? null,
    runner: `${environment.RUNNER_OS ?? process.platform}-${environment.RUNNER_ARCH ?? process.arch}`,
    mode: plan?.mode ?? null,
  };
  const record = (phase, data = {}) => {
    if (!directory) return;
    try {
      mkdirSync(directory, { recursive: true });
      write(
        path.join(directory, `${randomUUID()}.json`),
        JSON.stringify({
          format: 1,
          kind: "ci-timing",
          context,
          phase,
          recorded_at: new Date().toISOString(),
          process_elapsed_ms: Math.max(0, Math.round(now() - started)),
          ...data,
        }),
        { flag: "wx" },
      );
    } catch (error) {
      try {
        warn(`[ci-metrics] diagnostics unavailable (${error.code ?? "unknown"})`);
      } catch {
        /* Diagnostics cannot change command outcomes. */
      }
    }
  };
  const outcome = (value) =>
    value?.error ||
    value?.signal ||
    (value != null && Object.hasOwn(value, "status") && value.status !== 0)
      ? "failed"
      : "completed";
  const measure = (phase, operation) => {
    const start = now();
    try {
      const result = operation();
      record(phase, {
        elapsed_ms: Math.max(0, Math.round(now() - start)),
        outcome: outcome(result),
        ...(outcome(result) === "failed" ? { failure: describeFailure(result) } : {}),
      });
      return result;
    } catch (error) {
      record(phase, {
        elapsed_ms: Math.max(0, Math.round(now() - start)),
        outcome: "failed",
        failure: describeFailure({ error }),
      });
      throw error;
    }
  };
  const measureAsync = async (phase, operation) => {
    const start = now();
    try {
      const result = await operation();
      record(phase, {
        elapsed_ms: Math.max(0, Math.round(now() - start)),
        outcome: outcome(result),
        ...(outcome(result) === "failed" ? { failure: describeFailure(result) } : {}),
      });
      return result;
    } catch (error) {
      record(phase, {
        elapsed_ms: Math.max(0, Math.round(now() - start)),
        outcome: "failed",
        failure: describeFailure({ error }),
      });
      throw error;
    }
  };
  return { record, measure, measureAsync };
}

export function readCiMetrics(directory) {
  const records = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const record = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      if (
        record.format !== 1 ||
        record.kind !== "ci-timing" ||
        typeof record.phase !== "string" ||
        !record.context ||
        (record.elapsed_ms !== undefined &&
          (!Number.isSafeInteger(record.elapsed_ms) || record.elapsed_ms < 0))
      )
        throw new Error("Invalid CI timing report; no measurement claimed");
      return record;
    });
  return { records };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, ...rest] = process.argv.slice(2);
    if (command === "cache" && directory && rest.length <= 1) {
      createCiMetrics().record(`cache:${directory}`, {
        cache_outcome: rest[0] === "true" ? "hit" : rest[0] === "false" ? "miss" : "unknown",
      });
    } else {
      if (command !== "summarize" || !directory || rest.length)
        throw new Error(
          "usage: ci-metrics.mjs summarize DIRECTORY | cache NAME true|false|unknown",
        );
      console.log(summarizeReport("timings", readCiMetrics(directory), directory).text);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
