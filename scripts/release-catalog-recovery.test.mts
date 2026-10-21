import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import { catalogSigningRoles } from "./release-catalog-signing-contract.mts";
import { inspectCatalogTufPublicationReport } from "./release-catalog-metadata-contract.mts";
import { assertCatalogSitePublicationBinding } from "./release-catalog-publication-contract.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([target, bytes]) => ({ target, bytes: bytes.length, sha256: hash(bytes) }));

void test("injected recovery join verifies existing public bytes and original roles without assembly or a new clock", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "catalog-read-only-join-"));
  try {
    const repository = path.join(parent, "public"),
      context = path.join(parent, "context");
    await mkdir(repository);
    await mkdir(context);
    const files = new Map<string, Buffer>([["targets/index", Buffer.from("reviewed-index")]]);
    const roles = catalogSigningRoles.map((role) => {
      const wire = role === "definitions" || role === "policy" ? `official-${role}` : role;
      const bytes = Buffer.from(`original separately attested ${role} envelope`);
      files.set(
        role === "timestamp" ? "metadata/timestamp.json" : `metadata/1.${wire}.json`,
        bytes,
      );
      return { sha256: hash(bytes) };
    });
    for (const [name, bytes] of files) {
      await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
      await writeFile(path.join(repository, name), bytes);
    }
    const descriptor = catalogPublicationFixture(),
      version = Object.fromEntries(["targets", ...catalogSigningRoles].map((role) => [role, "1"])),
      expires = Object.fromEntries(
        ["targets", ...catalogSigningRoles].map((role) => [role, "2099-01-01T00:00:00Z"]),
      );
    const report = {
      schema_version: 1,
      authority: "none",
      changed: false,
      files: inventory(files),
      repository_sha256: hash(Buffer.from(JSON.stringify(inventory(files)))),
      index_sha256: hash(files.get("targets/index")!),
      root_sha256: descriptor.prior.catalog_root_sha256,
      offline_targets_sha256: "8".repeat(64),
      timestamp_sha256: roles[3]!.sha256,
      snapshot_sha256: roles[2]!.sha256,
      versions: version,
      expires,
    };
    await writeFile(
      path.join(context, "core-inspection.json"),
      JSON.stringify({ index_sha256: report.index_sha256 }),
    );
    const expected = {
      application_root_sha256: null,
      archive_sha256: "9".repeat(64),
      artifact_id: 4,
      catalog_repository_sha256: inspectCatalogTufPublicationReport(report).facts.repository_sha256,
      catalog_root_sha256: descriptor.prior.catalog_root_sha256,
      prior_site_generation_sha256: null,
      site_generation_sha256: "a".repeat(64),
    };
    let remoteReads = 0,
      changedIntent = false,
      commandCount = 0,
      badClock = false;
    const operation = {
      kind: "upload",
      destination: "github-pages:boburning/portcove:complete-site",
      outcome: "recovered",
      recovery: { resolution: "effect-completed" } as { resolution: string } | null,
      completed_effects: [
        { remote_identity: "retained original effect", evidence_sha256: "b".repeat(64) },
      ],
      catalog_publication: { descriptor },
      catalog_site_expectation: expected,
    };
    const admitted = {
      tools: { rust: path.join(parent, "binary") },
      context: { context: path.join(context, "context.json") },
      authorities: { namespace: "inert" },
      facts: {
        descriptor,
        root_sha256: report.root_sha256,
        offline_targets_sha256: report.offline_targets_sha256,
        versions: version,
        expires: Object.fromEntries(
          catalogSigningRoles.map((role) => [role, "2099-01-01T00:00:00Z"]),
        ),
      },
      manifest: { previous_site_pins: descriptor.prior },
      binding: {},
    };
    await writeFile(admitted.tools.rust, "inert fixed test tool");
    const source = await readFile(
        new URL("./release-catalog-signing.mts", import.meta.url),
        "utf8",
      ),
      start = source.indexOf("async function verifyPublishedRepositoryForRecovery("),
      end = source.indexOf("async function assembleRepository(", start),
      assemblies = new WeakMap<
        object,
        { recovery_only: boolean; report: ReturnType<typeof inspectCatalogTufPublicationReport> }
      >();
    const invoke = runInNewContext(
      stripTypeScriptTypes(source.slice(start, end)) + "\nverifyPublishedRepositoryForRecovery",
      {
        Buffer,
        path,
        process,
        performance,
        Object,
        Array,
        Set,
        JSON,
        admittedContext: async () => admitted,
        roleInputs: async () => roles,
        catalogSigningRoles,
        mkdtemp,
        mkdir,
        writeFile,
        digest,
        hash,
        inventory,
        isRecord,
        inspectCatalogTufPublicationReport,
        assertCatalogSitePublicationBinding,
        inspectCapacityOperation: (raw: unknown) => raw,
        readRemoteCoordinatorSnapshot: async () => ({
          checkpoint: changedIntent && ++remoteReads > 1 ? "changed" : "original",
          input: {
            catalog_publication: descriptor,
            controller: { capacity_attempt: { operation } },
          },
        }),
        materializePublishedCatalogCompleteSite: async () => ({ receipt: {} }),
        requirePublishedCatalogCompleteSite: async () => ({ catalog: repository }),
        readControllerToolFile: async (file: string) => readFile(file),
        readBoundedReleaseContextFiles,
        payloadSigningEnvironment: () => ({}),
        active: () => 15000,
        fixedApi: () => ({}),
        recheckCatalogSemanticProof: () => {},
        assemblies,
        requireActualCatalogRepositoryForRecovery: async (receipt: object) => {
          assert.equal(assemblies.get(receipt)!.recovery_only, true);
        },
        run: async (_tool: string, args: string[]) => {
          commandCount++;
          assert.equal(args[0], "verify-definition-repository");
          const config: unknown = JSON.parse(await readFile(args[1]!, "utf8"));
          assert.ok(isRecord(config));
          assert.equal(
            Object.keys(config).sort().join(","),
            "offline_targets,offline_targets_sha256,repository,schema_version,trusted_root,trusted_root_sha256",
          );
          return { stdout: JSON.stringify({ ...report, changed: badClock }), stderr: "" };
        },
      },
    ) as (...args: unknown[]) => Promise<object>;
    const receipt = await invoke({}, {}, [{}, {}, {}, {}], parent, performance.now() + 30000);
    assert.equal(assemblies.get(receipt)!.recovery_only, true);
    assert.equal(commandCount, 1);
    const deployment = await readFile(
        new URL("./release-site-deployment.mts", import.meta.url),
        "utf8",
      ),
      handoffStart = deployment.indexOf(
        "export async function prepareCatalogSiteHandoffFromActualRepository(",
      ),
      handoffEnd = deployment.indexOf(
        "export async function recoverPublishedCatalogSiteHandoff(",
        handoffStart,
      );
    let publicReads = 0;
    const actual = assemblies.get(receipt)!;
    const handoff = runInNewContext(
      stripTypeScriptTypes(
        deployment
          .slice(handoffStart, handoffEnd)
          .replace("export ", "")
          .replace('await import("./release-catalog-signing.mts")', "signing"),
      ) + "\nprepareCatalogSiteHandoffFromActualRepository",
      {
        structuredClone,
        Math,
        Object,
        isRecord,
        capacityDigest: digest,
        remaining: () => {},
        withCoordinatorDeadline: (_deadline: number, fn: () => unknown) => fn(),
        signing: {
          requireActualCatalogRepositoryForRecovery: async (value: object) => ({
            ...assemblies.get(value),
            descriptor,
            deadline: performance.now() + 30000,
          }),
        },
        requireControllerCatalogPublicationAuthorities: async () => ({
          configuration_sha256: descriptor.publisher_configuration_sha256,
          catalog: {
            public_source: {
              root: { sha256: report.root_sha256 },
              offline_targets: { sha256: report.offline_targets_sha256 },
            },
          },
        }),
        recoverReleaseOpportunity: async () => ({
          input: {
            catalog_publication: descriptor,
            controller: { capacity_attempt: { operation } },
          },
        }),
        inspectCatalogPublicationDescriptor: (raw: unknown) => raw,
        assertCatalogPublicationBaseline: () => {},
        inspectCatalogTufPublicationFacts: (raw: unknown) => raw,
        inspectCatalogCapacitySubject: (raw: unknown) => raw,
        inspectCatalogSitePublicationExpectation: (raw: unknown) => raw,
        currentPublishedSite: () => null,
        materializePublishedCatalogCompleteSite: async () => {
          publicReads++;
          return {
            directory: repository,
            generation: { previous_generation: null, application_root_sha256: null, files: [] },
          };
        },
        sessions: new WeakMap(),
        recheckCatalogDeployment: async () => {},
      },
    ) as (receipt: object, raw: unknown) => Promise<unknown>;
    const request = {
      repository: "controlled-journal",
      checkpoint: "original",
      output_parent: parent,
      deadline: performance.now() + 30000,
    };
    await handoff(receipt, request);
    assert.equal(publicReads, 1);
    await assert.rejects(
      handoff(receipt, { ...request, checkpoint: "different" }),
      /exact settled catalog Pages subject/,
    );
    operation.catalog_site_expectation.archive_sha256 = "0".repeat(64);
    await assert.rejects(handoff(receipt, request), /exact settled catalog Pages subject/);
    assert.equal(publicReads, 1, "changed intent refuses before another public read");
    operation.catalog_site_expectation.archive_sha256 = "9".repeat(64);

    assert.equal(
      assemblies.get(receipt)!.report.facts.repository_sha256,
      expected.catalog_repository_sha256,
    );
    // The normal publisher getter refuses the private recovery brand too.
    const getterStart = source.indexOf("export async function requireActualCatalogRepository("),
      getterEnd = source.indexOf("/** A read-only recovery receipt", getterStart);
    const ordinary = runInNewContext(
      stripTypeScriptTypes(source.slice(getterStart, getterEnd).replace("export ", "")) +
        "\nrequireActualCatalogRepository",
      { assemblies },
    ) as (receipt: object) => Promise<unknown>;
    await assert.rejects(ordinary(receipt), /actual keyless catalog assembly/);
    operation.outcome = "succeeded";
    operation.recovery = null;
    const succeededReceipt = await invoke(
      {},
      {},
      [{}, {}, {}, {}],
      parent,
      performance.now() + 30000,
    );
    assert.equal(assemblies.get(succeededReceipt)!.recovery_only, true);
    operation.outcome = "recovered";
    operation.recovery = { resolution: "effect-completed" };
    badClock = true;
    await assert.rejects(
      invoke({}, {}, [{}, {}, {}, {}], parent, performance.now() + 30000),
      /catalog public recovery verification refused/,
    );
    badClock = false;
    changedIntent = true;
    remoteReads = 0;
    await assert.rejects(
      invoke({}, {}, [{}, {}, {}, {}], parent, performance.now() + 30000),
      /catalog public recovery verification refused/,
    );
    changedIntent = false;
    roles[0]!.sha256 = "0".repeat(64);
    await assert.rejects(
      invoke({}, {}, [{}, {}, {}, {}], parent, performance.now() + 30000),
      /catalog public recovery verification refused/,
    );
    assert.equal(
      (await readFile(path.join(repository, "metadata/1.official-definitions.json"))).toString(),
      "original separately attested definitions envelope",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
