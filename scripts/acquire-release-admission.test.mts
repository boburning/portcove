import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
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
import type { IncludedResponse } from "./github-operation.mts";
import { rateLimitFromResponse } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import {
  PublicationInventoryIncompleteError,
  createPublicationInventoryWithSdk,
  createReleasePublicationReader,
  readPublicationAllocationsWithSdk,
  releasePublicationPrefixRefsQuery,
  releasePublicationRefsQuery,
} from "./release-publication-inventory.mts";

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
  let evidenceDispatches = 0;
  const fixtureApi = f.options.api;
  assert.ok(fixtureApi);
  const metadataRoutes: string[] = [];
  let sourceGuards = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(request.headers.get("authorization"), "token original-native-source");
      metadataRoutes.push(url.pathname);
      if (url.pathname === "/graphql") {
        const raw: unknown = await request.json();
        assert.ok(
          isRecord(raw) && raw.query === releasePublicationRefsQuery && isRecord(raw.variables),
        );
        return Response.json({
          data: fixtureApi.graphql(releasePublicationRefsQuery, raw.variables).data,
        });
      }
      const response = fixtureApi.request("GET", url.href);
      return Response.json(response.body, { headers: [...response.headers] });
    },
  );
  const { recover, download } = f.options;
  assert.ok(recover && download);
  const sources = {
    recover,
    download,
    nativeSource: {
      token: "original-native-source",
      deadline: performance.now() + 5000,
      guard() {
        sourceGuards++;
      },
    },
    collectEvidence: (request: unknown, options: Parameters<typeof collectReleaseRunEvidence>[1]) =>
      collectReleaseRunEvidence(request, {
        ...options,
        credential: { kind: "explicit", token: "fixture-hosted-evidence" },
        fetch: async (input, init) => {
          assert.ok(typeof input === "string");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "token fixture-hosted-evidence",
          );
          const response = fixtureApi.request("GET", input);
          evidenceDispatches++;
          return Response.json(response.body, {
            status: response.status ?? 200,
            headers: [...response.headers],
          });
        },
      }),
  };
  for (const phase of ["qualifying", "building"]) {
    f.input.active_candidate.phase = phase;
    await assert.rejects(
      acquireHostedNativePreparation(parent, f.root, f.config, sources, receive),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        assert.equal(error.evidence.phase, "actual-stage-native-qualification");
        return true;
      },
    );
  }
  assert.equal(calls, 2);
  assert.ok(metadataRoutes.some((route) => route.endsWith("/check-runs")));
  assert.ok(metadataRoutes.some((route) => route.includes("/compare/")));
  assert.ok(sourceGuards >= metadataRoutes.length);

  assert.ok(evidenceDispatches >= 14);
  f.input.active_candidate.phase = "publishing";
  await assert.rejects(
    acquireHostedNativePreparation(parent, f.root, f.config, sources, receive),
    /repository-and-reservation/,
  );
  await assert.rejects(
    acquireHostedNativePreparation({}, f.root, f.config, sources, receive),
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
  const download = f.options.download;
  assert.ok(download);
  let archiveLookups = 0;
  const options: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]> = {
    ...f.options,
    download: async (endpoint, bounds) => {
      assert.ok(bounds.lookup?.reserve && bounds.lookup.elapsed);
      archiveLookups++;
      return download(endpoint, bounds);
    },
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
  assert.ok(archiveLookups >= 2);
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
        assert.match(query, /query Admission(?:Prefix)?Refs/u);
        assert.doesNotMatch(query, /mutation/u);
        const offset = variables?.cursor === null ? 0 : Number(variables?.cursor);
        // A namespace scan reads one ref prefix, with names relative to it.
        const scoped =
          typeof variables?.prefix === "string"
            ? String(variables.prefix).slice("refs/tags/".length)
            : null;
        if (offset === 0 && scoped === null) tagRounds++;
        const matching =
          scoped === null
            ? tags
            : tags
                .filter((tag) => tag.name.startsWith(scoped))
                .map((tag) => ({
                  ...tag,
                  name: tag.name.slice(scoped.length),
                  prefix: `refs/tags/${scoped}`,
                }));
        const rows = structuredClone(matching.slice(offset, offset + 100));
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
                totalCount: matching.length + (faults.value === "truncated" ? 1 : 0),
                nodes: rows,
                pageInfo: {
                  hasNextPage: offset + 100 < matching.length,
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

void test("locked allocation reader joins the exact raw prepared and source commits", async (t) => {
  const f = await fixture(t);
  const api = f.options.api;
  assert.ok(api);
  const paths: string[] = [];
  const result = await readPublicationAllocationsWithSdk(f.config.namespace, {
    token: "synthetic-native-reader",
    deadline: performance.now() + 5000,
    recheck: async () => {},
    async fetch(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const { pathname, origin } = new URL(url);
      assert.equal(origin, "https://api.github.com");
      paths.push(pathname);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "token synthetic-native-reader",
      );
      if (pathname === "/graphql") {
        assert.ok(typeof init?.body === "string");
        const raw: unknown = JSON.parse(init.body);
        assert.ok(
          isRecord(raw) &&
            raw.query === releasePublicationPrefixRefsQuery &&
            isRecord(raw.variables),
        );
        return Response.json({
          data: api.graphql(releasePublicationPrefixRefsQuery, raw.variables).data,
        });
      }
      return Response.json(api.request("GET", pathname.slice(1)).body);
    },
  });
  const candidate = f.input.active_candidate;
  assert.deepEqual(result.allocations, [
    {
      version: candidate.version,
      source_commit: candidate.source_commit,
      source_tree: candidate.source_tree,
      prepared_commit: candidate.prepared_commit,
      prepared_tree: candidate.prepared_tree,
      intent_sha256: candidate.intent_sha256,
    },
  ]);
  assert.deepEqual(paths, [
    "/repos/boburning/portcove",
    "/graphql",
    "/graphql",
    `/repos/boburning/portcove/git/commits/${f.prepared.sha}`,
    `/repos/boburning/portcove/git/commits/${f.original.sha}`,
  ]);
});

void test("actual admission package transfer uses the scoped SDK with signed delivery before final readback", async (t) => {
  const f = await fixture(t);
  const download = f.options.download;
  assert.ok(download);
  const options = { ...f.options };
  delete options.download;
  const previous = process.env.GH_TOKEN;
  const token = "ghs_SYNTHETIC_ADMISSION_PACKAGE_READER";
  process.env.GH_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const lookups: string[] = [],
    deliveries: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url.origin === "https://api.github.com") {
        assert.equal(init?.method, "GET");
        assert.equal(headers.get("authorization"), `token ${token}`);
        const id = /^\/repos\/boburning\/portcove\/actions\/artifacts\/([1-9][0-9]*)\/zip$/u.exec(
          url.pathname,
        )?.[1];
        assert.ok(id);
        lookups.push(id);
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://productionresultssa10.blob.core.windows.net/actions-results/${id}?sig=synthetic`,
          },
        });
      }
      assert.equal(init?.credentials, "omit");
      assert.equal(headers.has("authorization"), false);
      const id = /^\/actions-results\/([1-9][0-9]*)$/u.exec(url.pathname)?.[1];
      assert.ok(id);
      deliveries.push(id);
      const archive = await download(`repos/boburning/portcove/actions/artifacts/${id}/zip`, {
        cwd: f.root,
        maxBytes: 512 * 1024 ** 2,
        timeoutMs: 120000,
      });
      return new Response(Uint8Array.from(archive));
    },
  );
  const result = await acquireReleaseAdmission(f.root, f.config, options);
  assert.equal(result.decision, "hold");
  assert.equal(result.descriptor, null);
  assert.equal(lookups.length, 4);
  assert.deepEqual(deliveries, lookups);
  assert.ok(!(await readdir(result.directory)).some((name) => /^package-.*[.]zip$/u.test(name)));
});

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

