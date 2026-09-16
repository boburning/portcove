import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  projectRuleset,
  repositoryApplyPlan,
  repositorySettingsMigration,
  rulesetMigration,
  validateRepositorySettings,
} from "./repository-settings.mjs";

const ruleset = JSON.parse(
  await readFile(new URL("../.github/repository-ruleset.json", import.meta.url)),
);
const security = JSON.parse(
  await readFile(new URL("../.github/repository-security.json", import.meta.url)),
);

test("checked-in repository settings enforce the exact main contract", () => {
  assert.doesNotThrow(() => validateRepositorySettings(ruleset, security));
  assert.deepEqual(projectRuleset({ id: 42, ...ruleset }), ruleset);
});

test("repository settings require standardized merge commits without narrowing merge methods", () => {
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
  narrowedMethods.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.allowed_merge_methods = ["merge"];
  assert.throws(
    () => validateRepositorySettings(narrowedMethods, security),
    /preserve merge, squash and rebase/,
  );
});

test("validation rejects approval gates, unresolved threads, or weakened status requirements", () => {
  const addedApproval = structuredClone(ruleset);
  addedApproval.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.required_approving_review_count = 1;
  assert.throws(() => validateRepositorySettings(addedApproval, security), /zero approvals/);

  const lastPushApproval = structuredClone(ruleset);
  lastPushApproval.rules.find(
    (rule) => rule.type === "pull_request",
  ).parameters.require_last_push_approval = true;
  assert.throws(() => validateRepositorySettings(lastPushApproval, security), /zero approvals/);

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
  assert.throws(() => validateRepositorySettings(missingCheck, security), /required status checks/);

  const strictChecks = structuredClone(ruleset);
  strictChecks.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.strict_required_status_checks_policy = true;
  assert.throws(
    () => validateRepositorySettings(strictChecks, security),
    /allow independently reviewed behind-main heads/,
  );

  const enforceOnCreate = structuredClone(ruleset);
  enforceOnCreate.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.do_not_enforce_on_create = false;
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
  widenedAdminBypass.bypass_actors[0].bypass_mode = "always";
  assert.throws(
    () => validateRepositorySettings(widenedAdminBypass, security),
    /repository-admin bypass/,
  );
});

test("bounded migration changes only status-check strictness and is idempotent", () => {
  const old = structuredClone(ruleset);
  old.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.strict_required_status_checks_policy = true;
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
  ]) {
    const reviewDrift = structuredClone(old);
    reviewDrift.rules.find((rule) => rule.type === "pull_request").parameters[name] = value;
    assert.throws(() => rulesetMigration(reviewDrift, ruleset), /out-of-scope drift/);
  }

  const drifted = structuredClone(old);
  drifted.rules
    .find((rule) => rule.type === "required_status_checks")
    .parameters.required_status_checks.pop();
  assert.throws(() => rulesetMigration(drifted, ruleset), /out-of-scope drift/);

  const statusPolicyDrift = structuredClone(old);
  statusPolicyDrift.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.do_not_enforce_on_create = false;
  assert.throws(() => rulesetMigration(statusPolicyDrift, ruleset), /out-of-scope drift/);

  const futureParameter = structuredClone(old);
  futureParameter.rules.find((rule) => rule.type === "pull_request").parameters.future_review_gate =
    true;
  assert.throws(() => rulesetMigration(futureParameter, ruleset), /unexpected parameters/);

  const futureStatusParameter = structuredClone(old);
  futureStatusParameter.rules.find(
    (rule) => rule.type === "required_status_checks",
  ).parameters.future_status_gate = true;
  assert.throws(() => rulesetMigration(futureStatusParameter, ruleset), /unexpected parameters/);
  assert.throws(() => rulesetMigration(null, ruleset), /refusing to create/);
});

test("each active worker contract requires delegated independent review", async () => {
  const files = [
    new URL("../AGENTS.md", import.meta.url),
    new URL("../CONTRIBUTING.md", import.meta.url),
    new URL("../docs/PROJECT-GOVERNANCE.md", import.meta.url),
    new URL("../docs/QUALITY.md", import.meta.url),
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
  ];

  for (const file of files) {
    const guidance = await readFile(file, "utf8");
    assert.match(guidance, /separate\s+non-writing\s+reviewer(?:-|\s+)subagent/iu, file.pathname);
    assert.doesNotMatch(
      guidance,
      /does not inherently require (?:a human or )?(?:a )?second agent/iu,
      file.pathname,
    );
  }
});

test("active worker guidance keeps behind-main merges head-guarded and evidence-bounded", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const contributing = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
  const quality = await readFile(new URL("../docs/QUALITY.md", import.meta.url), "utf8");
  const conventions = await readFile(
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    "utf8",
  );
  const guidance = [agents, contributing, quality, conventions].join("\n");

  assert.match(guidance, /behind-main (?:merge|pull request)/u);
  assert.match(conventions, /just pr-merge-rest --pr <number-or-url> --head <reviewed-head>/u);
  assert.match(guidance, /failed or missing check/u);
  assert.match(guidance, /conflict/u);
  assert.match(guidance, /changed source head/u);
  assert.match(quality, /target\s+advance alone does not invalidate an unchanged patch/u);
  assert.match(guidance, /dependencies, schemas, generated contracts/u);
  assert.doesNotMatch(guidance, /gh pr merge --auto --match-head-commit/u);
});

test("active validation guidance describes the selected hosted plan accurately", async () => {
  const guidance = (
    await Promise.all(
      [
        new URL("../AGENTS.md", import.meta.url),
        new URL("../CONTRIBUTING.md", import.meta.url),
        new URL("../docs/DEVELOPMENT-TOOLS.md", import.meta.url),
        new URL("../docs/QUALITY.md", import.meta.url),
        new URL("../docs/REPOSITORY-SETTINGS.md", import.meta.url),
        new URL("../justfile", import.meta.url),
        new URL("./local-validation.mjs", import.meta.url),
      ].map((file) => readFile(file, "utf8")),
    )
  ).join("\n");

  assert.match(guidance, /complete selected hosted plan/u);
  assert.doesNotMatch(guidance, /(?:ordinary )?exhaustive merge gate/iu);
  assert.doesNotMatch(guidance, /runs its exhaustive cross-platform plan/iu);
  assert.doesNotMatch(
    guidance,
    /Required CI executes those contracts independently on every exact pull-request head/iu,
  );
});

test("application plan preserves stable identity and scopes repository changes", () => {
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

test("repository setting migration is exact, idempotent and rejects an expanded desired contract", () => {
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

test("production automation has no routine administrator merge path", async () => {
  const scriptRoot = new URL("./", import.meta.url);
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  const files = [
    ...(await readdir(scriptRoot))
      .filter((name) => /\.(?:mjs|ps1|sh)$/.test(name) && !name.endsWith(".test.mjs"))
      .map((name) => new URL(name, scriptRoot)),
    ...(await readdir(workflowRoot))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => new URL(name, workflowRoot)),
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(combined, /gh\s+pr\s+merge[^\n]*--admin|--admin[^\n]*gh\s+pr\s+merge/i);
});
