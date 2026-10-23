import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { FallowProcessResult } from "./run-fallow.mts";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runResourceCommand } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";

export interface FallowCapture {
  directory: string;
  phase: "analysis" | "format";
  timeoutMilliseconds: number;
  identity: unknown;
}
const root = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("./fallow-capture-worker.mts", import.meta.url));
function boundedText(file: string, limit: number) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error("Invalid or oversized retained analyzer stream");
  return readFileSync(file, "utf8");
}

/** Actual CLI seam: live bounded streams remain outside the contained process. */
export async function executeFallow(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  capture?: FallowCapture,
): Promise<FallowProcessResult> {
  if (!capture) throw new Error("Owned Fallow execution requires a capture identity");
  const limit = options.maxBuffer ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024)
    throw new Error("Invalid analyzer capture byte limit");
  const directory = path.join(capture.directory, `${capture.phase}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const config = path.join(directory, "invocation.json");
  writeFileSync(config, JSON.stringify({ command, args, maxBytes: limit }), { flag: "wx" });
  writeFileSync(
    path.join(directory, "running.json"),
    JSON.stringify({
      format_version: 1,
      outcome: "running",
      phase: capture.phase,
      limit_ms: capture.timeoutMilliseconds,
      max_bytes_per_stream: limit,
      identity: capture.identity,
    }),
    { flag: "wx" },
  );
  const stdoutFile = path.join(directory, "stdout.txt");
  const stderrFile = path.join(directory, "stderr.txt");
  const stdout = openSync(stdoutFile, "wx");
  let stderr: number | undefined;
  let status: number | null = null;
  let failure: Error | undefined;
  let timedOut = false;
  let quiescent = false;
  let evidenceFailure: string | undefined;
  try {
    stderr = openSync(stderrFile, "wx");
    status = await runResourceCommand("analysis", process.execPath, [worker, config], {
      environment: options.env ?? process.env,
      cwd: typeof options.cwd === "string" ? options.cwd : root,
      exclusive: [frontendOutputResource(root)],
      executionTimeoutMilliseconds: capture.timeoutMilliseconds,
      onExecutionTimeout: () => {
        timedOut = true;
      },
      output: { stdout, stderr },
    });
    quiescent = true;
    if (timedOut)
      failure = Object.assign(
        new Error(`Fallow ${capture.phase} exceeded ${capture.timeoutMilliseconds}ms`),
        { code: "ETIMEDOUT" },
      );
    else {
      const native: unknown = JSON.parse(
        boundedText(path.join(directory, "native-exit.json"), 16384),
      );
      if (
        !isRecord(native) ||
        !(native.status === null || Number.isSafeInteger(native.status)) ||
        !(native.signal === null || typeof native.signal === "string") ||
        !(native.error === null || typeof native.error === "string")
      )
        throw new Error("Incomplete analyzer exit observation");
      if (native.error || native.signal)
        failure = Object.assign(
          new Error(
            native.error ? String(native.error) : `Analyzer signal ${String(native.signal)}`,
          ),
          { code: typeof native.code === "string" ? native.code : "ANALYZER_EXECUTION_FAILED" },
        );
      if (native.status !== status && !failure)
        throw new Error("Analyzer and custody exit status disagree");
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(errorMessage(error));
  } finally {
    for (const descriptor of [stdout, stderr]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch (error) {
        evidenceFailure ??= `capture close failed: ${errorCode(error) ?? "unknown"}`;
      }
    }
  }
  const stream = (file: string) => {
    try {
      return boundedText(file, limit);
    } catch (error) {
      evidenceFailure ??= `capture stream unavailable: ${errorCode(error) ?? "unknown"}`;
      return null;
    }
  };
  const result = {
    status,
    stdout: stream(stdoutFile),
    stderr: stderr === undefined ? "" : stream(stderrFile),
    ...(failure ? { error: failure } : {}),
  };
  try {
    writeFileSync(
      path.join(directory, "finished.json"),
      JSON.stringify({
        format_version: 1,
        outcome: timedOut
          ? "timed-out"
          : failure
            ? "failed"
            : evidenceFailure
              ? "incomplete"
              : "completed",
        phase: capture.phase,
        status,
        quiescent,
        error: failure
          ? { code: errorCode(failure) ?? null, message: errorMessage(failure).slice(0, 2048) }
          : null,
      }),
      { flag: "wx" },
    );
  } catch (error) {
    evidenceFailure ??= `capture finalization failed: ${errorCode(error) ?? "unknown"}`;
  }
  return { ...result, ...(evidenceFailure ? { evidenceFailure } : {}) };
}
