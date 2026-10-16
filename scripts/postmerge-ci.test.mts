import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildValidationPlan } from "./validation-plan.mts";
import { buildWorkflowProvenance } from "./workflow-provenance.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  discoverPostmergeReuse,
  postmergeEligible,
  validatePostmergeReuse,
} from "./postmerge-ci.mts";
import { evaluateCiResults } from "./ci-result-gate.mts";

const sha = (c) => c.repeat(40),
  repository = "boburning/portcove";
function fixture() {
  const plan = buildValidationPlan({
    changes: [
      {
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldPath: "apps/desktop/src/styles/changed.css",
        newPath: "apps/desktop/src/styles/changed.css",
      },
    ],
    eventName: "push",
    base: sha("a"),
    mergeBase: sha("a"),
    head: sha("b"),
    checkout: sha("b"),
  });
  const workflow = "reviewed workflow bytes\n";
  const record = buildWorkflowProvenance({
    workflow: "ci.yml",
    mode: "ci",
    desiredRunner: "ubuntu-latest",
    workflowContents: workflow,
    desired: {
      node: process.versions.node,
      package_manager: "12.11.2",
      rust: "1.98.1",
      build_configuration: { ci: true },
    },
    observed: {
      node: process.versions.node,
      package_manager: null,
      rust: null,
      cargo: null,
      runner: { os: "Linux", architecture: "X64" },
      build_configuration: { ci: true },
    },
    environment: {
      GITHUB_WORKFLOW_SHA: sha("c"),
      GITHUB_SHA: sha("c"),
      PORTCOVE_HEAD_SHA: sha("d"),
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: repository,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/7/merge`,
      GITHUB_EVENT_NAME: "pull_request",
      PORTCOVE_PLAN_DIGEST: plan.digest,
      PORTCOVE_PLAN_MODE: "fast",
    },
    checkoutSha: sha("c"),
  });
  const zip = createAuditZip([["workflow-provenance.json", JSON.stringify(record)]]);
  const run = {
    id: 42,
    run_attempt: 1,
    head_sha: sha("d"),
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    pull_requests: [{ number: 7 }],
    status: "completed",
    conclusion: "success",
  };
  const jobs = [
    "catalog",
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
    "record-workflow-provenance",
    "fast-frontend (linux-x86_64)",
    "fast-rust-quality (linux-x86_64)",
  ].map((name) => ({
    name,
    run_id: 42,
    run_attempt: 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
  }));
  const responses = {
    [`commits/${sha("b")}/pulls?per_page=100`]: [
      {
        number: 7,
        merged_at: "2026-10-16",
        merge_commit_sha: sha("b"),
        base: { ref: "main", repo: { full_name: repository } },
        head: { sha: sha("d"), repo: { full_name: repository } },
      },
    ],
    [`actions/workflows/ci.yml/runs?head_sha=${sha("d")}&event=pull_request&per_page=20`]: {
      workflow_runs: [run],
    },
    "actions/runs/42/jobs?filter=latest&per_page=100": { total_count: jobs.length, jobs },
    "actions/runs/42/artifacts?per_page=100": {
      total_count: 1,
      artifacts: [
        {
          id: 9,
          name: "workflow-provenance-ci-42-1",
          expired: false,
          size_in_bytes: zip.length,
          digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
        },
      ],
    },
    "actions/artifacts/9/zip": zip,
    "actions/runs/42": run,
  };
  const invoke = (command, args, binary) => {
    if (command === "gh") {
      const value = responses[args[1].replace(`repos/${repository}/`, "")];
      if (value === undefined) throw Error("unexpected route");
      return binary ? value : JSON.stringify(value);
    }
    if (args[0] === "show") return workflow;
    if (args[0] === "rev-parse") return sha("f");
    if (args[0] === "cat-file") return "";
    throw Error("unexpected git");
  };
  return { plan, invoke, responses, run, jobs, discoverPlan: () => plan };
}

test("trusted identical tested composition reuses explicit groups while current aggregates remain honest", () => {
  const f = fixture();
  const reuse = discoverPostmergeReuse(f.plan, {
    event: "push",
    invoke: f.invoke,
    discoverPlan: f.discoverPlan,
  });
  assert.ok(reuse);
  assert.equal(reuse.tested_checkout, sha("c"));
  assert.match(
    evaluateCiResults({
      classifier: "success",
      plan: f.plan,
      group: "frontend",
      prose: "skipped",
      fast: { frontend: "skipped" },
      qualification: { full: "skipped" },
      reuse,
    }),
    /reused CI 42/,
  );
  assert.equal(discoverPostmergeReuse(f.plan, { event: "pull_request", invoke: f.invoke }), null);
  assert.throws(() => validatePostmergeReuse({ ...reuse, checkout: sha("a") }, f.plan));
  assert.throws(() =>
    evaluateCiResults({
      classifier: "success",
      plan: f.plan,
      group: "frontend",
      prose: "skipped",
      fast: { frontend: "failure" },
      qualification: { full: "skipped" },
      reuse,
    }),
  );
});
test("changed composition, direct push, pending/failing or incomplete provenance execute normally", () => {
  for (const mutate of [
    (f) => (f.run.conclusion = "failure"),
    (f) => (f.run.status = "in_progress"),
    (f) => f.jobs.pop(),
    (f) => (f.discoverPlan = () => ({ ...f.plan, digest: "0".repeat(64) })),
    (f) => (f.discoverPlan = () => ({ ...f.plan, changes: [] })),
    (f) => (f.jobs.find((j) => j.name === "fast-frontend (linux-x86_64)").conclusion = "skipped"),
    (f) => (f.jobs[0].head_sha = sha("a")),
    (f) => (f.responses[`commits/${sha("b")}/pulls?per_page=100`] = []),
    (f) =>
      (f.responses["actions/runs/42/artifacts?per_page=100"].artifacts[0].digest =
        `sha256:${"0".repeat(64)}`),
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(
      discoverPostmergeReuse(f.plan, {
        event: "push",
        invoke: f.invoke,
        discoverPlan: f.discoverPlan,
      }),
      null,
    );
  }
  const f = fixture();
  assert.equal(
    discoverPostmergeReuse(f.plan, {
      event: "push",
      discoverPlan: f.discoverPlan,
      invoke: (c, args, b) =>
        c === "git" && args[0] === "rev-parse" && args[1].startsWith(sha("c"))
          ? sha("e")
          : f.invoke(c, args, b),
    }),
    null,
  );
  for (const file of [
    "scripts/tool.mjs",
    "apps/desktop/src/New.test.ts",
    "apps/desktop/public/inject.html",
    "vite.config.ts",
    "apps/desktop/src/transport-shared.generated.json",
    "apps/desktop/src-tauri/src/lib.rs",
  ]) {
    const p = fixture().plan;
    p.changes[0].oldPath = file;
    p.changes[0].newPath = file;
    assert.equal(postmergeEligible(p), false);
  }
});
