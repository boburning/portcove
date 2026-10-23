import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  persistReviewedClassification,
  readPublicationPause,
  readRatifiedCapacityConfiguration,
  readReviewedClassification,
  readReviewedClassificationForRequest,
} from "./release-control-inputs.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import {
  observeReleaseInputProtections,
  requireReleaseInputWriterPolicy,
  requireReleaseImmutabilityPolicy,
} from "./release-input-protections.mts";
import { capacityDigest } from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  releaseControlInputsFixture as fixture,
  source,
  before,
  after,
  opportunity,
  config,
} from "./fixtures/release-control-inputs-fixture.mts";
void test("neutral request discovers only its existing exact D1 path and reauthenticates the unchanged consumer", () => {
  const f = fixture();
  const request = createReleaseReviewRequest({
    before_checkpoint: "1".repeat(40),
    requested_at: "2026-01-01T00:00:00.000Z",
    base_commit: opportunity.base_commit,
    base_version: opportunity.classification.base_version,
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
  });
  assert.equal(readReviewedClassificationForRequest(f.api, config, request).status, "missing");
  assert.equal(f.mutations(), 0);
  persistReviewedClassification(f.api, config, opportunity, 303, () => {});
  const result = readReviewedClassificationForRequest(f.api, config, request);
  assert.equal(result.status, "reviewed");
  if (result.status !== "reviewed") assert.fail("verified fixture classification missing");
  assert.deepEqual(result.opportunity, opportunity);
  assert.equal(result.review_check_id, 303);
  const wrongBase = createReleaseReviewRequest({
    before_checkpoint: request.before_checkpoint,
    requested_at: request.requested_at,
    base_commit: request.base_commit,
    base_version: "0.1.0-alpha.1",
    source_commit: request.source_commit,
    source_tree: request.source_tree,
    change_set_sha256: request.change_set_sha256,
  });
  assert.throws(
    () => readReviewedClassificationForRequest(f.api, config, wrongBase),
    /exact neutral request/,
  );
  f.legacy();
  assert.throws(
    () => readReviewedClassificationForRequest(f.api, config, request),
    /schema differs/,
  );
  assert.equal(f.mutations(), 1);
  const malformed = fixture();
  malformed.conflicting();
  assert.throws(() => readReviewedClassificationForRequest(malformed.api, config, request));
  assert.equal(malformed.mutations(), 0);
});
void test("semantic review binds exact inputs; CAS writes once; identical repeat does not write", () => {
  const f = fixture();
  assert.equal(
    persistReviewedClassification(f.api, config, opportunity, 303, () => {}).changed,
    true,
  );
  assert.equal(readReviewedClassification(f.api, config, opportunity).review_check_id, 303);
  assert.equal(
    persistReviewedClassification(f.api, config, opportunity, 303, () => {}).changed,
    false,
  );
  assert.equal(f.mutations(), 1);
  assert.equal(
    f.requests.some((route) => route.includes("portcove-release-pause")),
    false,
  );
  assert.equal(readPublicationPause(f.api).publication_paused, true);
});
void test("writer identity, semantic failure, incomplete reports and changed inputs cannot persist acceptance", () => {
  for (const fault of [
    "issuer",
    "failure",
    "annotations",
    "input",
    "report-bytes",
    "pr-scope",
    "legacy-report",
  ]) {
    const f = fixture();
    f.faults.value = fault;
    assert.throws(() => persistReviewedClassification(f.api, config, opportunity, 303, () => {}));
    assert.equal(f.mutations(), 0);
  }
  for (const invalid of [
    { ...config, review_app_id: 15368 },
    { ...config, review_app_id: 202 },
    {},
  ]) {
    const f = fixture();
    assert.throws(() => persistReviewedClassification(f.api, invalid, opportunity, 303, () => {}));
    assert.equal(f.requests.length, 0);
  }
});
void test("immutable conflicts, CAS refusal and ambiguous acknowledgment never overwrite or retry", () => {
  const f = fixture();
  f.conflicting();
  assert.throws(
    () => persistReviewedClassification(f.api, config, opportunity, 303, () => {}),
    /conflicts/,
  );
  assert.equal(f.mutations(), 0);
  const race = fixture();
  race.faults.value = "cas";
  assert.throws(
    () => persistReviewedClassification(race.api, config, opportunity, 303, () => {}),
    /do not retry/,
  );
  assert.equal(race.mutations(), 1);
  const recovered = fixture();
  recovered.faults.value = "ambiguous";
  assert.equal(
    persistReviewedClassification(recovered.api, config, opportunity, 303, () => {}).recovered,
    true,
  );
  assert.equal(recovered.mutations(), 1);
});
void test("isolated observer only GETs and refuses hidden bypass, inherited coverage and drift", () => {
  for (const fault of [
    "",
    "bypass",
    "inherited",
    "drift",
    "release-ok",
    "release-disabled",
    "release-drift",
  ]) {
    let refReads = 0;
    let settingReads = 0;
    const publication = fault.startsWith("release-");
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        let body: unknown;
        const rule = {
          id: 1,
          source_type: fault === "inherited" ? "Organization" : "Repository",
          source: "boburning/portcove",
          enforcement: "active",
          conditions: {
            ref_name: { include: ["refs/heads/portcove-release-inputs"], exclude: [] },
          },
          bypass_actors: [],
          rules: [{ type: "update" }],
        };
        if (endpoint === "repos/boburning/portcove")
          body = { id: 1354613114, full_name: "boburning/portcove" };
        else if (endpoint.endsWith("/immutable-releases")) {
          settingReads++;
          body = {
            enabled:
              fault !== "release-disabled" && !(fault === "release-drift" && settingReads === 2),
            enforced_by_owner: false,
          };
        } else if (endpoint.includes("/rulesets?")) body = [rule];
        else if (endpoint.includes("/rulesets/1?"))
          body = fault === "bypass" ? { ...rule, bypass_actors: undefined } : rule;
        else if (endpoint.includes("/git/ref/heads/")) {
          refReads++;
          body = {
            ref: `refs/heads/${endpoint.split("/").at(-1)}`,
            object: { type: "commit", sha: fault === "drift" && refReads > 2 ? after : before },
          };
        } else if (endpoint.includes("/rules/branches/")) body = [{ type: "update" }];
        else if (endpoint.includes("/protection")) body = { enforce_admins: { enabled: true } };
        else throw new Error("unexpected observer route");
        return { status: 200, headers: new Map<string, string>(), body };
      },
    };
    if ((fault && !publication) || fault === "release-drift")
      assert.throws(() => observeReleaseInputProtections(api, { releasePublication: publication }));
    else {
      const result = observeReleaseInputProtections(api, { releasePublication: publication });
      assert.equal(result.admission, "hold");
      assert.equal(result.enforcement, "uninterpreted");
      if (fault === "release-ok") {
        assert.equal(requireReleaseImmutabilityPolicy(result).enabled, true);
        assert.equal(settingReads, 2);
      } else assert.throws(() => requireReleaseImmutabilityPolicy(result));
    }
  }
});

