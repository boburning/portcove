import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

interface PullParameters extends Record<string, unknown> {
  allowed_merge_methods: string[];
  dismiss_stale_reviews_on_push: boolean;
  require_code_owner_review: boolean;
  require_last_push_approval: boolean;
  required_approving_review_count: number;
  require_extra_approval_for_unattributed_changes: boolean;
  required_review_thread_resolution: boolean;
  required_reviewers?: unknown[];
}
interface StatusCheck extends Record<string, unknown> {
  context: string;
  integration_id?: number | null;
}
interface StatusParameters extends Record<string, unknown> {
  required_status_checks: StatusCheck[];
  strict_required_status_checks_policy: boolean;
  do_not_enforce_on_create: boolean;
}
interface RawRule {
  type: string;
  parameters?: unknown;
}
function record(value: unknown, label = "repository settings"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function records(value: unknown, label = "repository settings"): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values: unknown[] = value;
  return values.map((item) => record(item, label));
}
function rules(value: unknown): RawRule[] {
  return records(record(value).rules, "ruleset rules").map((rule) => {
    if (typeof rule.type !== "string") throw new Error("ruleset rule type must be text");
    return { ...rule, type: rule.type };
  });
}
function pullParameters(value: unknown): PullParameters {
  function assertParameters(value: unknown): asserts value is PullParameters {
    const fields = record(value, "pull-request parameters");
    if (
      !Array.isArray(fields.allowed_merge_methods) ||
      !fields.allowed_merge_methods.every((item: unknown) => typeof item === "string") ||
      typeof fields.required_approving_review_count !== "number"
    )
      throw new Error("Malformed pull-request parameters");
    for (const key of [
      "dismiss_stale_reviews_on_push",
      "require_code_owner_review",
      "require_last_push_approval",
      "require_extra_approval_for_unattributed_changes",
      "required_review_thread_resolution",
    ])
      if (typeof fields[key] !== "boolean") throw new Error("Malformed pull-request parameters");
    if (fields.required_reviewers !== undefined && !Array.isArray(fields.required_reviewers))
      throw new Error("Malformed required reviewers");
  }
  assertParameters(value);
  return value;
}
function statusParameters(value: unknown): StatusParameters {
  function assertParameters(value: unknown): asserts value is StatusParameters {
    const fields = record(value, "status-check parameters");
    if (
      typeof fields.strict_required_status_checks_policy !== "boolean" ||
      typeof fields.do_not_enforce_on_create !== "boolean"
    )
      throw new Error("Malformed status-check parameters");
    for (const check of records(fields.required_status_checks, "required status checks")) {
      if (
        typeof check.context !== "string" ||
        (check.integration_id !== undefined &&
          check.integration_id !== null &&
          (typeof check.integration_id !== "number" || !Number.isInteger(check.integration_id)))
      )
        throw new Error("Malformed status-check identity");
    }
  }
  assertParameters(value);
  return value;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rulesetPath = path.join(projectRoot, ".github", "repository-ruleset.json");
const securityPath = path.join(projectRoot, ".github", "repository-security.json");
const expectedChecks = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const repositorySettingNames = [
  "allow_auto_merge",
  "merge_commit_title",
  "merge_commit_message",
] as const;
const expectedBypassActors = [
  {
    actor_id: 5,
    actor_type: "RepositoryRole",
    bypass_mode: "pull_request",
  },
];
const github = new GitHubApiClient(createGitHubRunner({ cwd: projectRoot }));

function requiredRule(ruleset: unknown, type: string) {
  const matches = rules(ruleset).filter((rule) => rule.type === type);
  if (matches.length !== 1) throw new Error(`ruleset must contain exactly one ${type} rule`);
  const match = matches[0];
  if (!match) throw new Error(`ruleset must contain exactly one ${type} rule`);
  return match;
}

export function validateRepositorySettings(rulesetValue: unknown, securityValue: unknown) {
  const ruleset = record(rulesetValue),
    security = record(securityValue);
  assertExactKeys(
    security,
    ["schema_version", "repository", "private_vulnerability_reporting", ...repositorySettingNames],
    "repository security configuration",
  );
  if (security.schema_version !== 2)
    throw new Error("repository security schema_version must be 2");
  if (
    typeof security.repository !== "string" ||
    !security.repository.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  ) {
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
  const refs =
    isRecord(ruleset.conditions) && isRecord(ruleset.conditions.ref_name)
      ? ruleset.conditions.ref_name
      : undefined;
  if (
    JSON.stringify(refs?.include) !== JSON.stringify(["refs/heads/main"]) ||
    (refs?.exclude !== undefined && (!Array.isArray(refs.exclude) || refs.exclude.length > 0))
  ) {
    throw new Error("ruleset must include only refs/heads/main");
  }
  requiredRule(ruleset, "deletion");
  requiredRule(ruleset, "non_fast_forward");
  const pullRequest = pullParameters(requiredRule(ruleset, "pull_request").parameters);
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
  const statusChecks = statusParameters(requiredRule(ruleset, "required_status_checks").parameters);
  const contexts = statusChecks.required_status_checks.map((check) => check.context).sort();
  if (
    JSON.stringify(contexts) !== JSON.stringify(expectedChecks) ||
    statusChecks.strict_required_status_checks_policy !== false ||
    !statusChecks.do_not_enforce_on_create
  ) {
    throw new Error(
      `required status checks must be exactly ${expectedChecks.join(", ")} and must allow independently reviewed behind-main heads`,
    );
  }
}

export function projectRuleset(value: unknown) {
  const ruleset = record(value);
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    rules: rules(ruleset).map((rule) => {
      if (rule.type === "pull_request") {
        const parameters = pullParameters(rule.parameters);
        return {
          type: rule.type,
          parameters: {
            allowed_merge_methods: parameters.allowed_merge_methods,
            dismiss_stale_reviews_on_push: parameters.dismiss_stale_reviews_on_push,
            require_code_owner_review: parameters.require_code_owner_review,
            require_extra_approval_for_unattributed_changes:
              parameters.require_extra_approval_for_unattributed_changes,
            require_last_push_approval: parameters.require_last_push_approval,
            required_approving_review_count: parameters.required_approving_review_count,
            required_reviewers: parameters.required_reviewers ?? [],
            required_review_thread_resolution: parameters.required_review_thread_resolution,
          },
        };
      }
      if (rule.type === "required_status_checks") {
        const parameters = statusParameters(rule.parameters);
        return {
          type: rule.type,
          parameters: {
            do_not_enforce_on_create: parameters.do_not_enforce_on_create,
            required_status_checks: parameters.required_status_checks.map((check) => ({
              context: check.context,
              ...(Number.isInteger(check.integration_id)
                ? { integration_id: check.integration_id }
                : {}),
            })),
            strict_required_status_checks_policy: parameters.strict_required_status_checks_policy,
          },
        };
      }
      return { type: rule.type };
    }),
  };
}

const authorizedStatusCheckChanges = ["strict_required_status_checks_policy"] as const;

function assertExactKeys(value: unknown, expected: readonly string[], label: string) {
  const actual = Object.keys(record(value ?? {}, label)).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(`${label} has unexpected parameters; refusing the bounded migration`);
  }
}

