import { capacityDigest } from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  acquireReleaseAdmission,
  acquireHostedNativePreparation,
  runFixedBuildingConfiguration,
  requireActualReleaseAdmissionContext,
  acquireActualCandidateBuildingEligibility,
  requireActualCandidateBuildingEligibility,
  inspectAdmissionNativeStage,
} from "./acquire-release-admission.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { releasePublicBuildArtifactName } from "./release-public-build-provenance.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import type { IncludedResponse } from "./github-api.mts";
import { rateLimitFromResponse } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";

void test("qualifying continuation consumes pre-sign native stage without claiming payload admission", () => {
  assert.equal(inspectAdmissionNativeStage("admission", "candidate-building"), "payload-signing");
  assert.equal(inspectAdmissionNativeStage("payload", "payload-signing"), "payload-signing");
  assert.equal(
    inspectAdmissionNativeStage("release-publication", "release-publication"),
    "release-publication",
  );
  for (const [phase, stage] of [
    ["admission", "payload-signing"],
    ["payload", "candidate-building"],
    ["release-publication", "candidate-building"],
    ["payload", "release-publication"],
    ["admission", "release-publication"],
  ])
    assert.throws(() => inspectAdmissionNativeStage(phase, stage), /cannot appoint/);
});

void test("building eligibility is a separate private proof and imported success cannot authorize phase progress", async () => {
  for (const raw of [
    {},
    Object.freeze({
      kind: "actual-candidate-building-eligibility",
      decision: "eligible-for-candidate-building",
      checkpoint: "a".repeat(40),
      admission: { holds: [], evidence_scope: "github.com" },
      authority: "none",
    }),
  ]) {
    await assert.rejects(requireActualCandidateBuildingEligibility(raw), /actual same-process/);
    assert.throws(
      () => requireActualReleaseAdmissionContext(raw, "payload-signing"),
      /actual same-process/,
    );
  }
});
void test("qualifying collector requires genuine tools before source reads or output effects", async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.root);
  await assert.rejects(
    acquireActualCandidateBuildingEligibility(f.root, f.config, {}, []),
    /actual same-process controller tool/,
  );
  assert.deepEqual(await readdir(f.root), before);
});
void test("ordinary admission cannot activate the private qualifying path with caller flags", async (t) => {
  const f = await fixture(t);
  f.input.active_candidate.phase = "qualifying";
  const options = {
    ...f.options,
    qualifying: true,
    candidateBuilding: true,
    controlPhase: "admission" as const,
  };
  await assert.rejects(acquireReleaseAdmission(f.root, f.config, options), (error: unknown) => {
    assert.ok(error instanceof CoordinatorRemoteError);
    assert.ok(isRecord(error.evidence));
    assert.equal(error.evidence.phase, "repository-and-reservation");
    return true;
  });
});

void test("native preparatory collection reaches immutable facts while qualifying without minting admission", async (t) => {
  const f = await fixture(t);
  const parent = Object.freeze({});
  const original = await import("./release-hosted-native-parent.mts");
  t.mock.module("./release-hosted-native-parent.mts", {
    namedExports: {
      ...original,
      requireActualHostedNativeParentSource: async (raw: object) => {
        if (raw !== parent) throw new Error("original parent required");
        return { stage: "payload-signing" };
      },
    },
  });
  f.input.opportunity.change_set_sha256 = f.sourceFacts.expectedHash;
  Object.assign(f.input.opportunity.classification, {
    change_set_sha256: f.sourceFacts.expectedHash,
    change_set_scope: "portcove-release-net-tree-delta-v1",
  });
  Object.assign(f.input.active_candidate, {
    frozen_opportunity: structuredClone(f.input.opportunity),
  });
  let calls = 0;
  const receive = async (facts: unknown) => {
    calls++;
    assert.ok(Object.isFrozen(facts));
    // Deliberately return a forged success: the preparatory wrapper ignores it.
    return { decision: "admitted", holds: [] };
  };
  for (const phase of ["qualifying", "building"]) {
    f.input.active_candidate.phase = phase;
    await assert.rejects(
      acquireHostedNativePreparation(parent, f.root, f.config, f.options, receive),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        assert.equal(error.evidence.phase, "actual-stage-native-qualification");
        return true;
      },
    );
  }
  assert.equal(calls, 2);
  f.input.active_candidate.phase = "publishing";
  await assert.rejects(
    acquireHostedNativePreparation(parent, f.root, f.config, f.options, receive),
    /repository-and-reservation/,
  );
  await assert.rejects(
    acquireHostedNativePreparation({}, f.root, f.config, f.options, receive),
    /original parent/,
  );
  assert.equal(calls, 2);
});

