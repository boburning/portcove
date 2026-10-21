import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { slice4CapacityResources } from "./release-capacity.mts";

type Step = {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  steps: Step[];
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  "runs-on": string;
  "timeout-minutes": number;
};
type Workflow = {
  on: unknown;
  "run-name"?: string;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const root = new URL("../", import.meta.url);
void test("installed workflows remain inert without configuration and preserve exactly reviewed proposal bytes", async () => {
  for (const [actual, proposal] of [
    [
      ".github/workflows/application-update-production.yml",
      "docs/qualification/application-update-production.complete.yml",
    ],
    [
      ".github/workflows/application-update-wake.yml",
      "docs/qualification/application-update-wake.held.yml",
    ],
  ] as const) {
    const source = await readFile(new URL(actual, root), "utf8");
    assert.equal(source, await readFile(new URL(proposal, root), "utf8"));
    const workflow = parse(source) as Workflow;
    const states: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const dependencies = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
      const needs = Object.fromEntries(dependencies.map((key) => [key, states[key]]));
      const vars = new Proxy({}, { get: () => "" });
      const expression = (job.if ?? "${{ success() }}").slice(3, -2);
      const allowed: unknown = runInNewContext(expression, {
        vars,
        github: { sha: "a".repeat(40), ref: "refs/heads/main" },
        needs,
        always: () => true,
        success: () => Object.values(needs).every((value) => value?.result === "success"),
      });
      assert.equal(
        allowed,
        false,
        `${actual}: ${name} must not start without separately approved configuration`,
      );
      states[name] = { result: "skipped", outputs: {} };
    }
  }
});
void test("held automatic wake uses only the bound dispatch App and its actual installation", async () => {
  const wake = parse(
    await readFile(new URL(".github/workflows/application-update-wake.yml", root), "utf8"),
  ) as Workflow;
  const job = wake.jobs.wake!;
  assert.equal(job.if, "${{ vars.PORTCOVE_CONTROLLER_WAKE != '' }}");
  assert.equal(job["timeout-minutes"], slice4CapacityResources.wake_job_minutes[0]);
  assert.equal(wake.concurrency.group, slice4CapacityResources.wake_concurrency);
  const app = job.steps.findIndex((step) =>
    step.uses?.startsWith("actions/create-github-app-token@"),
  );
  assert.ok(app > 0);
  assert.equal(
    job.steps[app]!.with?.["app-id"],
    "${{ fromJSON(vars.PORTCOVE_RELEASE_AUTHORITIES).apps.dispatch.app_id }}",
  );
  assert.equal(job.steps[app]!.with?.["permission-actions"], "write");
  assert.equal(
    job.steps[app + 1]?.env?.PORTCOVE_OBSERVED_INSTALLATION_ID,
    "${{ steps.dispatch-token.outputs.installation-id }}",
  );
  assert.equal(
    job.steps[app + 1]?.env?.PORTCOVE_EXPECTED_INSTALLATION_ID,
    "${{ fromJSON(vars.PORTCOVE_RELEASE_AUTHORITIES).apps.dispatch.installation_id }}",
  );
  assert.ok(!JSON.stringify(wake).includes("SIGNING_PRIVATE_KEY"));
});
void test("actual held job conditions route retained custody without repeating signing and preserve renewal", async () => {
  const workflow = parse(
    await readFile(new URL(".github/workflows/application-update-production.yml", root), "utf8"),
  ) as Workflow;
  const permitted = (job: string, mode: string, reused: boolean, failed?: string) => {
    const needs = Object.fromEntries(
      Object.keys(workflow.jobs).map((name) => [
        name,
        {
          result:
            name === failed
              ? "failure"
              : reused && (name === "payload_signing" || name.startsWith("tuf_"))
                ? "skipped"
                : "success",
          outputs: name === "coordinator" ? { mode, signing_custody: reused ? "reused" : "" } : {},
        },
      ]),
    );
    const condition = workflow.jobs[job]?.if;
    assert.ok(condition);
    return runInNewContext(condition.slice(3, -2), { needs, always: () => true }) as boolean;
  };
  for (const name of [
    "payload_signing",
    "payload_protection_observation",
    ...["releases", "preview", "stable", "snapshot", "timestamp"].map((role) => `tuf_${role}`),
  ]) {
    assert.equal(permitted(name, "release", true), false, name);
    assert.equal(permitted(name, "release", false), true, name);
  }
  for (const name of [
    "independent_admission",
    "protection_observation",
    "attest",
    "release_publication",
    "release_protection_observation",
    "site_publication",
    "site_protection_observation",
  ]) {
    assert.equal(permitted(name, "release", true), true, name);
    assert.equal(permitted(name, "held", false), false, name);
  }
  for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"]) {
    assert.equal(permitted(`tuf_${role}`, "metadata", false), true);
    assert.equal(permitted(`tuf_${role}`, "release", false, "payload_signing"), false);
  }
  assert.equal(permitted("tuf_preview", "metadata", false, "tuf_releases"), false);
  assert.equal(permitted("release_publication", "release", true, "attest"), false);
  assert.equal(permitted("site_publication", "release", true, "release_publication"), false);
  assert.equal(permitted("site_publication", "metadata", false), true);
  assert.equal(permitted("site_publication", "metadata", false, "tuf_timestamp"), false);
  // Classification persistence is not maintenance authority. Its failed probe
  // must not prevent the actual coordinator from independently choosing renewal.
  for (const name of ["coordinator", "coordinator_protection_observation"]) {
    assert.equal(permitted(name, "metadata", false, "classification_writer"), true);
    assert.equal(permitted(name, "metadata", false, "tool_attest"), false);
    assert.equal(permitted(name, "metadata", false, "admission"), false);
  }
});
void test("complete held DAG keeps bounded resource and credential ownership across actual callables", async () => {
  const source = await readFile(
    new URL(".github/workflows/application-update-production.yml", root),
    "utf8",
  );
  const workflow = parse(source) as Workflow;
  assert.ok(Buffer.byteLength(source) < 65536);
  assert.deepEqual(workflow.on, {
    workflow_dispatch: {
      inputs: {
        wake_run_id: {
          description: "Inert automatic wake correlation; grants no admission authority",
          required: true,
          type: "string",
        },
      },
    },
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.queue, "max");
  const jobs = workflow.jobs;
  assert.equal(workflow["run-name"], "Portcove application release wake ${{ inputs.wake_run_id }}");
  const inputs = (name: string) =>
    name.includes("protection_observation") || name === "classification_writer";
  assert.deepEqual(
    Object.entries(jobs)
      .filter(([name]) => inputs(name))
      .map(([, job]) => job["timeout-minutes"]),
    slice4CapacityResources.input_job_minutes,
  );
  assert.deepEqual(
    Object.entries(jobs)
      .filter(([name]) => !inputs(name))
      .map(([, job]) => job["timeout-minutes"]),
    slice4CapacityResources.aggregate_job_minutes,
  );
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
    if (job.permissions?.actions === "read")
      assert.equal(
        job.permissions.checks,
        "read",
        `${name} needs authenticated producer/job Check readback`,
      );
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
    for (let index = 0; index < job.steps.length; index++) {
      const step = job.steps[index]!;
      if (step.uses?.startsWith("actions/create-github-app-token@")) {
        assert.match(
          step.with?.["app-id"] ?? "",
          /^\$\{\{ fromJSON\(vars\.PORTCOVE_RELEASE_AUTHORITIES\)\.apps\.[a-z_]+\.app_id \}\}$/u,
        );
        const installation = job.steps[index + 1];
        assert.equal(
          installation?.env?.PORTCOVE_OBSERVED_INSTALLATION_ID,
          `\${{ steps.${String((step as Step & { id: string }).id)}.outputs.installation-id }}`,
        );
        assert.ok(
          installation?.env?.PORTCOVE_EXPECTED_INSTALLATION_ID?.endsWith(".installation_id }}"),
        );
      }
    }
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
    (step) =>
      step.with?.["app-id"] ===
      "${{ fromJSON(vars.PORTCOVE_RELEASE_AUTHORITIES).apps.release_publication.app_id }}",
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
      ".github/workflows/application-update-production.yml",
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

void test("actual observer installation guard refuses drift before invoking its reader", async () => {
  const workflow = parse(
    await readFile(new URL(".github/workflows/application-update-production.yml", root), "utf8"),
  ) as Workflow;
  const observer = parse(
    await readFile(new URL(".github/actions/release-control-observer/action.yml", root), "utf8"),
  ) as { runs: { steps: Step[] } };
  const guards = observer.runs.steps.filter((step) => step.env?.PORTCOVE_OBSERVED_INSTALLATION_ID);
  assert.equal(guards.length, 15);
  const guard = guards[0]?.run?.split("\n")[0];
  assert.ok(guard);
  for (const step of guards) assert.equal(step.run?.split("\n")[0], guard);
  const direct = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.env?.PORTCOVE_OBSERVED_INSTALLATION_ID);
  assert.ok(direct.length >= 10);
  for (const step of direct) assert.equal(step.run, guard);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  for (const [expected, observed, status] of [
    ["123", "123", 0],
    ["123", "124", 1],
    ["", "", 1],
    ["123\n", "123\n", 1],
    ["$(exit 0)", "$(exit 0)", 1],
  ] as const) {
    const result: SpawnSyncReturns<string> = spawnSync(
      bash,
      ["--noprofile", "--norc", "-c", guard],
      {
        env: {
          PORTCOVE_EXPECTED_INSTALLATION_ID: expected,
          PORTCOVE_OBSERVED_INSTALLATION_ID: observed,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, status, result.stderr);
  }
});