void test("release immutability requires fresh complete isolated setting, not an imported enabled flag", () => {
  const now = Date.now();
  const inventory = { immutable_releases: { enabled: true, enforced_by_owner: false } };
  const proof = {
    schema_version: 1,
    repository_id: 1354613114,
    coverage: "current-repository-input-branches-and-release-immutability",
    observed_at: new Date(now).toISOString(),
    inventory,
    inventory_sha256: capacityDigest(inventory),
  };
  assert.equal(requireReleaseImmutabilityPolicy(proof, now).enforced_by_owner, false);
  for (const value of [
    { enabled: true },
    { ...proof, coverage: "current-repository-input-branches-only" },
    { ...proof, observed_at: new Date(now - 60001).toISOString() },
    { ...proof, observed_at: new Date(now + 1).toISOString() },
    { ...proof, inventory_sha256: "0".repeat(64) },
    { ...proof, inventory: { immutable_releases: { enabled: true } } },
  ])
    assert.throws(() => requireReleaseImmutabilityPolicy(value, now));
});

void test("writer policy requires fresh exact per-ref principals and unbypassable immutable ref rules", () => {
  const names = ["portcove-release-inputs", "portcove-release-pause"];
  const rulesets = names.flatMap((branch, index) => [
    {
      id: index * 2 + 1,
      enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
      rules: [{ type: "update" }],
      bypass_actors: [
        {
          actor_type: index === 0 ? "Integration" : "User",
          actor_id: index === 0 ? 202 : 43177418,
          bypass_mode: "always",
        },
      ],
    },
    {
      id: index * 2 + 2,
      enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
      rules: ["creation", "deletion", "non_fast_forward"].map((type) => ({ type })),
      bypass_actors: [],
    },
  ]);
  const inventory = {
    rulesets,
    branches: names.map((branch, index) => ({
      branch,
      effective_rules: [
        { type: "update", ruleset_id: index * 2 + 1 },
        ...["creation", "deletion", "non_fast_forward"].map((type) => ({
          type,
          ruleset_id: index * 2 + 2,
        })),
      ],
    })),
  };
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value !== null && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`
        : JSON.stringify(value);
  const make = () => ({
    schema_version: 1,
    repository_id: 1354613114,
    observed_at: new Date().toISOString(),
    coverage: "current-repository-input-branches-only",
    inventory,
    inventory_sha256: createHash("sha256").update(canonical(inventory)).digest("hex"),
  });
  assert.equal(
    requireReleaseInputWriterPolicy(make(), 202).authorization,
    "input-writer-policy-only",
  );
  assert.throws(() => requireReleaseInputWriterPolicy(make(), 203));
  assert.throws(() =>
    requireReleaseInputWriterPolicy(
      { ...make(), observed_at: new Date(Date.now() - 60001).toISOString() },
      202,
    ),
  );
  rulesets[0]!.bypass_actors[0]!.actor_id = 15368;
  assert.throws(() => requireReleaseInputWriterPolicy(make(), 202));
});

void test("held CLI source admission runs without installed dependencies and refuses before credential operations", async (context) => {
  const root = disposableDirectory(context, path.join(os.tmpdir(), "portcove-input-admission-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  for (const file of [
    "release-reviewed-inputs.mts",
    "release-control-phases.mts",
    "assembler-job-identity.mts",
    "production-controller-admission.mts",
    "github-api.mts",
    "release-readonly-child-environment.mts",
    "release-coordinator-deadline.mts",
    "release-signing-job-budget.mts",
    "release-authority-configuration.mts",
    "release-catalog-publication-contract.mts",
    "release-metadata-contract.mts",
    "controller-node-runtime.mts",
    "release-canonical.mts",
    "release-coordinator-namespace.mts",
    "linux-beta-risk-706-profile.mts",
    "release-native-qualification-contract.mts",
    "runtime-values.mts",
    "release-coordinator-errors.mts",
    "release-input-protections.mts",
    "release-classification-contract.mts",
    "release-classification-principal.mts",
  ])
    await copyFile(new URL(file, import.meta.url), path.join(root, "scripts", file));
  const workflow = Buffer.from("fixed inert source fixture\n");
  await writeFile(path.join(root, ".github/workflows/release-reviewed-inputs.yml"), workflow);
  const ref = "refs/tags/portcove-production-controller-fixture";
  const policy = {
    schema_version: 1,
    mode: "admission-only",
    execution_ref: ref,
    revision: source,
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
    actor_id: "43177418",
  };
  const env = {
    ...process.env,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    PORTCOVE_CONTROL_APP_TOKEN: undefined,
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/release-reviewed-inputs.yml@${ref}`,
    GITHUB_ACTOR: "boburning",
    GITHUB_ACTOR_ID: "43177418",
    GITHUB_TRIGGERING_ACTOR: "boburning",
    GITHUB_RUN_ID: "9988",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "admission",
    RUNNER_ENVIRONMENT: "github-hosted",
    PORTCOVE_CONTROLLER_REVISION: source,
    PORTCOVE_CONTROLLER_REF: ref,
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify(policy),
    RUNNER_TEMP: root,
  };
  const result: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/release-reviewed-inputs.mts"), "admission"],
      { env, encoding: "utf8" },
    ),
  );
  assert.ok(result);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/release-reviewed-inputs.mts"), "persist"],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  assert.match(
    await readFile(path.join(root, "release-reviewed-inputs-persist.jsonl"), "utf8"),
    /"status":"refused"/,
  );
});

