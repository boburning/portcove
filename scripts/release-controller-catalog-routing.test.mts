import assert from "node:assert/strict";
import test from "node:test";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  lstat,
  rm,
  rename,
  symlink,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseDocument } from "yaml";
import { inspectControllerExecutionPurpose } from "./release-control-phases.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { prepareFixedControllerConfiguration } from "./release-controller-configuration.mts";
import { fixedControllerConfigurationSource } from "./release-authority-configuration-contract.mts";
import { projectFixedControllerJobOutputs } from "./release-controller-job-output.mts";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";
import {
  inspectControllerWakeChoices,
  readControllerWakeChoicesFromEnvironment,
  selectControllerWakePurpose,
  readWakePurposePriority,
} from "./release-controller-wake.mts";
import {
  requireCatalogMaintenancePolicy,
  requireReleaseInputWriterPolicy,
  observeCatalogMaintenanceProtections,
  catalogProtectionEnvironments,
} from "./release-input-protections.mts";
import { catalogEnvironmentFixture } from "./fixtures/release-live-control-fixture.mts";
import { capacityDigest, slice4CapacityResources } from "./release-capacity.mts";
import { maximumProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const fixed = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    actor_id: "1234",
    run_id: "12345",
    run_attempt: 1,
  };
  const { actor_id: _actor, ...producer } = fixed;
  const artifact = (id: number) => ({ id, sha256: "c".repeat(64) });
  const context = {
    ...producer,
    artifact: artifact(3),
    bundle: artifact(4),
    manifest_sha256: "d".repeat(64),
    binding_sha256: "e".repeat(64),
    facts_sha256: "f".repeat(64),
  };
  const out = (outputs: Record<string, unknown>) => ({ result: "success", outputs });
  const roles = ["definitions", "policy", "snapshot", "timestamp"];
  const needs: Record<string, { result: string; outputs: Record<string, unknown> }> = {
    tool_bootstrap: out({
      artifact_id: "1",
      artifact_sha256: "c".repeat(64),
      source_tree: fixed.source_tree,
    }),
    tool_attest: out({ bundle_artifact_id: "2", bundle_artifact_sha256: "c".repeat(64) }),
    coordinator: out({ mode: "catalog", context_locator: JSON.stringify(context) }),
    ...Object.fromEntries(
      roles.map((role, i) => [
        `catalog_${role}`,
        out({
          role_locator: JSON.stringify({
            purpose: "catalog",
            role,
            controller: producer,
            artifact: artifact(5 + i * 2),
            bundle: artifact(6 + i * 2),
            context_manifest_sha256: context.manifest_sha256,
            context_binding_sha256: context.binding_sha256,
            context_facts_sha256: context.facts_sha256,
          }),
        }),
      ]),
    ),
  };
  return {
    fixed,
    producer,
    context,
    needs,
    input: {
      operation: "catalog-snapshot",
      publication_purpose: "catalog-publication",
      fixed,
      needs,
      admission_configuration: { namespace: "portcove-production" },
    },
  };
}
void test("catalog fixed DAG has no application setup dependency and preserves exact four-role custody", () => {
  const f = fixture();
  const coordinator = prepareFixedControllerConfiguration({ ...f.input, operation: "coordinator" });
  assert.deepEqual(Object.keys(coordinator).sort(), ["remote_configuration", "tools"]);
  for (const [role, count] of [
    ["definitions", 0],
    ["policy", 0],
    ["snapshot", 2],
    ["timestamp", 3],
  ] as const) {
    const value = prepareFixedControllerConfiguration({ ...f.input, operation: `catalog-${role}` });
    assert.ok("dependencies" in value);
    assert.equal(value.dependencies.length, count);
    assert.equal("role" in value && value.role, role);
    assert.equal(Object.hasOwn(value, "aggregate"), false);
    assert.equal(Object.hasOwn(value, "native_locators"), false);
  }
  const site = prepareFixedControllerConfiguration({ ...f.input, operation: "site-publication" });
  assert.ok("roles" in site);
  assert.equal(site.roles.length, 4);
  assert.equal("mode" in site && site.mode, "catalog");
  for (const changed of [
    { ...f.input, operation: "payload" },
    { ...f.input, operation: "building" },
    { ...f.input, operation: "release-publication" },
    { ...f.input, publication_purpose: "application" },
    { ...f.input, publication_purpose: "invented" },
    {
      ...f.input,
      needs: {
        ...f.needs,
        coordinator: {
          result: "success",
          outputs: { ...f.needs.coordinator!.outputs, mode: "metadata" },
        },
      },
    },
  ])
    assert.throws(() => prepareFixedControllerConfiguration(changed));
  const role = JSON.parse(String(f.needs.catalog_definitions!.outputs.role_locator)) as Record<
    string,
    unknown
  >;
  for (const change of [
    { purpose: "application" },
    { context_manifest_sha256: "0".repeat(64) },
    { controller: { ...f.producer, run_id: "999" } },
  ])
    assert.throws(() =>
      prepareFixedControllerConfiguration({
        ...f.input,
        needs: {
          ...f.needs,
          catalog_definitions: {
            result: "success",
            outputs: { role_locator: JSON.stringify({ ...role, ...change }) },
          },
        },
      }),
    );
});
void test("catalog outputs use exact distinct context and four-role predicates without imported authority", () => {
  const { producer } = fixture();
  const subject = Buffer.from(
    JSON.stringify({
      kind: "catalog-signing-context",
      controller: producer,
      facts: {},
      facts_sha256: digest({}),
      binding: {},
    }),
  );
  const predicate = Buffer.from(
    JSON.stringify({ role: "catalog-signing-context", manifest_sha256: hash(subject) }),
  );
  const result = {
    decision: "catalog-context-prepared",
    artifact: { id: 3, sha256: "a".repeat(64) },
    manifest_sha256: hash(subject),
  };
  const custody = { subject, predicate, bundle: { artifact_id: 4, sha256: "b".repeat(64) } };
  const output = projectFixedControllerJobOutputs("coordinator", result, custody);
  assert.equal(output.mode, "catalog");
  assert.throws(() =>
    projectFixedControllerJobOutputs("coordinator", result, {
      ...custody,
      predicate: Buffer.from(
        JSON.stringify({ role: "metadata-signing-context", manifest_sha256: hash(subject) }),
      ),
    }),
  );
  for (const role of ["definitions", "policy", "snapshot", "timestamp"]) {
    const bytes = Buffer.from("inert fixture manifest");
    const proof = Buffer.from(
      JSON.stringify({
        role: `catalog-${role}`,
        controller: producer,
        context_manifest_sha256: "d".repeat(64),
        context_binding_sha256: "e".repeat(64),
        context_facts_sha256: "f".repeat(64),
      }),
    );
    const out = projectFixedControllerJobOutputs(
      `catalog-${role}`,
      {
        decision: "catalog-role-output-prepared",
        artifact: { id: 5, sha256: "a".repeat(64) },
        subject_digest: hash(bytes),
      },
      { subject: bytes, predicate: proof, bundle: { artifact_id: 6, sha256: "b".repeat(64) } },
    );
    const locator: unknown = JSON.parse(out.role_locator!);
    assert.ok(isRecord(locator));
    assert.equal(locator.purpose, "catalog");
    assert.equal(locator.role, role);
  }
});
void test("catalog key credentials are rejected at the actual secret-free bootstrap", () => {
  for (const role of ["DEFINITIONS", "POLICY", "SNAPSHOT", "TIMESTAMP"])
    assert.throws(() =>
      assertControllerBootstrapEnvironment({ [`PORTCOVE_CATALOG_${role}_KEY`]: "inert-secret" }),
    );
  assertControllerBootstrapEnvironment({
    PORTCOVE_CATALOG_AUTHORITIES: "inert public appointments",
  });
  assert.throws(() => inspectControllerExecutionPurpose("catalog"));
});
void test("automatic purpose fairness is fixed-data routing, with exact shared namespace and priority", () => {
  const base = {
    schema_version: 3,
    namespace: "portcove-production",
    revision: "a".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    workflow_sha256: "b".repeat(64),
    wake_workflow_sha256: "c".repeat(64),
    dispatch_actor_id: "999",
    activation_started_at: "2026-10-21T00:00:00Z",
  };
  const app = { ...base, publication_purpose: "application" },
    catalog = { ...base, publication_purpose: "catalog-publication", dispatch_actor_id: "888" };
  const choices = inspectControllerWakeChoices(app, catalog);
  assert.deepEqual(
    readControllerWakeChoicesFromEnvironment({
      PORTCOVE_CONTROLLER_WAKE: JSON.stringify(app),
      PORTCOVE_CATALOG_CONTROLLER_WAKE: "",
    }),
    inspectControllerWakeChoices(app, null),
  );
  assert.deepEqual(
    readControllerWakeChoicesFromEnvironment({
      PORTCOVE_CONTROLLER_WAKE: "",
      PORTCOVE_CATALOG_CONTROLLER_WAKE: JSON.stringify(catalog),
    }),
    inspectControllerWakeChoices(null, catalog),
  );
  assert.throws(() =>
    readControllerWakeChoicesFromEnvironment({
      PORTCOVE_CONTROLLER_WAKE: " ",
      PORTCOVE_CATALOG_CONTROLLER_WAKE: JSON.stringify(catalog),
    }),
  );

  assert.equal(selectControllerWakePurpose(choices, 1).publication_purpose, "application");
  assert.equal(selectControllerWakePurpose(choices, 2).publication_purpose, "catalog-publication");
  assert.equal(
    selectControllerWakePurpose(choices, 2, "application").publication_purpose,
    "application",
  );
  assert.equal(
    selectControllerWakePurpose(choices, 1, "catalog-publication").publication_purpose,
    "catalog-publication",
  );
  assert.equal(
    selectControllerWakePurpose(inspectControllerWakeChoices(null, catalog), 1).publication_purpose,
    "catalog-publication",
  );
  for (const changed of [
    { ...catalog, namespace: "portcove-other" },
    { ...catalog, revision: "d".repeat(40) },
    { ...catalog, publication_purpose: "application" },
  ])
    assert.throws(() => inspectControllerWakeChoices(app, changed));
  assert.throws(() => inspectControllerWakeChoices(null, null));
  assert.throws(() => selectControllerWakePurpose(choices, NaN));
});
void test("catalog maintenance authenticates pause and exact catalog environments without application prerequisites", () => {
  const controllerRef = "refs/tags/portcove-production-controller-test";
  const environments = catalogEnvironmentFixture(controllerRef);
  const branch = "portcove-release-pause";
  const rule = (id: number, types: string[], actors: unknown[]) => ({
    id,
    source_type: "Repository",
    source: "boburning/portcove",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: types.map((type) => ({ type })),
    bypass_actors: actors,
  });
  const rules = [
    rule(1, ["update"], [{ actor_type: "User", actor_id: 43177418, bypass_mode: "always" }]),
    rule(2, ["creation", "deletion", "non_fast_forward"], []),
  ];
  const paths: string[] = [];
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      paths.push(endpoint);
      let body: unknown;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove" };
      else if (endpoint.includes("/rulesets?")) body = rules;
      else if (endpoint.includes("/rulesets/")) body = rules[endpoint.includes("/1?") ? 0 : 1];
      else if (endpoint.includes("/git/ref/heads/")) {
        assert.ok(endpoint.endsWith(branch));
        body = { ref: `refs/heads/${branch}`, object: { type: "commit", sha: "a".repeat(40) } };
      } else if (endpoint.includes("/rules/branches/"))
        body = rules.flatMap((r) => r.rules.map((value) => ({ ...value, ruleset_id: r.id })));
      else if (endpoint.includes("/environments/")) {
        const name = endpoint.split("/environments/")[1]!.split("/")[0]!;
        const row = environments.find((row) => row.name === name);
        assert.ok(row);
        body = endpoint.includes("/deployment-branch-policies?")
          ? { total_count: row.policies.length, branch_policies: row.policies }
          : row.environment;
      } else throw new Error("unexpected path " + endpoint);
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  const observation = observeCatalogMaintenanceProtections(api);
  assert.equal(observation.coverage, "current-repository-catalog-maintenance-only");
  assert.equal(observation.inventory.branches.length, 1);
  requireCatalogMaintenancePolicy(observation, controllerRef);
  assert.ok(paths.every((path) => !path.includes("portcove-release-inputs")));
  assert.throws(() => requireReleaseInputWriterPolicy(observation, 202));
  assert.throws(() =>
    requireCatalogMaintenancePolicy(
      {
        ...observation,
        coverage: "current-repository-input-branches-only",
      },
      controllerRef,
    ),
  );
  assert.throws(() =>
    requireCatalogMaintenancePolicy(
      {
        ...observation,
        observed_at: new Date(Date.now() - 60001).toISOString(),
      },
      controllerRef,
    ),
  );
  assert.deepEqual(catalogProtectionEnvironments, [
    "github-pages",
    "production-catalog-definitions",
    "production-catalog-policy",
    "production-catalog-snapshot",
    "production-catalog-timestamp",
    "production-release-coordinator",
    "production-release-protection-observer",
  ]);
  for (const mutate of [
    (row: (typeof environments)[number]) => {
      row.environment.can_admins_bypass = true;
    },
    (row: (typeof environments)[number]) => {
      row.environment.protection_rules.push({ id: 99, type: "required_reviewers" });
    },
    (row: (typeof environments)[number]) => {
      row.environment.deployment_branch_policy.custom_branch_policies = false;
    },
    (row: (typeof environments)[number]) => {
      row.policies[0]!.name = "portcove-production-controller-*";
    },
    (row: (typeof environments)[number]) => {
      row.policies[0]!.type = "branch";
    },
    (row: (typeof environments)[number]) => {
      row.policies.push({ id: 88, name: "main", type: "branch" });
    },
  ]) {
    // Rebuild through the real collector so the canonical inventory digest is
    // valid and refusal comes from policy interpretation, not a stale hash.
    const prior = structuredClone(environments[0]!);
    mutate(environments[0]!);
    const drifted = observeCatalogMaintenanceProtections(api);
    assert.throws(() => requireCatalogMaintenancePolicy(drifted, controllerRef));
    environments[0] = prior;
  }
  assert.throws(() =>
    requireCatalogMaintenancePolicy(observation, "refs/tags/portcove-production-controller-other"),
  );
  for (const mutate of [
    (rows: NonNullable<typeof observation.inventory.environments>) => {
      rows.pop();
    },
    (rows: NonNullable<typeof observation.inventory.environments>) => {
      delete rows[0]!.environment.can_admins_bypass;
    },
    (rows: NonNullable<typeof observation.inventory.environments>) => {
      rows[1]!.environment.id = rows[0]!.environment.id;
    },
    (rows: NonNullable<typeof observation.inventory.environments>) => {
      rows[0]!.name = "production-release-admission";
    },
  ]) {
    const changed = structuredClone(observation);
    assert.ok(changed.inventory.environments);
    mutate(changed.inventory.environments);
    changed.inventory_sha256 = capacityDigest(changed.inventory);
    assert.throws(() => requireCatalogMaintenancePolicy(changed, controllerRef));
  }
  for (const fault of ["short-total", "duplicate-pages", "nonterminal-pages"] as const) {
    const faultyApi = {
      request(method: string, endpoint: string) {
        const result = api.request(method, endpoint);
        if (!endpoint.includes("/deployment-branch-policies?")) return result;
        const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
        const entries = Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `tag-${index}`,
          type: "tag",
        }));
        return {
          ...result,
          body:
            fault === "short-total"
              ? { total_count: 2, branch_policies: environments[0]!.policies }
              : {
                  total_count: fault === "duplicate-pages" ? 200 : 800,
                  branch_policies: fault === "duplicate-pages" && page > 2 ? [] : entries,
                },
        };
      },
    };
    assert.throws(() => observeCatalogMaintenanceProtections(faultyApi), /inventory/);
  }
  let firstEnvironmentReads = 0;
  const driftingApi = {
    request(method: string, endpoint: string) {
      if (
        endpoint === "repos/boburning/portcove/environments/github-pages" &&
        ++firstEnvironmentReads === 2
      ) {
        environments[0]!.environment.can_admins_bypass = true;
      }
      return api.request(method, endpoint);
    },
  };
  assert.throws(
    () => observeCatalogMaintenanceProtections(driftingApi),
    /changed during observation/,
  );
  environments[0]!.environment.can_admins_bypass = false;
});
void test("installed two-purpose workflow remains mutually exclusive under unchanged source and job ceilings", async () => {
  const bytes = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  assert.ok(bytes.length <= maximumProductionControllerWorkflowBytes);
  const parsed = parseDocument(bytes.toString(), { uniqueKeys: true });
  assert.deepEqual(parsed.errors, []);
  const doc: unknown = parsed.toJS();
  assert.ok(isRecord(doc) && isRecord(doc.jobs));
  const jobs = doc.jobs;
  const catalogJobs = [
    "coordinator",
    "coordinator_protection_observation",
    "catalog_metadata_protection_observation",
    "site_protection_observation",
    "catalog_definitions",
    "catalog_policy",
    "catalog_snapshot",
    "catalog_timestamp",
    "site_publication",
  ];
  assert.deepEqual(
    [
      ...new Set(
        catalogJobs.map((name) => {
          const job = jobs[name];
          assert.ok(isRecord(job));
          return job.environment;
        }),
      ),
    ].sort((a, b) => String(a).localeCompare(String(b))),
    catalogProtectionEnvironments,
  );
  assert.equal(hash(bytes), slice4CapacityResources.aggregate_workflow_sha256);
  assert.equal(hash(bytes), slice4CapacityResources.input_workflow_sha256);
  assert.equal(
    await readFile(
      new URL("../docs/qualification/application-update-production.complete.yml", import.meta.url),
      "utf8",
    ),
    bytes.toString(),
  );
  for (const role of ["definitions", "policy", "snapshot", "timestamp"]) {
    const job = jobs[`catalog_${role}`];
    assert.ok(isRecord(job));
    assert.match(
      String(job.if),
      /needs.admission.outputs.publication_purpose == 'catalog-publication'/,
    );
    assert.equal(job["timeout-minutes"], 2);
    assert.equal(job.environment, `production-catalog-${role}`);
    assert.ok(Array.isArray(job.steps));
    const step: unknown = job.steps.find((value: unknown) => isRecord(value) && value.id === "job");
    assert.ok(isRecord(step) && isRecord(step.with));
    assert.equal(step.with.operation, `catalog-${role}`);
    assert.equal(
      step.with.role_key,
      "${{ secrets.PORTCOVE_CATALOG_" + role.toUpperCase() + "_KEY }}",
    );
  }
  for (const name of [
    "classification_writer",
    "independent_admission",
    "payload_signing",
    "tuf_releases",
    "tuf_timestamp",
    "release_publication",
  ]) {
    const job = jobs[name];
    assert.ok(isRecord(job));
    assert.match(String(job.if), /needs.admission.outputs.publication_purpose == 'application'/);
  }
  assert.equal(slice4CapacityResources.declared_job_minutes, 89);
  assert.equal(slice4CapacityResources.total_job_minutes, 100);
  assert.equal(
    slice4CapacityResources.catalog_job_minutes.reduce((a, b) => a + b, 0) +
      slice4CapacityResources.catalog_observer_job_minutes.reduce((a, b) => a + b, 0) +
      1,
    40,
  );
  assert.equal(slice4CapacityResources.report_repair_maximum_job_minutes_per_candidate, 4);
});

