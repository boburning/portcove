import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluatePullRequest,
  flattenCommitPages,
  parsePullRequestReference,
  renderFindings,
  validatePrConventionConfig,
} from "./pr-conventions.mjs";

const config = JSON.parse(
  await readFile(new URL("../.github/pr-conventions.json", import.meta.url)),
);
const headSha = "0123456789abcdef0123456789abcdef01234567";

function body(overrides = {}) {
  const values = {
    "Linked issue": "Closes #608",
    "Outcome and scope":
      "Maintainers receive predictable metadata. Product behavior is unchanged.",
    Verification:
      "`node --test scripts/pr-conventions.test.mjs` passed 12 tests. Not run — no product UI changed.",
    "Review and risk": `Distinct final-diff review of ${headSha} found no substantive issue. Required checks and merge authority are unchanged.`,
    "Readiness and follow-ups":
      "Roadmap: Validating. Standing routine merge authority applies. Follow-ups: None.",
    ...overrides,
  };
  return config.body.headings
    .map((heading) => `## ${heading}\n\n${values[heading]}`)
    .join("\n\n");
}

function pull(overrides = {}) {
  return {
    number: 608,
    title: "chore(repo): standardize pull request conventions",
    body: body(),
    branch: "chore/pr-conventions",
    headSha,
    actor: "boburning",
    isDraft: false,
    commits: [
      {
        sha: headSha,
        message: "chore(repo): standardize pull request conventions",
      },
    ],
    ...overrides,
  };
}

function codes(findings) {
  return findings.map((item) => item.code);
}

test("checked-in configuration and a complete ready pull request are valid", () => {
  assert.equal(validatePrConventionConfig(config), config);
  assert.deepEqual(evaluatePullRequest(pull(), config), []);
});

test("titles allow optional scopes and breaking markers", () => {
  assert.deepEqual(
    evaluatePullRequest(
      pull({
        title: "refactor!: replace transport contract",
        commits: [
          { sha: headSha, message: "feat(core)!: version machine output" },
        ],
      }),
      config,
    ),
    [],
  );
});

test("title, branch, length and punctuation problems produce advisory findings", () => {
  const findings = evaluatePullRequest(
    pull({
      title: `Add ${"very ".repeat(20)}long title.`,
      branch: "codex/PR_Conventions",
      commits: [{ sha: headSha, message: "Add a free-form commit." }],
    }),
    config,
  );
  assert.deepEqual(codes(findings), [
    "pull request title-format",
    "pull request title-length",
    "pull request title-punctuation",
    "branch-format",
    "commit subject-format",
    "commit subject-punctuation",
  ]);
  assert.match(findings.at(-1).message, /^0123456:/);
});

test("body headings must be present once, non-empty and in order", () => {
  const malformed = [
    "## Verification\n\n`just audit` passed.",
    "## Linked issue\n\nCloses #608",
    "## Outcome and scope\n\n<!-- empty -->",
    "## Review and risk\n\nReview pending.",
    "## Review and risk\n\nDuplicate.",
  ].join("\n\n");
  const result = codes(
    evaluatePullRequest(pull({ body: malformed, isDraft: true }), config),
  );
  assert.ok(result.includes("body-heading"));
  assert.ok(result.includes("body-empty"));
  assert.ok(result.includes("body-order"));
});

test("body warnings cover placeholders, missing links and weak verification", () => {
  const findings = evaluatePullRequest(
    pull({
      body: body({
        "Linked issue": "Closes #\n\nTBD",
        Verification: "The checks passed.",
      }),
    }),
    config,
  );
  assert.ok(codes(findings).includes("linked-issue"));
  assert.ok(codes(findings).includes("body-placeholder"));
  assert.ok(codes(findings).includes("verification-detail"));
});

test("drafts may retain pending verification, review and fixup commits", () => {
  const findings = evaluatePullRequest(
    pull({
      isDraft: true,
      body: body({ Verification: "Pending.", "Review and risk": "Pending." }),
      commits: [{ sha: headSha, message: "fixup! temporary repair" }],
    }),
    config,
  );
  assert.deepEqual(findings, []);
});

test("ready pull requests identify pending evidence and a stale reviewed head", () => {
  const findings = evaluatePullRequest(
    pull({
      body: body({
        Verification: "Pending. `just audit` will run.",
        "Review and risk": "Review in progress for abcdef0.",
      }),
    }),
    config,
  );
  assert.ok(codes(findings).includes("verification-pending"));
  assert.ok(codes(findings).includes("review-pending"));
  assert.ok(codes(findings).includes("review-head"));
});

