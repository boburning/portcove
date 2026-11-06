import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { parseDocument } from "yaml";
import { collectWorkflowJobEvidence } from "./workflow-job-evidence.mts";
import { isRecord } from "./runtime-values.mts";

const api = "https://api.github.com/repos/boburning/portcove";
const jobsRoute = api + "/actions/runs/21/attempts/1/jobs?per_page=100";
const logsRoute = api + "/actions/jobs/31/logs";
const checkRoute = api + "/check-runs/41";
const annotationsRoute = checkRoute + "/annotations?per_page=100";
const signed =
  "https://productionresultssa31.blob.core.windows.net/actions-results/fixed/logs/job/test?sig=inert";
const revision = "b".repeat(40);
const jobs = {
  total_count: 2,
  jobs: [
    {
      id: 31,
      name: "controlled-job-timeout",
      run_id: 21,
      run_attempt: 1,
      head_sha: revision,
      check_run_url: checkRoute,
    },
    { id: 32, name: "verify-job-timeout", run_id: 21, run_attempt: 1, head_sha: revision },
  ],
};

for (const [workflow, mode] of [
  ["browser-artifact-custody", "browser"],
  ["job-timeout-rehearsal", "timeout"],
] as const)
  void test(`workflow ${mode} uses the reviewed github-script distribution without script interpolation`, async () => {
    const source = await readFile(
      new URL(`../.github/workflows/${workflow}.yml`, import.meta.url),
      "utf8",
    );
    const document = parseDocument(source);
    assert.deepEqual(document.errors, []);
    const configuration: unknown = document.toJS();
    assert.ok(isRecord(configuration) && isRecord(configuration.jobs));
    const verifier = configuration.jobs.verify;
    assert.ok(isRecord(verifier) && Array.isArray(verifier.steps));
    const sdk = verifier.steps.find(
      (step: unknown) =>
        isRecord(step) &&
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/github-script@"),
    ) as unknown;
    assert.ok(isRecord(sdk) && isRecord(sdk.with));
    assert.equal(sdk.uses, "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    assert.equal(sdk.with.retries, 0);
    assert.equal(sdk.with.debug, false);
    assert.ok(typeof sdk.with.script === "string" && !sdk.with.script.includes("${{"));
    assert.ok(sdk.with.script.includes(`collectWorkflowJobEvidence(github, "${mode}")`));
    assert.doesNotMatch(source, /\bgh api\b/u);
  });

for (const refusal of [null, "stream", "escape", "pagination"] as const)
  void test(`locked SDK timeout evidence ${refusal ?? "success"}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-job-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dispatched: string[] = [];
    const exactLog = Buffer.from([0x41, 0x0d, 0x0a, 0x42, 0x0a]);
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        dispatched.push(url);
        if (url === signed) {
          assert.equal(new Headers(init?.headers).get("authorization"), null);
          assert.equal(init?.redirect, "error");
          return new Response(exactLog);
        }
        assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic");
        assert.equal(init?.redirect, "manual");
        if (url === jobsRoute && refusal === "stream")
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("unsafe fixture"));
              },
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        if (url === jobsRoute)
          return Response.json(jobs, {
            headers:
              refusal === "pagination" ? { link: '<https://example.invalid/>; rel="next"' } : {},
          });
        if (url === logsRoute)
          return new Response(null, {
            status: 302,
            headers: {
              location:
                refusal === "escape" ? "https://example.invalid/?sig=SECRET_FIXTURE" : signed,
            },
          });
        if (url === checkRoute) return Response.json({ id: 41 });
        if (url === annotationsRoute) return Response.json([{ message: "fixture" }]);
        return assert.fail("Unexpected route");
      },
    );
    const result = collectWorkflowJobEvidence(new Octokit({ auth: "synthetic" }), "timeout", {
      GITHUB_REPOSITORY: "boburning/portcove",
      GITHUB_RUN_ID: "21",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: revision,
      RUNNER_TEMP: directory,
    });
    if (refusal) {
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /unsafe fixture|SECRET_FIXTURE|example\.invalid/u);
        return true;
      });
      assert.deepEqual(await readdir(directory), []);
      assert.deepEqual(dispatched, refusal === "escape" ? [jobsRoute, logsRoute] : [jobsRoute]);
      return;
    }
    await result;
    assert.deepEqual(dispatched, [jobsRoute, logsRoute, signed, checkRoute, annotationsRoute]);
    assert.deepEqual(await readFile(path.join(directory, "timeout-job.log")), exactLog);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "timeout-jobs.json"), "utf8")),
      jobs,
    );
  });

void test("browser evidence publishes the exact complete attempt packet", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-browser-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(input, jobsRoute);
      assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic");
      return Response.json(jobs);
    },
  );
  await collectWorkflowJobEvidence(new Octokit({ auth: "synthetic" }), "browser", {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_RUN_ID: "21",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: revision,
    RUNNER_TEMP: directory,
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await readdir(directory), ["browser-custody-jobs.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "browser-custody-jobs.json"), "utf8")),
    jobs,
  );
});
