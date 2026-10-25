import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

const file = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const readyPrefix = "CI timeout custody ready: ";
const drainedPrefix = "CI timeout custody drained: ";
const expectedNode = `v${readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()}`;
export const timeoutProbeMinutes = 5;
export interface TimeoutProbeContext {
  source: string;
  run: string;
  attempt: string;
}

export function timeoutProbeContext(environment: NodeJS.ProcessEnv): TimeoutProbeContext {
  const source = environment.GITHUB_SHA,
    run = environment.GITHUB_RUN_ID,
    attempt = environment.GITHUB_RUN_ATTEMPT;
  assert.ok(source && /^[a-f0-9]{40}$/u.test(source));
  assert.ok(run && /^[1-9][0-9]*$/u.test(run));
  assert.ok(attempt && /^[1-9][0-9]*$/u.test(attempt));
  return { source, run, attempt };
}

async function readLimited(filename: string, maximum: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of createReadStream(filename, { highWaterMark: 65536 })) {
    assert.ok(Buffer.isBuffer(value));
    bytes += value.length;
    if (bytes > maximum) throw new Error("Timeout probe evidence exceeds its byte limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function packet(log: string, prefix: string): Record<string, unknown> {
  const lines = log.split(/\r?\n/u).filter((line) => line.includes(prefix));
  assert.equal(lines.length, 1, `Expected one ${prefix}`);
  const text = lines[0]!.slice(lines[0]!.indexOf(prefix) + prefix.length);
  assert.ok(Buffer.byteLength(text) <= 16384);
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value));
  return value;
}

/** The verifier checks one fixed two-job attempt. The original timed-out job
 * remains timed out even when the independent observation is accepted. */