void test("protection expiry during source acquisition refuses immediately before CAS with zero mutations", () => {
  const f = fixture();
  const deadline = Date.now() + 1;
  let clock = deadline - 1;
  const api = {
    ...f.api,
    request: (...args: Parameters<typeof f.api.request>) => {
      clock = deadline + 1;
      return f.api.request(...args);
    },
  };
  assert.throws(
    () =>
      persistReviewedClassification(api, config, opportunity, 303, () => {
        if (clock > deadline) throw new Error("protection observation expired");
      }),
    /expired/,
  );
  assert.equal(f.mutations(), 0);
});

void test("owner-ref capacity source binds raw bytes, guarded provenance and revocation without claiming live headroom", () => {
  const document = {
    schema_version: 1,
    capacity: capacityFixture(),
    observation: {
      kind: "provider-ui-spending-configuration",
      operator_actor_id: 43177418,
      observed_at: "2026-10-18T00:00:00Z",
      evidence_sha256: "e".repeat(64),
    },
  };
  const f = fixture(document);
  let guards = 0;
  const result = readRatifiedCapacityConfiguration(f.api, () => {
    guards++;
  });
  assert.equal(guards, 2);
  assert.equal(result.path, "capacity.json");
  assert.equal(result.report.eligibility, "eligible");
  assert.equal(result.report.headroom, "unknown");
  assert.equal(result.report.reservation, "none");
  assert.equal(f.mutations(), 0);
  const revoked = structuredClone(document);
  revoked.capacity.ratification.active = false;
  assert.equal(
    readRatifiedCapacityConfiguration(fixture(revoked).api, () => {}).report.eligibility,
    "ineligible",
  );
  const drift = fixture(document);
  drift.faults.value = "pause-drift";
  assert.throws(() => readRatifiedCapacityConfiguration(drift.api, () => {}));
  assert.throws(
    () =>
      readRatifiedCapacityConfiguration(f.api, () => {
        throw Error("unverified observer/job");
      }),
    /unverified/,
  );
  for (const bad of [
    { ...document, observation: { ...document.observation, operator_actor_id: 202 } },
    { ...document, capacity: { ...document.capacity, operation: {} } },
  ])
    assert.throws(() => readRatifiedCapacityConfiguration(fixture(bad).api, () => {}));
  assert.throws(() => readRatifiedCapacityConfiguration(fixture().api, () => {}), /unavailable/);
});

void test("persisted classification binds actual semantic report bytes, not just its App-authored input digest", () => {
  const f = fixture();
  persistReviewedClassification(f.api, config, opportunity, 303, () => {});
  f.faults.value = "report-change";
  assert.throws(
    () => readReviewedClassification(f.api, config, opportunity),
    /persisted semantic review report changed/,
  );
  assert.equal(f.mutations(), 1);
});

void test("legacy persisted classification refuses consumption and is never overwritten as migration", () => {
  const f = fixture();
  persistReviewedClassification(f.api, config, opportunity, 303, () => {});
  f.legacy();
  assert.throws(() => readReviewedClassification(f.api, config, opportunity));
  assert.throws(() => persistReviewedClassification(f.api, config, opportunity, 303, () => {}));
  assert.equal(f.mutations(), 1);
});
