import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  admitProductionController,
  admitReviewedInputsController,
} from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";

const source = Buffer.from("independently selected workflow fixture\n");
const policy = {
  schema_version: 1,
  mode: "admission-only",
  execution_ref: "refs/tags/portcove-production-controller-fixture",
  revision: "a".repeat(40),
  workflow_sha256: createHash("sha256").update(source).digest("hex"),
  actor_id: "123456",
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "boburning/portcove",
  GITHUB_REPOSITORY_ID: "1354613114",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/tags/portcove-production-controller-fixture",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_REF:
    "boburning/portcove/.github/workflows/application-update-production.yml@refs/tags/portcove-production-controller-fixture",
  GITHUB_ACTOR: "fixture-principal",
  GITHUB_ACTOR_ID: "123456",
  GITHUB_TRIGGERING_ACTOR: "fixture-principal",
  GITHUB_RUN_ID: "987654",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "admission",
  RUNNER_ENVIRONMENT: "github-hosted",
  PORTCOVE_CONTROLLER_REVISION: "a".repeat(40),
  PORTCOVE_CONTROLLER_REF: "refs/tags/portcove-production-controller-fixture",
};
const raw = JSON.stringify(policy);

void test("exact separately configured fixture admits only its source execution", () => {
  const result = admitProductionController(raw, environment, source);
  assert.equal(result.repository_id, "1354613114");
  assert.equal(result.repository, "boburning/portcove");
  assert.equal(result.workflow, ".github/workflows/application-update-production.yml");
  assert.equal(result.actor_id, "123456");
  assert.equal(result.run_id, "987654");
  assert.equal(result.run_attempt, 1);
  assert.equal(result.mode, "admission-only");
  assert.match(result.qualification, /no candidate acceptance/u);
  assert.equal("candidate" in result, false);
  assert.equal("signing" in result, false);
});

void test("policy is absent by default and cannot add candidate or privileged modes", () => {
  for (const candidate of [undefined, "", "null", "[]", "{", " ".repeat(4097)])
    assert.throws(() => admitProductionController(candidate, environment, source), /refused/u);
  const cases = [
    { ...policy, schema_version: 2 },
    { ...policy, mode: "publish" },
    { ...policy, candidate: { accepted: true } },
    { ...policy, actor_id: 123456 },
    { ...policy, actor_id: "0" },
    { ...policy, revision: "a".repeat(39) },
    { ...policy, workflow_sha256: "A".repeat(64) },
    { ...policy, execution_ref: "refs/heads/main" },
    { ...policy, execution_ref: "refs/tags/portcove-controller-canary-20261010" },
    { ...policy, execution_ref: "refs/tags/portcove-production-controller-a/../../main" },
  ];
  for (const candidate of cases)
    assert.throws(
      () => admitProductionController(JSON.stringify(candidate), environment, source),
      /policy schema/u,
    );
  for (const key of Object.keys(policy)) {
    const missing: Record<string, unknown> = { ...policy };
    delete missing[key];
    assert.throws(() => admitProductionController(JSON.stringify(missing), environment, source));
  }
});

void test("every execution identity is required and mismatches refuse", () => {
  for (const key of Object.keys(environment)) {
    assert.throws(
      () => admitProductionController(raw, { ...environment, [key]: undefined }, source),
      /refused/u,
      `missing ${key}`,
    );
    assert.throws(
      () => admitProductionController(raw, { ...environment, [key]: "different" }, source),
      /refused/u,
      `changed ${key}`,
    );
  }
});

void test("main, same-name branch, fork, reusable identity and rerun never inherit admission", () => {
  for (const delta of [
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/heads/portcove-production-controller-fixture", GITHUB_REF_TYPE: "branch" },
    { GITHUB_REF: "refs/pull/7/merge", GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REPOSITORY_ID: "100", GITHUB_REPOSITORY: "another/portcove" },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/caller.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_TRIGGERING_ACTOR: "other-principal" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
  ])
    assert.throws(() => admitProductionController(raw, { ...environment, ...delta }, source));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537), Buffer.from("changed source")])
    assert.throws(
      () => admitProductionController(raw, environment, bytes),
      /source byte identity/u,
    );
});

const workflow = await readFile(
  new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  "utf8",
);

void test("inactive workflow enforces bootstrap identities before checkout without a candidate lane", () => {
  const marker = "      - uses: actions/checkout@";
  const before = workflow.slice(0, workflow.indexOf(marker));
  const script = before.split("        run: |\n")[1]?.replaceAll(/^ {10}/gmu, "");
  assert.ok(script, "bootstrap script must precede checkout");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const execute = (delta: Record<string, string | undefined>) =>
    execFileSync(bash, ["-c", script], {
      env: { ...process.env, ...environment, PORTCOVE_CONTROLLER_ADMISSION: raw, ...delta },
      windowsHide: true,
      timeout: 5000,
      stdio: "pipe",
    });
  execute({});
  for (const delta of [
    { PORTCOVE_CONTROLLER_REVISION: undefined },
    { PORTCOVE_CONTROLLER_REF: "refs/heads/main" },
    { PORTCOVE_CONTROLLER_ADMISSION: "" },
    { GITHUB_REPOSITORY_ID: "100" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REF: "refs/heads/portcove-production-controller-fixture" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/caller.yml@refs/heads/main" },
    { GITHUB_RUN_ATTEMPT: "2" },
  ])
    assert.throws(() => execute(delta));
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /timeout-minutes: 5/u);
  assert.match(workflow, /run: node scripts\/production-controller-admission\.mts/u);
  assert.doesNotMatch(
    workflow,
    /^\s*(?:environment|secrets|inputs|schedule|push|pull_request|workflow_call|cache):|: write|pnpm |npm |uses: \.\//mu,
  );
});

void test("CLI runs with only fixed source files and no installed dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-controller-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  for (const file of [
    "production-controller-admission.mts",
    "runtime-values.mts",
    "release-control-phases.mts",
  ])
    await copyFile(new URL(file, import.meta.url), path.join(root, "scripts", file));
  await writeFile(path.join(root, ".github/workflows/application-update-production.yml"), source);
  const command = path.join(root, "scripts/production-controller-admission.mts");
  const invoke = (extra: string[], delta: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [command, ...extra], {
      cwd: root,
      env: { ...process.env, ...environment, PORTCOVE_CONTROLLER_ADMISSION: raw, ...delta },
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    });
  const result: unknown = JSON.parse(invoke([], {}));
  assert.ok(isRecord(result));
  assert.equal(result.run_id, "987654");
  assert.throws(() => invoke([], { PORTCOVE_CONTROLLER_ADMISSION: "" }), /missing or oversized/u);
  assert.throws(() => invoke(["candidate.json"], {}), /no candidate or policy path/u);
  await writeFile(
    path.join(root, ".github/workflows/application-update-production.yml"),
    "changed",
  );
  assert.throws(() => invoke([], {}), /source byte identity/u);
  await writeFile(
    path.join(root, ".github/workflows/application-update-production.yml"),
    Buffer.alloc(65537),
  );
  assert.throws(() => invoke([], {}), /source byte identity/u);
});

void test("reviewed inputs source admission pins its own fixed workflow and rejects production cross-use", () => {
  const env = {
    ...environment,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release-reviewed-inputs.yml@${policy.execution_ref}`,
  };
  assert.equal(
    admitReviewedInputsController(raw, env, source).workflow,
    ".github/workflows/release-reviewed-inputs.yml",
  );
  assert.throws(() => admitProductionController(raw, env, source));
  assert.throws(() => admitReviewedInputsController(raw, environment, source));
});
