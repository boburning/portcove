import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import os from "node:os";
import { isRecord } from "./runtime-values.mts";
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

const outputs = ["context", "definitions", "policy", "snapshot", "timestamp"] as const;
function fixture(output: (typeof outputs)[number], index = 0) {
  const descriptor = catalogPublicationFixture(),
    capacity = capacityFixture();
  const producer = {
    actor_id: "1122",
    check_run_id: String(777 + index),
    controller_revision: "1".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    job_id: 501 + index,
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
        remote_identity: `github-actions:boburning/portcove:artifact:${100 + index * 2}`,
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
    id: 100 + index * 2,
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
  const bundle = { ...artifact, id: 101 + index * 2, name: `${prefix}-attestation-9988-1` };
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

async function catalogContinuationBehavior(
  entry: string,
  parent: string,
  packet: ReturnType<typeof fixture>[],
  sourceOverride?: string,
) {
  if (sourceOverride !== undefined) {
    const { registerHooks, stripTypeScriptTypes } = await import("node:module");
    registerHooks({
      load(url, context, next) {
        const original = next(url, context);
        return url === entry
          ? {
              ...original,
              format: "module",
              source: stripTypeScriptTypes(sourceOverride, { mode: "strip" }),
            }
          : original;
      },
    });
  }
  const { mock } = await import("node:test");
  const childProcess = await import("node:child_process");
  const forbidden = () => {
    throw new Error("Unowned process, custody or publication effect is forbidden");
  };
  const processes = Object.fromEntries(
    Object.entries(childProcess)
      .filter(([name]) => name !== "default")
      .map(([name, value]) => [name, typeof value === "function" ? forbidden : value]),
  );
  mock.module("node:child_process", { namedExports: processes, defaultExport: processes });
  process.kill = forbidden;
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { performance } = await import("node:perf_hooks");
  const { default: path } = await import("node:path");
  const { capacityDigest: digest } = (await import(
    new URL("release-capacity.mts", entry).href
  )) as typeof import("./release-capacity.mts");
  const { catalogPublicationFixture } = (await import(
    new URL("fixtures/release-catalog-publication-fixture.mts", entry).href
  )) as typeof import("./fixtures/release-catalog-publication-fixture.mts");
  const { catalogPublicationLifecycle } = (await import(
    new URL("release-catalog-publication-contract.mts", entry).href
  )) as typeof import("./release-catalog-publication-contract.mts");
  const { isRecord } = (await import(
    new URL("runtime-values.mts", entry).href
  )) as typeof import("./runtime-values.mts");
  const productionControllerWorkflow = packet[0]!.run.path;
  const outputs = ["context", "definitions", "policy", "snapshot", "timestamp"] as const;
  const fixture = (output: (typeof outputs)[number]) =>
    structuredClone(packet[outputs.indexOf(output)]!);
  try {
    const operations = new Map(outputs.map((output) => [output, fixture(output).operation])),
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
    const {
      id: _id,
      outcome: _outcome,
      completed_effects: _effects,
      failure_evidence: _failure,
      recovery: _recovery,
      ...pagesIdentity
    } = pages;
    pages.id = digest(pagesIdentity);
    const prior = [...operations.values()].map((operation) => ({
      summary_schema_version: 1,
      subject: { kind: "catalog-publication", identity: catalogPublicationLifecycle(descriptor) },
      kind: "upload",
      destination_sha256: digest(operation.destination),
      transient_retries: 0,
      substantive_repairs: 0,
      completed: true,
      attempts: [{ checkpoint, id: operation.id, operation_sha256: digest(operation) }],
    }));
    const input = {
      catalog_publication: descriptor,
      active_candidate: null,
      review_disposition: null as Record<string, unknown> | null,
      controller: {
        capacity_attempt: { schema_version: 2, operation: pages, prior_operations: prior },
      },
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
    const executionEnvironment = process.env;
    const toolsReceipt = Object.freeze({ kind: "inert-tool-receipt" });
    const contextReceipt = Object.freeze({ kind: "inert-context-receipt" });
    const receivedRoles: object[] = [];
    let mutateEnvironment = false,
      roleIndex = 0;
    const peers = {
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
      verifiedControllerToolPaths: async (receipt: object) => {
        assert.equal(receipt, toolsReceipt);
        return tools;
      },
      GitHubApiClient: class {
        request(method: string, endpoint: string) {
          assert.equal(method, "GET");
          const route = endpoint.replace("repos/boburning/portcove/", "");
          if (route === "actions/runs/9988" || route === "actions/runs/9988/attempts/1")
            return { status: 200, body: fixture("context").run };
          const job = /^actions\/jobs\/([0-9]+)$/u.exec(route);
          if (job) {
            const row = outputs
              .map((output) => fixture(output))
              .find((row) => row.job.id === Number(job[1]));
            assert.ok(row);
            return { status: 200, body: row.job };
          }
          assert.equal(route, "actions/runs/9988/artifacts?per_page=100&page=1");
          const artifacts = outputs.flatMap((output) => fixture(output).inventory.artifacts);
          artifacts[0]!.digest = `sha256:${hash(archive)}`;
          artifacts[0]!.size_in_bytes = archive.length;
          return { status: 200, body: { total_count: artifacts.length, artifacts } };
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
      readGitHubArtifactArchive: () => archive,
      inspectSigningContextArchive: () => ({ manifest, manifest_sha256: "6".repeat(64) }),
      inspectCatalogSigningBinding: () => ({ facts: { descriptor } }),
      receiveCatalogSigningContextArtifact: async () => {
        calls.push("original-context");
        receivedRoles.length = 0;
        return contextReceipt;
      },
      requireReceivedCatalogSigningContext: async (receipt: object) => {
        assert.equal(receipt, contextReceipt);
        return {};
      },
      receiveCatalogRoleArtifact: async (
        _context: object,
        _directory: string,
        locator: { role: string },
      ) => {
        assert.equal(_context, contextReceipt);
        calls.push(`original-${locator.role}`);
        const receipt = Object.freeze({ role: locator.role });
        receivedRoles.push(receipt);
        return receipt;
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
      assembleActualCatalogRepositoryForRecovery: async (
        context: object,
        tools: object,
        roles: object[],
      ) => {
        assert.equal(context, contextReceipt);
        assert.equal(tools, toolsReceipt);
        assert.equal(roles.length, 4, "catalog verifier must consume four original role receipts");
        assert.equal(
          receivedRoles.length,
          4,
          "catalog verifier must consume four original role receipts",
        );
        for (const [index, receipt] of roles.entries()) assert.equal(receipt, receivedRoles[index]);
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
      readRetainedCapacityOperation: (
        _repository: string,
        proof: { id: string; operation_sha256: string },
      ) => {
        const operation = [...operations.values()].find((operation) => operation.id === proof.id);
        assert.ok(operation);
        assert.equal(digest(operation), proof.operation_sha256);
        return operation;
      },
    };
    const moduleOwners: Record<string, string[]> = {
      "release-controller-tool-admission.mts": ["verifiedControllerToolPaths"],
      "github-api.mts": ["GitHubApiClient", "createGitHubRunner"],
      "github-binary.mts": ["readGitHubArtifactArchive"],
      "release-coordinator-recovery.mts": [
        "recoverRemoteCoordinator",
        "readRemoteCoordinatorSnapshot",
        "hydrateRetainedCoordinatorOperation",
      ],
      "release-coordinator-state.mts": ["readRetainedCapacityOperation"],
      "release-coordinator-remote.mts": ["inspectCoordinatorRemoteNamespace"],
      "release-coordinator-deadline.mts": ["withCoordinatorDeadline", "coordinatorCommandTimeout"],
      "release-authority-configuration.mts": ["requireControllerCatalogJobAuthorities"],
      "production-controller-admission.mts": [
        "readProductionControllerWorkflowBytes",
        "productionControllerWorkflow",
      ],
      "release-live-control-admission.mts": [
        "authenticateCatalogControlReaderJob",
        "authenticateCatalogReleaseControlSource",
        "authenticateCatalogReleaseControlRound",
      ],
      "assembler-job-identity.mts": ["controllerOidcSubject"],
      "release-capacity-executor.mts": [
        "authenticateCapacityExecutor",
        "refreshCapacityExecutor",
        "recoverOwnedCapacityEffect",
      ],
      "release-coordinator-driver.mts": ["catalogCoordinatorMaintenanceIdentity"],
      "release-control-handshake.mts": ["prepareControlReadiness", "waitForControlArtifact"],
      "release-control-step-bridge.mts": ["retainControlStepLocator"],
      "release-signing-context-artifact.mts": [
        "inspectSigningContextArchive",
        "receiveCatalogSigningContextArtifact",
        "requireReceivedCatalogSigningContext",
        "signingContextRemaining",
      ],
      "release-tuf-role-artifact.mts": [
        "receiveCatalogRoleArtifact",
        "requireRetainedCatalogRoleArtifact",
      ],
      "release-controller-tools.mts": ["readControllerToolFile"],
      "release-pages-provider.mts": ["createPagesProviderTransport"],
      "release-site-readback.mts": [
        "materializePublishedCatalogCompleteSite",
        "requirePublishedCatalogCompleteSite",
      ],
      "release-catalog-signing.mts": ["assembleActualCatalogRepositoryForRecovery"],
      "release-catalog-site-controller.mts": ["recoverActualCatalogSitePublication"],
      "release-catalog-signing-contract.mts": [
        "catalogSigningRoles",
        "inspectCatalogSigningBinding",
      ],
    };
    for (const [module, names] of Object.entries(moduleOwners)) {
      const namedExports = Object.fromEntries(
        names.map((name) => [
          name,
          name === "productionControllerWorkflow"
            ? productionControllerWorkflow
            : (Reflect.get(peers, name) ?? forbidden),
        ]),
      );
      mock.module(new URL(module, entry).href, { namedExports });
    }
    const actual: unknown = await import(entry);
    assert.ok(isRecord(actual));
    const selected: unknown = actual.continueActualCatalogPublication;
    assert.equal(typeof selected, "function");
    const invoke = selected as (...args: unknown[]) => Promise<{ decision: string }>;

    const result = await invoke(
      toolsReceipt,
      { schema_version: 1, namespace: "portcove-production" },
      parent,
      performance.now() + 30000,
    );
    assert.equal(
      result.decision,
      "catalog-publication-recovered",
      "catalog continuation entry must reach the exact recovered decision",
    );
    assert.deepEqual(calls, [
      "original-context",
      "original-definitions",
      "original-policy",
      "original-snapshot",
      "original-timestamp",
      "read-only-verifier",
      "exact-handoff",
    ]);
    const heldFor = (message: string) => (error: unknown) =>
      error instanceof Error &&
      /catalog continuation held/u.test(error.message) &&
      error.cause instanceof Error &&
      error.cause.message === message;
    calls.length = 0;
    input.controller.capacity_attempt.prior_operations = prior.filter(
      (group) => group.destination_sha256 !== digest(operations.get("policy")!.destination),
    );
    await assert.rejects(
      invoke(
        toolsReceipt,
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      heldFor("original complete catalog output set missing or ambiguous; retain HOLD"),
      "missing catalog output must reach the original completeness refusal",
    );
    assert.deepEqual(calls, []);
    input.controller.capacity_attempt.prior_operations = prior;
    input.review_disposition = { retained: "application negative result" };
    await assert.rejects(
      invoke(
        toolsReceipt,
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      heldFor("catalog continuation cannot replace application work or protected configuration"),
    );
    assert.deepEqual(calls, [], "application negative history cannot enter catalog receivers");
    input.review_disposition = null;
    mutateEnvironment = true;
    roleIndex = 0;
    await assert.rejects(
      invoke(
        toolsReceipt,
        { schema_version: 1, namespace: "portcove-production" },
        parent,
        performance.now() + 30000,
      ),
      heldFor("catalog protected mutation configuration changed"),
      "changed protected environment must refuse the final handoff",
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
}

void test(
  "imported actual continuation joins original five receivers before read-only verifier and exact handoff; missing custody never signs",
  { timeout: 60_000 },
  async (t) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-continuation-flow-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const { spawnSync } = await import("node:child_process");
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const packet = outputs.map((output, index) => fixture(output, index));
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--input-type=module",
        "--eval",
        `import assert from 'node:assert/strict';await (${catalogContinuationBehavior.toString()})(${JSON.stringify(new URL("./release-catalog-recovery.mts", import.meta.url).href)},${JSON.stringify(parent)},${JSON.stringify(packet)});`,
      ],
      { encoding: "utf8", env: environment, timeout: 45_000, maxBuffer: 65536 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);

function* catalogControlNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) for (const child of value) yield* catalogControlNodes(child);
  else if (isRecord(value)) {
    if (typeof value.type === "string") yield value;
    for (const child of Object.values(value)) yield* catalogControlNodes(child);
  }
}
function catalogControlName(value: unknown) {
  return isRecord(value)
    ? value.type === "Identifier" && typeof value.name === "string"
      ? value.name
      : typeof value.value === "string"
        ? value.value
        : undefined
    : undefined;
}
function catalogControlRange(node: unknown) {
  assert.ok(isRecord(node) && typeof node.start === "number" && typeof node.end === "number");
  assert.ok(node.start >= 0 && node.end > node.start);
  return { start: node.start, end: node.end };
}
function catalogControlEdit(source: string, node: unknown, text: string) {
  const range = catalogControlRange(node);
  return source.slice(0, range.start) + text + source.slice(range.end);
}

void test(
  "catalog continuation behavior tolerates real source refactors and kills removed guards, dependency and receipt inputs",
  { timeout: 360_000 },
  async (t) => {
    const { parseAst } = await import("vite-plus");
    const { createHash } = await import("node:crypto");
    const { spawnSync } = await import("node:child_process");
    const source = await readFile(
      new URL("./release-catalog-recovery.mts", import.meta.url),
      "utf8",
    );
    const tree: unknown = parseAst(stripTypeScriptTypes(source, { mode: "strip" }));
    const nodes = [...catalogControlNodes(tree)];
    const exported = nodes.filter((node) => node.type === "ExportNamedDeclaration");
    let binding = "continueActualCatalogPublication";
    for (const node of exported)
      if (Array.isArray(node.specifiers))
        for (const item of node.specifiers) {
          if (
            isRecord(item) &&
            catalogControlName(item.exported) === "continueActualCatalogPublication"
          ) {
            const local = catalogControlName(item.local);
            assert.ok(local);
            binding = local;
          }
        }
    const entry = nodes.find(
      (node) => node.type === "FunctionDeclaration" && catalogControlName(node.id) === binding,
    );
    assert.ok(entry && isRecord(entry.body));
    const declaration = exported.find((node) => node.declaration === entry) ?? entry;
    const declarationRange = catalogControlRange(declaration);
    const entryNodes = [...catalogControlNodes(entry.body)];
    const imported = (module: string, name: string) => {
      const matches: unknown[] = nodes
        .filter(
          (node) =>
            node.type === "ImportDeclaration" &&
            isRecord(node.source) &&
            node.source.value === module,
        )
        .flatMap((node) => (Array.isArray(node.specifiers) ? (node.specifiers as unknown[]) : []));
      const selected = matches.find(
        (item) => isRecord(item) && catalogControlName(item.imported) === name,
      );
      assert.ok(isRecord(selected));
      const local = catalogControlName(selected.local);
      assert.ok(local);
      return local;
    };
    const call = (name: string) => {
      const selected = entryNodes.find(
        (node) => node.type === "CallExpression" && catalogControlName(node.callee) === name,
      );
      assert.ok(selected && Array.isArray(selected.arguments));
      return selected;
    };
    const role = call(imported("./release-tuf-role-artifact.mts", "receiveCatalogRoleArtifact"));
    const assemble = call(
      imported("./release-catalog-signing.mts", "assembleActualCatalogRepositoryForRecovery"),
    );
    assert.ok(Array.isArray(assemble.arguments));
    const handoff = call(
      imported("./release-catalog-site-controller.mts", "recoverActualCatalogSitePublication"),
    );
    assert.ok(Array.isArray(handoff.arguments));
    const finalizers: unknown = handoff.arguments[3];
    assert.ok(isRecord(finalizers) && Array.isArray(finalizers.properties));
    const beforeProperty: unknown = finalizers.properties.find(
      (item: unknown) => isRecord(item) && catalogControlName(item.key) === "beforeMutation",
    );
    assert.ok(isRecord(beforeProperty));
    const beforeBinding = catalogControlName(beforeProperty.value);
    assert.ok(beforeBinding);
    const before = entryNodes.find(
      (node) => node.type === "VariableDeclarator" && catalogControlName(node.id) === beforeBinding,
    );
    assert.ok(before && isRecord(before.init) && before.init.type === "ArrowFunctionExpression");
    const missingThrow = nodes.find(
      (node) =>
        node.type === "ThrowStatement" &&
        [...catalogControlNodes(node.argument)].some(
          (child) =>
            child.type === "Literal" &&
            child.value ===
              "original complete catalog output set missing or ambiguous; retain HOLD",
        ),
    );
    assert.ok(missingThrow);
    const missingGate = nodes.find(
      (node) =>
        node.type === "IfStatement" &&
        [...catalogControlNodes(node.consequent)].includes(missingThrow),
    );
    assert.ok(missingGate);
    const variants = [
      {
        name: "declaration-order",
        source:
          source.slice(declarationRange.start, declarationRange.end) +
          "\n" +
          catalogControlEdit(source, declaration, ""),
      },
      {
        name: "private-name-layout",
        source: source
          .replace(/\bsettled\b/gu, "observedSettledUpload")
          .replace(/\bconst /gu, "const /* harmless layout */ "),
      },
      {
        name: "entry-no-op",
        source: catalogControlEdit(source, entry.body, '{ return { decision: "bypassed" }; }'),
        marker: "catalog continuation entry must reach the exact recovered decision",
      },
      {
        name: "removed-completeness-guard",
        source: catalogControlEdit(source, missingGate.test, "false"),
        marker: "missing catalog output must reach the original completeness refusal",
      },
      {
        name: "wrong-receiver-dependency",
        source: catalogControlEdit(
          source,
          role.callee,
          imported(
            "./release-signing-context-artifact.mts",
            "receiveCatalogSigningContextArtifact",
          ),
        ),
        marker: "catalog verifier must consume four original role receipts",
      },
      {
        name: "dropped-artifact-inputs",
        source: catalogControlEdit(source, assemble.arguments[2], "[]"),
        marker: "catalog verifier must consume four original role receipts",
      },
      {
        name: "removed-protected-guard",
        source: catalogControlEdit(source, before.init.body, "{}"),
        marker: "changed protected environment must refuse the final handoff",
      },
    ];
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const packet = outputs.map((output, index) => fixture(output, index));
    for (const variant of variants)
      await t.test(variant.name, { timeout: 60_000 }, async (control) => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-entry-control-"));
        control.after(() => rm(parent, { recursive: true, force: true }));
        const result = spawnSync(
          process.execPath,
          [
            "--experimental-test-module-mocks",
            "--input-type=module",
            "--eval",
            `import assert from 'node:assert/strict';await (${catalogContinuationBehavior.toString()})(${JSON.stringify(new URL("./release-catalog-recovery.mts", import.meta.url).href)},${JSON.stringify(parent)},${JSON.stringify(packet)},${JSON.stringify(variant.source)});`,
          ],
          { env: environment, encoding: "utf8", timeout: 45_000, maxBuffer: 65536 },
        );
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        if (variant.marker) {
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.ok(result.stderr.includes(variant.marker), result.stderr);
        } else assert.equal(result.status, 0, result.stderr || result.stdout);
        control.diagnostic(
          JSON.stringify({
            variant: variant.name,
            source_sha256: createHash("sha256").update(variant.source).digest("hex"),
            status: result.status,
            expected: variant.marker ?? "all original behavior observations pass",
            witness: variant.marker ? result.stderr.slice(-8192) : null,
          }),
        );
      });
  },
);

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
