import { hostedAmendmentMarker, parseHostedAmendment } from "./hosted-discovery-amendment.mts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

interface Outcome {
  request: number;
  status: "complete" | "complete_with_holds" | "incomplete";
  counts?: { delivered: number; existing: number; held: number; pending: number };
  continuation: "inventory_changed" | "budget_exhausted" | null;
  progress: string | null;
}
export const hostedIntakeMaxPasses = 12;
const hostedIntakeDeadlineMs = 90 * 60000;
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
      !["complete", "complete_with_holds", "incomplete"].includes(String(value.status)) ||
      ![null, "inventory_changed", "budget_exhausted"].includes(value.continuation as null) ||
      !(
        value.progress === null ||
        (typeof value.progress === "string" && /^[a-f0-9]{64}$/u.test(value.progress))
      ) ||
      (value.status !== "incomplete" && value.continuation !== null) ||
      (value.counts !== undefined &&
        (!isRecord(value.counts) ||
          !["delivered", "existing", "held", "pending"].every((key) => {
            const count = (value.counts as Record<string, unknown>)[key];
            return Number.isSafeInteger(count) && Number(count) >= 0;
          }) ||
          Number(value.counts.held) > Number(value.counts.pending))) ||
      (value.status === "complete_with_holds" &&
        (!isRecord(value.counts) ||
          !Number.isSafeInteger(value.counts.held) ||
          Number(value.counts.held) < 1 ||
          value.counts.pending !== value.counts.held))
    )
      throw new Error("Invalid intake continuation outcome");
    seen.add(value.request);
    return value as unknown as Outcome;
  });
  if ((raw.status === "passed") !== outcomes.every((o) => o.status !== "incomplete"))
    throw new Error("Intake summary disagrees with affected outcomes");
  return outcomes;
}

/** Existing receipts remain the only durable queue. These are finite job passes,
 * not a scheduler, HTTP retry loop or alternative planning authority. */
export function runHostedIntakePasses(
  run: (pass: number, requests: number[] | null, remainingMs: number) => unknown,
  now = Date.now,
  auditRequest?: number | number[],
) {
  const retained = new Map<number, Outcome>();
  const stalls = new Map<number, number>();
  const deadline = now() + hostedIntakeDeadlineMs;
  let requests: number[] | null = auditRequest === undefined ? null : [auditRequest].flat();
  let queuePending = false;
  let queueMovements = 0;
  let stopReason = "pass_limit";
  for (let pass = 1; pass <= hostedIntakeMaxPasses; pass++) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      stopReason = "deadline";
      break;
    }
    const report = run(pass, requests, remainingMs);
    if (isRecord(report) && report.queue_continuation === "maintenance_resource_deferred") {
      queuePending = true;
      stopReason = "maintenance_resource_deferred";
      break;
    }
    queuePending = isRecord(report) && report.queue_continuation !== undefined;
    if (isRecord(report) && queuePending) {
      if (
        typeof report.queue_continuation !== "string" ||
        !["inventory_changed", "budget_exhausted"].includes(report.queue_continuation) ||
        report.status !== "incomplete" ||
        report.requests !== 0 ||
        !Array.isArray(report.outcomes) ||
        report.outcomes.length
      )
        throw new Error("Malformed queue continuation");
      if (++queueMovements >= 3) {
        stopReason = "stalled";
        break;
      }
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
      const unchanged =
        outcome.continuation &&
        previous?.continuation === outcome.continuation &&
        previous.progress === outcome.progress;
      const count = unchanged ? (stalls.get(outcome.request) ?? 0) + 1 : 0;
      stalls.set(outcome.request, count);
      const stalled = count >= (outcome.continuation === "budget_exhausted" ? 1 : 2);
      retained.set(outcome.request, outcome);
      if (outcome.continuation && !stalled) next.push(outcome.request);
    }
    if (!next.length) {
      stopReason = outcomes.every((o) => o.status !== "incomplete")
        ? "complete"
        : "blocked_or_stalled";
      break;
    }
    // Give requests at the exhausted tail first access to the next envelope.
    requests = next.reverse();
  }
  const outcomes = [...retained.values()];
  return {
    status:
      stopReason === "complete" && !queuePending && outcomes.every((o) => o.status !== "incomplete")
        ? "passed"
        : "incomplete",
    outcomes,
    queue_pending: queuePending,
    stop_reason: stopReason,
  };
}