void test("imported or frozen zero-hold descriptors cannot mint an actual stage-specific admission continuation", () => {
  for (const raw of [
    {},
    Object.freeze({
      stage: "release-publication",
      facts: {},
      controls: { evidence_scope: "github.com" },
      admission: { decision: "admitted", holds: [], evidence_scope: "github.com" },
      checkpoint: "a".repeat(40),
      pending_obligations: [],
    }),
    { stage: "payload-signing", decision: "eligible-for-payload-signing" },
  ]) {
    for (const stage of ["payload-signing", "release-publication"] as const)
      assert.throws(() => requireActualReleaseAdmissionContext(raw, stage), /actual same-process/);
  }
});
void test("native continuation receives frozen acquired bytes once, before controls, and imported reports cannot qualify it", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const frozen = {
    ...structuredClone(f.input.opportunity),
    change_set_sha256: f.sourceFacts.expectedHash,
    classification: {
      ...f.input.opportunity.classification,
      change_set_sha256: f.sourceFacts.expectedHash,
      change_set_scope: "portcove-release-net-tree-delta-v1",
    },
  };
  Object.assign(f.input.active_candidate, { frozen_opportunity: frozen });
  let nativeCalls = 0,
    controlCalls = 0;
  await assert.rejects(
    acquireReleaseAdmission(f.root, f.config, {
      ...f.options,
      controlPhase: "payload",
      establishNative: async (facts) => {
        nativeCalls++;
        assert.ok(Object.isFrozen(facts));
        assert.ok(Object.isFrozen(facts.assembly));
        assert.ok(Object.isFrozen(facts.archives));
        assert.equal(facts.archives.length, 2);
        assert.equal(f.calls.filter((v) => v.startsWith("ZIP ")).length, 2);
        return [
          Object.freeze({ stage: "payload-signing", accepted: true }),
          Object.freeze({ accepted: true }),
        ];
      },
      establishControls: async () => {
        controlCalls++;
        throw new Error("must not run");
      },
    }),
    (error: unknown) =>
      error instanceof CoordinatorRemoteError &&
      isRecord(error.evidence) &&
      error.evidence.phase === "actual-stage-native-qualification",
  );
  assert.equal(nativeCalls, 1);
  assert.equal(controlCalls, 0);
});
void test("admission cannot relabel injected provenance when the caller mutates options during an awaited read", async (t) => {
  const f = await fixture(t);
  const original = f.options.recover;
  assert.ok(original);
  const options: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]> = { ...f.options };
  options.recover = async (...args) => {
    delete options.api;
    delete options.download;
    delete options.recover;
    delete options.now;
    return original(...args);
  };
  const result = await acquireReleaseAdmission(f.root, f.config, options);
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.ok(result.holds.includes("strict-release-native-authorization-not-evaluated"));
});
void test("updater package custody retains the captured callback without granting native acceptance", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const retained: string[] = [];
  const originalRecover = f.options.recover;
  assert.ok(originalRecover);
  const options: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]> = {
    ...f.options,
    retainDesktopPackage: async (identity, bytes) => {
      assert.equal(bytes.length, identity.bytes);
      assert.equal(hash(bytes), identity.sha256);
      assert.match(identity.filename, /(?:\.exe|\.AppImage)$/u);
      retained.push(identity.platform_label);
    },
    recover: async (...args) => {
      delete options.retainDesktopPackage;
      return originalRecover(...args);
    },
  };
  const result = await acquireReleaseAdmission(f.root, f.config, options);
  assert.deepEqual(retained.sort(), ["linux-x86_64", "windows-x86_64"]);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.ok(result.holds.includes("strict-release-native-authorization-not-evaluated"));
});
import {
  releaseControlInputsFixture,
  config as reviewProducer,
} from "./fixtures/release-control-inputs-fixture.mts";
import {
  capacityDocumentFixture,
  liveControlRuntimeFixture,
  protectionFixture,
} from "./fixtures/release-live-control-fixture.mts";
import {
  persistReviewedClassification,
  releaseControlRefQuery,
} from "./release-control-inputs.mts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function commit(tree: string, parents: string[], message: string) {
  const actor = { name: "Fixture", email: "fixture@example.invalid", date: "2026-10-18T00:00:00Z" };
  const header = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author Fixture <fixture@example.invalid> 1792281600 +0000\ncommitter Fixture <fixture@example.invalid> 1792281600 +0000`;
  const raw = Buffer.from(`${header}\n\n${message}`);
  const sha = createHash("sha1").update(`commit ${raw.length}\0`).update(raw).digest("hex");
  return {
    sha,
    tree: { sha: tree },
    parents: parents.map((sha) => ({ sha })),
    message,
    author: actor,
    committer: actor,
  };
}
async function fixture(t: test.TestContext, profile: "full" | "initial-beta-win-linux" = "full") {
  const f = await trustedAssemblyFixture(t, profile);
  const sourceFacts = releaseSourceFixture();
  const original = sourceFacts.original;
  const intent = JSON.stringify({
    proposal: {
      schema_version: 1,
      source_commit: original.sha,
      base_version: "0.1.0-alpha.2",
      version: f.request.version,
      change: "prerelease",
      github_prerelease: true,
      channels: ["preview"],
    },
    compatibility: "compatible",
    migration_notes: "",
  });
  const intentHash = hash(intent);
  const prepared = commit(
    "2".repeat(40),
    [original.sha],
    `Prepare application ${f.request.version}\n\nPortcove-Preparation-SHA256: ${intentHash}\n${intent}\n`,
  );
  const candidate = {
    source_commit: original.sha,
    source_tree: original.tree.sha,
    prepared_commit: prepared.sha,
    prepared_tree: prepared.tree.sha,
    version: f.request.version,
    intent_sha256: intentHash,
    phase: "building",
    failure_kind: null,
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: { run_id: 12345, attempt: 1, revision: prepared.sha },
  };
  const input = {
    schema_version: 1,
    now: "2026-10-18T00:00:00.000Z",
    controller: {
      workflow: ".github/workflows/application-update-production.yml",
      revision: "3".repeat(40),
      publication_paused: false,
      free_capacity_available: true,
    },
    opportunity: {
      source_commit: original.sha,
      source_tree: original.tree.sha,
      base_commit: sourceFacts.base.sha,
      change_set_sha256: "a".repeat(64),
      complete_change_set: true,
      meaningful: true,
      documentation_only: false,
      urgency: false,
      requested_channel: "preview",
      classification: {
        source_commit: original.sha,
        reviewed_commit: original.sha,
        source_tree: original.tree.sha,
        reviewed_tree: original.tree.sha,
        change_set_sha256: "a".repeat(64),
        base_version: "0.1.0-alpha.2",
        change: "prerelease",
        compatibility: "compatible",
      },
    },
    publication: {
      complete: true,
      observed_at: "2026-10-18T00:00:00.000Z",
      published_versions: [],
      published_sources: [],
      reserved_versions: [f.request.version],
      last_routine_preview_at: null,
    },
    active_candidate: candidate,
  };
  const tags = [
    {
      id: "Ref_version",
      name: `portcove-fixture-prepared/v${f.request.version}`,
      prefix: "refs/tags/",
      target: { __typename: "Commit", oid: prepared.sha },
    },
    {
      id: "Ref_source",
      name: `portcove-fixture-prepared-source/${original.sha}`,
      prefix: "refs/tags/",
      target: { __typename: "Commit", oid: prepared.sha },
    },
  ];
  const archives = new Map<number, Buffer>();
  const artifacts: Record<string, unknown>[] = [];
  for (const [index, platform] of [
    ...new Set(f.request.files.map((file) => file.platform_label)),
  ].entries()) {
    const entries = f.request.files
      .filter((file) => file.platform_label === platform)
      .map((file) => {
        let bytes = f.contents.get(`${platform}/${file.filename}`)!;
        if (file.filename.startsWith("release-producer-"))
          bytes = Buffer.from(bytes.toString().replaceAll(f.request.source_commit, prepared.sha));
        return [file.filename, bytes, { descriptor: true }] as const;
      });
    const archive = createAuditZip(entries);
    const id = 100 + index;
    archives.set(id, archive);
    artifacts.push({
      id,
      name: `release-build-${platform}-12345-1`,
      size_in_bytes: archive.length,
      digest: `sha256:${hash(archive)}`,
      expired: false,
      created_at: "2026-10-18T00:00:00Z",
      expires_at: null,
      workflow_run: {
        id: 12345,
        repository_id: 1354613114,
        head_repository_id: 1354613114,
        head_sha: prepared.sha,
      },
    });
  }
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url));
  const run = {
    id: 12345,
    run_attempt: 1,
    head_sha: prepared.sha,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
    path: ".github/workflows/release.yml",
    workflow_id: 123,
    status: "completed",
    conclusion: "success",
    updated_at: "2026-10-18T00:00:00Z",
    event: "workflow_dispatch",
  };
  const jobs = [
    {
      id: 10,
      run_id: 12345,
      run_attempt: 1,
      head_sha: prepared.sha,
      name: "fixture package job",
      status: "completed",
      conclusion: "success",
      runner_id: 1,
      runner_name: "GitHub Actions fixture",
      started_at: "2026-10-18T00:00:00Z",
      completed_at: "2026-10-18T00:00:01Z",
    },
  ];
  const checks = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"].map(
    (name, index) => ({
      id: 20 + index,
      name,
      status: "completed",
      conclusion: "success",
      head_sha: prepared.sha,
      app: { id: 15368 },
      html_url: `https://github.com/boburning/portcove/actions/runs/456/job/${20 + index}`,
    }),
  );
  const faults = { value: "" };
  const statuses: { id: number; context: string; state: string }[] = [];
  const calls: string[] = [];
  let tagRounds = 0;
  let releaseRounds = 0;
  let recoveries = 0;
  const releases: {
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
    updated_at: string;
  }[] = [];
  const response = (body: unknown, headers: Record<string, string> = {}) => {
    const included: IncludedResponse = {
      status: 200,
      body,
      headers: new Map(Object.entries(headers)),
    };
    return { ...included, rateLimit: rateLimitFromResponse(included) };
  };
  const options: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]> = {
    now: () => Date.parse("2026-10-18T00:01:00.000Z"),
    recover: async () => {
      recoveries++;
      return {
        checkpoint:
          faults.value === "checkpoint-drift" && recoveries > 1 ? "e".repeat(40) : "c".repeat(40),
        input,
        complete_allocation_history: false,
      };
    },
    download: (endpoint: string) => {
      calls.push(`ZIP ${endpoint}`);
      if (faults.value === "check-drift") checks[0]!.conclusion = "failure";
      if (faults.value === "check-identity-drift") checks[0]!.id = 999;
      if (faults.value === "issuer-drift") checks[0]!.app.id = 1;
      if (faults.value === "job-drift") jobs[0]!.id = 999;
      if (faults.value === "status-drift" && !statuses.length)
        statuses.push({ id: 900, context: "catalog", state: "failure" });
      if (faults.value === "secret-error") throw new Error("Bearer secret-provider-text");
      const id = Number(endpoint.match(/artifacts\/(\d+)/u)?.[1]);
      const archive = archives.get(id);
      assert.ok(archive);
      return archive;
    },
    api: {
      request: (method: string, endpoint: string) => {
        assert.equal(method, "GET");
        calls.push(endpoint);
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        assert.equal(url.origin, "https://api.github.com");
        const route = url.pathname.replace("/repos/boburning/portcove", "");
        if (route === "")
          return response({
            id: 1354613114,
            node_id: "R_fixture",
            full_name: "boburning/portcove",
            private: false,
            visibility: "public",
          });
        if (route === "/releases") {
          const page = Number(url.searchParams.get("page") ?? 1);
          if (page === 1) releaseRounds++;
          const rows = structuredClone(releases.slice((page - 1) * 100, page * 100));
          if (faults.value === "publication-drift" && releaseRounds > 1 && rows[0])
            rows[0].updated_at = "2026-10-18T00:00:02Z";
          return response(
            rows,
            page * 100 < releases.length
              ? {
                  link: `<https://api.github.com/repos/boburning/portcove/releases?per_page=100&page=${page + 1}>; rel="next"`,
                }
              : {},
          );
        }
        if (route === `/git/commits/${original.sha}`) return response(original);
        if (route === `/git/commits/${prepared.sha}`) return response(prepared);
        if (
          route.startsWith("/git/trees/") ||
          route.startsWith("/compare/") ||
          route === `/git/commits/${sourceFacts.base.sha}`
        )
          return response(sourceFacts.api.request(method, endpoint).body);
        if (route === "/actions/runs/12345" || route === "/actions/runs/12345/attempts/1")
          return response(run);
        if (route === "/actions/runs/12345/attempts/1/jobs")
          return response({ total_count: jobs.length, jobs });
        if (route === "/actions/runs/12345/artifacts")
          return response({ total_count: artifacts.length, artifacts });
        if (route === "/contents/.github/workflows/release.yml")
          return response({
            type: "file",
            path: ".github/workflows/release.yml",
            encoding: "base64",
            size: workflow.length,
            content: workflow.toString("base64"),
          });
        if (route === `/commits/${prepared.sha}/check-runs`)
          return response({ total_count: checks.length, check_runs: checks });
        if (route === `/commits/${prepared.sha}/status`)
          return response({ sha: prepared.sha, total_count: statuses.length, statuses });
        throw Error(`unexpected fixture route ${route}`);
      },
      graphql: (query: string, variables?: Readonly<Record<string, unknown>>) => {
        calls.push("GraphQL refs");
        assert.match(query, /query AdmissionRefs/u);
        assert.doesNotMatch(query, /mutation/u);
        const offset = variables?.cursor === null ? 0 : Number(variables?.cursor);
        if (offset === 0) tagRounds++;
        const rows = structuredClone(tags.slice(offset, offset + 100));
        if (faults.value === "tag-drift" && tagRounds > 1 && rows[0])
          rows[0].target.oid = "e".repeat(40);
        if (faults.value === "duplicate-tag" && rows[1]) rows[1].id = rows[0]!.id;
        return {
          response: response({}),
          rateLimit: rateLimitFromResponse(response({})),
          data: {
            repository: {
              id: "R_fixture",
              databaseId: 1354613114,
              nameWithOwner: "boburning/portcove",
              refs: {
                totalCount: tags.length + (faults.value === "truncated" ? 1 : 0),
                nodes: rows,
                pageInfo: {
                  hasNextPage: offset + 100 < tags.length,
                  endCursor: String(offset + rows.length),
                },
              },
            },
          },
        };
      },
    },
  };
  return {
    ...f,
    sourceFacts,
    original,
    prepared,
    input,
    tags,
    releases,
    checks,
    artifacts,
    jobs,
    faults,
    calls,
    options,
    config:
      profile === "full"
        ? { schema_version: 1, namespace: "portcove-fixture" }
        : { schema_version: 2, namespace: "portcove-fixture", release_profile: profile },
  };
}

