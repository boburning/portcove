import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { mkdtemp, readdir, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import os from "node:os";
import { capacityDigest as digest } from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import {
  inspectCatalogContinuationOperation,
  inspectCatalogContinuationProvider,
  continueActualCatalogPublication,
} from "./release-catalog-recovery.mts";
import { isRecord } from "./runtime-values.mts";

const outputs = ["context", "definitions", "policy", "snapshot", "timestamp"] as const;
function fixture(output: (typeof outputs)[number]) {
  const descriptor = catalogPublicationFixture(),
    capacity = capacityFixture();
  const producer = {
    actor_id: "1122",
    check_run_id: "777",
    controller_revision: "1".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    job_id: 501,
    role: output === "context" ? "coordinator" : `catalog-${output}`,
    run_attempt: 1,
    run_id: "9988",
    workflow: productionControllerWorkflow,
  };
  const identity = {
    before_checkpoint: "e".repeat(40),
    catalog_publication: {
      descriptor,
      descriptor_sha256: digest(descriptor),
      observed_at: "2026-10-21T00:00:00Z",
      substantive_repairs: 0,
      transient_retries: 0,
    },
    kind: "upload",
    sequence: 1,
    destination: `github-actions:boburning/portcove:${output === "context" ? "catalog-publication-context" : `catalog-tuf-role-${output}`}`,
    executor_nonce: "f".repeat(64),
    receipt_limit: 1,
    executor_identity: producer,
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: digest(capacity.ratification),
  };
  const operation = {
    ...identity,
    id: digest(identity),
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:100",
        evidence_sha256: "2".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: null,
  };
  const run = {
    id: 9988,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    actor: { id: 1122 },
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const phase = output === "context" ? "coordinator" : (`catalog-${output}` as const);
  const job = {
    id: producer.job_id,
    run_id: 9988,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    name: releaseControlPhaseProfile(phase).reader_name,
    status: "completed",
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${producer.check_run_id}`,
  };
  const prefix =
    output === "context" ? "trusted-catalog-signing-context" : `trusted-catalog-${output}`;
  const artifact = {
    id: 100,
    name: `${prefix}${output === "context" ? "" : "-output"}-9988-1`,
    expired: false,
    digest: `sha256:${"3".repeat(64)}`,
    size_in_bytes: 100,
    workflow_run: {
      id: 9988,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: producer.controller_revision,
    },
  };
  const bundle = { ...artifact, id: 101, name: `${prefix}-attestation-9988-1` };
  return {
    descriptor,
    operation,
    run,
    job,
    inventory: { total_count: 2, artifacts: [artifact, bundle] },
  };
}

void test("catalog original provider discovery binds all five exact producer artifacts despite later unrelated run failure", () => {
  for (const output of outputs) {
    const f = fixture(output);
    const result = inspectCatalogContinuationProvider(
      f.run,
      f.run,
      f.job,
      f.inventory,
      f.operation,
      f.descriptor,
      output,
    );
    assert.equal(result.artifact.id, 100);
    assert.equal(result.bundle.id, 101);
    assert.equal(result.authority, "none");
    for (const change of [
      { run: { ...f.run, actor: { id: 999 } } },
      { run: { ...f.run, head_sha: "9".repeat(40) } },
      { run: { ...f.run, status: "in_progress" } },
      { job: { ...f.job, conclusion: "failure" } },
      { job: { ...f.job, name: "Sign authenticated Stable metadata" } },
      {
        inventory: {
          total_count: 3,
          artifacts: [...f.inventory.artifacts, { ...f.inventory.artifacts[0], id: 102 }],
        },
      },
      {
        inventory: {
          total_count: 2,
          artifacts: f.inventory.artifacts.map((row) => ({ ...row, expired: true })),
        },
      },
      { inventory: { total_count: 3, artifacts: f.inventory.artifacts } },
    ]) {
      const changed = { ...f, ...change };
      assert.throws(() =>
        inspectCatalogContinuationProvider(
          changed.run,
          changed.run,
          changed.job,
          changed.inventory,
          changed.operation,
          changed.descriptor,
          output,
        ),
      );
    }
  }
});

void test("catalog continuation never treats incomplete upload, changed bundle or application output as settled custody", () => {
  const f = fixture("definitions");
  for (const change of [
    { outcome: "ambiguous" },
    { completed_effects: [] },
    {
      completed_effects: [
        {
          remote_identity: "github-actions:boburning/portcove:artifact:999",
          evidence_sha256: "2".repeat(64),
        },
      ],
    },
    {
      catalog_publication: {
        ...f.operation.catalog_publication,
        descriptor: { ...f.descriptor, bundle_sha256: "8".repeat(64) },
      },
    },
    { executor_identity: { ...f.operation.executor_identity, role: "tuf-snapshot" } },
  ]) {
    assert.throws(() =>
      inspectCatalogContinuationProvider(
        f.run,
        f.run,
        f.job,
        f.inventory,
        { ...f.operation, ...change },
        f.descriptor,
        "definitions",
      ),
    );
  }
  assert.throws(() => inspectCatalogContinuationOperation(f.operation, f.descriptor, "policy"));
});

void test("actual continuation refuses expired or imported tool receipts before provider or retained attempt creation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-continuation-import-"));
  try {
    await assert.rejects(
      continueActualCatalogPublication(
        {},
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() - 1,
      ),
    );
    await assert.rejects(
      continueActualCatalogPublication(
        { kind: "actual-controller-tools" },
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("injected actual continuation body joins original five receivers before read-only verifier and exact handoff; missing custody never signs", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-continuation-flow-"));
  try {
    const source = await readFile(
        new URL("./release-catalog-recovery.mts", import.meta.url),
        "utf8",
      ),
      start = source.indexOf("export async function continueActualCatalogPublication("),
      operations = new Map(outputs.map((output) => [output, fixture(output).operation])),
      descriptor = catalogPublicationFixture(),
      contextProducer = operations.get("context")!.executor_identity,
      checkpoint = "a".repeat(40),
      calls: string[] = [];
    const pages = {
      ...fixture("context").operation,
      destination: "github-pages:boburning/portcove:complete-site",
      executor_identity: { ...contextProducer, role: "site-publication" },
      catalog_site_expectation: {
        artifact_id: 42,
        archive_sha256: "9".repeat(64),
        catalog_root_sha256: descriptor.prior.catalog_root_sha256,
        catalog_repository_sha256: "b".repeat(64),
        site_generation_sha256: "c".repeat(64),
        prior_site_generation_sha256: null,
        application_root_sha256: null,
      },
      completed_effects: [
        {
          remote_identity: `github-pages:boburning/portcove:${"c".repeat(64)}`,
          evidence_sha256: "d".repeat(64),
        },
      ],
    };
    const input = {
      catalog_publication: descriptor,
      active_candidate: null,
      review_disposition: null as Record<string, unknown> | null,
      controller: { capacity_attempt: { operation: pages } },
    };
    const archive = Buffer.from("controlled context archive; not an attestation"),
      hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
      manifest = {
        kind: "catalog-signing-context",
        controller: {
          controller_revision: contextProducer.controller_revision,
          controller_ref: contextProducer.execution_ref,
          run_id: contextProducer.run_id,
          run_attempt: 1,
          source_tree: "2".repeat(40),
        },
        facts: { descriptor },
        binding: {},
        facts_sha256: "4".repeat(64),
        previous_site_pins: descriptor.prior,
      },
      tools = { identity: { ...manifest.controller, run_id: "current" } },
      controls = { evidence_scope: "github.com", readMaintenance: () => ({}) };
    const executionEnvironment: Record<string, string | undefined> = {};
    let missing = false,
      mutateEnvironment = false,
      roleIndex = 0;
    const invoke = runInNewContext(
      stripTypeScriptTypes(source.slice(start).replace("export ", "")) +
        "\ncontinueActualCatalogPublication",
      {
        assert,
        Buffer,
        process: { env: executionEnvironment },
        performance,
        path,
        JSON,
        Math,
        Object,
        Map,
        Set,
        mkdtemp,
        mkdir,
        writeFile,
        digest,
        hash,
        isRecord,
        settled: (raw: { outcome: string }) => raw.outcome === "succeeded",
        base: "repos/boburning/portcove",
        catalogSigningRoles: outputs.slice(1),
        signingContextRemaining: (deadline: number) => {
          assert.ok(deadline > performance.now());
          return 15000;
        },
        coordinatorCommandTimeout: () => 15000,
        inspectCoordinatorRemoteNamespace: (raw: { namespace: string }) => raw.namespace,
        withCoordinatorDeadline: (_deadline: number, work: () => unknown) => work(),
        verifiedControllerToolPaths: async () => tools,
        GitHubApiClient: class {
          request() {
            return { status: 200, body: {} };
          }
        },
        createGitHubRunner: () => () => {
          throw new Error("injected client should own transport");
        },
        requireControllerCatalogJobAuthorities: async () => ({
          namespace: "portcove-production",
          configuration_sha256: descriptor.publisher_configuration_sha256,
        }),
        readProductionControllerWorkflowBytes: async () => Buffer.from("inert"),
        authenticateCatalogControlReaderJob: async () => ({
          identity: { evidence_scope: "github.com" },
          admitted: {
            revision: tools.identity.controller_revision,
            execution_ref: tools.identity.controller_ref,
            run_id: tools.identity.run_id,
            run_attempt: 1,
            actor_id: "1",
          },
        }),
        recoverRemoteCoordinator: async () => ({ repository: parent, checkpoint, input }),
        inspectCatalogPublicationDescriptor: (raw: unknown) => raw,
        inspectCapacityOperation: (raw: unknown) => raw,
        prepareControlReadiness: () => ({}),
        retainControlStepLocator: async () => {},
        waitForControlArtifact: async () => ({}),
        authenticateCatalogReleaseControlSource: async () => controls,
        catalogCoordinatorMaintenanceIdentity: () => "same-controls",
        authenticateCapacityExecutor: async () => ({}),
        controllerOidcSubject: () => "fixed",
        readRemoteCoordinatorSnapshot: async () => ({ checkpoint, input }),
        refreshCapacityExecutor: async () => ({}),
        readCatalogContinuationOperations: async () => {
          if (missing) throw new Error("original role missing");
          return operations;
        },
        readCompleteRunArtifactInventory: () => ({}),
        inspectCatalogContinuationProvider: (
          _run: unknown,
          _attempt: unknown,
          _job: unknown,
          _inventory: unknown,
          op: typeof operations extends Map<unknown, infer V> ? V : never,
        ) => ({
          artifact: { id: 100, sha256: hash(archive), bytes: archive.length },
          bundle: { id: 101, sha256: "5".repeat(64) },
          producer: op.executor_identity,
          authority: "none",
        }),
        readGitHubArtifactArchive: () => archive,
        inspectSigningContextArchive: () => ({ manifest, manifest_sha256: "6".repeat(64) }),
        inspectCatalogSigningBinding: () => ({ facts: { descriptor } }),
        receiveCatalogSigningContextArtifact: async () => {
          calls.push("original-context");
          return {};
        },
        requireReceivedCatalogSigningContext: async () => ({}),
        receiveCatalogRoleArtifact: async (
          _context: object,
          _directory: string,
          locator: { role: string },
        ) => {
          calls.push(`original-${locator.role}`);
          return {};
        },
        requireRetainedCatalogRoleArtifact: async () => ({
          envelope: { path: path.join(parent, "envelope.json") },
        }),
        readControllerToolFile: async () =>
          Buffer.from(
            JSON.stringify({
              pending: { operation_id: operations.get(outputs[++roleIndex]!)!.id },
            }),
          ),
        assembleActualCatalogRepositoryForRecovery: async () => {
          calls.push("read-only-verifier");
          return {};
        },
        recoverActualCatalogSitePublication: async (
          _receipt: object,
          _executor: object,
          raw: { checkpoint: string },
          guards: { refresh: () => Promise<void>; beforeMutation: () => void },
        ) => {
          assert.equal(raw.checkpoint, checkpoint);
          await guards.refresh();
          if (mutateEnvironment) executionEnvironment.PORTCOVE_CATALOG_AUTHORITIES = "changed";
          guards.beforeMutation();
          calls.push("exact-handoff");
          return { checkpoint: "next" };
        },
      },
    ) as (...args: unknown[]) => Promise<{ decision: string }>;
    const result = await invoke(
      {},
      { schema_version: 1, namespace: "portcove-production" },
      parent,
      performance.now() + 30000,
    );
    assert.equal(result.decision, "catalog-publication-recovered");
    assert.deepEqual(calls, [
      "original-context",
      "original-definitions",
      "original-policy",
      "original-snapshot",
      "original-timestamp",
      "read-only-verifier",
      "exact-handoff",
    ]);
    calls.length = 0;
    missing = true;
    await assert.rejects(
      invoke(
        {},
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      /catalog continuation held/,
    );
    assert.deepEqual(calls, []);
    missing = false;
    input.review_disposition = { retained: "application negative result" };
    await assert.rejects(
      invoke(
        {},
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      /catalog continuation held/,
    );
    assert.deepEqual(calls, [], "application negative history cannot enter catalog receivers");
    input.review_disposition = null;
    mutateEnvironment = true;
    roleIndex = 0;
    await assert.rejects(
      invoke(
        {},
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      /catalog continuation held/,
    );
    assert.equal(calls.join(",").includes("read-only-verifier"), true);
    assert.equal(
      calls.join(",").includes("exact-handoff"),
      false,
      "changed protected environment cannot reach final journal handoff",
    );
    assert.ok(
      (await readdir(parent)).length >= 2,
      "separate actual filesystem captures are retained on refusal",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("actual continuation guard renews and checks maintenance LAST after delayed journal/executor reads", async () => {
  const source = await readFile(new URL("./release-catalog-recovery.mts", import.meta.url), "utf8"),
    start = source.indexOf("const guard = async () => {"),
    end = source.indexOf("await guard();", start),
    descriptor = catalogPublicationFixture(),
    checkpoint = "a".repeat(40),
    events: string[] = [];
  let now = 0,
    changed = false;
  const initial = {
      evidence_scope: "github.com",
      readMaintenance: () => {
        events.push("old-maintenance");
        return "stable";
      },
    },
    fresh = {
      evidence_scope: "github.com",
      readMaintenance: () => {
        events.push("final-maintenance");
        return changed ? "changed" : "stable";
      },
    };
  const guard = runInNewContext(
    stripTypeScriptTypes(
      `let controls = initial, observed = 0, round = 0; ${source.slice(start, end)}\nguard`,
    ),
    {
      initial,
      originalDeadline: 170000,
      toolsReceipt: {},
      directory: "controlled",
      remote: {},
      executor: {},
      checkpoint,
      descriptor,
      stable: "stable",
      api: {},
      spawn: undefined,
      digest,
      path,
      performance: { now: () => now },
      signingContextRemaining: (deadline: number) => {
        assert.ok(now < deadline);
        events.push("original-clock");
        return 15000;
      },
      verifiedControllerToolPaths: async () => {
        events.push("tools");
      },
      readRemoteCoordinatorSnapshot: async () => {
        events.push("journal");
        now = 61000;
        return { checkpoint, input: { catalog_publication: descriptor } };
      },
      refreshCapacityExecutor: async () => {
        events.push("executor");
      },
      authenticateCatalogReleaseControlRound: async () => {
        events.push("renew");
        return fresh;
      },
      catalogCoordinatorMaintenanceIdentity: (raw: unknown) => raw,
    },
  ) as () => Promise<void>;
  await guard();
  assert.deepEqual(events.slice(-4), ["executor", "renew", "final-maintenance", "original-clock"]);
  changed = true;
  await assert.rejects(guard(), /catalog continuation controls changed/);
  assert.equal(events.at(-1), "final-maintenance");
});
