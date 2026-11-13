/** Secret-free, inert provider qualification. At most one workflow_dispatch POST;
 * it can target only this fixture on the same main source. No production route. */
import { open, mkdir } from "node:fs/promises";
import path from "node:path";
import { createWakeProvider } from "./release-wake-provider.mts";
import type { WakeResponse } from "./release-wake-provider.mts";
import {
  inspectJobTokenDispatchRun,
  observeJobTokenDispatchRun,
} from "./release-controller-wake.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove",
  prefix = `repos/${repository}`;
const workflow = ".github/workflows/job-token-dispatch-fixture.yml";
const env = process.env,
  mode = env.PORTCOVE_DISPATCH_FIXTURE_MODE;
if (
  !["send", "receive"].includes(mode ?? "") ||
  process.platform !== "linux" ||
  env.GITHUB_ACTIONS !== "true" ||
  env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  env.GITHUB_SERVER_URL !== "https://github.com" ||
  env.GITHUB_API_URL !== "https://api.github.com" ||
  env.GITHUB_REPOSITORY !== repository ||
  env.GITHUB_REPOSITORY_ID !== "1354613114" ||
  env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  env.GITHUB_REF !== "refs/heads/main" ||
  env.GITHUB_REF_PROTECTED !== "true" ||
  env.GITHUB_RUN_ATTEMPT !== "1" ||
  env.GITHUB_JOB !== mode ||
  !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "") ||
  env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
  env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main` ||
  !/^[1-9][0-9]{0,15}$/u.test(env.GITHUB_RUN_ID ?? "") ||
  !env.RUNNER_TEMP
)
  throw new Error("inert dispatch fixture requires its exact ordinary hosted main job");
const output = path.join(env.RUNNER_TEMP, "job-token-dispatch-fixture");
await mkdir(output, { mode: 0o700 });
const receipt = await open(path.join(output, "receipt.jsonl"), "wx", 0o600);
const retain = async (phase: string, value: unknown) => {
  await receipt.writeFile(
    JSON.stringify({
      schema_version: 1,
      observed_at: new Date().toISOString(),
      phase,
      run_id: env.GITHUB_RUN_ID,
      source: env.GITHUB_SHA,
      mode,
      value,
      authority: "none",
      scope: "inert job-token dispatch only; no protected execution or release acceptance",
    }) + "\n",
  );
  await receipt.sync();
};
try {
  const started = performance.now();
  let deadline = started + 10000;
  const token = env.GH_TOKEN ?? "";
  const api = await createWakeProvider({
    credential: { kind: "explicit", token },
    deadline: started + 55000,
    remainingDeadline: () => deadline,
    maxBytes: 1024 * 1024,
    maxRequests: 8,
    apiVersion: "2022-11-28",
  });
  const readRun = async (id: string, source: string) => {
    const raw = await api.run(id);
    if (
      !isRecord(raw) ||
      String(raw.id) !== id ||
      raw.path !== workflow ||
      raw.head_sha !== source ||
      raw.head_branch !== "main" ||
      raw.event !== "workflow_dispatch" ||
      raw.run_attempt !== 1 ||
      !isRecord(raw.repository) ||
      raw.repository.id !== 1354613114 ||
      raw.repository.full_name !== repository ||
      !isRecord(raw.head_repository) ||
      raw.head_repository.id !== 1354613114
    )
      throw new Error("inert dispatch workflow/source identity differs");
    return raw;
  };
  const jobs = await api.jobs(env.GITHUB_RUN_ID!);
  if (
    !isRecord(jobs) ||
    !Number.isSafeInteger(jobs.total_count) ||
    Number(jobs.total_count) < 1 ||
    Number(jobs.total_count) > 2 ||
    !Array.isArray(jobs.jobs) ||
    jobs.jobs.length !== jobs.total_count
  )
    throw new Error("inert dispatch original job inventory unavailable");
  const expectedName =
    mode === "send" ? "Send inert job-token dispatch" : "Observe inert job-token dispatch";
  const matches = (jobs.jobs as unknown[]).filter(
    (job) => isRecord(job) && job.name === expectedName,
  );
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    !Number.isSafeInteger(job.id) ||
    Number(job.id) < 1 ||
    String(job.run_id) !== env.GITHUB_RUN_ID ||
    job.run_attempt !== 1 ||
    job.head_sha !== env.GITHUB_SHA ||
    job.status !== "in_progress" ||
    typeof job.started_at !== "string"
  )
    throw new Error("inert dispatch actual original job unavailable");
  const remaining = Date.parse(job.started_at) + 55000 - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 55000)
    throw new Error("inert dispatch original job budget exhausted or future-dated");
  deadline = Math.min(started + 55000, performance.now() + remaining);
  const current = await readRun(env.GITHUB_RUN_ID, env.GITHUB_SHA!);
  await retain("actual-job-run", {
    id: current.id,
    actor: current.actor,
    triggering_actor: current.triggering_actor,
  });
  if (mode === "send") {
    if (env.PORTCOVE_DISPATCH_PARENT_RUN || env.PORTCOVE_DISPATCH_PARENT_REVISION)
      throw new Error("initial inert sender cannot import parent state");
    const endpoint = `${prefix}/actions/workflows/job-token-dispatch-fixture.yml/dispatches`;
    const body = {
      ref: "main",
      return_run_details: true,
      inputs: {
        mode: "receive",
        parent_run_id: env.GITHUB_RUN_ID,
        parent_revision: env.GITHUB_SHA,
      },
    };
    await retain("dispatch-intent", { endpoint, body, automatic_retry: false });
    let response: WakeResponse;
    try {
      response = await api.dispatch("job-token-dispatch-fixture.yml", body, async (received) => {
        await retain("dispatch-response", received);
      });
    } catch {
      await retain("dispatch-ambiguous", { automatic_retry: false });
      throw new Error("retain original dispatch; readback before any later attempt");
    }
    // Persist even a refusal or malformed response; it may follow a remote effect.
    const raw = response.body;
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.workflow_run_id) ||
      Number(raw.workflow_run_id) < 1 ||
      raw.run_url !==
        `https://api.github.com/${prefix}/actions/runs/${String(raw.workflow_run_id)}` ||
      raw.html_url !==
        `https://github.com/${repository}/actions/runs/${String(raw.workflow_run_id)}`
    )
      throw new Error("inert dispatch not acknowledged; preserve original response, no retry");
    const expected = {
      run_id: String(raw.workflow_run_id),
      revision: env.GITHUB_SHA!,
      workflow,
      display_title: `Portcove job-token fixture receive ${env.GITHUB_RUN_ID}`,
    };
    const run = await observeJobTokenDispatchRun(api, expected, retain, deadline);
    const observed = inspectJobTokenDispatchRun(run, expected);
    await retain("dispatch-run-observed", observed);
  } else {
    const parent = env.PORTCOVE_DISPATCH_PARENT_RUN ?? "",
      source = env.PORTCOVE_DISPATCH_PARENT_REVISION;
    if (
      !/^[1-9][0-9]{0,15}$/u.test(parent) ||
      parent === env.GITHUB_RUN_ID ||
      source !== env.GITHUB_SHA
    )
      throw new Error("inert receiver requires exact independent parent run/source");
    const observed = inspectJobTokenDispatchRun(current, {
      run_id: env.GITHUB_RUN_ID,
      revision: env.GITHUB_SHA!,
      workflow,
      display_title: `Portcove job-token fixture receive ${parent}`,
    });
    const original = await readRun(parent, source!);
    if (original.display_title !== "Portcove job-token fixture send initial")
      throw new Error("inert receiver parent is not the initial sender");
    await retain("receiver-executed", { ...observed, parent_run_id: parent });
  }
} catch (error) {
  await retain("failed", {
    message: error instanceof Error ? error.message : "unknown",
    automatic_retry: false,
  });
  throw error;
} finally {
  await receipt.close();
}