void test("source publication inventory keeps ordered short pages, exact repo alias and original row shape through the SDK", async () => {
  for (const wrongRepository of [false, true]) {
    const routes: string[] = [];
    const second = `/repositories/${wrongRepository ? 1354613115 : 1354613114}/releases?page=2&per_page=100`;
    const reader = await createPublicationInventoryWithSdk({
      token: "synthetic-source-inventory",
      deadline: performance.now() + 5000,
      async recheck() {},
      async fetch(input, init) {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("authorization"), "token synthetic-source-inventory");
        routes.push(url.pathname + url.search);
        if (url.pathname === "/repos/boburning/portcove") {
          return Response.json({
            id: 1354613114,
            full_name: "boburning/portcove",
            node_id: "R_fixture",
          });
        }
        const first = url.pathname === "/repos/boburning/portcove/releases";
        if (!first) assert.equal(url.pathname + url.search, second);
        const time = "2026-11-04T00:00:00Z";
        return Response.json(
          [
            {
              id: first ? 3 : 1,
              tag_name: first ? "v0.0.3" : "v0.0.1",
              draft: false,
              prerelease: true,
              published_at: time,
              updated_at: time,
            },
          ],
          first
            ? { headers: { link: `<https://api.github.com${second}>; rel="next"` } }
            : undefined,
        );
      },
    });
    if (wrongRepository) {
      await assert.rejects(reader.releases(), /pagination changed scope/u);
      assert.equal(routes.length, 2);
    } else {
      assert.deepEqual(
        (await reader.releases()).map((row) => row.id),
        [1, 3],
      );
      // The walk's earlier page is re-read once at the end and must not change.
      assert.deepEqual(routes, [
        "/repos/boburning/portcove",
        "/repos/boburning/portcove/releases?per_page=100",
        second,
        "/repos/boburning/portcove/releases?per_page=100",
      ]);
    }
  }
});

