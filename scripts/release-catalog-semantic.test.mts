import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capacityDigest } from "./release-capacity.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import {
  prepareSemanticReviewHandoff,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
import {
  readIndependentCatalogSemanticReview,
  readIndependentSemanticReview,
  inspectCatalogReviewProducerConfiguration,
  inspectReviewProducerConfiguration,
  persistReviewedClassification,
  readReviewedClassification,
  readReviewedClassificationForRequest,
} from "./release-control-inputs.mts";
import {
  discoverIndependentSemanticDisposition,
  readIndependentSemanticCheckInventory,
} from "./release-semantic-disposition-reader.mts";
import {
  prepareFrozenCatalogSemanticInputs,
  requireFrozenSemanticInputs,
} from "./release-semantic-inputs.mts";
import {
  createSemanticBundleReader,
  materializeSemanticReaderIndex,
} from "./release-semantic-reader.mts";
import { inspectSemanticReaderIndex } from "./release-semantic-reader-core.mts";
import {
  inspectSemanticRuntimeEvents,
  requireDirectSemanticCapture,
} from "./release-semantic-runtime.mts";
import {
  publishSemanticCapture,
  requireActualCatalogSemanticReview,
} from "./release-semantic-broker.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(listing?: Buffer) {
  const files = new Map<string, Buffer>([
    ["definitions/index.json", Buffer.from('{"catalog_schema":2,"entries":[]}')],
  ]);
  if (listing) files.set("policy/official/catalog.listings.json", listing);
  const listings = listing
    ? {
        target: "policy/official/catalog.listings.json",
        revision: 1,
        sha256: sha(listing),
        listing_count: 1,
        withdrawn_count: 0,
      }
    : null;
  const entries = [...files].map(([target, bytes]) => ({
    target,
    bytes: bytes.length,
    sha256: sha(bytes),
  }));
  const inspection = Buffer.from(
    JSON.stringify({
      publication_schema: listing ? 2 : 1,
      ...(listings ? { listings } : {}),
      authority: "none",
      index_sha256: entries[0]!.sha256,
      files: entries,
      definitions: [],
      scope: listing
        ? "inert-catalog-publication-inspection"
        : "inert-managed-definition-publication-inspection",
    }),
  );
  return {
    files,
    inspection,
    opportunity: {
      kind: "catalog-publication",
      source_commit: "a".repeat(40),
      source_tree: "b".repeat(40),
      base_commit: "c".repeat(40),
      change_set_sha256: "d".repeat(64),
      bundle_sha256: capacityDigest(entries),
      core_inspection_sha256: sha(inspection),
      publisher_configuration_sha256: "f".repeat(64),
      baseline: {
        source_commit: "c".repeat(40),
        source_tree: "e".repeat(40),
        catalog_root_sha256: "1".repeat(64),
        catalog_repository_sha256: null as string | null,
        site_generation_sha256: null as string | null,
        application_root_sha256: null as string | null,
        application_repository_sha256: null as string | null,
      },
      classification: {
        change: "initial",
        index_sha256: entries[0]!.sha256,
        definitions: [],
        ...(listings ? { listings } : {}),
      },
      compatibility: {
        contract: listing ? "official-catalog-listings-v2" : "official-definition-policy-launch-v1",
        notes: "Inert empty catalog fixture; no actual Core or publisher authority.",
      },
    },
  };
}
function review(opportunity: unknown) {
  return {
    scope: "complete-catalog-publication-opportunity",
    runtime: "codex-independent-local-review",
    session_ref: "inert:catalog-review",
    completed_at: "2026-01-01T00:00:00Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    accepted_opportunity: structuredClone(opportunity),
    report: "Controlled purpose/issuer contract fixture, not actual review acceptance.",
  };
}

