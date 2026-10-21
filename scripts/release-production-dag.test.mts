import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

type Step = {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type Job = {
  steps: Step[];
  needs?: string[];
  environment?: string;
  permissions?: Record<string, string>;
  "runs-on": string;
  "timeout-minutes": number;
};
type Workflow = { on: unknown; concurrency: Record<string, unknown>; jobs: Record<string, Job> };
const root = new URL("../", import.meta.url);
void test("complete held DAG keeps bounded resource and credential ownership across actual callables", async () => {
  const source = await readFile(
    new URL("docs/qualification/application-update-production.complete.yml", root),
    "utf8",
  );
  const workflow = parse(source) as Workflow;
  assert.ok(Buffer.byteLength(source) < 65536);
  assert.deepEqual(workflow.on, { workflow_dispatch: {} });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.queue, "max");
  const jobs = workflow.jobs;
  const requiredJob = (name: string) => {
    const selected = jobs[name];
    assert.ok(selected, `missing fixed job ${name}`);
    return selected;
  };
  assert.equal(
    Object.values(jobs).reduce((total: number, job: Job) => total + job["timeout-minutes"], 1),
    99,
  );
  assert.equal(requiredJob("independent_admission")["timeout-minutes"], 9);
  assert.equal(requiredJob("protection_observation")["timeout-minutes"], 10);
  assert.equal(requiredJob("attest")["timeout-minutes"], 2);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job["runs-on"], "ubuntu-22.04", name);
    for (const match of JSON.stringify(job).matchAll(/needs\.([a-z_][a-z_0-9]*)/gu))
      assert.ok(
        job.needs?.includes(match[1]!),
        `${name} references undeclared producer ${match[1]}`,
      );
    assert.ok(Number.isSafeInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0);
    if (name !== "tool_bootstrap")
      assert.ok(!job.steps.some((step) => /(?:npm|pnpm) (?:install|ci)/u.test(step.run ?? "")));
    assert.ok(
      !job.steps.some((step) => /gh workflow run|gh api[^\n]*dispatches/u.test(step.run ?? "")),
    );
    assert.ok(!JSON.stringify(job).includes("overwrite: true"));
    for (const step of job.steps) {
      if (step.uses && !step.uses.startsWith("./")) assert.match(step.uses, /@[a-f0-9]{40}$/u);
      if (step.with?.["role_key"] && step.with.role_key !== "")
        assert.ok(name === "payload_signing" || name.startsWith("tuf_"));
      if (step.with?.["permission-administration"])
        assert.ok(name.includes("protection_observation"));
      if (step.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN)
        assert.equal(step.uses, "./.github/actions/release-controller-job");
    }
    if (job.permissions?.contents === "write") assert.equal(name, "release_publication");
    if (job.permissions?.pages === "write") assert.equal(name, "site_publication");
  }
  assert.ok(requiredJob("attest").needs!.includes("independent_admission"));
  assert.ok(requiredJob("payload_signing").needs!.includes("attest"));
  for (const [index, role] of [
    "releases",
    "preview",
    "stable",
    "snapshot",
    "timestamp",
  ].entries()) {
    const job = requiredJob(`tuf_${role}`);
    assert.equal(job.environment, `production-tuf-${role}`);
    assert.equal(job["timeout-minutes"], 2);
    assert.equal(
      job.steps.at(-1)?.with?.role_key,
      `\${{ secrets.PORTCOVE_TUF_${role.toUpperCase()}_KEY }}`,
    );
    if (index > 0)
      assert.ok(
        job.needs!.includes(`tuf_${["releases", "preview", "stable", "snapshot"][index - 1]}`),
      );
  }
  // Match the actual reader ABIs: TUF/site begin at ordinal one; aggregate,
  // coordinator and payload have an initial ordinal-zero admission handshake.
  const observerCalls = (name: string) =>
    requiredJob(name).steps.filter(
      (step) => step.uses === "./.github/actions/release-control-observer",
    );
  for (const name of [
    "coordinator_protection_observation",
    "protection_observation",
    "payload_protection_observation",
    "release_protection_observation",
  ]) {
    const calls = observerCalls(name);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.with?.initial, "true");
    assert.equal(calls[0]?.with?.rounds, "14");
  }
  assert.deepEqual(
    observerCalls("metadata_protection_observation").map((step) => [
      step.with?.initial,
      step.with?.rounds,
    ]),
    Array.from({ length: 5 }, () => ["false", "3"]),
  );
  assert.equal(observerCalls("site_protection_observation")[0]?.with?.initial, "false");
  assert.equal(observerCalls("site_protection_observation")[0]?.with?.rounds, "5");
  const publisher = requiredJob("release_publication");
  const publicationApp = publisher.steps.findIndex(
    (step) => step.with?.["app-id"] === "${{ vars.PORTCOVE_RELEASE_PUBLICATION_APP_ID }}",
  );
  const publisherGuard = publisher.steps.findIndex((step) =>
    step.run?.includes("requireControllerReleaseAuthorities('release-publication')"),
  );
  const publishingWorker = publisher.steps.find(
    (step) => step.uses === "./.github/actions/release-controller-job",
  );
  assert.ok(publisherGuard >= 0 && publicationApp > publisherGuard);
  assert.equal(publisher.permissions?.contents, "read");
  assert.equal(
    publishingWorker?.env?.PORTCOVE_RELEASE_PUBLICATION_TOKEN,
    "${{ steps.publication.outputs.token }}",
  );
  for (const [name, job] of Object.entries(jobs))
    if (name !== "release_publication")
      assert.ok(!JSON.stringify(job).includes("PORTCOVE_RELEASE_PUBLICATION_TOKEN"));
  assert.ok(requiredJob("release_publication").needs!.includes("tuf_timestamp"));
  assert.ok(requiredJob("site_publication").needs!.includes("release_publication"));
});

void test("held DAG embedded fixed Node programs parse in the actual pinned runtime", async () => {
  const documents = await Promise.all(
    [
      "docs/qualification/application-update-production.complete.yml",
      ".github/actions/release-controller-job/action.yml",
      ".github/actions/release-control-observer/action.yml",
    ].map(
      async (file) =>
        parse(await readFile(new URL(file, root), "utf8")) as {
          jobs?: Record<string, Job>;
          runs: { steps: Step[] };
        },
    ),
  );
  let checked = 0;
  for (const document of documents) {
    const groups = document.jobs
      ? Object.values<Job>(document.jobs).map((job) => job.steps)
      : [document.runs.steps];
    for (const steps of groups)
      for (const step of steps)
        for (const match of String(step.run ?? "").matchAll(
          /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/gu,
        )) {
          const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
            input: match[1],
            encoding: "utf8",
            timeout: 5000,
          });
          assert.equal(result.status, 0, result.stderr);
          checked++;
        }
  }
  assert.ok(checked >= 5, "actual embedded programs must be selected");
});
