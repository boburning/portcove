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
const historyLimit = 30;

export interface AdmissionRead {
  (route: string): Promise<unknown>;
}

export type Admission =
  | { observe: true; reason: "not-push" | "no-recent-observation" }
  | { observe: false; reason: string };

function recentRuns(value: unknown, event: "schedule" | "push", cutoff: number, seen: Set<number>) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.workflow_runs) ||
    !Number.isSafeInteger(value.total_count)
  )
    throw new Error("observer run inventory unavailable");
  if (value.total_count !== value.workflow_runs.length || value.workflow_runs.length > historyLimit)
    throw new Error(`${event} cooldown history is incomplete within the read limit`);
  return value.workflow_runs.map((run: unknown) => {
    if (
      !isRecord(run) ||
      !Number.isSafeInteger(run.id) ||
      typeof run.id !== "number" ||
      run.id <= 0 ||
      seen.has(run.id) ||
      run.event !== event ||
      run.head_branch !== "main" ||
      typeof run.status !== "string" ||
      typeof run.created_at !== "string" ||
      !(Date.parse(run.created_at) >= cutoff)
    )
      throw new Error("observer run record invalid");
    seen.add(run.id);
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
  const base = `repos/boburning/portcove/actions/workflows/${observerWorkflowId}/runs`;
  // GitHub reports run creation to whole seconds. Give the API the containing
  // second, then enforce the exact cutoff locally for the decision.
  const cutoff = options.now - pushCooldownMs;
  const queryCutoff = Math.floor(cutoff / 1000) * 1000;
  const listed = [];
  const seen = new Set<number>();
  for (const event of ["schedule", "push"] as const) {
    const params = new URLSearchParams({
      branch: "main",
      event,
      created: ">=" + new Date(queryCutoff).toISOString().replace(".000Z", "Z"),
      per_page: String(historyLimit),
    });
    listed.push(
      ...recentRuns(await options.read(`${base}?${params.toString()}`), event, queryCutoff, seen),
    );
  }
  const recent = listed.filter(
    (run) =>
      run.id !== options.currentRun &&
      Date.parse(String(run.created_at)) >= cutoff &&
      !["cancelled", "skipped"].includes(String(run.conclusion)),
  );
  if (recent.length > historyLimit)
    return { observe: false, reason: "combined cooldown history exceeds the job read limit" };
  for (const run of recent) {
    if (run.status !== "completed")
      return { observe: false, reason: `run ${String(run.id)} is ${String(run.status)}` };
    // A completed run counts only when its observe job actually ran; push runs
    // the gate declined finish successfully with that job skipped.
    const jobs = await options.read(
      `repos/boburning/portcove/actions/runs/${String(run.id)}/jobs?filter=latest&per_page=20`,
    );
    if (
      !isRecord(jobs) ||
      !Array.isArray(jobs.jobs) ||
      jobs.total_count !== jobs.jobs.length ||
      jobs.jobs.length > 20
    )
      throw new Error("observer job inventory unavailable");
    const matches = jobs.jobs.filter((job: unknown) => isRecord(job) && job.name === observeJob);
    const observed: unknown = matches[0];
    if (
      matches.length !== 1 ||
      !isRecord(observed) ||
      observed.run_id !== run.id ||
      observed.status !== "completed" ||
      !["success", "failure", "timed_out", "skipped"].includes(String(observed.conclusion))
    )
      throw new Error("observer job is not conclusively accounted for");
    if (observed.conclusion !== "skipped")
      return { observe: false, reason: `run ${String(run.id)} observed recently` };
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
    const deadline = AbortSignal.timeout(90_000);
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
          signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
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