void test("catalog availability policy identity needs no managed launch and stays purpose bound", () => {
  const f = fixture();
  const opportunity = {
    ...f.opportunity,
    classification: {
      ...f.opportunity.classification,
      definitions: [
        {
          namespace: "official",
          stable_id: "post-client-catalog",
          revision: 1,
          definition_target: `sha256/${"a".repeat(64)}.json`,
          policy_target: "policy/official/post-client-catalog.json",
          policy_schema: 1,
          policy_revision: 1,
          grant_id: "post-client-test-grant",
          launch_target: null,
          launch_revision: null,
        },
      ],
    },
  };
  const parsed = inspectCatalogSemanticOpportunity(opportunity);
  assert.equal(parsed.classification.definitions[0]?.policy_schema, 1);
  const report = prepareSemanticReviewHandoff(opportunity, review(opportunity));
  const summary = JSON.parse(report.proposed_request.body.output.summary) as Record<
    string,
    unknown
  >;
  assert.equal(summary.purpose, "catalog-publication");
  const wrongLaunch = structuredClone(opportunity);
  Object.assign(wrongLaunch.classification.definitions[0]!, {
    launch_target: "policy/official/post-client-catalog.launch.json",
    launch_revision: 1,
  });
  assert.throws(() => inspectCatalogSemanticOpportunity(wrongLaunch), /launch identity/);
});

void test("catalog serializer binds complete purpose without app semver and refuses changed/incomplete inputs", () => {
  const f = fixture(),
    result = prepareSemanticReviewHandoff(f.opportunity, review(f.opportunity));
  const summary = JSON.parse(result.proposed_request.body.output.summary) as Record<
    string,
    unknown
  >;
  assert.equal(summary.schema_version, 3);
  assert.equal(summary.purpose, "catalog-publication");
  assert.equal(result.authority, "none");
  assert.equal(
    result.proposed_request.body.external_id,
    `portcove-catalog-review-v1:${capacityDigest(f.opportunity)}`,
  );
  for (const field of [
    "bundle_sha256",
    "core_inspection_sha256",
    "publisher_configuration_sha256",
    "source_tree",
    "change_set_sha256",
  ]) {
    const changed = { ...f.opportunity, [field]: "9".repeat(field === "source_tree" ? 40 : 64) };
    assert.throws(
      () => prepareSemanticReviewHandoff(changed, review(f.opportunity)),
      /different exact inputs/,
    );
  }
  assert.throws(() =>
    prepareSemanticReviewHandoff(f.opportunity, {
      ...review(f.opportunity),
      scope: "complete-release-opportunity",
    }),
  );
  assert.throws(() =>
    prepareSemanticReviewHandoff(f.opportunity, {
      ...review(f.opportunity),
      coverage: { accumulated_changes: true, classification: false, compatibility: true },
    }),
  );
  assert.throws(() =>
    inspectCatalogSemanticOpportunity({ ...f.opportunity, base_version: "0.1.0" }),
  );
  assert.throws(() =>
    inspectCatalogSemanticOpportunity({
      ...f.opportunity,
      baseline: { ...f.opportunity.baseline, application_root_sha256: "2".repeat(64) },
    }),
  );
});

void test("catalog review binds exact Core policy/grant/launch identities and refuses unsafe u64 rounding", () => {
  const f = fixture();
  const definition = {
    namespace: "official",
    stable_id: "fixture",
    revision: 5,
    definition_target: `sha256/${"1".repeat(64)}.json`,
    policy_target: "policy/official/fixture.json",
    policy_schema: 3,
    policy_revision: 6,
    grant_id: "fixture-grant",
    launch_target: "policy/official/fixture.launch.json",
    launch_revision: 7,
  };
  const opportunity = {
    ...f.opportunity,
    classification: { ...f.opportunity.classification, definitions: [definition] },
  };
  assert.equal(
    inspectCatalogSemanticOpportunity(opportunity).classification.definitions[0]!.launch_revision,
    7,
  );
  for (const change of [
    { revision: 9007199254740992 },
    { policy_revision: 9007199254740992 },
    { launch_revision: 9007199254740992 },
    { policy_schema: "3" },
    { policy_target: "policy/official/other.json" },
    { launch_target: null },
    { grant_id: "" },
  ])
    assert.throws(() =>
      inspectCatalogSemanticOpportunity({
        ...opportunity,
        classification: {
          ...opportunity.classification,
          definitions: [{ ...definition, ...change }],
        },
      }),
    );
  assert.throws(
    () =>
      prepareSemanticReviewHandoff(
        {
          ...opportunity,
          classification: {
            ...opportunity.classification,
            definitions: [{ ...definition, grant_id: "changed" }],
          },
        },
        review(opportunity),
      ),
    /different exact inputs/,
  );
});

