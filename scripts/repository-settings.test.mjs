import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  projectRuleset,
  repositoryApplyPlan,
  rulesetMigration,
  validateRepositorySettings,
} from "./repository-settings.mjs";

const ruleset = JSON.parse(
  await readFile(
    new URL("../.github/repository-ruleset.json", import.meta.url),
  ),
);
const security = JSON.parse(
  await readFile(
    new URL("../.github/repository-security.json", import.meta.url),
  ),
);

test("checked-in repository settings enforce the exact main contract", () => {
  assert.doesNotThrow(() => validateRepositorySettings(ruleset, security));
  assert.deepEqual(projectRuleset({ id: 42, ...ruleset }), ruleset);
});

test("validation rejects approval gates, unresolved threads, or weakened status requirements", () => {
  const addedApproval = structuredClone(ruleset);
  addedApproval.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.required_approving_review_count = 1;
  assert.throws(
    () => validateRepositorySettings(addedApproval, security),
    /zero approvals/,
  );

  const lastPushApproval = structuredClone(ruleset);
  lastPushApproval.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.require_last_push_approval = true;
  assert.throws(
    () => validateRepositorySettings(lastPushApproval, security),
    /zero approvals/,
  );

  const unresolvedThreads = structuredClone(ruleset);
  unresolvedThreads.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.required_review_thread_resolution = false;
  assert.throws(
    () => validateRepositorySettings(unresolvedThreads, security),
    /resolved review threads/,
  );

  const missingCheck = structuredClone(ruleset);
  missingCheck.rules
    .find((rule) => rule.type === "required_status_checks")
    .parameters.required_status_checks.pop();
  assert.throws(
    () => validateRepositorySettings(missingCheck, security),
    /required status checks/,
  );

  const missingAdminBypass = structuredClone(ruleset);
  missingAdminBypass.bypass_actors = [];
  assert.throws(
    () => validateRepositorySettings(missingAdminBypass, security),
    /repository-admin bypass/,
  );

  const widenedAdminBypass = structuredClone(ruleset);
  widenedAdminBypass.bypass_actors[0].bypass_mode = "always";
  assert.throws(
    () => validateRepositorySettings(widenedAdminBypass, security),
    /repository-admin bypass/,
  );
});

test("bounded migration changes only authorized review gates and is idempotent", () => {
  const old = structuredClone(ruleset);
  const pullRequest = old.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters;
  pullRequest.required_approving_review_count = 1;
  pullRequest.require_last_push_approval = true;
  const migration = rulesetMigration(old, ruleset);
  assert.deepEqual(migration.payload, ruleset);
  assert.deepEqual(
    migration.changes.map((change) => change.path),
    [
      "pull_request.required_approving_review_count",
      "pull_request.require_last_push_approval",
    ],
  );
  assert.deepEqual(rulesetMigration(ruleset, ruleset).changes, []);

  const drifted = structuredClone(old);
  drifted.rules
    .find((rule) => rule.type === "required_status_checks")
    .parameters.required_status_checks.pop();
  assert.throws(() => rulesetMigration(drifted, ruleset), /out-of-scope drift/);

  const futureParameter = structuredClone(old);
  futureParameter.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.future_review_gate = true;
  assert.throws(
    () => rulesetMigration(futureParameter, ruleset),
    /unexpected parameters/,
  );
  assert.throws(() => rulesetMigration(null, ruleset), /refusing to create/);
});

test("application plan preserves stable identity and scopes repository changes", () => {
  const summaries = [{ id: 99, name: "Protect main", target: "branch" }];
  const plan = repositoryApplyPlan({
    rulesets: summaries,
    actualRuleset: ruleset,
    securityStatus: { enabled: true },
    repositoryStatus: { allow_auto_merge: false },
    desiredRuleset: ruleset,
    desiredAutoMerge: true,
  });
  assert.equal(plan.rulesetEndpoint, "rulesets/99");
  assert.deepEqual(plan.rulesetChanges, []);
  assert.equal(plan.enablePrivateReporting, false);
  assert.equal(plan.enableAutoMerge, true);
  assert.throws(
    () =>
      repositoryApplyPlan({
        rulesets: [],
        actualRuleset: null,
        securityStatus: { enabled: true },
        repositoryStatus: { allow_auto_merge: true },
        desiredRuleset: ruleset,
        desiredAutoMerge: true,
      }),
    /refusing to create/,
  );
});

test("production automation has no routine administrator merge path", async () => {
  const scriptRoot = new URL("./", import.meta.url);
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  const files = [
    ...(await readdir(scriptRoot))
      .filter(
        (name) => /\.(?:mjs|ps1|sh)$/.test(name) && !name.endsWith(".test.mjs"),
      )
      .map((name) => new URL(name, scriptRoot)),
    ...(await readdir(workflowRoot))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => new URL(name, workflowRoot)),
  ];
  const combined = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");
  assert.doesNotMatch(
    combined,
    /gh\s+pr\s+merge[^\n]*--admin|--admin[^\n]*gh\s+pr\s+merge/i,
  );
});