void test("actual admission authenticates frozen semantic producer, owner pause and spending source without clearing independent holds", async (t) => {
  const f = await fixture(t);
  const frozen = {
    ...structuredClone(f.input.opportunity),
    change_set_sha256: f.sourceFacts.expectedHash,
    classification: {
      ...f.input.opportunity.classification,
      change_set_sha256: f.sourceFacts.expectedHash,
      change_set_scope: "portcove-release-net-tree-delta-v1",
    },
  };
  Object.assign(f.input.active_candidate, { frozen_opportunity: frozen });
  const control = releaseControlInputsFixture(
    capacityDocumentFixture(),
    frozen,
    reviewProducer,
    false,
    "R_fixture",
  );
  persistReviewedClassification(control.api, reviewProducer, frozen, 303, () => {});
  const runtime = liveControlRuntimeFixture(protectionFixture(control.head()));
  const controls = await runtime.create();
  const baseApi = f.options.api;
  assert.ok(baseApi);
  const api = {
    request: (method: string, endpoint: string) => {
      const url = new URL(endpoint, "https://api.github.com/");
      const canonical = url.pathname.slice(1);
      if (!control.owns(canonical)) return baseApi.request(method, endpoint);
      const response = control.api.request(method, canonical);
      return { ...response, rateLimit: rateLimitFromResponse(response) };
    },
    graphql: (query: string, variables: Readonly<Record<string, unknown>> = {}) => {
      if (query !== releaseControlRefQuery) return baseApi.graphql(query, variables);
      const response = { status: 200, headers: new Map<string, string>(), body: {} };
      return {
        data: control.api.graphql(query, variables).data,
        response,
        rateLimit: rateLimitFromResponse(response),
      };
    },
  };
  const options = { ...f.options, api, controls };
  const result = await acquireReleaseAdmission(f.root, f.config, options);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.equal(result.controls?.classification.review_check_id, 303);
  assert.equal(
    result.holds.includes("independent-classification-and-pause-sources-unconfigured"),
    false,
  );
  assert.equal(result.holds.includes("admitted-spending-boundary-source-unconfigured"), false);
  assert.equal(result.holds.includes("publication-paused-by-owner-source"), false);
  assert.ok(result.holds.includes("candidate-workflow-execution-and-producer-acceptance-unproven"));
  assert.ok(result.holds.includes("strict-release-SBOM-document-unverified"));
  assert.ok(result.holds.includes("strict-release-native-authorization-not-evaluated"));
  assert.ok(
    result.holds.includes(
      "current-controller-workflow-differs-from-ratified-capacity-resource-policy",
    ),
  );
  assert.equal(result.capacity.eligibility, "ineligible");
  assert.equal(result.capacity.availability, "unknown");
  assert.equal(result.capacity.headroom, "unknown");
  assert.equal(result.capacity.reservation, "none");
  const downloaded = f.calls.filter((call) => call.startsWith("ZIP ")).length;
  let ready = 0;
  const late = await acquireReleaseAdmission(f.root, f.config, {
    ...f.options,
    api,
    establishControls: async (factsSha256, facts) => {
      ready++;
      assert.ok(Object.isFrozen(facts));
      assert.ok(Object.isFrozen(facts.archives));
      assert.ok(Object.isFrozen(facts.assembly));
      assert.throws(() => {
        (facts as { checkpoint: string }).checkpoint = "attacker";
      });
      assert.throws(() => {
        (facts.archives as unknown[]).push({});
      });
      assert.equal(facts.checkpoint, "c".repeat(40));
      assert.match(factsSha256, /^[a-f0-9]{64}$/u);
      assert.equal(f.calls.filter((call) => call.startsWith("ZIP ")).length, downloaded + 4);
      return runtime.create();
    },
  });
  assert.equal(ready, 1);
  assert.equal(late.controls?.classification.review_check_id, 303);
  assert.equal(late.decision, "hold");
  assert.equal(late.descriptor, null);
  assert.equal(f.calls.filter((call) => call.startsWith("ZIP ")).length, downloaded + 4);
  await assert.rejects(
    acquireReleaseAdmission(f.root, f.config, {
      ...f.options,
      api,
      establishControls: async () => ({ ...controls }),
    }),
    /private-facts-ready/u,
  );
  control.faults.value = "issuer";
  await assert.rejects(acquireReleaseAdmission(f.root, f.config, options), CoordinatorRemoteError);
  assert.equal(control.mutations(), 1);
});