for (const selected of [false, true]) {
  void test(`same independent issuer consumer separates catalog from app and refuses wrong issuer or source (selected=${selected})`, () => {
    const f = fixture(),
      handoff = prepareSemanticReviewHandoff(f.opportunity, review(f.opportunity));
    const body = {
      ...handoff.proposed_request.body,
      id: 303,
      app: { id: 101 },
      output: { ...handoff.proposed_request.body.output, annotations_count: 0 },
    };
    const config = selected
      ? {
          schema_version: 2,
          purpose: "catalog-publication",
          review_app_id: 101,
          review_check_name: semanticReviewCheckName,
        }
      : {
          schema_version: 1,
          review_app_id: 101,
          writer_app_id: 202,
          review_check_name: semanticReviewCheckName,
        };
    let observed = body;
    const api = {
      request(method: string, route: string) {
        assert.equal(method, "GET");
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: route.endsWith("/check-runs/303")
            ? observed
            : { id: 1354613114, full_name: "boburning/portcove", node_id: "fixture" },
        };
      },
      graphql() {
        throw new Error("no mutation");
      },
    } as CoordinatorRemoteApi;
    assert.match(
      readIndependentCatalogSemanticReview(api, config, f.opportunity, 303),
      /catalog-publication/,
    );
    assert.throws(() => readIndependentSemanticReview(api, config, f.opportunity, 303));
    for (const change of [
      { app: { id: 102 } },
      { head_sha: "9".repeat(40) },
      { external_id: "portcove-release-review-v2:" + capacityDigest(f.opportunity) },
      { status: "in_progress" },
      { conclusion: "failure" },
      { name: "generic implementation review" },
    ]) {
      observed = { ...body, ...change };
      assert.throws(() => readIndependentCatalogSemanticReview(api, config, f.opportunity, 303));
    }
    observed = body;
    assert.throws(() =>
      readIndependentCatalogSemanticReview(
        api,
        config,
        { ...f.opportunity, publisher_configuration_sha256: "8".repeat(64) },
        303,
      ),
    );
  });
}

void test("catalog-only semantic projection cannot appoint application persistence or bypass closed producer identity", () => {
  const config = {
    schema_version: 2,
    purpose: "catalog-publication",
    review_app_id: 101,
    review_check_name: semanticReviewCheckName,
  };
  assert.deepEqual(inspectCatalogReviewProducerConfiguration(config), config);
  let calls = 0;
  const api: CoordinatorRemoteApi = {
    request() {
      calls++;
      throw new Error("unexpected provider request");
    },
    graphql() {
      calls++;
      throw new Error("unexpected provider mutation");
    },
  };
  for (const read of [
    () => inspectReviewProducerConfiguration(config),
    () => readIndependentSemanticReview(api, config, {}, 303),
    () =>
      persistReviewedClassification(api, config, {}, 303, () => {
        calls++;
      }),
    () => readReviewedClassification(api, config, {}),
    () => readReviewedClassificationForRequest(api, config, {}),
    () => discoverIndependentSemanticDisposition(api, config, {}),
    () => readIndependentSemanticCheckInventory(api, config, "a".repeat(40)),
  ])
    assert.throws(read, /schema differs/);
  for (const changed of [
    { ...config, purpose: "application" },
    { ...config, purpose: ["catalog-publication"] },
    { ...config, review_app_id: 15368 },
    { ...config, review_check_name: "generic Actions review" },
    { ...config, writer_app_id: 202 },
    { ...config, schema_version: 3 },
    { ...config, extra: true },
    { schema_version: 2, purpose: "catalog-publication", review_app_id: 101 },
  ])
    assert.throws(() =>
      readIndependentCatalogSemanticReview(api, changed, fixture().opportunity, 303),
    );
  assert.equal(
    calls,
    0,
    "invalid producer/configuration fails before provider reads or persistence",
  );
});

