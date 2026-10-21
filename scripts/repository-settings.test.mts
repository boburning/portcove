import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ruleset from "../.github/repository-ruleset.json" with { type: "json" };
import security from "../.github/repository-security.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
function requiredFixture<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function parameters(value: unknown, type: string) {
  const rules = array(record(value).rules).map(record);
  return record(requiredFixture(rules.find((rule) => rule.type === type)).parameters);
}

import test from "node:test";

import {
  projectRuleset,
  repositoryApplyPlan,
  repositorySettingsMigration,
  rulesetMigration,
  validateRepositorySettings,
} from "./repository-settings.mts";

void test("repository-settings help does not read artifacts or contact GitHub", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-repository-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  for (const file of [
    "repository-settings.mts",
    "runtime-values.mts",
    "github-api.mts",
    "release-readonly-child-environment.mts",
    "release-coordinator-deadline.mts",
  ])
    copyFileSync(new URL(file, import.meta.url), path.join(root, "scripts", file));
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/repository-settings.mts"), "--help"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
      cwd: root,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/u);
  assert.match(result.stdout, /--plan.*JSON/u);
  assert.match(result.stdout, /explicit owner authorization/u);
  assert.match(result.stdout, /Example:/u);
  assert.equal(result.stderr, "");
  const invalid = spawnSync(
    process.execPath,
    [path.join(root, "scripts/repository-settings.mts"), "--help", "--apply"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
      cwd: root,
    },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/u);
  assert.doesNotMatch(invalid.stderr, /ENOENT/u);
});

void test("checked-in repository settings enforce the exact main contract", () => {
  assert.doesNotThrow(() => validateRepositorySettings(ruleset, security));
  assert.deepEqual(projectRuleset({ id: 42, ...ruleset }), ruleset);
});

void test("repository settings require standardized merge commits without narrowing merge methods", () => {
  const classicMergeTitle = structuredClone(security);
  classicMergeTitle.merge_commit_title = "MERGE_MESSAGE";
  assert.throws(() => validateRepositorySettings(ruleset, classicMergeTitle), /pull request title/);

  const repeatedMergeBody = structuredClone(security);
  repeatedMergeBody.merge_commit_message = "PR_TITLE";
  assert.throws(
    () => validateRepositorySettings(ruleset, repeatedMergeBody),
    /blank generated body/,
  );

  const narrowedMethods = structuredClone(ruleset);
  parameters(narrowedMethods, "pull_request").allowed_merge_methods = ["merge"];
  assert.throws(
    () => validateRepositorySettings(narrowedMethods, security),
    /preserve merge, squash and rebase/,
  );
});

void test("validation rejects approval gates, unresolved threads, or weakened status requirements", () => {
  const addedApproval = structuredClone(ruleset);
  parameters(addedApproval, "pull_request").required_approving_review_count = 1;
  assert.throws(() => validateRepositorySettings(addedApproval, security), /zero approvals/);

  const lastPushApproval = structuredClone(ruleset);
  parameters(lastPushApproval, "pull_request").require_last_push_approval = true;
  assert.throws(() => validateRepositorySettings(lastPushApproval, security), /zero approvals/);

  const unresolvedThreads = structuredClone(ruleset);
  parameters(unresolvedThreads, "pull_request").required_review_thread_resolution = false;
  assert.throws(
    () => validateRepositorySettings(unresolvedThreads, security),
    /resolved review threads/,
  );

  const missingCheck = structuredClone(ruleset);
  array(parameters(missingCheck, "required_status_checks").required_status_checks).pop();
  assert.throws(() => validateRepositorySettings(missingCheck, security), /required status checks/);

  const strictChecks = structuredClone(ruleset);
  parameters(strictChecks, "required_status_checks").strict_required_status_checks_policy = true;
  assert.throws(
    () => validateRepositorySettings(strictChecks, security),
    /allow independently reviewed behind-main heads/,
  );

  const enforceOnCreate = structuredClone(ruleset);
  parameters(enforceOnCreate, "required_status_checks").do_not_enforce_on_create = false;
  assert.throws(
    () => validateRepositorySettings(enforceOnCreate, security),
    /required status checks/,
  );

  const missingAdminBypass = structuredClone(ruleset);
  missingAdminBypass.bypass_actors = [];
  assert.throws(
    () => validateRepositorySettings(missingAdminBypass, security),
    /repository-admin bypass/,
  );

  const widenedAdminBypass = structuredClone(ruleset);
  requiredFixture(widenedAdminBypass.bypass_actors[0]).bypass_mode = "always";
  assert.throws(
    () => validateRepositorySettings(widenedAdminBypass, security),
    /repository-admin bypass/,
  );
});