void test("wake priority uses one stable bounded data snapshot and never turns malformed or missing state into fair absence", () => {
  const namespace = "portcove-production";
  let input: Record<string, unknown> = {
    active_candidate: null,
    controller: { capacity_attempt: { operation: null } },
  };
  let drift = false;
  let reads = 0;
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      let body: unknown;
      if (endpoint.includes("/git/ref/")) {
        reads++;
        body = {
          ref: `refs/heads/${namespace}-coordinator-state`,
          object: { type: "commit", sha: (drift && reads % 2 === 0 ? "b" : "a").repeat(40) },
        };
      } else {
        assert.match(endpoint, /contents\/state.json\?ref=a{40}$/u);
        const bytes = Buffer.from(JSON.stringify({ schema_version: 1, previous: null, input }));
        body = {
          type: "file",
          path: "state.json",
          encoding: "base64",
          content: bytes.toString("base64"),
          size: bytes.length,
          sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
        };
      }
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  assert.equal(readWakePurposePriority(api, namespace), null);
  input = { ...input, catalog_review_request: { kind: "inert routing" } };
  assert.equal(readWakePurposePriority(api, namespace), "catalog-publication");
  input = { ...input, active_candidate: { phase: "promoting" } };
  assert.equal(readWakePurposePriority(api, namespace), "application");
  input = {
    active_candidate: null,
    controller: {
      capacity_attempt: { operation: { outcome: "ambiguous", catalog_publication: {} } },
    },
  };
  assert.equal(readWakePurposePriority(api, namespace), "catalog-publication");
  for (const bad of [
    { controller: input.controller },
    { active_candidate: null, controller: {} },
    { active_candidate: null, controller: { capacity_attempt: { operation: "unreadable" } } },
  ]) {
    input = bad;
    assert.throws(() => readWakePurposePriority(api, namespace));
  }
  input = { active_candidate: null, controller: { capacity_attempt: { operation: null } } };
  drift = true;
  reads = 0;
  assert.throws(() => readWakePurposePriority(api, namespace), /changed/);
  assert.throws(
    () =>
      readWakePurposePriority(
        {
          request() {
            return { status: 404, headers: new Map<string, string>(), body: {} };
          },
        },
        namespace,
      ),
    /unavailable/,
  );
});

