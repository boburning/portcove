import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rulesetPath = path.join(projectRoot, ".github", "repository-ruleset.json");
const securityPath = path.join(projectRoot, ".github", "repository-security.json");
const expectedChecks = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const repositorySettingNames = ["allow_auto_merge", "merge_commit_title", "merge_commit_message"];
const expectedBypassActors = [
  {
    actor_id: 5,
    actor_type: "RepositoryRole",
    bypass_mode: "pull_request",
  },
];

function requiredRule(ruleset, type) {
  const matches = ruleset.rules.filter((rule) => rule.type === type);
  if (matches.length !== 1) throw new Error(`ruleset must contain exactly one ${type} rule`);
  return matches[0];
}

export function validateRepositorySettings(ruleset, security) {
  assertExactKeys(
    security,
    ["schema_version", "repository", "private_vulnerability_reporting", ...repositorySettingNames],
    "repository security configuration",
  );
  if (security.schema_version !== 2)
    throw new Error("repository security schema_version must be 2");
  if (!security.repository?.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) {
    throw new Error("repository security configuration has an invalid repository");
  }
  if (security.private_vulnerability_reporting !== true) {
    throw new Error("private vulnerability reporting must be enabled");
  }
  if (security.allow_auto_merge !== true) {
    throw new Error("repository auto-merge capability must be enabled");
  }
  if (security.merge_commit_title !== "PR_TITLE" || security.merge_commit_message !== "BLANK") {
    throw new Error("merge commits must use the pull request title with a blank generated body");
  }
  if (ruleset.name !== "Protect main" || ruleset.target !== "branch") {
    throw new Error("ruleset must target branches under the stable Protect main name");
  }
  if (ruleset.enforcement !== "active") throw new Error("ruleset enforcement must be active");
  if (JSON.stringify(ruleset.bypass_actors) !== JSON.stringify(expectedBypassActors)) {
    throw new Error("main protection must define only the pull-request repository-admin bypass");
  }
  const refs = ruleset.conditions?.ref_name;
  if (
    JSON.stringify(refs?.include) !== JSON.stringify(["refs/heads/main"]) ||
    refs?.exclude?.length
  ) {
    throw new Error("ruleset must include only refs/heads/main");
  }
  requiredRule(ruleset, "deletion");
  requiredRule(ruleset, "non_fast_forward");
  const pullRequest = requiredRule(ruleset, "pull_request").parameters;
  if (
    JSON.stringify(pullRequest.allowed_merge_methods) !==
      JSON.stringify(["merge", "squash", "rebase"]) ||
    pullRequest.required_approving_review_count !== 0 ||
    !pullRequest.dismiss_stale_reviews_on_push ||
    pullRequest.require_last_push_approval ||
    pullRequest.require_code_owner_review ||
    pullRequest.require_extra_approval_for_unattributed_changes !== true ||
    !pullRequest.required_review_thread_resolution
  ) {
    throw new Error(
      "pull requests must preserve merge, squash and rebase plus zero approvals, no last-push or CODEOWNERS approval, and resolved review threads",
    );
  }
  const statusChecks = requiredRule(ruleset, "required_status_checks").parameters;
  const contexts = statusChecks.required_status_checks.map((check) => check.context).sort();
  if (
    JSON.stringify(contexts) !== JSON.stringify(expectedChecks) ||
    !statusChecks.strict_required_status_checks_policy ||
    !statusChecks.do_not_enforce_on_create
  ) {
    throw new Error(`required status checks must be exactly: ${expectedChecks.join(", ")}`);
  }
}