export function verifyJobTimeoutProbe(
  jobs: unknown,
  log: string,
  context: TimeoutProbeContext,
  timeout: unknown,
) {
  assert.ok(Buffer.byteLength(log) <= 8 * 1024 * 1024);
  assert.ok(isRecord(jobs) && Array.isArray(jobs.jobs));
  assert.equal(jobs.total_count, 2);
  assert.equal(jobs.jobs.length, 2);
  const names = new Set<unknown>(),
    ids = new Set<unknown>();
  for (const job of jobs.jobs) {
    assert.ok(
      isRecord(job) && Number.isSafeInteger(job.id) && !ids.has(job.id) && !names.has(job.name),
    );
    ids.add(job.id);
    names.add(job.name);
    assert.equal(job.head_sha, context.source);
    assert.equal(String(job.run_id), context.run);
    assert.equal(String(job.run_attempt), context.attempt);
  }
  assert.ok(names.has("controlled-job-timeout") && names.has("verify-job-timeout"));
  const job: unknown = jobs.jobs.find(
    (value: unknown) => isRecord(value) && value.name === "controlled-job-timeout",
  );
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  assert.equal(job.status, "completed");
  assert.ok(job.conclusion === "timed_out" || job.conclusion === "cancelled");
  assert.ok(isRecord(timeout) && isRecord(timeout.check) && Array.isArray(timeout.annotations));
  const check = timeout.check;
  assert.equal(check.url, job.check_run_url);
  assert.ok(typeof check.url === "string" && check.url.endsWith(`/check-runs/${String(check.id)}`));
  assert.ok(Number.isSafeInteger(check.id) && Number(check.id) > 0);
  assert.equal(check.head_sha, context.source);
  assert.equal(check.status, "completed");
  assert.equal(check.conclusion, job.conclusion);
  assert.ok(isRecord(check.output));
  assert.equal(check.output.annotations_count, timeout.annotations.length);
  assert.ok(timeout.annotations.length > 0 && timeout.annotations.length < 100);
  const timeoutMessage = "The job has exceeded the maximum execution time of 5m0s";
  assert.equal(
    timeout.annotations.filter(
      (value: unknown) =>
        isRecord(value) && value.annotation_level === "failure" && value.message === timeoutMessage,
    ).length,
    1,
    "An explicit runner timeout annotation is required; cancellation alone is insufficient",
  );
  assert.ok(typeof job.started_at === "string" && typeof job.completed_at === "string");
  const elapsed = Date.parse(job.completed_at) - Date.parse(job.started_at);
  assert.ok(
    elapsed >= 4 * 60000 && elapsed <= 6 * 60000,
    "Observed job must reach its finite five-minute limit",
  );
  for (const name of ["Install pinned Node", "Install pinned Rust", "Run controlled payload"])
    assert.equal(
      job.steps.filter((step: unknown) => isRecord(step) && step.name === name).length,
      1,
    );
  const stepNumbers = new Set<unknown>();
  for (const step of job.steps) {
    assert.ok(isRecord(step) && step.status === "completed");
    assert.ok(Number.isSafeInteger(step.number) && !stepNumbers.has(step.number));
    stepNumbers.add(step.number);
    if (step.name === "Run controlled payload")
      assert.ok(step.conclusion === "cancelled" || step.conclusion === "timed_out");
    else if (
      ["Post Install pinned Node", "Post Install pinned Rust", "Post Checkout"].includes(
        String(step.name),
      )
    )
      assert.ok(step.conclusion === "success" || step.conclusion === "skipped");
    else assert.equal(step.conclusion, "success");
  }
  const ready = packet(log, readyPrefix),
    drained = packet(log, drainedPrefix);
  for (const value of [ready, drained]) {
    assert.equal(value.format_version, 1);
    assert.equal(value.node, expectedNode);
    assert.equal(value.source, context.source);
    assert.equal(value.checkout, context.source);
    assert.equal(value.run, context.run);
    assert.equal(value.attempt, context.attempt);
    assert.equal(value.platform, "linux");
    assert.equal(value.job_limit_minutes, timeoutProbeMinutes);
    assert.ok(typeof value.nonce === "string" && /^[a-f0-9-]{36}$/u.test(value.nonce));
  }
  assert.ok(Array.isArray(ready.processes) && ready.processes.length === 2);
  const processes = ready.processes;
  const pids = new Set<unknown>();
  for (const process of processes) {
    assert.ok(
      isRecord(process) &&
        typeof process.pid === "number" &&
        Number.isSafeInteger(process.pid) &&
        process.pid > 1 &&
        !pids.has(process.pid),
    );
    assert.ok(typeof process.identity === "string" && process.identity.length > 0);
    pids.add(process.pid);
  }
  assert.equal(drained.nonce, ready.nonce);
  assert.deepEqual(drained.processes, ready.processes);
  assert.equal(drained.quiescent, true);
  assert.ok(drained.status === 130 || drained.status === 143);
  assert.equal(
    drained.ready_sha256,
    createHash("sha256").update(JSON.stringify(ready)).digest("hex"),
  );
  return {
    ...context,
    job: job.id,
    elapsed_ms: elapsed,
    job_outcome: job.conclusion,
    timeout_annotation: timeoutMessage,
    supervised_status: drained.status,
    quiescent: true,
    processes: processes.length,
    scope:
      "Controlled Linux hosted job deadline and maintained supervisor cleanup; not a whole-suite or product acceptance",
  };
}

async function runWorker(directory: string, nonce: string) {
  assert.equal(process.env.PORTCOVE_TIMEOUT_PROBE_NONCE, nonce);
  assert.ok(
    path.basename(directory).startsWith("portcove-job-timeout-") && /^[a-f0-9-]{36}$/u.test(nonce),
  );
  const child = spawn(process.execPath, [file, "grandchild"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (value: unknown) => {
      if (!isRecord(value) || value.nonce !== nonce || value.pid !== child.pid)
        reject(new Error("Unexpected controlled child readiness"));
      else resolve();
    });
  });
  const candidate = path.join(directory, "ready.candidate.json");
  await writeFile(candidate, JSON.stringify({ nonce, worker: process.pid, child: child.pid }), {
    flag: "wx",
  });
  await rename(candidate, path.join(directory, "ready.json"));
  process.stderr.write(
    "Owned timeout fixture and detached descendant are waiting for the outer job deadline\n",
  );
  setInterval(() => {}, 1000);
}