for (const failure of ["releases", "comparison"] as const)
  void test(`default admission uses locked publication and frozen source readers before ${failure} failure`, async (t) => {
    const f = await fixture(t);
    f.input.opportunity.change_set_sha256 = f.sourceFacts.expectedHash;
    Object.assign(f.input.opportunity.classification, {
      change_set_sha256: f.sourceFacts.expectedHash,
      change_set_scope: "portcove-release-net-tree-delta-v1",
    });
    Object.assign(f.input.active_candidate, {
      frozen_opportunity: structuredClone(f.input.opportunity),
    });
    const { api, recover } = f.options;
    assert.ok(api && recover);
    const token = "inert-fixed-admission-inventory";
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = token;
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    });
    const events: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(request.headers.get("authorization"), `token ${token}`);
        events.push(url.pathname);
        if (url.pathname === "/graphql") {
          const raw: unknown = await request.json();
          assert.ok(
            isRecord(raw) && raw.query === releasePublicationRefsQuery && isRecord(raw.variables),
          );
          return Response.json({
            data: api.graphql(releasePublicationRefsQuery, raw.variables).data,
          });
        }
        if (
          failure === "releases"
            ? url.pathname.endsWith("/releases")
            : url.pathname.includes("/compare/")
        )
          return Response.json({ message: "transient provider refusal" }, { status: 503 });
        return Response.json(api.request("GET", url.pathname.slice(1)).body);
      },
    );
    await assert.rejects(
      acquireReleaseAdmission(f.root, f.config, {
        deadline: performance.now() + 5000,
        recover: async (...args) => {
          events.push("recover");
          return recover(...args);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        assert.equal(
          error.evidence.phase,
          failure === "releases" ? "repository-and-reservation" : "source-consistency",
        );
        assert.equal(
          error.evidence.api_requests,
          events.filter((event) => event !== "recover").length,
        );
        return true;
      },
    );
    assert.deepEqual(events.slice(0, 4), [
      "/repos/boburning/portcove",
      "recover",
      "/graphql",
      "/repos/boburning/portcove/releases",
    ]);
    if (failure === "comparison") {
      assert.match(events.at(-1) ?? "", /^\/repos\/boburning\/portcove\/compare\//u);
      assert.equal(events.filter((event) => event.includes("/compare/")).length, 1);
    } else
      // A transient inventory refusal retries with bounded backoff (three
      // attempts in total) and then fails; it is never read as an empty list.
      assert.deepEqual(events.slice(3), Array(3).fill("/repos/boburning/portcove/releases"));
  });

void test("default admission journal uses a separate scoped SDK read through a stalled body", async (t) => {
  const f = await fixture(t);
  const token = "inert-fixed-admission-journal";
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const routes: string[] = [];
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), `token ${token}`);
      routes.push(new URL(request.url).pathname);
      if (routes.length === 1)
        return Response.json({
          id: 1354613114,
          full_name: "boburning/portcove",
          node_id: "R_fixture",
        });
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  await assert.rejects(
    acquireReleaseAdmission(f.root, f.config, { deadline: performance.now() + 250 }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.phase, "repository-and-reservation");
      assert.equal(error.evidence.api_requests, 1);
      return true;
    },
  );
  assert.deepEqual(routes, ["/repos/boburning/portcove", "/repos/boburning/portcove"]);
  assert.equal(cancelled, true);
});

void test("locked publication inventory uses the operation's existing exhausted reservation", async () => {
  let occupied = 159;
  let observed = 0;
  let dispatched = 0;
  const reader = await createPublicationInventoryWithSdk({
    token: "synthetic-shared-inventory",
    deadline: performance.now() + 1000,
    async recheck() {},
    accounting: {
      currentDeadline: () => performance.now() + 1000,
      reserve() {
        if (occupied >= 160) throw new Error("admission API acquisition bound exhausted");
        occupied++;
        return {
          consumeBytes() {},
          settle(attempt) {
            if (!attempt.dispatched) occupied--;
          },
        };
      },
      elapsed() {
        observed++;
      },
    },
    async fetch() {
      dispatched++;
      return Response.json({
        id: 1354613114,
        full_name: "boburning/portcove",
        node_id: "R_fixture",
      });
    },
  });
  await assert.rejects(reader.releases(), /admission API acquisition bound exhausted/u);
  assert.equal(dispatched, 1);
  assert.equal(occupied, 160);
  assert.ok(observed >= 1);
});

void test("default admission brackets exact SDK check pages and statuses across archive acquisition", async (t) => {
  const token = "inert-fixed-admission-qualification";
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  for (const drift of [null, "status-drift", "issuer-drift"]) {
    const f = await fixture(t);
    const { api, recover, download } = f.options;
    assert.ok(api && recover && download);
    if (drift) f.faults.value = drift;
    const qualification: string[] = [];
    const mocked = t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(request.headers.get("authorization"), `token ${token}`);
        if (url.pathname === "/graphql") {
          const raw: unknown = await request.json();
          assert.ok(
            isRecord(raw) && raw.query === releasePublicationRefsQuery && isRecord(raw.variables),
          );
          return Response.json({
            data: api.graphql(releasePublicationRefsQuery, raw.variables).data,
          });
        }
        const raw = api.request("GET", url.href);
        const headers = new Headers(Object.fromEntries(raw.headers));
        if (url.pathname.endsWith("/check-runs")) {
          assert.equal(url.searchParams.get("filter"), "latest");
          assert.match(url.pathname, new RegExp(f.prepared.sha, "u"));
          const page = url.searchParams.get("page") ?? "1";
          qualification.push(`checks-${page}`);
          assert.ok(isRecord(raw.body) && Array.isArray(raw.body.check_runs));
          const first = page === "1";
          if (first) {
            url.searchParams.set("page", "2");
            headers.set("link", `<${url.href}>; rel="next"`);
          }
          return Response.json(
            {
              ...raw.body,
              check_runs: raw.body.check_runs.slice(first ? 0 : 1, first ? 1 : undefined),
            },
            { headers },
          );
        }
        if (url.pathname.endsWith("/status")) {
          assert.match(url.pathname, new RegExp(f.prepared.sha, "u"));
          qualification.push("status");
        }
        return Response.json(raw.body, { headers });
      },
    );
    try {
      const result = acquireReleaseAdmission(f.root, f.config, { recover, download });
      if (drift) await assert.rejects(result, /freshness-bracket/u);
      else assert.equal((await result).decision, "hold");
      assert.deepEqual(
        qualification,
        drift === "issuer-drift"
          ? ["checks-1", "checks-2", "status", "checks-1"]
          : ["checks-1", "checks-2", "status", "checks-1", "checks-2", "status"],
      );
    } finally {
      mocked.mock.restore();
    }
  }
});

/** Simulated provider for lifetime-scale inventory behavior. It models GitHub
 * page and cursor semantics only; it does not measure a real provider quota. */