void test("read-only acquisition constructs the full internally observed matrix and feeds only a conservative held plan", async (t) => {
  const f = await fixture(t);
  const result = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.equal(result.authority, "none");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.allocations.length, 1);
  assert.equal(result.contexts.length, 5);
  assert.equal(result.archives.length, 4);
  assert.equal(result.assembly.files.length, f.request.files.length);
  assert.equal(result.diagnostic_plan?.action, "pause");
  assert.ok(result.holds.includes("candidate-workflow-execution-and-producer-acceptance-unproven"));
  assert.ok(result.holds.includes("independent-classification-and-pause-sources-unconfigured"));
  assert.equal(f.calls.filter((call) => call.startsWith("ZIP ")).length, 4);
  assert.ok((await readdir(f.root)).some((name) => name.startsWith("release-admission-")));
});

void test("ratified beta acquisition consumes exactly the two declared platform archives without clearing remaining holds", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const result = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.equal(result.archives.length, 2);
  assert.equal(result.assembly.release_profile, "initial-beta-win-linux");
  assert.equal(result.assembly.files.length, f.request.files.length);
  assert.equal(f.calls.filter((call) => call.startsWith("ZIP ")).length, 2);
});

void test("schema3 admission independently selects and verifies immutable public build provenance while preserving unrelated holds", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const p = await releasePublicBuildProvenanceFixture(t);
  for (const item of p.binding.artifacts)
    f.artifacts.push({
      ...f.artifacts[0],
      id: item.artifact_id,
      name: releasePublicBuildArtifactName(item.platform, "12345", 1),
      size_in_bytes: item.bytes,
      digest: `sha256:${item.sha256}`,
      workflow_run: {
        id: 12345,
        repository_id: 1354613114,
        head_repository_id: 1354613114,
        head_sha: f.prepared.sha,
      },
    });
  const packageDownload = f.options.download;
  assert.ok(packageDownload);
  const options = {
    ...f.options,
    download: (endpoint: string, options: Parameters<typeof packageDownload>[1]) =>
      Number(endpoint.split("/").at(-2)) < 100
        ? p.download(endpoint)
        : packageDownload(endpoint, options),
  };
  const config = {
    schema_version: 3,
    namespace: "portcove-fixture",
    release_profile: "initial-beta-win-linux",
    public_build_inputs: p.configuration,
  };
  const result = await acquireReleaseAdmission(f.root, config, options);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.equal(result.assembly.schema_version, 3);
  assert.deepEqual(result.assembly.public_build_inputs, p.binding);
  assert.equal(result.public_build_inputs?.receipts.length, 2);
  assert.ok(result.holds.length > 0);
  assert.equal(result.holds.includes("ratified-public-build-inputs-unavailable"), false);
  await assert.rejects(
    acquireReleaseAdmission(
      f.root,
      { ...config, public_build_inputs: { ...p.configuration, manifest_sha256: "f".repeat(64) } },
      options,
    ),
  );
});