void test("production secret selection never falls back across purposes and job-token wake has no App secrets", async () => {
  for (const file of [
    "../.github/workflows/application-update-production.yml",
    "../.github/workflows/application-update-wake.yml",
  ]) {
    const bytes = await readFile(new URL(file, import.meta.url), "utf8");
    const expression = /\$\{\{([\s\S]*?)\}\}/gu;
    let count = 0;
    for (const match of bytes.matchAll(expression)) {
      // YAML folding may wrap a closed expression without changing its tokens.
      const body = match[1]!.replace(/\s+/gu, " ");
      if (!body.includes("secrets.PORTCOVE_CATALOG_") || !body.includes("||")) continue;
      assert.match(
        body,
        /\(.*publication_purpose == 'catalog-publication' && secrets\.PORTCOVE_CATALOG_[A-Z_]+\)/su,
      );
      assert.match(
        body,
        /\|\| \(.*publication_purpose == 'application' && secrets\.PORTCOVE_[A-Z_]+\)/su,
      );
      // Execute exactly these two closed boolean branches with controlled strings.
      const selected = body
        .replace(/(?:needs\.admission|steps\.prepare)\.outputs\.publication_purpose/gu, "purpose")
        .replace(/secrets\.PORTCOVE_CATALOG_[A-Z_]+/gu, "catalog")
        .replace(/secrets\.PORTCOVE_[A-Z_]+/gu, "app");
      const evaluate = (purpose: string, catalog: string, app: string): unknown =>
        runInNewContext(selected, { purpose, catalog, app }, { timeout: 1000 });
      assert.equal(Boolean(evaluate("catalog-publication", "", "APP")), false);
      assert.equal(Boolean(evaluate("application", "CATALOG", "")), false);
      assert.equal(evaluate("catalog-publication", "CATALOG", "APP"), "CATALOG");
      assert.equal(evaluate("application", "CATALOG", "APP"), "APP");
      count++;
    }
    if (file.endsWith("application-update-wake.yml")) {
      assert.equal(count, 0);
      assert.doesNotMatch(bytes, /secrets\.|create-github-app-token/u);
      assert.match(bytes, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
    } else assert.ok(count > 0);
  }
});

void test("actual fixed coordinator entry creates one fresh private work parent for BOTH named purposes before their factory", async (t) => {
  const originalEnvironment = process.env;
  t.after(() => {
    process.env = originalEnvironment;
  });
  let bindingForCall: unknown;
  const authority = await import("./release-authority-configuration.mts");
  t.mock.module("./release-authority-configuration.mts", {
    namedExports: {
      ...authority,
      requireControllerJobSourceConfiguration: async () => ({
        binding: bindingForCall,
        recheck: () => {},
      }),
    },
  });
  let factoryForCall: (raw: unknown, work: string, deadline: number) => Promise<unknown>;
  let selectedPurpose = "";
  const refuse = () => {
    throw new Error("wrong named purpose factory");
  };
  t.mock.module("./release-catalog-coordinator.mts", {
    namedExports: {
      runFixedCatalogCoordinatorConfiguration: (...args: [unknown, string, number]) =>
        selectedPurpose === "catalog-publication" ? factoryForCall(...args) : refuse(),
    },
  });
  t.mock.module("./release-coordinator-driver.mts", {
    namedExports: {
      runFixedCoordinatorConfiguration: (...args: [unknown, string, number]) =>
        selectedPurpose === "application" ? factoryForCall(...args) : refuse(),
    },
  });
  const nodeUrl = await import("node:url");
  const repositoryUrl = new URL("..", import.meta.url).href;
  let selectedRoot = "";
  let rootReads = 0;
  t.mock.module("node:url", {
    namedExports: {
      ...Object.fromEntries(Object.entries(nodeUrl).filter(([name]) => name !== "default")),
      fileURLToPath: (value: string | URL, options?: { windows?: boolean }) => {
        if (String(value) === repositoryUrl) {
          rootReads++;
          return selectedRoot;
        }
        return nodeUrl.fileURLToPath(value, options);
      },
    },
  });
  const parent = await mkdtemp(path.join(os.tmpdir(), "fixed-coordinator-work-"));
  try {
    for (const purpose of ["application", "catalog-publication"]) {
      const root = path.join(parent, purpose),
        privateRoot = path.join(parent, `${purpose}-private`);
      await mkdir(root, { mode: 0o700 });
      await mkdir(privateRoot, { mode: 0o700 });
      const filename = path.join(privateRoot, "controller-coordinator.json"),
        configuration = {
          remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
          tools: { artifact: "inert", bundle: "inert" },
        };
      await writeFile(filename, JSON.stringify(configuration), { flag: "wx", mode: 0o600 });
      const binding = {
        purpose: purpose as "application" | "catalog-publication",
        namespace: "portcove-fixture",
        actor_id: "1234",
        authority_configuration_sha256: "a".repeat(64),
        grant_sha256: "b".repeat(64),
        controller_revision: "c".repeat(40),
        controller_ref: "refs/tags/portcove-production-controller-fixture",
        run_id: "12345",
        run_attempt: 1,
      };
      await writeFile(
        path.join(privateRoot, "controller-coordinator-source.json"),
        JSON.stringify(
          fixedControllerConfigurationSource(
            "coordinator",
            binding,
            Buffer.from(JSON.stringify(configuration)),
          ),
        ),
        { flag: "wx", mode: 0o600 },
      );
      let calls = 0;
      const factory = async (raw: unknown, work: string, deadline: number) => {
        calls++;
        assert.deepEqual(JSON.parse(JSON.stringify(raw)), configuration);
        assert.equal(work, path.join(root, "work"));
        assert.equal(deadline, 12345);
        const stat = await lstat(work);
        assert.equal(stat.isDirectory(), true);
        assert.equal(stat.isSymbolicLink(), false);
        if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
        return { decision: "held", authority: "none" };
      };
      bindingForCall = binding;
      factoryForCall = factory;
      selectedPurpose = purpose;
      selectedRoot = root;
      rootReads = 0;
      process.env = {
        ...originalEnvironment,
        RUNNER_TEMP: privateRoot,
        PORTCOVE_EXECUTION_PURPOSE: purpose,
      };
      const moduleUrl = new URL("./release-controller-job.mts", import.meta.url);
      moduleUrl.searchParams.set("fixture", randomBytes(16).toString("hex"));
      const imported: unknown = await import(moduleUrl.href);
      assert.ok(isRecord(imported) && typeof imported.runFixedControllerJob === "function");
      const entry = imported.runFixedControllerJob as (
        role: string,
        deadline: number,
      ) => Promise<unknown>;
      assert.equal(rootReads, 1, "actual module resolves its private work root");
      await entry("coordinator", 12345);
      assert.equal(calls, 1);
      await assert.rejects(entry("coordinator", 12345), { code: "EEXIST" });
      assert.equal(calls, 1, "existing work is not adopted or passed to either factory again");
      const original = path.join(root, "original-work");
      await rename(path.join(root, "work"), original);
      await symlink(
        original,
        path.join(root, "work"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(entry("coordinator", 12345), { code: "EEXIST" });
      assert.equal(calls, 1, "existing work symlink is refused before either named factory");
      assert.equal((await lstat(path.join(root, "work"))).isSymbolicLink(), true);
      assert.equal((await lstat(original)).isDirectory(), true);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("actual fixed output source function refuses a late append and retains partial routing bytes", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "fixed-output-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const originalEnvironment = process.env;
  t.after(() => {
    process.env = originalEnvironment;
  });
  let expired = false;
  let bindingForCall: unknown;
  const authority = await import("./release-authority-configuration.mts");
  t.mock.module("./release-authority-configuration.mts", {
    namedExports: {
      ...authority,
      requireControllerJobSourceConfiguration: async () => ({
        binding: bindingForCall,
        recheck: () =>
          assert.equal(expired, false, "controlled original phase/source expired after append"),
      }),
    },
  });
  const budget = await import("./release-signing-job-budget.mts");
  t.mock.module("./release-signing-job-budget.mts", {
    namedExports: {
      ...budget,
      currentControllerJobDeadline: () => performance.now() + 10000,
    },
  });
  const filesystem = await import("node:fs/promises");
  const namedFilesystem: Record<string, unknown> = Object.fromEntries(
    Object.entries(filesystem).filter(([name]) => name !== "default"),
  );
  let delayAppend = false;
  t.mock.module("node:fs/promises", {
    namedExports: {
      ...namedFilesystem,
      appendFile: async (file: string, bytes: string) => {
        await appendFile(file, bytes);
        expired = delayAppend;
      },
    },
  });
  const moduleUrl = new URL("./release-controller-job-output.mts", import.meta.url);
  moduleUrl.searchParams.set("fixture", randomBytes(16).toString("hex"));
  const imported: unknown = await import(moduleUrl.href);
  assert.ok(isRecord(imported));
  const entry = imported.finishFixedControllerJobOutputs;
  assert.ok(typeof entry === "function");
  for (const delayed of [false, true]) {
    const root = path.join(parent, String(delayed));
    await mkdir(root);
    const output = path.join(root, "output");
    const binding = {
      purpose: "application" as const,
      namespace: "portcove-fixture",
      actor_id: "1234",
      authority_configuration_sha256: "a".repeat(64),
      grant_sha256: "b".repeat(64),
      controller_revision: "c".repeat(40),
      controller_ref: "refs/tags/portcove-production-controller-fixture",
      run_id: "12345",
      run_attempt: 1,
    };
    bindingForCall = binding;
    expired = false;
    delayAppend = delayed;
    process.env = { ...originalEnvironment, RUNNER_TEMP: root, GITHUB_OUTPUT: output };
    const configuration = Buffer.from("{}");
    await writeFile(path.join(root, "controller-coordinator.json"), configuration);
    await writeFile(
      path.join(root, "controller-coordinator-source.json"),
      JSON.stringify(fixedControllerConfigurationSource("coordinator", binding, configuration)),
    );
    await writeFile(
      path.join(root, "controller-job-settlement-coordinator.json"),
      JSON.stringify({ exit_code: 0, requires_attestation: false }),
    );
    await writeFile(
      path.join(root, "controller-coordinator-result.json"),
      JSON.stringify({ decision: "held" }),
    );
    const invoke = (): Promise<unknown> =>
      Promise.resolve(Reflect.apply(entry, undefined, ["coordinator"]));
    if (delayed) await assert.rejects(invoke(), /expired after append/);
    else
      assert.deepEqual(JSON.parse(JSON.stringify(await invoke())), {
        mode: "held",
        stage: "held",
      });
    const retained = await readFile(output, "utf8");
    assert.match(retained, /mode<</);
    assert.equal(
      retained.includes("stage<<"),
      !delayed,
      "later output is absent after late refusal",
    );
    assert.equal(
      await readFile(path.join(root, "controller-coordinator-result.json"), "utf8"),
      '{"decision":"held"}',
    );
  }
});