function simulatedPublicationProvider(count: number, extraTags: string[] = []) {
  const time = "2026-11-04T00:00:00Z";
  const releases = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    tag_name: `v0.${Math.floor(index / 1000)}.${index % 1000}`,
    draft: false,
    prerelease: true,
    published_at: time,
    updated_at: time,
  }));
  const tag = (name: string, index: number) => ({
    id: `ref-${index}`,
    name,
    prefix: "refs/tags/",
    target: { __typename: "Commit", oid: index.toString(16).padStart(40, "0") },
  });
  const tags = [...releases.map((release) => release.tag_name), ...extraTags]
    .map(tag)
    .sort((a, b) => a.name.localeCompare(b.name));
  const provider = {
    releases,
    tags,
    tag,
    requests: 0,
    fault: undefined as
      | ((url: URL, body: Record<string, unknown> | null) => Response | undefined)
      | undefined,
    async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      provider.requests++;
      const body: unknown = request.method === "POST" ? await request.json() : null;
      assert.ok(body === null || isRecord(body));
      const fault = provider.fault?.(url, body);
      if (fault) return fault;
      if (url.pathname === "/repos/boburning/portcove")
        return Response.json({
          id: 1354613114,
          full_name: "boburning/portcove",
          node_id: "R_scale",
        });
      if (url.pathname === "/repos/boburning/portcove/releases") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const listing = [...provider.releases].reverse();
        const rows = listing.slice((page - 1) * 100, page * 100);
        return Response.json(
          rows,
          page * 100 < listing.length
            ? {
                headers: {
                  link: `<https://api.github.com/repos/boburning/portcove/releases?per_page=100&page=${page + 1}>; rel="next"`,
                },
              }
            : undefined,
        );
      }
      assert.equal(url.pathname, "/graphql");
      assert.ok(isRecord(body) && typeof body.query === "string" && isRecord(body.variables));
      const variables = body.variables;
      const repository = {
        id: "R_scale",
        databaseId: 1354613114,
        nameWithOwner: "boburning/portcove",
      };
      if (/query AdmissionExactRef/u.test(body.query)) {
        const name = String(variables.name).slice("refs/tags/".length);
        const ref = provider.tags.find((value) => value.name === name) ?? null;
        return Response.json({ data: { repository: { ...repository, ref } } });
      }
      const scoped =
        typeof variables.prefix === "string" ? variables.prefix.slice("refs/tags/".length) : "";
      const matching = provider.tags
        .filter((value) => value.name.startsWith(scoped))
        .map((value) => ({
          ...value,
          name: value.name.slice(scoped.length),
          prefix: `refs/tags/${scoped}`,
        }));
      const offset = variables.cursor === null ? 0 : Number(variables.cursor);
      const nodes = matching.slice(offset, offset + 100);
      return Response.json({
        data: {
          repository: {
            ...repository,
            refs: {
              totalCount: matching.length,
              pageInfo: {
                hasNextPage: offset + 100 < matching.length,
                endCursor: String(offset + nodes.length),
              },
              nodes,
            },
          },
        },
      });
    },
  };
  return provider;
}

function openSimulatedInventory(provider: ReturnType<typeof simulatedPublicationProvider>) {
  return createPublicationInventoryWithSdk({
    token: "synthetic-scale-inventory",
    deadline: performance.now() + 120000,
    recheck: async () => {},
    fetch: provider.fetch,
  });
}

async function interruptedScan(
  provider: ReturnType<typeof simulatedPublicationProvider>,
  scan: (reader: Awaited<ReturnType<typeof openSimulatedInventory>>) => Promise<unknown>,
) {
  const error = await scan(await openSimulatedInventory(provider)).then(
    () => assert.fail("a budget-interrupted inventory resolved as complete"),
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof PublicationInventoryIncompleteError);
  assert.match(error.message, /publication inventory budget exceeded/u);
  return error;
}

for (const count of [1000, 5000, 20000])
  void test(`release and tag inventories read past the former 1,600-record ceiling to provider exhaustion at ${count} records`, async () => {
    const provider = simulatedPublicationProvider(count);
    const ids = Array.from({ length: count }, (_, index) => index + 1);
    const names = provider.tags.map((row) => row.name);
    if (count <= 7900) {
      // Within one reader's request budget (walk plus end-of-walk re-reads,
      // about 7,900 Releases) the read is a single pass.
      const reader = await openSimulatedInventory(provider);
      assert.deepEqual(
        (await reader.releases()).map((row) => row.id),
        ids,
      );
      assert.deepEqual(
        (await (await openSimulatedInventory(provider)).tags()).map((row) => row.name),
        names,
      );
      return;
    }
    // Past one budget the single pass fails visibly; continuation reaches the
    // end and is labeled a composite rather than a single snapshot.
    const releases = await interruptedScan(provider, (reader) => reader.releases());
    const resumed = await (
      await openSimulatedInventory(provider)
    ).resumeReleases(releases.checkpoint);
    assert.equal(resumed.snapshot, "composite-across-budget-windows");
    assert.deepEqual(
      resumed.rows.map((row) => row.id),
      ids,
    );
    const tags = await interruptedScan(provider, (reader) => reader.tags());
    const resumedTags = await (await openSimulatedInventory(provider)).resumeTags(tags.checkpoint);
    assert.equal(resumedTags.snapshot, "composite-across-budget-windows");
    assert.deepEqual(
      resumedTags.rows.map((row) => row.name),
      names,
    );
  });

