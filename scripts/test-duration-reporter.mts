import type { TestEvent } from "node:test/reporters";
import { isRecord } from "./runtime-values.mts";
import { spec } from "node:test/reporters";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createNodeCaseObservations } from "./node-case-observations.mts";

export const slowTestThresholdMs = 5_000;
const maxFileObservations = 512;
const maxFileObservationBytes = 16_384;
const countNames = [
  "tests",
  "failed",
  "passed",
  "cancelled",
  "skipped",
  "todo",
  "topLevel",
  "suites",
] as const;
type FileCounts = Record<(typeof countNames)[number], number>;
interface NodeFileObservation {
  file: string;
  entry_file: string | null;
  duration_ms: number;
  success: boolean;
  counts: FileCounts;
}
function filePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
}
function fileCounts(value: unknown): value is FileCounts {
  return (
    isRecord(value) &&
    countNames.every(
      (key) =>
        typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  );
}
/** File/entry-file summaries are observations; aggregate summaries are not file execution. */
export function nodeFileObservation(event: unknown): NodeFileObservation | undefined {
  if (!isRecord(event) || event.type !== "test:summary" || !isRecord(event.data)) return;
  const value = event.data;
  if (
    !filePath(value.file) ||
    (value.entryFile !== undefined && !filePath(value.entryFile)) ||
    typeof value.duration_ms !== "number" ||
    !Number.isFinite(value.duration_ms) ||
    value.duration_ms < 0 ||
    typeof value.success !== "boolean" ||
    !fileCounts(value.counts)
  )
    return;
  return {
    file: value.file,
    entry_file: value.entryFile ?? null,
    duration_ms: value.duration_ms,
    success: value.success,
    counts: {
      tests: value.counts.tests,
      failed: value.counts.failed,
      passed: value.counts.passed,
      cancelled: value.counts.cancelled,
      skipped: value.counts.skipped,
      todo: value.counts.todo,
      topLevel: value.counts.topLevel,
      suites: value.counts.suites,
    },
  };
}

interface SlowTestObservation {
  type: "test:pass" | "test:fail";
  data: { name: string; details: { type: "test"; duration_ms: number } };
}
export function isSlowTest(event: unknown): event is SlowTestObservation {
  if (
    !isRecord(event) ||
    (event.type !== "test:pass" && event.type !== "test:fail") ||
    !isRecord(event.data) ||
    !isRecord(event.data.details)
  )
    return false;
  return (
    typeof event.data.name === "string" &&
    event.data.details.type === "test" &&
    !event.data.skip &&
    !event.data.todo &&
    typeof event.data.details.duration_ms === "number" &&
    event.data.details.duration_ms > slowTestThresholdMs
  );
}

// Report measured latency independently of the hang timeout. In particular,
// synchronous work can block the event loop beyond an asynchronous deadline.
export default async function* report(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string | Buffer> {
  const slow: SlowTestObservation["data"][] = [];
  const invocation = randomUUID();
  const cases = createNodeCaseObservations(invocation);
  const files: string[] = [];
  let invalidFiles = 0;
  let omittedFiles = 0;
  const workerFailures: {
    exitCode: number | null;
    signal: string | null;
    failureType: string;
    code: string;
  }[] = [];
  async function* inspect() {
    for await (const event of source) {
      cases.capture(event);
      if (isSlowTest(event)) slow.push(event.data);
      if (event.type === "test:summary" && event.data.file !== undefined) {
        const observation = nodeFileObservation(event);
        if (!observation) invalidFiles++;
        else {
          const line = `Node test file observation: ${JSON.stringify({
            format_version: 1,
            invocation_id: invocation,
            ...observation,
          })}\n`;
          if (
            files.length === maxFileObservations ||
            Buffer.byteLength(line) > maxFileObservationBytes
          )
            omittedFiles++;
          else files.push(line);
        }
      }
      const error = event.type === "test:fail" ? event.data.details.error : undefined;
      if (
        event.type === "test:fail" &&
        isRecord(error) &&
        ("exitCode" in error || "signal" in error)
      ) {
        workerFailures.push({
          exitCode:
            typeof error.exitCode === "number" && Number.isSafeInteger(error.exitCode)
              ? error.exitCode
              : null,
          signal:
            typeof error.signal === "string" && /^SIG[A-Z0-9]{1,12}$/u.test(error.signal)
              ? error.signal
              : null,
          failureType: error.failureType === "testCodeFailure" ? error.failureType : "unknown",
          code: error.code === "ERR_TEST_FAILURE" ? error.code : "unknown",
        });
      }
      yield event;
    }
  }
  for await (const chunk of Readable.from(inspect()).compose(spec())) {
    const output: unknown = chunk;
    if (typeof output !== "string" && !Buffer.isBuffer(output))
      throw new TypeError("Node spec reporter emitted non-text output");
    yield output;
  }
  for (const failure of workerFailures)
    yield `Worker process failure: ${JSON.stringify(failure)}\n`;
  if (slow.length) {
    yield `\nSlow tests to investigate (${slowTestThresholdMs}ms):\n`;
    for (const test of slow) yield `  ${test.name}: ${test.details.duration_ms.toFixed(1)}ms\n`;
  }
  const caseSummary = cases.summary();
  if (
    files.length ||
    invalidFiles ||
    omittedFiles ||
    caseSummary.observed ||
    caseSummary.invalid ||
    caseSummary.omitted
  ) {
    const environment = (name: string) => {
      const value = process.env[name];
      return typeof value === "string" && value.length <= 256 ? value : null;
    };
    // Environment labels bind diagnostics to the outer invocation; they do not
    // attest source bytes, clean state, coverage or acceptance.
    const context = {
      format_version: 1,
      invocation_id: invocation,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      source: environment("PORTCOVE_HEAD_SHA"),
      checkout: environment("GITHUB_SHA"),
      run: environment("GITHUB_RUN_ID"),
      attempt: environment("GITHUB_RUN_ATTEMPT"),
      job: environment("GITHUB_JOB"),
    };
    if (caseSummary.observed || caseSummary.invalid || caseSummary.omitted) {
      yield `Node test case observation context: ${JSON.stringify({ ...context, ...caseSummary })}\n`;
      for (const observation of cases.records()) yield observation;
    }
    if (files.length || invalidFiles || omittedFiles) {
      yield `Node test file observation context: ${JSON.stringify({
        ...context,
        observed: files.length,
        invalid: invalidFiles,
        omitted: omittedFiles,
      })}\n`;
      for (const file of files) yield file;
    }
  }
}
