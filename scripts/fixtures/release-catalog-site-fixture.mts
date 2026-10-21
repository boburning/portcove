/** Controlled module-wiring fixture only. All OIDC, journal, crypto and provider
 * boundaries below are mocked; this never establishes hosted authority. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as signing from "../release-catalog-signing.mts";
import * as config from "../release-authority-configuration.mts";
import * as journal from "../release-coordinator-state.mts";
import * as bootstrap from "../release-bootstrap-public-inputs.mts";
import * as executors from "../release-capacity-executor.mts";
import * as live from "../release-live-control-admission.mts";
import * as github from "../github-api.mts";
import * as binary from "../github-binary.mts";
import * as provider from "../release-pages-provider.mts";
import * as remote from "../release-coordinator-remote.mts";
import * as operation from "../release-capacity-operation.mts";
import { releaseCanonicalDigest as digest } from "../release-canonical.mts";
import { createAuditZip } from "./audit-zip-fixture.mts";
import { inspectCatalogTufPublicationFacts } from "../release-catalog-metadata-contract.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = await mkdtemp(path.join(os.tmpdir(), "catalog-site-joined-"));
try {
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "metadata"), { recursive: true });
  const bytes = Buffer.from("inert target: no Tough authority");
  await writeFile(path.join(repository, "metadata", "timestamp.json"), bytes);
  const inventory = [{ path: "metadata/timestamp.json", bytes: bytes.length, sha256: hash(bytes) }];
  const descriptor = {
    schema_version: 1,
    kind: "catalog-publication",
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    admission_sha256: "c".repeat(64),
    bundle_sha256: "d".repeat(64),
    core_inspection_sha256: "e".repeat(64),
    publisher_configuration_sha256: "f".repeat(64),
    prior: {
      catalog_root_sha256: "1".repeat(64),
      catalog_repository_sha256: null,
      application_root_sha256: null,
      application_repository_sha256: null,
      site_generation_sha256: null,
    },
  };
  const facts = inspectCatalogTufPublicationFacts({
    schema_version: 1,
    root_sha256: "1".repeat(64),
    offline_targets_sha256: "2".repeat(64),
    index_sha256: "3".repeat(64),
    repository_sha256: digest(inventory),
    verifier_repository_sha256: "4".repeat(64),
    snapshot_sha256: "5".repeat(64),
    timestamp_sha256: hash(bytes),
    immutable_targets_sha256: "6".repeat(64),
    versions: { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires: Object.fromEntries(
      ["targets", "definitions", "policy", "snapshot", "timestamp"].map((role) => [
        role,
        "2026-12-01T00:00:00Z",
      ]),
    ),
  });
  assert(facts);
  const initialization = {
    schema_version: 1,
    kind: "catalog-initialization",
    authority: "none",
    source_commit: "7".repeat(40),
    source_tree: "8".repeat(40),
    root_sha256: facts.root_sha256,
    setup_plan_sha256: "9".repeat(64),
    initial_site_preimage_sha256: "a".repeat(64),
    publisher_configuration_sha256: descriptor.publisher_configuration_sha256,
  };
  const input: Record<string, unknown> = {
    catalog_publication: descriptor,
    active_candidate: null,
    catalog_initialization: initialization,
  };
  const receipt = {},
    executor = {},
    controls = {
      evidence_scope: "github.com",
      readMaintenance: () => ({
        pause: { publication_paused: false },
        resource_policy_matches_controller: true,
        capacity_source: { capacity: { boundary: { authority: "none" } } },
      }),
    };
  const identity = {
    role: "site-publication",
    run_id: "123",
    run_attempt: 1,
    controller_revision: "b".repeat(40),
    job_id: 42,
  };
  const deadline = performance.now() + 20000;
  let zip = Buffer.alloc(0),
    posts = 0,
    bootstrapReads = 0,
    custodyReads = 0,
    failCustody = false;
  const install = (name: string, exports: object) =>
    mock.module(new URL(`../${name}.mts`, import.meta.url).href, { namedExports: exports });
  install("release-catalog-signing", {
    ...signing,
    requireActualCatalogRepository: async (value: object) => {
      assert.equal(value, receipt);
      custodyReads++;
      if (failCustody) throw new Error("controlled changed custody");
      return { descriptor, report: { facts }, repository, deadline };
    },
  });
  install("release-authority-configuration", {
    ...config,
    requireControllerCatalogPublicationAuthorities: async () => ({
      configuration_sha256: descriptor.publisher_configuration_sha256,
      catalog: {
        public_source: {
          commit: initialization.source_commit,
          root: { sha256: facts.root_sha256 },
          offline_targets: { sha256: facts.offline_targets_sha256 },
          initial_site_preimage: { sha256: initialization.initial_site_preimage_sha256 },
        },
        setup_plan_sha256: initialization.setup_plan_sha256,
      },
    }),
  });
  install("release-bootstrap-public-inputs", {
    ...bootstrap,
    readConfiguredCatalogBootstrapSite: async () => {
      bootstrapReads++;
      return {
        configuration_sha256: initialization.publisher_configuration_sha256,
        root_sha256: facts.root_sha256,
        setup_plan_sha256: initialization.setup_plan_sha256,
        historical_preimage_sha256: initialization.initial_site_preimage_sha256,
        source: { source_tree: initialization.source_tree },
        authority: "none",
      };
    },
  });
  install("release-coordinator-state", {
    ...journal,
    recoverReleaseOpportunity: async () => ({ input }),
  });
  let atomic = 0;
  install("release-capacity-operation", {
    ...operation,
    recordPublishedCatalogMetadata: async (
      _repo: string,
      _checkpoint: string,
      metadata: Record<string, unknown>,
      site: Record<string, unknown>,
    ) => {
      atomic++;
      assert.equal(metadata.source_commit, descriptor.source_commit);
      assert.equal(metadata.source_tree, descriptor.source_tree);
      assert.deepEqual((site.components as Record<string, unknown>).application, null);
      return { checkpoint: "advanced", durable_checkpoint: "advanced" };
    },
  });
  install("release-coordinator-remote", {
    ...remote,
    publishCoordinatorCheckpoint: async () => ({}),
  });
  install("release-live-control-admission", {
    ...live,
    requireAuthenticatedCatalogControlSource: (value: unknown) => assert.equal(value, controls),
  });
  install("release-capacity-executor", {
    ...executors,
    capacityExecutorIdentity: (value: object) => {
      assert.equal(value, executor);
      return identity;
    },
    refreshCapacityExecutor: async () => identity,
    executeOwnedCapacityEffect: async (
      _executor: object,
      request: Record<string, unknown>,
      boundary: () => Promise<unknown>,
      effect: (pending: object) => Promise<unknown>,
    ) => {
      assert.deepEqual(request.catalog_publication, descriptor);
      const expected = request.request as Record<string, unknown>;
      assert.equal(expected.site_expectation, undefined);
      assert.equal(
        (expected.catalog_site_expectation as Record<string, unknown>).catalog_repository_sha256,
        facts.repository_sha256,
      );
      await boundary();
      const observed = await effect({ checkpoint: "pending", operation_id: "c".repeat(64) });
      const op = { id: "c".repeat(64), outcome: "recovered", completed_effects: [observed] };
      input.controller = { capacity_attempt: { operation: op } };
      return { checkpoint: "settled", operation_id: op.id, ...(observed as object) };
    },
  });
  install("github-api", {
    ...github,
    GitHubApiClient: class {
      request() {
        return {
          status: 200,
          body: {
            id: 70,
            name: "application-update-site-123-1",
            expired: false,
            digest: `sha256:${hash(zip)}`,
            size_in_bytes: zip.length,
            workflow_run: {
              id: 123,
              repository_id: 1354613114,
              head_repository_id: 1354613114,
              head_sha: identity.controller_revision,
            },
          },
        };
      }
    },
  });
  install("github-binary", { ...binary, readGitHubArtifactArchive: () => zip });
  install("release-pages-provider", {
    ...provider,
    createPagesProviderTransport: () => ({
      evidence_scope: "github.com",
      create: async (expected: Record<string, unknown>, guard: () => Promise<void>) => {
        await guard();
        posts++;
        return { ...expected, id: expected.generation };
      },
      observe: (expected: object) => ({ ...expected, status: "succeed" }),
    }),
  });
  const deployment = (await import(
    new URL("../release-site-deployment.mts?controlled-catalog", import.meta.url).href
  )) as typeof import("../release-site-deployment.mts");
  const prepared = await deployment.prepareCatalogSiteDeploymentFromActualRepository(receipt, {
    repository: root,
    checkpoint: "old",
    output_parent: root,
    deadline,
  });
  const tar = await readFile(prepared.archive);
  zip = createAuditZip([["artifact.tar", tar]]);
  await deployment.verifyUploadedSiteArchive(prepared.session, {
    artifact_id: 70,
    run_id: 123,
    run_attempt: 1,
    controller_revision: identity.controller_revision,
  });
  // This fetch is another explicitly controlled byte boundary, not public proof.
  const originalFetch = globalThis.fetch;
  const marker = Buffer.from(JSON.stringify(prepared.generation));
  globalThis.fetch = async (value) => {
    if (typeof value !== "string") throw new Error("controlled fixed URL string required");
    const url = value,
      pathname = new URL(url).pathname.replace(/^\/portcove\//u, "");
    const body =
      pathname === "publication.json" ? marker : pathname === ".nojekyll" ? Buffer.alloc(0) : bytes;
    return Object.defineProperty(new Response(body), "url", { value: url });
  };
  try {
    const result = await deployment.publishPreparedSiteDeployment(
      prepared.session,
      executor as never,
      controls as never,
      {
        repository: root,
        checkpoint: "old",
        remote_configuration: {},
        catalog_publication: descriptor,
      },
    );
    assert.equal(result.checkpoint, "advanced");
    assert.equal(posts, 1);
    assert.equal(atomic, 1);
    assert.ok(bootstrapReads >= 3);
    assert.ok(custodyReads >= 5);
    failCustody = true;
    await assert.rejects(
      deployment.publishPreparedSiteDeployment(
        prepared.session,
        executor as never,
        controls as never,
        {
          repository: root,
          checkpoint: "old",
          remote_configuration: {},
          catalog_publication: descriptor,
        },
      ),
      /changed custody/,
    );
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(
    "controlled catalog composition/archive/sole-pages/atomic-cursor PASS; no actual authority",
  );
} finally {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