void test("a budget-interrupted inventory is refused as complete and continues only from its own checkpoint", async () => {
  const provider = simulatedPublicationProvider(20000);
  const interrupted = await interruptedScan(provider, (reader) => reader.releases());
  assert.match(interrupted.message, /incomplete after 15900 records; resumable/u);
  assert.equal(interrupted.checkpoint.kind, "releases");
  assert.equal(interrupted.checkpoint.rows.length, 15900);
  const resumed = await (
    await openSimulatedInventory(provider)
  ).resumeReleases(interrupted.checkpoint);
  assert.equal(new Set(resumed.rows.map((row) => row.id)).size, 20000);
  const tagError = await interruptedScan(provider, (reader) => reader.tags());
  assert.equal(tagError.checkpoint.kind, "tags");
  const tags = await (await openSimulatedInventory(provider)).resumeTags(tagError.checkpoint);
  assert.equal(new Set(tags.rows.map((row) => row.id)).size, 20000);
  // A checkpoint belongs to one scan kind, row projection and position.
  const reader = await openSimulatedInventory(provider);
  await assert.rejects(
    reader.resumeReleases(tagError.checkpoint),
    /checkpoint does not match this scan/u,
  );
  assert.equal(interrupted.checkpoint.kind, "releases");
  for (const forged of [
    { ...interrupted.checkpoint, projection: "notes" as const },
    { ...interrupted.checkpoint, previous: { route: interrupted.checkpoint.route, ids: [1] } },
    { ...interrupted.checkpoint, head: [] },
  ])
    await assert.rejects(reader.resumeReleases(forged), /checkpoint does not match this scan/u);
});

void test("resuming fails visibly when the head page or the last accepted page changed", async () => {
  for (const change of ["older-deleted", "added-and-deleted", "tag-added-and-deleted"] as const) {
    const provider = simulatedPublicationProvider(20000);
    const tags = change === "tag-added-and-deleted";
    const interrupted = await interruptedScan(provider, (reader) =>
      tags ? reader.tags() : reader.releases(),
    );
    const reader = await openSimulatedInventory(provider);
    if (change === "older-deleted") {
      // Deleting an already-read Release shifts every later page by one row.
      provider.releases.splice(provider.releases.length - 1000, 1);
    } else if (change === "added-and-deleted") {
      // A new Release plus a deleted one keeps every page count unchanged.
      provider.releases.splice(provider.releases.length - 5, 1);
      provider.releases.push({ ...provider.releases.at(-1)!, id: 99999, tag_name: "v9.9.9" });
    } else {
      // A new tag plus a deleted already-read tag keeps totalCount unchanged.
      provider.tags.splice(500, 1);
      provider.tags.unshift(provider.tag("a-new-tag", 99999));
    }
    await assert.rejects(
      tags
        ? reader.resumeTags(interrupted.checkpoint)
        : reader.resumeReleases(interrupted.checkpoint),
      tags
        ? /admission refs changed before their resume point/u
        : /release inventory changed before its resume point/u,
    );
  }
});

void test("a Release deleted behind a resumed window during its walk fails visibly", async () => {
  const provider = simulatedPublicationProvider(20000);
  const interrupted = await interruptedScan(provider, (reader) => reader.releases());
  let deleted = false;
  provider.fault = (url) => {
    // Delete a Release from an earlier window's page while page 170 is read.
    if (!deleted && url.searchParams.get("page") === "170") {
      provider.releases.splice(provider.releases.length - 5000, 1);
      deleted = true;
    }
    return undefined;
  };
  await assert.rejects(
    (await openSimulatedInventory(provider)).resumeReleases(interrupted.checkpoint),
    (error: unknown) =>
      error instanceof PublicationInventoryIncompleteError &&
      /changed during the scan/u.test(error.message),
  );
});

void test("a composite continuation does not re-observe edits to already-read records", async () => {
  const provider = simulatedPublicationProvider(20000);
  const interrupted = await interruptedScan(provider, (reader) => reader.releases());
  // Publishing an older draft in place moves no row and changes no count.
  const edited = provider.releases[15000]!;
  edited.draft = true;
  const resumed = await (
    await openSimulatedInventory(provider)
  ).resumeReleases(interrupted.checkpoint);
  // This is why a composite is labeled and is not conflict authority alone.
  assert.equal(resumed.snapshot, "composite-across-budget-windows");
  assert.equal(resumed.rows.find((row) => row.id === edited.id)?.draft, false);
  await assert.rejects(
    (await openSimulatedInventory(provider)).releases(),
    PublicationInventoryIncompleteError,
  );
});

void test("a single-pass Release read of one short page costs no verification requests", async () => {
  const provider = simulatedPublicationProvider(15);
  const reader = await openSimulatedInventory(provider);
  const before = provider.requests;
  assert.equal((await reader.releases()).length, 15);
  assert.equal(provider.requests - before, 1);
});

void test("a Release deleted from an already-read page during a single pass fails visibly", async () => {
  for (const deletedPage of [1, 3]) {
    const provider = simulatedPublicationProvider(1000);
    const removed = provider.releases.at(-((deletedPage - 1) * 100 + 7))!.id;
    const skipped = provider.releases.at(-(5 * 100 + 1))!.id;
    let deleted = false;
    provider.fault = (url) => {
      // Delete after page 5 is read and before page 6: page 6 loses its first row.
      if (!deleted && url.searchParams.get("page") === "6") {
        provider.releases.splice(
          provider.releases.findIndex((row) => row.id === removed),
          1,
        );
        deleted = true;
      }
      return undefined;
    };
    const error = await (await openSimulatedInventory(provider)).releases().then(
      () => assert.fail("a walk that skipped a Release resolved as complete"),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof PublicationInventoryIncompleteError);
    assert.match(error.message, /release inventory changed during the scan/u);
    // The checkpoint never claims the shifted row was read.
    assert.ok(!error.checkpoint.rows.some((row) => isRecord(row) && row.id === skipped));
    // A fresh read after the change is complete again.
    provider.fault = undefined;
    const rows = await (await openSimulatedInventory(provider)).releases();
    assert.equal(rows.length, 999);
    assert.ok(rows.some((row) => row.id === skipped));
  }
});