test("bot pull requests keep title checks but exempt generated body and commits", () => {
  const botPull = pull({
    actor: "dependabot[bot]",
    branch: "dependabot/npm_and_yarn/apps/desktop/react-20",
    body: "Generated dependency update body.",
    commits: [{ sha: headSha, message: "Bump react to 20" }],
  });
  assert.deepEqual(evaluatePullRequest(botPull, config), []);
  assert.deepEqual(
    codes(evaluatePullRequest({ ...botPull, title: "Bump react" }, config)),
    ["pull request title-format"],
  );
});

test("Git-generated merge and revert subjects are exempt", () => {
  assert.deepEqual(
    evaluatePullRequest(
      pull({
        commits: [
          {
            sha: headSha,
            message: "Merge remote-tracking branch 'origin/main'",
          },
          { sha: headSha, message: 'Revert "feat(core): add sample"' },
        ],
      }),
      config,
    ),
    [],
  );
});

test("commit pagination must be structured and complete", () => {
  assert.deepEqual(flattenCommitPages([[{ sha: "a" }], [{ sha: "b" }]], 2), [
    { sha: "a" },
    { sha: "b" },
  ]);
  assert.throws(
    () => flattenCommitPages([{ sha: "a" }], 1),
    /invalid response/,
  );
  assert.throws(() => flattenCommitPages([[{ sha: "a" }]], 2), /1 of 2/);
});

test("pull request references accept repository numbers and URLs only", () => {
  assert.equal(parsePullRequestReference("608", config.repository), 608);
  assert.equal(
    parsePullRequestReference(
      "https://github.com/boburning/portcove/pull/608",
      config.repository,
    ),
    608,
  );
  assert.throws(
    () => parsePullRequestReference("0", config.repository),
    /positive number/,
  );
  assert.throws(
    () =>
      parsePullRequestReference(
        "https://github.com/example/other/pull/1",
        config.repository,
      ),
    /boburning\/portcove/,
  );
});

test("configuration validation rejects unknown, duplicate and malformed values", () => {
  const unknown = { ...structuredClone(config), future: true };
  assert.throws(() => validatePrConventionConfig(unknown), /exactly/);
  const duplicate = structuredClone(config);
  duplicate.title.types.push(duplicate.title.types[0]);
  assert.throws(() => validatePrConventionConfig(duplicate), /duplicates/);
  const badPrefix = structuredClone(config);
  badPrefix.branch.prefixes[0] = "Feature/";
  assert.throws(
    () => validatePrConventionConfig(badPrefix),
    /lowercase kebab-case/,
  );
});

test("rendered findings clearly identify advisory success and warnings", () => {
  assert.match(renderFindings(pull(), []), /follows the advisory/);
  assert.match(
    renderFindings(pull(), [{ code: "sample", message: "Example." }]),
    /1 advisory convention finding:/,
  );
});

test("pull request template headings exactly match the configured contract", async () => {
  const template = await readFile(
    new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
    "utf8",
  );
  const headings = [...template.matchAll(/^##\s+(.+?)\s*$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(headings, config.body.headings);
});

test("advisory workflow executes only trusted base metadata with read permissions", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pr-conventions.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^name: PR conventions \(advisory\)$/m);
  const triggerList = workflow.match(
    /pull_request_target:\s+types:\s+\[([\s\S]*?)\]\s+workflow_dispatch:/,
  )?.[1];
  assert.deepEqual(
    triggerList?.split(",").map((value) => value.trim()).filter(Boolean),
    [
      "opened",
      "edited",
      "synchronize",
      "reopened",
      "converted_to_draft",
      "ready_for_review",
    ],
  );
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(
    workflow,
    /^permissions:\r?\n  contents: read\r?\n  pull-requests: read$/m,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /node scripts\/pr-conventions\.mjs --pr "\$PR_NUMBER"/,
  );
  assert.doesNotMatch(
    workflow,
    /pull-requests: write|contents: write|secrets\.|issue-comment|continue-on-error/,
  );
  assert.doesNotMatch(
    workflow,
    /pull_request\.head|pull_request\.(?:title|body)|github\.head_ref/,
  );
});
