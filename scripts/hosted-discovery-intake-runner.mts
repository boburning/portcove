import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

interface Outcome {
  request: number;
  status: "complete" | "incomplete";
  continuation: "inventory_changed" | "budget_exhausted" | null;
  progress: string | null;
}
export function readHostedOutcomes(raw: unknown): Outcome[] {
  if (
    !isRecord(raw) ||
    !["passed", "incomplete"].includes(String(raw.status)) ||
    !Array.isArray(raw.outcomes) ||
    raw.requests !== raw.outcomes.length
  )
    throw new Error("Missing or invalid intake worker summary");
  const seen = new Set<number>();
  const outcomes = raw.outcomes.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.request !== "number" ||
      !Number.isSafeInteger(value.request) ||
      value.request < 1 ||
      seen.has(value.request) ||
      !["complete", "incomplete"].includes(String(value.status)) ||
      ![null, "inventory_changed", "budget_exhausted"].includes(value.continuation as null) ||
      !(
        value.progress === null ||
        (typeof value.progress === "string" && /^[a-f0-9]{64}$/u.test(value.progress))
      ) ||
      (value.status === "complete" && value.continuation !== null)
    )
      throw new Error("Invalid intake continuation outcome");
    seen.add(value.request);
    return value as unknown as Outcome;
  });
  if ((raw.status === "passed") !== outcomes.every((o) => o.status === "complete"))
    throw new Error("Intake summary disagrees with affected outcomes");
  return outcomes;
}

/** Existing receipts remain the only durable queue. These are finite job passes,
 * not a scheduler, HTTP retry loop or alternative planning authority. */
export function runHostedIntakePasses(run: (pass: number, requests: number[] | null) => unknown) {
  const retained = new Map<number, Outcome>();
  let requests: number[] | null = null;
  let queuePending = false;
  for (let pass = 1; pass <= 3; pass++) {
    const report = run(pass, requests);
    queuePending = isRecord(report) && report.queue_continuation === "inventory_changed";
    if (isRecord(report) && report.queue_continuation === "inventory_changed") {
      if (
        report.status !== "incomplete" ||
        report.requests !== 0 ||
        !Array.isArray(report.outcomes) ||
        report.outcomes.length
      )
        throw new Error("Malformed queue continuation");
      continue;
    }
    const outcomes = readHostedOutcomes(report);
    if (
      requests &&
      (outcomes.length !== requests.length || outcomes.some((o) => !requests!.includes(o.request)))
    )
      throw new Error("Worker changed the bound continuation selection");
    const next: number[] = [];
    for (const outcome of outcomes) {
      const previous = retained.get(outcome.request);
      // A fresh envelope cannot fix work whose replay consumed the whole next
      // envelope without advancing. Preserve the actual pending result.
      const stalled =
        outcome.continuation === "budget_exhausted" &&
        previous?.continuation === "budget_exhausted" &&
        previous.progress === outcome.progress;
      retained.set(outcome.request, outcome);
      if (outcome.continuation && !stalled) next.push(outcome.request);
    }
    if (!next.length || pass === 3) break;
    // Give requests at the exhausted tail first access to the next envelope.
    requests = next.reverse();
  }
  const outcomes = [...retained.values()];
  return {
    status:
      !queuePending && outcomes.every((o) => o.status === "complete") ? "passed" : "incomplete",
    outcomes,
    queue_pending: queuePending,
  };
}

export function runHostedIntakeWorker(
  root: string,
  directory: string,
  pass: number,
  requests: number[] | null,
) {
  const summary = path.join(directory, `pass-${pass}`, "summary.json");
  // A stale file must never stand in for a worker that crashed or was killed.
  if (existsSync(path.dirname(summary))) throw new Error("Intake pass directory already exists");
  const child = spawnSync(
    process.execPath,
    [path.join(root, "scripts/hosted-discovery-intake.mts")],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 31 * 60000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        HOSTED_INTAKE_PASS: String(pass),
        HOSTED_INTAKE_REQUESTS: requests ? JSON.stringify(requests) : "",
      },
    },
  );
  // spawnSync joins the child before returning. Never restart after a timeout,
  // signal, missing report or unknown worker failure.
  if (child.error || child.signal || ![0, 1].includes(child.status ?? -1))
    throw new Error("Intake worker did not terminate with a qualified outcome");
  if (!existsSync(summary)) {
    // Probe mode has its own exact write-proof report and no queue.
    if (child.status === 0 && existsSync(path.join(directory, `pass-${pass}`, "write-probe.json")))
      return { status: "passed", requests: 0, outcomes: [] };
    throw new Error("Intake worker ended without a continuation report");
  }
  const report: unknown = JSON.parse(readFileSync(summary, "utf8"));
  if (!isRecord(report) || (child.status === 0) !== (report.status === "passed"))
    throw new Error("Intake worker exit and report disagree");
  return report;
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, "work/hosted-discovery-intake");
  mkdirSync(directory, { recursive: true });
  const result = runHostedIntakePasses((pass, requests) =>
    runHostedIntakeWorker(root, directory, pass, requests),
  );
  writeFileSync(path.join(directory, "summary.json"), JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
