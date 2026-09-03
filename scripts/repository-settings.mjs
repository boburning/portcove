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

function requiredRule(ruleset, type) {
  const matches = ruleset.rules.filter(rule => rule.type === type);
  if (matches.length !== 1) throw new Error(`ruleset must contain exactly one ${type} rule`);
  return matches[0];
}

export function validateRepositorySettings(ruleset, security) {
  if (security.schema_version !== 1) throw new Error("repository security schema_version must be 1");
  if (!security.repository?.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) {
    throw new Error("repository security configuration has an invalid repository");
  }
  if (security.private_vulnerability_reporting !== true) {
    throw new Error("private vulnerability reporting must be enabled");
  }
  if (ruleset.name !== "Protect main" || ruleset.target !== "branch") {
    throw new Error("ruleset must target branches under the stable Protect main name");
  }
  if (ruleset.enforcement !== "active") throw new Error("ruleset enforcement must be active");
  if (ruleset.bypass_actors?.length) throw new Error("main protection must not define bypass actors");
  const refs = ruleset.conditions?.ref_name;
  if (JSON.stringify(refs?.include) !== JSON.stringify(["refs/heads/main"]) || refs?.exclude?.length) {
    throw new Error("ruleset must include only refs/heads/main");
  }
  requiredRule(ruleset, "deletion");
  requiredRule(ruleset, "non_fast_forward");
  const pullRequest = requiredRule(ruleset, "pull_request").parameters;
  if (
    pullRequest.required_approving_review_count < 1
    || !pullRequest.dismiss_stale_reviews_on_push
    || !pullRequest.require_last_push_approval
    || !pullRequest.required_review_thread_resolution
  ) {
    throw new Error("pull requests must require a fresh approval and resolved review threads");
  }
  const statusChecks = requiredRule(ruleset, "required_status_checks").parameters;
  const contexts = statusChecks.required_status_checks.map(check => check.context).sort();
  if (
    JSON.stringify(contexts) !== JSON.stringify(expectedChecks)
    || !statusChecks.strict_required_status_checks_policy
    || !statusChecks.do_not_enforce_on_create
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
    rules: ruleset.rules.map(rule => {
      if (rule.type === "pull_request") {
        return {
          type: rule.type,
          parameters: {
            allowed_merge_methods: rule.parameters.allowed_merge_methods,
            dismiss_stale_reviews_on_push: rule.parameters.dismiss_stale_reviews_on_push,
            require_code_owner_review: rule.parameters.require_code_owner_review,
            require_last_push_approval: rule.parameters.require_last_push_approval,
            required_approving_review_count: rule.parameters.required_approving_review_count,
            required_review_thread_resolution: rule.parameters.required_review_thread_resolution,
          },
        };
      }
      if (rule.type === "required_status_checks") {
        return {
          type: rule.type,
          parameters: {
            do_not_enforce_on_create: rule.parameters.do_not_enforce_on_create,
            required_status_checks: rule.parameters.required_status_checks.map(check => ({
              context: check.context,
            })),
            strict_required_status_checks_policy: rule.parameters.strict_required_status_checks_policy,
          },
        };
      }
      return { type: rule.type };
    }),
  };
}

export function repositoryApplyPlan(rulesets, securityStatus, desiredRuleset) {
  const existing = rulesets.find(
    ruleset => ruleset.name === desiredRuleset.name && ruleset.target === desiredRuleset.target,
  );
  return {
    rulesetMethod: existing ? "PUT" : "POST",
    rulesetEndpoint: existing
      ? `rulesets/${existing.id}`
      : "rulesets",
    enablePrivateReporting: securityStatus.enabled !== true,
  };
}

function gh(repo, args, input) {
  const command = ["api", `repos/${repo}/${args.endpoint}`, "--method", args.method];
  if (input !== undefined) command.push("--input", "-");
  const result = spawnSync("gh", command, {
    cwd: projectRoot,
    encoding: "utf8",
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh api failed with exit ${result.status}`);
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
  if (!["--validate", "--check", "--apply"].includes(mode) || argv.length > 1) {
    throw new Error("usage: node scripts/repository-settings.mjs [--validate|--check|--apply]");
  }
  const { ruleset, security } = await loadDesired();
  if (mode === "--validate") {
    console.log("Repository settings artifacts are valid.");
    return;
  }
  const repo = security.repository;
  let summaries = gh(repo, { endpoint: "rulesets", method: "GET" });
  let securityStatus = gh(repo, { endpoint: "private-vulnerability-reporting", method: "GET" });
  let plan = repositoryApplyPlan(summaries, securityStatus, ruleset);
  if (mode === "--apply") {
    gh(repo, { endpoint: plan.rulesetEndpoint, method: plan.rulesetMethod }, ruleset);
    if (plan.enablePrivateReporting) {
      gh(repo, { endpoint: "private-vulnerability-reporting", method: "PUT" });
    }
    summaries = gh(repo, { endpoint: "rulesets", method: "GET" });
    securityStatus = gh(repo, { endpoint: "private-vulnerability-reporting", method: "GET" });
    plan = repositoryApplyPlan(summaries, securityStatus, ruleset);
  }
  const summary = summaries.find(item => item.name === ruleset.name && item.target === ruleset.target);
  if (!summary) throw new Error("Protect main ruleset is not configured");
  const actual = gh(repo, { endpoint: `rulesets/${summary.id}`, method: "GET" });
  if (!isDeepStrictEqual(projectRuleset(actual), projectRuleset(ruleset))) {
    throw new Error("Protect main ruleset differs from .github/repository-ruleset.json");
  }
  if (securityStatus.enabled !== true) throw new Error("private vulnerability reporting is not enabled");
  if (plan.enablePrivateReporting) throw new Error("private vulnerability reporting still requires application");
  console.log(`Repository settings match the checked-in contract for ${repo}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
