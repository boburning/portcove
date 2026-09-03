import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectRuleset,
  repositoryApplyPlan,
  validateRepositorySettings,
} from "./repository-settings.mjs";

const ruleset = JSON.parse(await readFile(new URL("../.github/repository-ruleset.json", import.meta.url)));
const security = JSON.parse(await readFile(new URL("../.github/repository-security.json", import.meta.url)));

test("checked-in repository settings enforce the exact main contract", () => {
  assert.doesNotThrow(() => validateRepositorySettings(ruleset, security));
  assert.deepEqual(projectRuleset({ id: 42, ...ruleset }), ruleset);
});

test("validation rejects weakened review or status requirements", () => {
  const noFreshApproval = structuredClone(ruleset);
  noFreshApproval.rules.find(rule => rule.type === "pull_request")
    .parameters.dismiss_stale_reviews_on_push = false;
  assert.throws(
    () => validateRepositorySettings(noFreshApproval, security),
    /fresh approval/,
  );

  const missingCheck = structuredClone(ruleset);
  missingCheck.rules.find(rule => rule.type === "required_status_checks")
    .parameters.required_status_checks.pop();
  assert.throws(
    () => validateRepositorySettings(missingCheck, security),
    /required status checks/,
  );
});

test("application plan updates by stable identity and enables private reporting", () => {
  assert.deepEqual(repositoryApplyPlan([], { enabled: false }, ruleset), {
    rulesetMethod: "POST",
    rulesetEndpoint: "rulesets",
    enablePrivateReporting: true,
  });
  assert.deepEqual(repositoryApplyPlan([{ id: 99, name: "Protect main", target: "branch" }], { enabled: true }, ruleset), {
    rulesetMethod: "PUT",
    rulesetEndpoint: "rulesets/99",
    enablePrivateReporting: false,
  });
});