void test("frozen net source facts bind the original classification and preparation despite a newer queued opportunity", async (t) => {
  const f = await fixture(t);
  f.input.opportunity.change_set_sha256 = f.sourceFacts.expectedHash;
  Object.assign(f.input.opportunity.classification, {
    change_set_sha256: f.sourceFacts.expectedHash,
    change_set_scope: "portcove-release-net-tree-delta-v1",
  });
  const frozen = structuredClone(f.input.opportunity);
  Object.assign(f.input.active_candidate, { frozen_opportunity: frozen });
  f.input.opportunity.source_commit = "7".repeat(40);
  f.input.opportunity.classification.source_commit = "7".repeat(40);
  f.input.opportunity.classification.reviewed_commit = "7".repeat(40);
  const result = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(result.source_changes?.source_commit, f.original.sha);
  assert.equal(result.source_changes?.change_set_sha256, f.sourceFacts.expectedHash);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.ok(result.holds.includes("independent-classification-and-pause-sources-unconfigured"));
  frozen.change_set_sha256 = "f".repeat(64);
  await assert.rejects(acquireReleaseAdmission(f.root, f.config, f.options), /source-consistency/u);
});

void test("legacy absence and opaque digest scope remain explicit holds without backfilling the latest classification", async (t) => {
  const f = await fixture(t);
  const absent = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(absent.source_changes, null);
  assert.ok(
    absent.holds.includes(
      "active-frozen-opportunity-unavailable-no-latest-opportunity-substitution",
    ),
  );
  Object.assign(f.input.active_candidate, {
    frozen_opportunity: structuredClone(f.input.opportunity),
  });
  const opaque = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(opaque.source_changes, null);
  assert.ok(
    opaque.holds.includes("frozen-change-set-scope-unsupported-no-legacy-hash-reinterpretation"),
  );
});

