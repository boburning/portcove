/** Secret-free, inert provider qualification. At most one workflow_dispatch POST;
 * it can target only this fixture on the same main source. No production route. */
import { open, mkdir } from "node:fs/promises";
import path from "node:path";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
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
let requests = 0;
const started = performance.now(),
  api = new GitHubApiClient(
    createGitHubRunner({
      cwd: process.cwd(),
      timeoutMs: 10000,
      maxBuffer: 1024 * 1024,
    }),
  );
const request = (method: "GET" | "POST", endpoint: string, body?: unknown) => {
  if (++requests > 8 || performance.now() - started > 55000)
    throw new Error("inert dispatch fixed request/time budget exhausted");
  return api.request(method, endpoint, body);
};
const get = (endpoint: string) => {
  const response = request("GET", endpoint);
  if (response.status !== 200) throw new Error("inert dispatch provider readback unavailable");
  return response.body;
};
const readRun = (id: string, source: string) => {
  const raw = get(`${prefix}/actions/runs/${id}`);
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
try {
  const current = readRun(env.GITHUB_RUN_ID!, env.GITHUB_SHA!);
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
    let response: ReturnType<typeof request>;
    try {
      response = request("POST", endpoint, body);
    } catch {
      await retain("dispatch-ambiguous", { automatic_retry: false });
      throw new Error("retain original dispatch; readback before any later attempt");
    }
    // Persist even a refusal or malformed response; it may follow a remote effect.
    await retain("dispatch-response", { status: response.status, body: response.body });
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
    const run = await observeJobTokenDispatchRun({ request }, expected, retain, started + 55000);
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
      run_id: env.GITHUB_RUN_ID!,
      revision: env.GITHUB_SHA!,
      workflow,
      display_title: `Portcove job-token fixture receive ${parent}`,
    });
    const original = readRun(parent, source!);
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