void test("a Release published mid-walk fails visibly in a single pass", async () => {
  const provider = simulatedPublicationProvider(1000);
  let published = false;
  provider.fault = (url) => {
    if (!published && url.searchParams.get("page") === "4") {
      provider.releases.push({ ...provider.releases.at(-1)!, id: 5000, tag_name: "v9.9.9" });
      published = true;
    }
    return undefined;
  };
  await assert.rejects(
    (await openSimulatedInventory(provider)).releases(),
    /duplicates a Release ID/u,
  );
});

void test("a provider that drops the next relation at a full page boundary fails visibly", async () => {
  const provider = simulatedPublicationProvider(1000);
  provider.fault = (url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname !== "/repos/boburning/portcove/releases" || page !== 4) return undefined;
    // A full page without `next`, although six more pages exist.
    return Response.json([...provider.releases].reverse().slice(300, 400));
  };
  await assert.rejects(
    (await openSimulatedInventory(provider)).releases(),
    (error: unknown) =>
      error instanceof PublicationInventoryIncompleteError &&
      /ended before the provider was exhausted/u.test(error.message),
  );
});

void test("a provider that ends a short page without next is the documented residual", async () => {
  // REST Release listing reports no total, so a short page without `next` is
  // indistinguishable from the real end. This pins the residual, not a defect.
  const provider = simulatedPublicationProvider(1000);
  provider.fault = (url) =>
    url.pathname === "/repos/boburning/portcove/releases" && url.searchParams.get("page") === "4"
      ? Response.json([...provider.releases].reverse().slice(300, 350))
      : undefined;
  assert.equal((await (await openSimulatedInventory(provider)).releases()).length, 350);
});

void test("the legacy synchronous Release reader verifies its walk the same way", () => {
  const provider = simulatedPublicationProvider(300);
  const listing = () => [...provider.releases].reverse();
  let deleted = false;
  const reader = createReleasePublicationReader({
    request(method, endpoint) {
      assert.equal(method, "GET");
      const url = new URL(endpoint, "https://api.github.com/");
      if (url.pathname === "/repos/boburning/portcove")
        return {
          headers: new Map(),
          body: { id: 1354613114, full_name: "boburning/portcove", node_id: "R_scale" },
        };
      const page = Number(url.searchParams.get("page") ?? "1");
      if (page === 2 && !deleted) {
        provider.releases.splice(provider.releases.length - 3, 1);
        deleted = true;
      }
      const rows = listing().slice((page - 1) * 100, page * 100);
      const more = page * 100 < listing().length;
      return {
        headers: new Map(
          more
            ? [
                [
                  "link",
                  `<https://api.github.com/repos/boburning/portcove/releases?per_page=100&page=${page + 1}>; rel="next"`,
                ],
              ]
            : [],
        ),
        body: rows,
      };
    },
    graphql() {
      throw new Error("not used");
    },
  });
  assert.throws(
    () => reader.releases(),
    (error: unknown) =>
      error instanceof PublicationInventoryIncompleteError &&
      /changed during the scan/u.test(error.message),
  );
  assert.equal(reader.releases().length, 299);
});

void test("exact identity and namespace receipt reads detect conflicts beyond the former bound at 20,000 tags", async () => {
  const receipts = Array.from({ length: 2000 }, (_, index) => [
    `portcove-fixture-prepared/v1.0.${index}`,
    ...(index === 1999
      ? []
      : [`portcove-fixture-prepared-source/${index.toString(16).padStart(40, "0")}`]),
  ]).flat();
  const provider = simulatedPublicationProvider(20000, receipts);
  const reader = await openSimulatedInventory(provider);
  const before = provider.requests;
  const last = await reader.tag("v0.19.999");
  assert.equal(last?.name, "v0.19.999");
  assert.equal(await reader.tag("v9.9.9"), null);
  assert.equal(provider.requests - before, 2);
  const namespace = await reader.namespaceTags("portcove-fixture");
  assert.equal(namespace.length, 3999);
  assert.ok(namespace.every((row) => row.prefix === "refs/tags/"));
  assert.equal(provider.requests - before, 2 + 20 + 20);
  // The unpaired receipt sorts past position 1,600 and is still a conflict.
  await assert.rejects(
    reader.readAllocations(namespace, "portcove-fixture"),
    /incomplete receipt pairs/u,
  );
});

