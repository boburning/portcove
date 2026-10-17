import { readValidationPlanInput } from "./validation-plan.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFailure, summarizeReport } from "./report-summary.mts";

interface MetricsOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  write?: (file: string, data: string, options: { flag: "wx" }) => void;
  warn?: (message: string) => void;
}
interface TimingData {
  elapsed_ms?: number;
  outcome?: "failed" | "completed";
  failure?: ReturnType<typeof describeFailure>;
  cache_outcome?: string;
  fingerprint?: string;
  selected_tests?: number;
  complete_tests?: number;
  groups?: string[];
}
interface TimingContext {
  source: string | null;
  checkout: string | null;
  run: string | null;
  attempt: string | null;
  job: string | null;
  runner: string;
  mode: string | null;
}
export interface CiTimingRecord extends TimingData {
  format: 1;
  kind: "ci-timing";
  context: TimingContext;
  phase: string;
  recorded_at: string;
  process_elapsed_ms: number;
}

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function isTimingContext(value: unknown): value is TimingContext {
  return (
    isRecord(value) &&
    typeof value.runner === "string" &&
    ["source", "checkout", "run", "attempt", "job", "mode"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    )
  );
}
function isTimingRecord(value: unknown): value is CiTimingRecord {
  return (
    isRecord(value) &&
    value.format === 1 &&
    value.kind === "ci-timing" &&
    typeof value.phase === "string" &&
    isTimingContext(value.context) &&
    typeof value.recorded_at === "string" &&
    nonnegativeInteger(value.process_elapsed_ms) &&
    ["elapsed_ms", "selected_tests", "complete_tests"].every(
      (key) => value[key] === undefined || nonnegativeInteger(value[key]),
    ) &&
    (value.outcome === undefined || value.outcome === "failed" || value.outcome === "completed") &&
    ["cache_outcome", "fingerprint"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.groups === undefined ||
      (Array.isArray(value.groups) &&
        value.groups.every((group: unknown) => typeof group === "string"))) &&
    (value.failure === undefined ||
      (isRecord(value.failure) &&
        typeof value.failure.kind === "string" &&
        typeof value.failure.label === "string" &&
        typeof value.failure.observation === "string"))
  );
}

// Diagnostics only: never acquire resources, execute commands or supply acceptance.
export function createCiMetrics({
  environment = process.env,
  now = () => performance.now(),
  write = writeFileSync,
  warn = console.error,
}: MetricsOptions = {}) {
  const directory = environment.PORTCOVE_CI_METRICS_DIR;
  const started = now();
  let plan: unknown = null;
  try {
    plan = readValidationPlanInput(environment);
  } catch {
    /* Unknown is reported explicitly. */
  }
  const identities = isRecord(plan) && isRecord(plan.identities) ? plan.identities : null;
  const context: TimingContext = {
    source: optionalString(identities?.head) ?? environment.PORTCOVE_HEAD_SHA ?? null,
    checkout: optionalString(identities?.checkout) ?? environment.GITHUB_SHA ?? null,
    run: environment.GITHUB_RUN_ID ?? null,
    attempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    job: environment.GITHUB_JOB ?? null,
    runner: `${environment.RUNNER_OS ?? process.platform}-${environment.RUNNER_ARCH ?? process.arch}`,
    mode: optionalString(isRecord(plan) ? plan.mode : null),
  };
  const record = (phase: string, data: TimingData = {}) => {
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
        warn(`[ci-metrics] diagnostics unavailable (${errorCode(error) ?? "unknown"})`);
      } catch {
        /* Diagnostics cannot change command outcomes. */
      }
    }
  };
  const outcome = (value: unknown) =>
    isRecord(value) &&
    (value.error || value.signal || (Object.hasOwn(value, "status") && value.status !== 0))
      ? "failed"
      : "completed";
  const measure = <T,>(phase: string, operation: () => T): T => {
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
  const measureAsync = async <T,>(phase: string, operation: () => Promise<T>): Promise<T> => {
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

export function readCiMetrics(directory: string) {
  const records = readdirSync(directory)
    .filter((file: string) => file.endsWith(".json"))
    .map((file: string) => {
      const record: unknown = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      if (!isTimingRecord(record))
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
          "usage: ci-metrics.mts summarize DIRECTORY | cache NAME true|false|unknown",
        );
      console.log(summarizeReport("timings", readCiMetrics(directory), directory).text);
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