void test("complete ref and release inventories cross real pagination boundaries without trusting titles or target_commitish", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 101; i++) {
    f.tags.push({
      id: `Ref_extra_${i}`,
      name: `unrelated-${i}`,
      prefix: "refs/tags/",
      target: { __typename: "Commit", oid: "5".repeat(40) },
    });
    f.releases.push({
      id: 1000 + i,
      tag_name: `v0.1.0-alpha.${100 + i}`,
      draft: true,
      prerelease: true,
      published_at: null,
      updated_at: "2026-10-18T00:00:00Z",
    });
  }
  const result = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(result.decision, "hold");
  assert.equal(result.allocations.length, 1);
  assert.equal(f.calls.filter((call) => call.includes("releases?per_page=100&page=2")).length, 2);
  assert.equal(f.calls.filter((call) => call === "GraphQL refs").length, 4);
});

void test("duplicate truncated drifting and unpaired source inventories refuse without another allocation", async (t) => {
  for (const fault of ["duplicate-tag", "truncated", "tag-drift", "checkpoint-drift"]) {
    const f = await fixture(t);
    f.faults.value = fault;
    await assert.rejects(acquireReleaseAdmission(f.root, f.config, f.options));
    assert.ok(f.calls.every((call) => !call.includes("POST ") && !call.includes("PATCH ")));
  }
  const f = await fixture(t);
  f.tags.pop();
  await assert.rejects(
    acquireReleaseAdmission(f.root, f.config, f.options),
    /repository-and-reservation/u,
  );
});