export function rulesetMigration(actualRuleset: unknown, desiredRuleset: unknown) {
  if (!actualRuleset)
    throw new Error(
      "Protect main ruleset is not configured; refusing to create replacement protection",
    );
  const actualPullRequestRule = requiredRule(actualRuleset, "pull_request");
  const desiredPullRequestRule = requiredRule(desiredRuleset, "pull_request");
  assertExactKeys(
    actualPullRequestRule.parameters,
    Object.keys(record(desiredPullRequestRule.parameters)),
    "Protect main pull-request rule",
  );
  const actualStatusRule = requiredRule(actualRuleset, "required_status_checks");
  const desiredStatusRule = requiredRule(desiredRuleset, "required_status_checks");
  assertExactKeys(
    actualStatusRule.parameters,
    Object.keys(record(desiredStatusRule.parameters)),
    "Protect main status-check rule",
  );
  for (const check of statusParameters(actualStatusRule.parameters).required_status_checks) {
    const keys = Number.isInteger(check.integration_id)
      ? ["context", "integration_id"]
      : ["context"];
    assertExactKeys(check, keys, `Protect main status check ${check.context ?? "<unnamed>"}`);
  }
  const payload = projectRuleset(actualRuleset);
  const actualStatusChecks = statusParameters(
    requiredRule(payload, "required_status_checks").parameters,
  );
  const desiredStatusChecks = statusParameters(
    requiredRule(desiredRuleset, "required_status_checks").parameters,
  );
  const changes = [];
  for (const name of authorizedStatusCheckChanges) {
    if (actualStatusChecks[name] !== desiredStatusChecks[name]) {
      changes.push({
        path: `required_status_checks.${name}`,
        from: actualStatusChecks[name],
        to: desiredStatusChecks[name],
      });
      actualStatusChecks[name] = desiredStatusChecks[name];
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
}: {
  rulesets: unknown;
  actualRuleset: unknown;
  securityStatus: unknown;
  repositoryStatus: unknown;
  desiredRuleset: unknown;
  desiredRepository: unknown;
}) {
  const desired = record(desiredRuleset);
  const existing = records(rulesets, "ruleset summaries").find(
    (ruleset) => ruleset.name === desired.name && ruleset.target === desired.target,
  );
  if (!existing)
    throw new Error(
      "Protect main ruleset is not configured; refusing to create replacement protection",
    );
  if (
    isRecord(actualRuleset) &&
    actualRuleset.id !== undefined &&
    actualRuleset.id !== existing.id
  ) {
    throw new Error(
      "Protect main ruleset identity changed during inspection; refusing the bounded migration",
    );
  }
  const migration = rulesetMigration(actualRuleset, desiredRuleset);
  const repository = repositorySettingsMigration(repositoryStatus, desiredRepository);
  return {
    rulesetEndpoint: `rulesets/${String(existing.id)}`,
    rulesetPayload: migration.payload,
    rulesetChanges: migration.changes,
    enablePrivateReporting: record(securityStatus).enabled !== true,
    repositoryChanges: repository.changes,
    repositoryPayload: repository.payload,
  };
}

export function repositorySettingsMigration(actualValue: unknown, desiredValue: unknown) {
  const actual = record(actualValue),
    desired = record(desiredValue);
  assertExactKeys(desired, repositorySettingNames, "desired repository settings");
  const changes = repositorySettingNames
    .filter((name) => actual[name] !== desired[name])
    .map((name) => ({ path: name, from: actual[name], to: desired[name] }));
  return {
    changes,
    payload: Object.fromEntries(changes.map((change) => [change.path, change.to])),
  };
}

function gh(repo: string, args: { endpoint: string; method: string }, input?: unknown) {
  const endpoint = args.endpoint ? `repos/${repo}/${args.endpoint}` : `repos/${repo}`;
  return github.request(args.method, endpoint, input ?? null).body;
}

async function loadDesired() {
  const [ruleset, security] = await Promise.all([
    readFile(rulesetPath, "utf8").then((text): unknown => JSON.parse(text)),
    readFile(securityPath, "utf8").then((text): unknown => JSON.parse(text)),
  ]);
  validateRepositorySettings(ruleset, security);
  return { ruleset: record(ruleset), security: record(security) };
}

async function main(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`Usage: node scripts/repository-settings.mts [--validate|--plan|--check|--apply|--help]

Validate the checked-in repository protection and security contract, or compare it
with GitHub. Live operations require an authenticated GitHub CLI with access to
the configured repository.

Options (choose one):
  --validate  Validate local artifacts only; this is the default.
  --plan      Read live settings and print the supported changes as JSON.
  --check     Read live settings and fail if they differ from the checked-in contract.
  --apply     Apply only the supported migration, then read back the live settings.
  --help      Show this help without reading configuration or contacting GitHub.

Applying protection or security changes requires explicit owner authorization.
This command does not create replacement protection or bypass its migration guards.

Example:
  node scripts/repository-settings.mts --validate`);
    return;
  }
  const mode = argv[0] ?? "--validate";
  if (!["--validate", "--plan", "--check", "--apply"].includes(mode) || argv.length > 1) {
    throw new Error(
      "Usage: node scripts/repository-settings.mts [--validate|--plan|--check|--apply]. Run with --help for an example.",
    );
  }
  const { ruleset, security } = await loadDesired();
  if (mode === "--validate") {
    console.log("Repository settings artifacts are valid.");
    return;
  }
  const repo = security.repository;
  if (typeof repo !== "string") throw new Error("Invalid configured repository");
  const desiredRepository = Object.fromEntries(
    repositorySettingNames.map((name) => [name, security[name]]),
  );
  let summaries = records(gh(repo, { endpoint: "rulesets", method: "GET" }));
  let securityStatus = gh(repo, {
    endpoint: "private-vulnerability-reporting",
    method: "GET",
  });
  let repositoryStatus = gh(repo, { endpoint: "", method: "GET" });
  let summary = summaries.find(
    (item) => item.name === ruleset.name && item.target === ruleset.target,
  );
  if (!summary) throw new Error("Protect main ruleset is not configured");
  let actual = gh(repo, { endpoint: `rulesets/${String(summary.id)}`, method: "GET" });
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
    summaries = records(gh(repo, { endpoint: "rulesets", method: "GET" }));
    securityStatus = gh(repo, {
      endpoint: "private-vulnerability-reporting",
      method: "GET",
    });
    repositoryStatus = gh(repo, { endpoint: "", method: "GET" });
    summary = summaries.find(
      (item) => item.name === ruleset.name && item.target === ruleset.target,
    );
    if (!summary) throw new Error("Protect main ruleset disappeared during application");
    actual = gh(repo, { endpoint: `rulesets/${String(summary.id)}`, method: "GET" });
  }
  if (!isDeepStrictEqual(projectRuleset(actual), projectRuleset(ruleset))) {
    throw new Error("Protect main ruleset differs from .github/repository-ruleset.json");
  }
  if (record(securityStatus).enabled !== true)
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