async function runControlledJob() {
  assert.equal(process.platform, "linux");
  const context = timeoutProbeContext(process.env);
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  }).trim();
  assert.equal(checkout, context.source);
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-job-timeout-")),
    nonce = randomUUID();
  const { runResourceCommand } = await import("./resource-command.mts");
  const { readProcessIdentity } = await import("./heavy-rust-test-lock.mts");
  let finished = false;
  const pending = runResourceCommand(
    "analysis",
    process.execPath,
    [file, "worker", directory, nonce],
    {
      cwd: root,
      environment: { ...process.env, PORTCOVE_TIMEOUT_PROBE_NONCE: nonce },
      executionTimeoutMilliseconds: 10 * 60000,
    },
  )
    .then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      finished = true;
    });
  const completion = async () => {
    const result = await pending;
    if ("error" in result) throw result.error;
    return result.status;
  };
  try {
    let worker: unknown;
    const deadline = performance.now() + 120000;
    while (worker === undefined) {
      if (finished) {
        await completion();
        throw new Error("Controlled payload exited before readiness");
      }
      assert.ok(performance.now() < deadline, "Controlled payload readiness deadline expired");
      try {
        worker = JSON.parse(await readLimited(path.join(directory, "ready.json"), 16384));
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      if (worker === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      isRecord(worker) &&
        worker.nonce === nonce &&
        typeof worker.worker === "number" &&
        typeof worker.child === "number",
    );
    const processes = [worker.worker, worker.child].map((pid) => ({
      pid,
      identity: readProcessIdentity(pid),
    }));
    assert.ok(processes.every((process) => process.identity));
    const ready = {
      format_version: 1,
      ...context,
      checkout,
      platform: process.platform,
      node: process.version,
      nonce,
      job_limit_minutes: timeoutProbeMinutes,
      processes,
    };
    console.log(readyPrefix + JSON.stringify(ready));
    const status = await completion();
    assert.ok(
      status === 130 || status === 143,
      "The outer job deadline must cancel the supervised payload",
    );
    assert.ok(processes.every((process) => readProcessIdentity(process.pid) !== process.identity));
    for (const observed of processes) {
      let absent = false;
      try {
        process.kill(observed.pid, 0);
      } catch (error) {
        if (isRecord(error) && error.code === "ESRCH") absent = true;
        else throw error;
      }
      assert.ok(
        absent,
        "Owned process exit must be observed without treating access failure as absence",
      );
    }
    console.log(
      drainedPrefix +
        JSON.stringify({
          ...ready,
          status,
          quiescent: true,
          ready_sha256: createHash("sha256").update(JSON.stringify(ready)).digest("hex"),
        }),
    );
    process.exitCode = status;
  } catch (original) {
    console.error("Controlled timeout observation failed:", original);
    if (!finished) process.emit("SIGTERM");
    try {
      await completion();
    } catch (cleanup) {
      throw new AggregateError([original, cleanup], "Timeout fixture and cleanup failed");
    }
    throw original;
  }
}

if (path.resolve(process.argv[1] ?? "") === file) {
  if (process.argv[2] === "run") await runControlledJob();
  else if (process.argv[2] === "worker")
    await runWorker(process.argv[3] ?? "", process.argv[4] ?? "");
  else if (process.argv[2] === "grandchild") {
    assert.equal(process.connected, true);
    assert.match(process.env.PORTCOVE_TIMEOUT_PROBE_NONCE ?? "", /^[a-f0-9-]{36}$/u);
    process.send?.({ nonce: process.env.PORTCOVE_TIMEOUT_PROBE_NONCE, pid: process.pid });
    setInterval(() => {}, 1000);
  } else if (process.argv[2] === "verify") {
    const check: unknown = JSON.parse(await readLimited(process.argv[5] ?? "", 256 * 1024));
    const annotations: unknown = JSON.parse(await readLimited(process.argv[6] ?? "", 1024 * 1024));
    console.log(
      JSON.stringify(
        verifyJobTimeoutProbe(
          JSON.parse(await readLimited(process.argv[3] ?? "", 256 * 1024)),
          await readLimited(process.argv[4] ?? "", 8 * 1024 * 1024),
          timeoutProbeContext(process.env),
          { check, annotations },
        ),
      ),
    );
  } else throw new Error("Usage: ci-job-timeout-probe.mts run|verify JOBS LOG CHECK ANNOTATIONS");
}