void test("incomplete provider evidence is refused rather than read as absence", async () => {
  const provider = simulatedPublicationProvider(5000);
  provider.fault = (url, body) => {
    if (
      url.pathname === "/repos/boburning/portcove/releases" &&
      url.searchParams.get("page") === "30"
    )
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (isRecord(body) && isRecord(body.variables) && body.variables.cursor === "2500")
      return Response.json({
        data: {
          repository: {
            id: "R_scale",
            databaseId: 1354613114,
            nameWithOwner: "boburning/portcove",
            refs: {
              totalCount: 5000,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    if (isRecord(body) && isRecord(body.variables) && body.variables.name === "refs/tags/v0.0.1")
      return Response.json({
        data: {
          repository: {
            id: "R_scale",
            databaseId: 1354613114,
            nameWithOwner: "boburning/portcove",
          },
        },
      });
    if (isRecord(body) && isRecord(body.variables) && body.variables.name === "refs/tags/v0.0.2")
      return Response.json({ data: null, errors: [{ message: "timeout" }] });
    return undefined;
  };
  const reader = await openSimulatedInventory(provider);
  await assert.rejects(
    reader.releases(),
    (error: unknown) =>
      error instanceof PublicationInventoryIncompleteError && error.checkpoint.rows.length === 2900,
  );
  await assert.rejects(reader.tags(), /admission refs omit records/u);
  await assert.rejects(reader.tag("v0.0.1"), /exact tag lookup response is incomplete/u);
  // A provider GraphQL error is a failed lookup, never a null (absent) ref.
  await assert.rejects(reader.tag("v0.0.2"), /timeout/u);
  await assert.rejects(reader.tag("refs/tags/v0.0.3"), /requires one valid tag name/u);
});

/** Adds `count` published historical versions, each with its published tag
 * and its complete receipt pair, to an admission fixture. */
function publishHistory(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const oidOf = (value: number) => value.toString(16).padStart(40, "0");
  for (let i = 0; i < count; i++) {
    const version = `0.0.${i + 1}`;
    const prepared = oidOf(0x1000000 + 2 * i);
    const source = oidOf(0x1000001 + 2 * i);
    const target = { __typename: "Commit", oid: prepared };
    f.tags.push(
      { id: `Ref_published_${i}`, name: `v${version}`, prefix: "refs/tags/", target },
      {
        id: `Ref_receipt_${i}`,
        name: `portcove-fixture-prepared/v${version}`,
        prefix: "refs/tags/",
        target,
      },
      {
        id: `Ref_receipt_source_${i}`,
        name: `portcove-fixture-prepared-source/${source}`,
        prefix: "refs/tags/",
        target,
      },
    );
    f.releases.push({
      id: 100000 + i,
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      published_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
  }
  f.tags.sort((a, b) => a.name.localeCompare(b.name));
}

for (const count of [256, 257])
  void test(`admission verifies only the active receipt's raw commits with ${count} published historical versions`, async (t) => {
    const commits = (calls: string[]) => calls.filter((call) => call.includes("/git/commits/"));
    const empty = await fixture(t);
    await acquireReleaseAdmission(empty.root, empty.config, empty.options);
    const f = await fixture(t);
    publishHistory(f, count);
    const result = await acquireReleaseAdmission(f.root, f.config, f.options);
    // Before receipt pairing every historical receipt cost two raw-commit
    // reads (2 x 258 more here), which exhausted the 160-request admission
    // budget at roughly sixty published versions. History adds none now.
    assert.deepEqual(commits(f.calls), commits(empty.calls));
    assert.equal(result.decision, "hold");
    assert.ok(result.holds.includes("routine-preview-publication-history-unresolved"));
    assert.equal(result.allocations.length, count + 1);
    const publication = result.publication as {
      published_versions: string[];
      published_sources: string[];
      reserved_versions: string[];
    };
    assert.equal(publication.published_versions.length, count);
    assert.equal(publication.published_sources.length, count);
    // The complete reservation inventory still finds exactly the active
    // reservation unpublished past the former 256-entry coordinator bound.
    assert.deepEqual(publication.reserved_versions, [f.input.active_candidate.version]);
  });

void test("admission still refuses a historical receipt that does not pair beyond the former bound", async (t) => {
  const f = await fixture(t);
  publishHistory(f, 257);
  const unpaired = f.tags.findIndex((tag) =>
    tag.name.startsWith("portcove-fixture-prepared-source/"),
  );
  f.tags.splice(unpaired, 1);
  await assert.rejects(
    acquireReleaseAdmission(f.root, f.config, f.options),
    /repository-and-reservation/u,
  );
});

for (const count of [1600, 1601])
  void test(`admission's synchronous reader reads a ${count}-Release inventory past the former 16-page guard`, async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < count; i++)
      f.releases.push({
        id: 200000 + i,
        tag_name: `v0.1.0-alpha.${100 + i}`,
        draft: true,
        prerelease: true,
        published_at: null,
        updated_at: "2026-10-18T00:00:00Z",
      });
    const result = await acquireReleaseAdmission(f.root, f.config, f.options);
    assert.equal(result.decision, "hold");
    const last = Math.ceil(count / 100);
    // The final page is read once by the walk and once by the freshness
    // bracket; page 17 was refused as an escaped traversal before.
    assert.equal(
      f.calls.filter((call) => call.endsWith(`releases?per_page=100&page=${last}`)).length,
      2,
    );
  });

void test("an in-place edit of an already-read Release is refused as changed, never accepted stale", async () => {
  const provider = simulatedPublicationProvider(350);
  let edited = false;
  provider.fault = (url) => {
    // After the walk has accepted page 1, the newest Release is edited in
    // place: same ID, same position, different publication facts.
    if (!edited && url.searchParams.get("page") === "3") {
      const newest = provider.releases.at(-1)!;
      newest.prerelease = false;
      newest.updated_at = "2026-11-05T00:00:00Z";
      edited = true;
    }
    return undefined;
  };
  await assert.rejects(
    (await openSimulatedInventory(provider)).releases(),
    (error: unknown) =>
      error instanceof PublicationInventoryIncompleteError &&
      /changed during the scan/u.test(error.message),
  );
  const rows = await (await openSimulatedInventory(provider)).releases();
  assert.equal(rows.at(-1)?.prerelease, false);
});

void test("a resumed inventory whose already-read rows were edited is refused as incomplete", async () => {
  const provider = simulatedPublicationProvider(9000);
  const interrupted = await interruptedScan(provider, (reader) => reader.releases());
  provider.releases.at(-1)!.draft = true;
  // The continuation is discarded, not completed from stale rows; a fresh
  // single-pass read is the only way forward.
  await assert.rejects(
    (await openSimulatedInventory(provider)).resumeReleases(interrupted.checkpoint),
    /changed before its resume point/u,
  );
  const tagProvider = simulatedPublicationProvider(20000);
  const tags = await interruptedScan(tagProvider, (reader) => reader.tags());
  // Same ref ID and name, moved to another commit: an in-place tag edit.
  tagProvider.tags[0]!.target = { __typename: "Commit", oid: "e".repeat(40) };
  await assert.rejects(
    (await openSimulatedInventory(tagProvider)).resumeTags(tags.checkpoint),
    /changed before their resume point/u,
  );
});

for (const count of [256, 257, 1600, 1601, 20000])
  void test(`receipt pairing reads ${count} receipts with no per-receipt request and still detects a late conflict`, async () => {
    const oidOf = (value: number) => value.toString(16).padStart(40, "0");
    const provider = simulatedPublicationProvider(1);
    for (let i = 0; i < count; i++) {
      const target = { __typename: "Commit", oid: oidOf(0x1000000 + 2 * i) };
      provider.tags.push(
        {
          id: `receipt-${i}`,
          name: `portcove-fixture-prepared/v1.${Math.floor(i / 1000)}.${i % 1000}`,
          prefix: "refs/tags/",
          target,
        },
        {
          id: `receipt-source-${i}`,
          name: `portcove-fixture-prepared-source/${oidOf(0x1000001 + 2 * i)}`,
          prefix: "refs/tags/",
          target,
        },
      );
    }
    provider.tags.sort((a, b) => a.name.localeCompare(b.name));
    const pagesNeeded = 1 + 2 * Math.ceil(count / 100);
    if (pagesNeeded > 160)
      // One default reader's 160-request budget cannot list this namespace in
      // a single pass; it fails visibly as incomplete, never as absence.
      await assert.rejects(
        (await openSimulatedInventory(provider)).namespaceTags("portcove-fixture"),
        PublicationInventoryIncompleteError,
      );
    let granted = 0;
    const reader = await createPublicationInventoryWithSdk({
      token: "synthetic-scale-inventory",
      deadline: performance.now() + 120000,
      recheck: async () => {},
      fetch: provider.fetch,
      // A caller-owned budget sized to the namespace (as admission supplies).
      accounting: {
        reserve() {
          if (++granted > pagesNeeded) throw new Error("caller budget exceeded");
          return { consumeBytes() {}, settle() {} };
        },
        elapsed() {},
        currentDeadline: () => performance.now() + 120000,
      },
    });
    const before = provider.requests;
    const namespace = await reader.namespaceTags("portcove-fixture");
    const pages = 2 * Math.ceil(count / 100);
    assert.equal(provider.requests - before, pages);
    const { receipts, allocations } = await reader.readAllocations(
      namespace,
      "portcove-fixture",
      [],
    );
    // Receipt pairs come from the tag listing alone: no raw-commit reads,
    // where every receipt previously cost two.
    assert.equal(provider.requests - before, pages);
    assert.equal(receipts.length, count);
    assert.equal(allocations.length, 0);
    const last = `1.${Math.floor((count - 1) / 1000)}.${(count - 1) % 1000}`;
    assert.deepEqual(
      receipts.find((receipt) => receipt.version === last),
      {
        version: last,
        source_commit: oidOf(0x1000001 + 2 * (count - 1)),
        prepared_commit: oidOf(0x1000000 + 2 * (count - 1)),
      },
    );
    // A source receipt paired twice past every former bound is a conflict.
    const conflicting = structuredClone(namespace);
    const lastSource = conflicting.findLastIndex((row) =>
      String(row.name).startsWith("portcove-fixture-prepared-source/"),
    );
    conflicting[lastSource]!.target = structuredClone(conflicting[0]!.target);
    await assert.rejects(
      reader.readAllocations(conflicting, "portcove-fixture", []),
      /source pair is missing or ambiguous/u,
    );
  });

void test("ordinary download and body activity on an already-read page is not an inventory change", async () => {
  const provider = simulatedPublicationProvider(350);
  const listing = () =>
    [...provider.releases].reverse().map((row) => ({
      ...row,
      body: `notes ${downloads}`,
      assets: [{ id: row.id * 10, name: "installer.exe", size: 1, download_count: downloads }],
    }));
  let downloads = 0;
  provider.fault = (url) => {
    if (url.pathname !== "/repos/boburning/portcove/releases") return undefined;
    const page = Number(url.searchParams.get("page") ?? "1");
    downloads++;
    const rows = listing().slice((page - 1) * 100, page * 100);
    return Response.json(
      rows,
      page * 100 < provider.releases.length
        ? {
            headers: {
              link: `<https://api.github.com/repos/boburning/portcove/releases?per_page=100&page=${page + 1}>; rel="next"`,
            },
          }
        : undefined,
    );
  };
  const { readPublicationReleases } = await import("./release-publication-inventory.mts");
  const rows = await readPublicationReleases(async (url) => {
    const response = await provider.fetch(url.href);
    return {
      data: await response.json(),
      headers: { link: response.headers.get("link") ?? undefined },
    };
  });
  assert.equal(rows.length, 350);
});