void test("failed qualification is a hold while wrong source and issuer refuse before archive reads", async (t) => {
  const f = await fixture(t);
  f.checks[0]!.conclusion = "failure";
  const held = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.ok(held.holds.includes("exact-prepared-head-required-contexts-not-successful"));
  for (const fault of ["source", "issuer"]) {
    const g = await fixture(t);
    if (fault === "source") g.checks[0]!.head_sha = "e".repeat(40);
    else g.checks[0]!.app.id = 1;
    await assert.rejects(acquireReleaseAdmission(g.root, g.config, g.options), /qualification/u);
    assert.equal(g.calls.filter((call) => call.startsWith("ZIP ")).length, 0);
  }
});

void test("historical publication without immutable source/routine attribution remains unknown and changed snapshot refuses", async (t) => {
  const f = await fixture(t);
  f.tags.push({
    id: "Ref_alpha",
    name: "v0.1.0-alpha.1",
    prefix: "refs/tags/",
    target: { __typename: "Commit", oid: f.original.sha },
  });
  f.releases.push({
    id: 1000,
    tag_name: "v0.1.0-alpha.1",
    draft: false,
    prerelease: true,
    published_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  });
  const result = await acquireReleaseAdmission(f.root, f.config, f.options);
  assert.equal(result.publication.complete, false);
  assert.equal(result.diagnostic_plan, null);
  assert.ok(
    result.holds.includes(
      "historical-original-source-and-routine-preview-classification-unresolved",
    ),
  );
  const g = await fixture(t);
  g.tags.push(structuredClone(f.tags[2]!));
  g.releases.push(structuredClone(f.releases[0]!));
  g.faults.value = "publication-drift";
  await assert.rejects(acquireReleaseAdmission(g.root, g.config, g.options), /freshness-bracket/u);
});

