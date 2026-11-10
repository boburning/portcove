/**
 * Admission for push-triggered upstream observations (#4779).
 *
 * GitHub can skip scheduled observer runs for hours, so merges to main may also
 * start an observation, but only to fill a gap: a push run observes only when
 * no schedule or push run of this workflow observed, or is observing, within
 * the cooldown. Scheduled runs are never gated. Any read failure or
 * inconsistent provider record refuses admission, leaving the schedule as the
 * fallback; a push gate can never widen the observer's request rate.
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

export const observerWorkflowId = 354075266;
export const pushCooldownMs = 55 * 60000;
const observeJob = "observe";
const pageSize = 10;

export interface AdmissionRead {
  (route: string): Promise<unknown>;
}

export type Admission =
  | { observe: true; reason: "not-push" | "no-recent-observation" }
  | { observe: false; reason: string };

function runs(value: unknown, event: "schedule" | "push") {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs))
    throw new Error("observer run inventory unavailable");
  return value.workflow_runs.map((run: unknown) => {
    if (
      !isRecord(run) ||
      !Number.isSafeInteger(run.id) ||
      run.event !== event ||
      run.head_branch !== "main" ||
      typeof run.status !== "string" ||
      typeof run.created_at !== "string" ||
      !Number.isFinite(Date.parse(run.created_at))
    )
      throw new Error("observer run record invalid");
    return run;
  });
}

/** Decide whether this run may observe. Only push runs are gated. */
export async function admitObservation(options: {
  event: string;
  currentRun: number;
  now: number;
  read: AdmissionRead;
}): Promise<Admission> {
  if (options.event !== "push") return { observe: true, reason: "not-push" };
  const base = `repos/boburning/portcove/actions/workflows/${observerWorkflowId}/runs?branch=main&per_page=${pageSize}`;
  const listed = [];
  for (const event of ["schedule", "push"] as const) {
    const page = runs(await options.read(`${base}&event=${event}`), event);
    // A full page whose oldest row is still inside the cooldown may omit an
    // observing run; unknown coverage declines rather than admitting.
    // The oldest row is taken by time, not by the provider's listing order.
    const oldest = Math.min(...page.map((run) => Date.parse(String(run.created_at))));
    if (page.length >= pageSize && options.now - oldest <= pushCooldownMs)
      return { observe: false, reason: `${event} runs exceed one page within the cooldown` };
    listed.push(...page);
  }
  const recent = listed.filter(
    (run) =>
      run.id !== options.currentRun &&
      options.now - Date.parse(String(run.created_at)) <= pushCooldownMs &&
      !["cancelled", "skipped"].includes(String(run.conclusion)),
  );
  for (const run of recent) {
    if (run.status !== "completed")
      return { observe: false, reason: `run ${String(run.id)} is ${String(run.status)}` };
    // A completed run counts only when its observe job actually ran; push runs
    // the gate declined finish successfully with that job skipped.
    const jobs = await options.read(
      `repos/boburning/portcove/actions/runs/${String(run.id)}/jobs?filter=latest&per_page=20`,
    );
    if (!isRecord(jobs) || !Array.isArray(jobs.jobs))
      throw new Error("observer job inventory unavailable");
    const observed = jobs.jobs.some(
      (job: unknown) =>
        isRecord(job) &&
        job.name === observeJob &&
        ["success", "failure", "timed_out"].includes(String(job.conclusion)),
    );
    if (observed) return { observe: false, reason: `run ${String(run.id)} observed recently` };
  }
  return { observe: true, reason: "no-recent-observation" };
}

async function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  let admission: Admission;
  try {
    const token = process.env.GITHUB_TOKEN;
    if (event === "push" && !token) throw new Error("GITHUB_TOKEN is required");
    admission = await admitObservation({
      event,
      currentRun: Number(process.env.GITHUB_RUN_ID),
      now: Date.now(),
      read: async (route) => {
        const response = await fetch(`https://api.github.com/${route}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${String(token)}`,
            "x-github-api-version": "2022-11-28",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return response.json();
      },
    });
  } catch (error) {
    // Fail closed: the hourly schedule remains the fallback.
    admission = {
      observe: false,
      reason: `admission unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  console.log(JSON.stringify({ kind: "observer-push-admission", event, ...admission }));
  await appendFile(output, `observe=${admission.observe ? "true" : "false"}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