void test("bounded migration changes only status-check strictness and is idempotent", () => {
  const old = structuredClone(ruleset);
  parameters(old, "required_status_checks").strict_required_status_checks_policy = true;
  const migration = rulesetMigration(old, ruleset);
  assert.deepEqual(migration.payload, ruleset);
  assert.deepEqual(
    migration.changes.map((change) => change.path),
    ["required_status_checks.strict_required_status_checks_policy"],
  );
  assert.deepEqual(migration.changes.at(-1), {
    path: "required_status_checks.strict_required_status_checks_policy",
    from: true,
    to: false,
  });
  assert.deepEqual(rulesetMigration(ruleset, ruleset).changes, []);

  for (const [name, value] of [
    ["required_approving_review_count", 1],
    ["require_last_push_approval", true],
    ["require_code_owner_review", true],
  ] as const) {
    const reviewDrift = structuredClone(old);
    parameters(reviewDrift, "pull_request")[name] = value;
    assert.throws(() => rulesetMigration(reviewDrift, ruleset), /out-of-scope drift/);
  }

  const drifted = structuredClone(old);
  array(parameters(drifted, "required_status_checks").required_status_checks).pop();
  assert.throws(() => rulesetMigration(drifted, ruleset), /out-of-scope drift/);

  const statusPolicyDrift = structuredClone(old);
  parameters(statusPolicyDrift, "required_status_checks").do_not_enforce_on_create = false;
  assert.throws(() => rulesetMigration(statusPolicyDrift, ruleset), /out-of-scope drift/);

  const futureParameter = structuredClone(old);
  parameters(futureParameter, "pull_request").future_review_gate = true;
  assert.throws(() => rulesetMigration(futureParameter, ruleset), /unexpected parameters/);

  const futureStatusParameter = structuredClone(old);
  parameters(futureStatusParameter, "required_status_checks").future_status_gate = true;
  assert.throws(() => rulesetMigration(futureStatusParameter, ruleset), /unexpected parameters/);
  assert.throws(() => rulesetMigration(null, ruleset), /refusing to create/);
});

void test("canonical owners declare required review, hosted baseline and guarded merge", async () => {
  const root = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const conventions = await readFile(
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    "utf8",
  );
  assert.match(root, /QUALITY\.md#required-hosted-baseline/u);
  assert.match(root, /CONTRIBUTION-CONVENTIONS\.md#review-and-merge/u);
  assert.match(conventions, /just pr-merge-rest --pr <number-or-url> --head <reviewed-head>/u);
});

void test("application plan preserves stable identity and scopes repository changes", () => {
  const summaries = [{ id: 99, name: "Protect main", target: "branch" }];
  const desiredRepository = {
    allow_auto_merge: security.allow_auto_merge,
    merge_commit_title: security.merge_commit_title,
    merge_commit_message: security.merge_commit_message,
  };
  const plan = repositoryApplyPlan({
    rulesets: summaries,
    actualRuleset: ruleset,
    securityStatus: { enabled: true },
    repositoryStatus: {
      allow_auto_merge: false,
      merge_commit_title: "MERGE_MESSAGE",
      merge_commit_message: "PR_TITLE",
    },
    desiredRuleset: ruleset,
    desiredRepository,
  });
  assert.equal(plan.rulesetEndpoint, "rulesets/99");
  assert.deepEqual(plan.rulesetChanges, []);
  assert.equal(plan.enablePrivateReporting, false);
  assert.deepEqual(
    plan.repositoryChanges.map((change) => change.path),
    ["allow_auto_merge", "merge_commit_title", "merge_commit_message"],
  );
  assert.deepEqual(plan.repositoryPayload, desiredRepository);
  assert.throws(
    () =>
      repositoryApplyPlan({
        rulesets: [],
        actualRuleset: null,
        securityStatus: { enabled: true },
        repositoryStatus: desiredRepository,
        desiredRuleset: ruleset,
        desiredRepository,
      }),
    /refusing to create/,
  );
});

void test("repository setting migration is exact, idempotent and rejects an expanded desired contract", () => {
  const desired = {
    allow_auto_merge: true,
    merge_commit_title: "PR_TITLE",
    merge_commit_message: "BLANK",
  };
  const current = {
    allow_auto_merge: true,
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
    unrelated_live_setting: true,
  };
  assert.deepEqual(repositorySettingsMigration(current, desired), {
    changes: [
      { path: "merge_commit_title", from: "MERGE_MESSAGE", to: "PR_TITLE" },
      { path: "merge_commit_message", from: "PR_TITLE", to: "BLANK" },
    ],
    payload: { merge_commit_title: "PR_TITLE", merge_commit_message: "BLANK" },
  });
  assert.deepEqual(repositorySettingsMigration({ ...current, ...desired }, desired), {
    changes: [],
    payload: {},
  });
  assert.throws(
    () =>
      repositorySettingsMigration(current, {
        ...desired,
        future_setting: true,
      }),
    /unexpected parameters/,
  );
});

void test("production automation has no routine administrator merge path", async () => {
  const scriptRoot = new URL("./", import.meta.url);
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  const files = [
    ...(await readdir(scriptRoot))
      .filter(
        (name: string) =>
          /\.(?:[cm]?[jt]s|ps1|sh)$/.test(name) && !/\.test\.[cm]?[jt]s$/u.test(name),
      )
      .map((name) => new URL(name, scriptRoot)),
    ...(await readdir(workflowRoot))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => new URL(name, workflowRoot)),
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(combined, /gh\s+pr\s+merge[^\n]*--admin|--admin[^\n]*gh\s+pr\s+merge/i);
});

void test("ruleset validation rejects malformed exclusion collections", () => {
  for (const exclude of ["refs/heads/other", "", {}, null]) {
    const candidate = structuredClone(ruleset);
    record(candidate.conditions.ref_name).exclude = exclude;
    assert.throws(
      () => validateRepositorySettings(candidate, security),
      /include only refs\/heads\/main/,
    );
  }
});