for (const largeDirectory of [false, true])
  void test(`catalog source freeze carries exact current and prior bytes through fixed reader (large directory=${largeDirectory}); full observation is required`, async (t) => {
    const listing = largeDirectory
      ? Buffer.from(
          JSON.stringify({
            listing_delivery_schema: 1,
            revision: 1,
            withdrawn_ids: [],
            directory: {
              catalog_schema: 1,
              listings: [{ stable_id: "fixture", description: "x".repeat(2 * 1024 ** 2) }],
            },
          }),
        )
      : undefined;
    const f = fixture(listing),
      source = releaseSourceFixture(),
      root = await mkdtemp(path.join(os.tmpdir(), "catalog-semantic-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
    const git = (args: string[], input?: Buffer | string) =>
      execFileSync("git", ["-C", root, ...args], { input, windowsHide: true })
        .toString()
        .trim();
    for (const text of ["readme\n", "base\n", "source\n"])
      git(["hash-object", "-w", "--stdin"], text);
    const readme = git(["hash-object", "--stdin"], "readme\n");
    for (const blob of [source.oldBlob, source.newBlob])
      git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${blob}\tapp.rs\n`);
    for (const commit of [source.base, source.original])
      git(
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        inspectRemoteCommitObject(commit, commit.sha).object.bytes,
      );
    const prior = new Map([
      [
        "metadata/timestamp.json",
        Buffer.from(
          "inert retained prior bytes, independently authenticated only by actual caller",
        ),
      ],
    ]);
    if (listing)
      prior.set(`targets/${sha(listing)}.policy/official/catalog.listings.json`, listing);
    const priorInventory = [...prior].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha(bytes),
    }));
    const opportunity = {
      ...f.opportunity,
      source_commit: source.original.sha,
      source_tree: source.sourceTree,
      base_commit: source.base.sha,
      change_set_sha256: source.expectedHash,
      baseline: {
        ...f.opportunity.baseline,
        source_commit: source.base.sha,
        source_tree: source.base.tree.sha,
        catalog_repository_sha256: capacityDigest(priorInventory),
        site_generation_sha256: "7".repeat(64),
      },
      classification: { ...f.opportunity.classification, change: "update" },
    };
    const input = { files: f.files, inspection: f.inspection, prior_repository: prior };
    const mutableInspection = Buffer.from(f.inspection);
    const api = {
      request(method: string, endpoint: string) {
        mutableInspection.fill(0);
        return source.api.request(method, endpoint);
      },
    };
    const bundle = prepareFrozenCatalogSemanticInputs(api, root, opportunity, {
      ...input,
      inspection: mutableInspection,
    });
    assert.equal(
      mutableInspection.every((byte) => byte === 0),
      true,
    );
    const capturedInspection = bundle.manifest.evidence.core_inspection as {
      raw_utf8: string;
      sha256: string;
    };
    assert.equal(capturedInspection.raw_utf8, f.inspection.toString("utf8"));
    assert.equal(sha(Buffer.from(capturedInspection.raw_utf8)), opportunity.core_inspection_sha256);
    assert.throws(
      () =>
        prepareFrozenCatalogSemanticInputs(
          {
            request() {
              assert.fail("oversized capture cannot invoke provider");
            },
          },
          root,
          opportunity,
          {
            ...input,
            files: new Map([["definitions/index.json", Buffer.alloc(8 * 1024 ** 2 + 1)]]),
          },
        ),
      /capture exceeds/,
    );
    const index = materializeSemanticReaderIndex(bundle);
    assert.equal(
      inspectSemanticReaderIndex(index.bytes, index.sha256).manifest.snapshots.catalog!.length,
      f.files.size,
    );
    const reader = createSemanticBundleReader(bundle);
    assert.ok(
      reader("read", {
        snapshot: "catalog",
        path: "definitions/index.json",
        offset: 0,
        length: 16384,
      }),
    );
    assert.ok(
      reader("read", {
        snapshot: "catalog_prior",
        path: "metadata/timestamp.json",
        offset: 0,
        length: 16384,
      }),
    );
    const result = {
      schema_version: 1,
      outcome: "accepted",
      opportunity_sha256: bundle.manifest.opportunity_sha256,
      bundle_sha256: bundle.bundle_sha256,
      coverage: { accumulated_changes: true, classification: true, compatibility: true },
      report: "Synthetic complete observation only; no runtime brand.",
    };
    const read = (snapshot: string, name: string, offset: number) => {
      const call = {
        id: `${snapshot}:${name}:${offset}`,
        type: "mcp_tool_call",
        server: "portcove_frozen_bundle",
        tool: "read",
        arguments: { snapshot, path: name, offset, length: 16384 },
      };
      return [
        { type: "item.started", item: { ...call, status: "in_progress" } },
        {
          type: "item.completed",
          item: {
            ...call,
            status: "completed",
            result: {
              content: [{ type: "text", text: JSON.stringify(reader("read", call.arguments)) }],
            },
          },
        },
      ];
    };
    const manifest = Buffer.from(JSON.stringify(bundle.manifest));
    const metadata = Array.from({ length: Math.ceil(manifest.length / 16384) }, (_, i) =>
      read("manifest", "manifest.json", i * 16384),
    ).flat();
    const observations: unknown[] = [];
    for (const [snapshot, rows] of Object.entries(bundle.manifest.snapshots))
      for (const row of rows ?? [])
        for (
          let offset = 0;
          offset <
          bundle.files.find((file) => file.name === `objects/${row.oid}.data`)!.bytes.length;
          offset += 16384
        )
          observations.push(...read(snapshot, row.path, offset));
    const events = (extra: unknown[]) =>
      Buffer.from(
        [
          { type: "thread.started", thread_id: "01234567-0123-0123-0123-0123456789ab" },
          { type: "turn.started" },
          ...extra,
          { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } },
          { type: "turn.completed" },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      );
    assert.throws(() => inspectSemanticRuntimeEvents(events(metadata), bundle), /lacks relevant/);
    assert.equal(
      inspectSemanticRuntimeEvents(events([...metadata, ...observations]), bundle).result.outcome,
      "accepted",
    );
    assert.throws(
      () =>
        prepareFrozenCatalogSemanticInputs(source.api, root, opportunity, {
          ...input,
          prior_repository: new Map(),
        }),
      /prior repository bytes/,
    );
    assert.throws(() => requireFrozenSemanticInputs(structuredClone(bundle)), /imported/);
    f.files.get("definitions/index.json")!.fill(0);
    assert.throws(
      () => prepareFrozenCatalogSemanticInputs(source.api, root, opportunity, input),
      /exact catalog bytes/,
    );
  });

void test("copied catalog data cannot acquire runtime brand or reach broker credentials/POST", async () => {
  const f = fixture(),
    handoff = prepareSemanticReviewHandoff(f.opportunity, review(f.opportunity));
  const raw = { handoff, authority: "none" } as unknown as Parameters<
    typeof publishSemanticCapture
  >[0];
  let authorityCalls = 0;
  assert.throws(() => requireDirectSemanticCapture(raw), /imported/);
  await assert.rejects(
    publishSemanticCapture(
      raw,
      { app_id: 101, installation_id: 303, writer_app_id: 202 },
      {
        async requireProvisioningGrant() {
          authorityCalls++;
        },
        async authenticateIssuer() {
          authorityCalls++;
          throw new Error("must never authenticate");
        },
      },
    ),
    /imported/,
  );
  assert.equal(authorityCalls, 0);
  await assert.rejects(
    requireActualCatalogSemanticReview(
      raw,
      f.opportunity,
      { app_id: 101, installation_id: 303, writer_app_id: 202 },
      {
        request() {
          authorityCalls++;
          throw new Error("no API before actual capture");
        },
        graphql() {
          throw new Error("no mutation");
        },
      },
      303,
    ),
    /imported/,
  );
  assert.equal(authorityCalls, 0);
});

void test("listing classification requires its capable compatibility declaration and strict descriptive identity", () => {
  const f = fixture();
  const listings = {
    target: "policy/official/catalog.listings.json",
    revision: 2,
    sha256: "a".repeat(64),
    listing_count: 7,
    withdrawn_count: 1,
  };
  const candidate = {
    ...f.opportunity,
    classification: { ...f.opportunity.classification, listings },
    compatibility: { ...f.opportunity.compatibility, contract: "official-catalog-listings-v2" },
  };
  assert.deepEqual(inspectCatalogSemanticOpportunity(candidate).classification.listings, listings);
  assert.throws(() =>
    inspectCatalogSemanticOpportunity({ ...candidate, compatibility: f.opportunity.compatibility }),
  );
  for (const change of [
    { revision: 0 },
    { listing_count: 10001 },
    { target: "policy/official/other.listings.json" },
    { operations: ["install"] },
  ])
    assert.throws(() =>
      inspectCatalogSemanticOpportunity({
        ...candidate,
        classification: { ...candidate.classification, listings: { ...listings, ...change } },
      }),
    );
});