export function runHostedIntakeWorker(
  root: string,
  directory: string,
  pass: number,
  requests: number[] | null,
  remainingMs = hostedIntakeDeadlineMs,
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
      timeout: Math.min(31 * 60000, remainingMs),
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
  if (!child.error && !child.signal && child.status === 75)
    return { queue_continuation: "maintenance_resource_deferred" };
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

export function hostedTriggerRequest(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.comment)) return undefined;
  const { body, id } = event.comment;
  return typeof body === "string" && body.startsWith(hostedAmendmentMarker)
    ? parseHostedAmendment(body).request_comment
    : id;
}

export function auditDispatchRequest(mode: string | undefined, id: string | undefined) {
  if (mode !== "audit") {
    if (id) throw new Error("An audit request requires audit mode");
    return undefined;
  }
  if (!id || !/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Audit mode requires one positive proposal comment ID");
  return Number(id);
}

export interface AuditContinuation {
  request: number;
  binding: string;
}

export function scheduledAuditRequests(environment: NodeJS.ProcessEnv): AuditContinuation[] {
  if (environment.HOSTED_INTAKE_MODE !== "resume-audits") return [];
  if (
    environment.GITHUB_EVENT_NAME !== "schedule" ||
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_WORKFLOW_REF !==
      "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main"
  )
    throw new Error("Only the protected maintenance schedule may resume owner-authorized audits");
  const parsed: unknown = JSON.parse(environment.HOSTED_INTAKE_AUDIT_CONTINUATIONS ?? "null");
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some(
      (value) =>
        !isRecord(value) ||
        !Number.isSafeInteger(value.request) ||
        Number(value.request) < 1 ||
        typeof value.binding !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.binding),
    ) ||
    new Set(parsed.map((value) => value.request)).size !== parsed.length
  )
    throw new Error("Invalid bound audit continuation selection");
  return parsed as AuditContinuation[];
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, "work/hosted-discovery-intake");
  mkdirSync(directory, { recursive: true });
  const audit = auditDispatchRequest(
    process.env.HOSTED_INTAKE_MODE,
    process.env.HOSTED_INTAKE_AUDIT_REQUEST,
  );
  const scheduled = scheduledAuditRequests(process.env);
  const result = runHostedIntakePasses(
    (pass, requests, remainingMs) =>
      runHostedIntakeWorker(root, directory, pass, requests, remainingMs),
    Date.now,
    scheduled.length ? scheduled.map(({ request }) => request) : audit,
  );
  // A comment event reports its own proposal result. The ledger still retains
  // the outcomes of all other queue entries, including historical holds.
  const event: unknown =
    process.env.GITHUB_EVENT_NAME === "issue_comment" && process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      : null;
  const trigger = hostedTriggerRequest(event);
  const triggered = result.outcomes.find((o) => o.request === trigger);
  const passed =
    typeof trigger === "number"
      ? triggered !== undefined && triggered.status !== "incomplete"
      : result.status === "passed";
  writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(
      { ...result, trigger_request: trigger, trigger_status: triggered?.status },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = result.outcomes.flatMap(({ request, status, counts }) =>
      counts
        ? [
            `| ${request} | ${status} | ${counts.delivered} | ${counts.existing} | ${counts.held} | ${counts.pending} |`,
          ]
        : [`| ${request} | ${status} | — | — | — | — |`],
    );
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Hosted discovery intake",
        "",
        ...(result.stop_reason === "maintenance_resource_deferred"
          ? [
              "Maintenance checkpoint work is pending. The next existing intake event retries it when the provider budget allows.",
              "",
            ]
          : []),
        "| Proposal comment | Result | Delivered | Existing | Held | Pending |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
        ...rows,
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