export function projectRuleset(ruleset) {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    rules: ruleset.rules.map((rule) => {
      if (rule.type === "pull_request") {
        return {
          type: rule.type,
          parameters: {
            allowed_merge_methods: rule.parameters.allowed_merge_methods,
            dismiss_stale_reviews_on_push: rule.parameters.dismiss_stale_reviews_on_push,
            require_code_owner_review: rule.parameters.require_code_owner_review,
            require_extra_approval_for_unattributed_changes:
              rule.parameters.require_extra_approval_for_unattributed_changes,
            require_last_push_approval: rule.parameters.require_last_push_approval,
            required_approving_review_count: rule.parameters.required_approving_review_count,
            required_reviewers: rule.parameters.required_reviewers ?? [],
            required_review_thread_resolution: rule.parameters.required_review_thread_resolution,
          },
        };
      }
      if (rule.type === "required_status_checks") {
        return {
          type: rule.type,
          parameters: {
            do_not_enforce_on_create: rule.parameters.do_not_enforce_on_create,
            required_status_checks: rule.parameters.required_status_checks.map((check) => ({
              context: check.context,
              ...(Number.isInteger(check.integration_id)
                ? { integration_id: check.integration_id }
                : {}),
            })),
            strict_required_status_checks_policy:
              rule.parameters.strict_required_status_checks_policy,
          },
        };
      }
      return { type: rule.type };
    }),
  };
}

const authorizedReviewChanges = [
  "required_approving_review_count",
  "require_last_push_approval",
  "require_code_owner_review",
];

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(`${label} has unexpected parameters; refusing the bounded migration`);
  }
}

export function rulesetMigration(actualRuleset, desiredRuleset) {
  if (!actualRuleset)
    throw new Error(
      "Protect main ruleset is not configured; refusing to create replacement protection",
    );
  const actualPullRequestRule = requiredRule(actualRuleset, "pull_request");
  const desiredPullRequestRule = requiredRule(desiredRuleset, "pull_request");
  assertExactKeys(
    actualPullRequestRule.parameters,
    Object.keys(desiredPullRequestRule.parameters),
    "Protect main pull-request rule",
  );
  const actualStatusRule = requiredRule(actualRuleset, "required_status_checks");
  const desiredStatusRule = requiredRule(desiredRuleset, "required_status_checks");
  assertExactKeys(
    actualStatusRule.parameters,
    Object.keys(desiredStatusRule.parameters),
    "Protect main status-check rule",
  );
  for (const check of actualStatusRule.parameters.required_status_checks ?? []) {
    const keys = Number.isInteger(check.integration_id)
      ? ["context", "integration_id"]
      : ["context"];
    assertExactKeys(check, keys, `Protect main status check ${check.context ?? "<unnamed>"}`);
  }
  const payload = projectRuleset(actualRuleset);
  const actualPullRequest = requiredRule(payload, "pull_request").parameters;
  const desiredPullRequest = requiredRule(desiredRuleset, "pull_request").parameters;
  const changes = [];
  for (const name of authorizedReviewChanges) {
    if (actualPullRequest[name] !== desiredPullRequest[name]) {
      changes.push({
        path: `pull_request.${name}`,
        from: actualPullRequest[name],
        to: desiredPullRequest[name],
      });
      actualPullRequest[name] = desiredPullRequest[name];
    }
  }
  if (!isDeepStrictEqual(payload, desiredRuleset)) {
    throw new Error(
      "Protect main has unexpected out-of-scope drift; refusing the bounded migration",
    );
  }
  return { payload, changes };
}

export function repositoryApplyPlan({
  rulesets,
  actualRuleset,
  securityStatus,
  repositoryStatus,
  desiredRuleset,
  desiredRepository,
}) {
  const existing = rulesets.find(
    (ruleset) => ruleset.name === desiredRuleset.name && ruleset.target === desiredRuleset.target,
  );
  if (!existing)
    throw new Error(
      "Protect main ruleset is not configured; refusing to create replacement protection",
    );
  if (actualRuleset?.id !== undefined && actualRuleset.id !== existing.id) {
    throw new Error(
      "Protect main ruleset identity changed during inspection; refusing the bounded migration",
    );
  }
  const migration = rulesetMigration(actualRuleset, desiredRuleset);
  const repository = repositorySettingsMigration(repositoryStatus, desiredRepository);
  return {
    rulesetEndpoint: `rulesets/${existing.id}`,
    rulesetPayload: migration.payload,
    rulesetChanges: migration.changes,
    enablePrivateReporting: securityStatus.enabled !== true,
    repositoryChanges: repository.changes,
    repositoryPayload: repository.payload,
  };
}

export function repositorySettingsMigration(actual, desired) {
  assertExactKeys(desired, repositorySettingNames, "desired repository settings");
  const changes = repositorySettingNames
    .filter((name) => actual[name] !== desired[name])
    .map((name) => ({ path: name, from: actual[name], to: desired[name] }));
  return {
    changes,
    payload: Object.fromEntries(changes.map((change) => [change.path, change.to])),
  };
}