void test("qualification identities, outcomes, issuers, statuses and attempt jobs are bracketed across downloads", async (t) => {
  for (const fault of [
    "check-drift",
    "check-identity-drift",
    "issuer-drift",
    "job-drift",
    "status-drift",
  ]) {
    const f = await fixture(t);
    f.faults.value = fault;
    await assert.rejects(
      acquireReleaseAdmission(f.root, f.config, f.options),
      /freshness-bracket/u,
    );
  }
});

void test("refusal retains its owned directory and bounded phase without provider secrets", async (t) => {
  const f = await fixture(t);
  f.faults.value = "secret-error";
  let evidence: { directory: string; phase: string; checkpoint: string } | undefined;
  await assert.rejects(acquireReleaseAdmission(f.root, f.config, f.options), (error: unknown) => {
    assert.ok(error instanceof CoordinatorRemoteError);
    evidence = error.evidence as { directory: string; phase: string; checkpoint: string };
    assert.equal(evidence.phase, "archive-acquisition");
    assert.equal(evidence.checkpoint, "c".repeat(40));
    return true;
  });
  assert.ok(evidence);
  const retained = await readFile(`${evidence.directory}/admission-failure.json`, "utf8");
  assert.deepEqual(JSON.parse(retained), evidence);
  assert.doesNotMatch(retained, /Bearer|secret-provider-text/u);
});

void test("bounded capacity eligibility cannot clear unrelated admission holds or claim headroom", async (t) => {
  const f = await fixture(t),
    capacity = capacityFixture();
  const result = await acquireReleaseAdmission(f.root, f.config, {
    ...f.options,
    capacity: { ratification: capacity.ratification, readBoundary: async () => capacity.boundary },
  });
  assert.equal(result.capacity.eligibility, "eligible");
  assert.equal(result.capacity.availability, "unknown");
  assert.equal(result.capacity.headroom, "unknown");
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.ok(result.holds.includes("independent-classification-and-pause-sources-unconfigured"));
  assert.ok(result.holds.includes("candidate-workflow-execution-and-producer-acceptance-unproven"));
  assert.ok(result.holds.includes("strict-release-SBOM-document-unverified"));
  assert.ok(result.holds.includes("strict-release-native-authorization-not-evaluated"));
});

void test("capacity bracketing snapshots aliased observations and initial ratification", async (t) => {
  const f = await fixture(t),
    capacity = capacityFixture();
  let reads = 0;
  const result = await acquireReleaseAdmission(f.root, f.config, {
    ...f.options,
    capacity: {
      ratification: capacity.ratification,
      readBoundary: async () => {
        reads++;
        if (reads === 2) {
          capacity.boundary.configuration_generation = "changed-after-first-observation";
          capacity.ratification.boundary_sha256 = capacityDigest(capacity.boundary);
        }
        return capacity.boundary;
      },
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.capacity.eligibility, "ineligible");
  assert.ok(result.holds.includes("bounded-no-spend-attempt-ineligible"));
});

void test("fixed building caller refuses imported configuration and exhausted original clock before provider work", async () => {
  for (const value of [
    {},
    { configuration: {}, tools: {}, native_locators: [] },
    {
      configuration: {},
      tools: { artifact: {}, bundle: {} },
      native_locators: [],
      descriptor: { admitted: true },
    },
  ])
    await assert.rejects(
      runFixedBuildingConfiguration(value, process.cwd(), performance.now() + 1000),
      /caller fields/,
    );
  await assert.rejects(
    runFixedBuildingConfiguration({}, process.cwd(), performance.now() - 1),
    /deadline/,
  );
});