function gh(repo, args, input) {
  const endpoint = args.endpoint ? `repos/${repo}/${args.endpoint}` : `repos/${repo}`;
  const command = ["api", endpoint, "--method", args.method];
  if (input !== undefined) command.push("--input", "-");
  const result = spawnSync("gh", command, {
    cwd: projectRoot,
    encoding: "utf8",
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `gh api failed with exit ${result.status}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function loadDesired() {
  const [ruleset, security] = await Promise.all([
    readFile(rulesetPath, "utf8").then(JSON.parse),
    readFile(securityPath, "utf8").then(JSON.parse),
  ]);
  validateRepositorySettings(ruleset, security);
  return { ruleset, security };
}

async function main(argv) {
  const mode = argv[0] ?? "--validate";
  if (!["--validate", "--plan", "--check", "--apply"].includes(mode) || argv.length > 1) {
    throw new Error(
      "usage: node scripts/repository-settings.mjs [--validate|--plan|--check|--apply]",
    );
  }
  const { ruleset, security } = await loadDesired();
  if (mode === "--validate") {
    console.log("Repository settings artifacts are valid.");
    return;
  }
  const repo = security.repository;
  const desiredRepository = Object.fromEntries(
    repositorySettingNames.map((name) => [name, security[name]]),
  );
  let summaries = gh(repo, { endpoint: "rulesets", method: "GET" });
  let securityStatus = gh(repo, {
    endpoint: "private-vulnerability-reporting",
    method: "GET",
  });
  let repositoryStatus = gh(repo, { endpoint: "", method: "GET" });
  let summary = summaries.find(
    (item) => item.name === ruleset.name && item.target === ruleset.target,
  );
  if (!summary) throw new Error("Protect main ruleset is not configured");
  let actual = gh(repo, { endpoint: `rulesets/${summary.id}`, method: "GET" });
  const plan = repositoryApplyPlan({
    rulesets: summaries,
    actualRuleset: actual,
    securityStatus,
    repositoryStatus,
    desiredRuleset: ruleset,
    desiredRepository,
  });
  if (mode === "--plan") {
    console.log(
      JSON.stringify(
        {
          ruleset: plan.rulesetChanges,
          repository: plan.repositoryChanges,
          privateVulnerabilityReporting: plan.enablePrivateReporting
            ? [
                {
                  path: "private_vulnerability_reporting",
                  from: false,
                  to: true,
                },
              ]
            : [],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "--apply") {
    if (plan.rulesetChanges.length) {
      gh(repo, { endpoint: plan.rulesetEndpoint, method: "PUT" }, plan.rulesetPayload);
    }
    if (plan.repositoryChanges.length) {
      gh(repo, { endpoint: "", method: "PATCH" }, plan.repositoryPayload);
    }
    if (plan.enablePrivateReporting) {
      gh(repo, { endpoint: "private-vulnerability-reporting", method: "PUT" });
    }
    summaries = gh(repo, { endpoint: "rulesets", method: "GET" });
    securityStatus = gh(repo, {
      endpoint: "private-vulnerability-reporting",
      method: "GET",
    });
    repositoryStatus = gh(repo, { endpoint: "", method: "GET" });
    summary = summaries.find(
      (item) => item.name === ruleset.name && item.target === ruleset.target,
    );
    if (!summary) throw new Error("Protect main ruleset disappeared during application");
    actual = gh(repo, { endpoint: `rulesets/${summary.id}`, method: "GET" });
  }
  if (!isDeepStrictEqual(projectRuleset(actual), projectRuleset(ruleset))) {
    throw new Error("Protect main ruleset differs from .github/repository-ruleset.json");
  }
  if (securityStatus.enabled !== true)
    throw new Error("private vulnerability reporting is not enabled");
  const repositoryDrift = repositorySettingsMigration(repositoryStatus, desiredRepository).changes;
  if (repositoryDrift.length) {
    throw new Error(
      `repository settings differ from .github/repository-security.json: ${repositoryDrift.map((change) => change.path).join(", ")}`,
    );
  }
  console.log(`Repository settings match the checked-in contract for ${repo}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
