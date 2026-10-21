import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  assessInitialProofBudget706,
  initialProofRisk706Body,
  inspectInitialProofRisk706,
  inspectInitialProofRisk706Comment,
  risk706GraphDigest,
  risk706Expiry,
  inspectRisk706MeasurementPins,
} from "./linux-beta-risk-706-profile.mts";
import {
  authorizeActualLinuxRisk706,
  authorizeActualSiteLinuxRisk706,
  durableExposure706,
  readRisk706NativeInputs,
} from "./linux-beta-risk-706-controller.mts";
import { nativePaths706, approval706 } from "./linux-beta-risk-706.mts";
import { requireVerifiedLinuxRiskAssessment706 } from "./release-compiler-evidence.mts";
import { requireActualAdmissionCompilerReceipt706 } from "./acquire-release-admission.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { inspectReleaseEffectExpectation } from "./release-effect-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectReleaseAuthorityConfiguration } from "./release-authority-configuration.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function fixture() {
  const profile = {
    schema_version: 1,
    profile: "initial-public-proof-three-total-v1",
    max_publications: 3,
    approved_at: "2026-10-21T12:30:00Z",
    expires_at: risk706Expiry,
    native_inputs_sha256: "a".repeat(64),
    dependency_graph_sha256: "b".repeat(64),
    policy_sha256: "c".repeat(64),
    amendment: { comment_id: 7000000000, owner_id: 43177418, body_sha256: "d".repeat(64) },
  };
  const body = initialProofRisk706Body(profile);
  profile.amendment.body_sha256 = hash(body);
  const comment = {
    id: profile.amendment.comment_id,
    html_url: `https://github.com/boburning/portcove/issues/706#issuecomment-${profile.amendment.comment_id}`,
    issue_url: "https://api.github.com/repos/boburning/portcove/issues/706",
    user: { id: 43177418, login: "boburning", type: "User" },
    created_at: profile.approved_at,
    body,
  };
  return { profile, comment, now: "2026-10-21T12:31:00Z" };
}
void test("future profile requires a distinct exact owner amendment with unchanged advisory/expiry", () => {
  const f = fixture();
  assert.equal(inspectInitialProofRisk706Comment(f.profile, f.comment, f.now).authority, "none");
  for (const comment of [
    { ...f.comment, html_url: approval706 },
    { ...f.comment, body: f.comment.body + "\n" },
    { ...f.comment, user: { ...f.comment.user, id: 1 } },
    { ...f.comment, user: { ...f.comment.user, type: "Bot" } },
    { ...f.comment, issue_url: "https://api.github.com/repos/boburning/portcove/issues/534" },
  ])
    assert.throws(() => inspectInitialProofRisk706Comment(f.profile, comment, f.now), /amendment/u);
  assert.throws(
    () => inspectInitialProofRisk706Comment(f.profile, f.comment, risk706Expiry),
    /expired/u,
  );
  assert.throws(
    () => inspectInitialProofRisk706({ ...f.profile, max_publications: 4 }),
    /original #706/u,
  );
  assert.throws(
    () => inspectInitialProofRisk706({ ...f.profile, expires_at: "2027-01-01T00:00:00Z" }),
    /original #706/u,
  );
  assert.throws(
    () =>
      inspectInitialProofRisk706({
        ...f.profile,
        amendment: { ...f.profile.amendment, comment_id: 6182222682 },
      }),
    /original #706/u,
  );
});
void test("existing ratified configuration schema selects no risk profile by default; explicit scope changes its bound digest", () => {
  const legacy = nativeAuthorityConfigurationFixture();
  const original = inspectReleaseAuthorityConfiguration(legacy);
  assert.equal(original.linux_risk_profile, undefined);
  assert.throws(
    () =>
      inspectReleaseAuthorityConfiguration({ ...legacy, linux_risk_profile: fixture().profile }),
    /schema2/u,
  );
  const selected = inspectReleaseAuthorityConfiguration({
    ...legacy,
    schema_version: 2,
    native_prepublication_profile: "signed-package-compatibility-v1",
    linux_risk_profile: fixture().profile,
  });
  assert.equal(selected.linux_risk_profile?.max_publications, 3);
  assert.notEqual(digest(selected), digest(original));
});
void test("three TOTAL exposures include deleted/withdrawn and partial feed failures; ambiguity and fourth refuse", () => {
  const entries = [1, 2, 3].map((release_id) => ({ tag: `v0.1.0-beta.${release_id}`, release_id }));
  assert.equal(
    assessInitialProofBudget706({
      durable: entries.slice(0, 2),
      current: [],
      pending: false,
      publication_tag: entries[2]!.tag,
    }).charged_tags.length,
    2,
  );
  assert.equal(
    assessInitialProofBudget706({
      durable: entries,
      current: [],
      pending: false,
      publication_tag: entries[2]!.tag,
    }).charged_tags.length,
    3,
  );
  assert.throws(
    () =>
      assessInitialProofBudget706({
        durable: entries,
        current: [],
        pending: false,
        publication_tag: "v0.1.0-beta.4",
      }),
    /fourth/u,
  );
  assert.throws(
    () =>
      assessInitialProofBudget706({
        durable: [],
        current: [],
        pending: true,
        publication_tag: entries[0]!.tag,
      }),
    /recovery/u,
  );
  assert.throws(
    () =>
      assessInitialProofBudget706({
        durable: entries,
        current: [{ ...entries[0]!, release_id: 99 }],
        pending: false,
        publication_tag: entries[2]!.tag,
      }),
    /ambiguous/u,
  );
  // A failed allocation with proven no public effect is absent from both
  // exposure inventories. Allocation alone cannot charge or erase publication.
  assert.deepEqual(
    assessInitialProofBudget706({
      durable: [],
      current: [],
      pending: false,
      publication_tag: "v0.1.0-beta.9",
    }).charged_tags,
    [],
  );
});
void test("real Release expectation normalization charges successful/partial public effect without requiring feed completion", () => {
  const assets = [{ filename: "Portcove.AppImage", bytes: 100, sha256: "a".repeat(64) }];
  const checkpoint = "b".repeat(40);
  const effect = {
    tag: "v0.1.0-beta.1",
    kind: "publish-draft",
    destination: "github-release:boburning/portcove:v0.1.0-beta.1:publish",
    asset_set_sha256: digest(assets),
    method: "PATCH",
    endpoint: "repos/boburning/portcove/releases/12",
    release_id: 12,
    body: { draft: false, make_latest: "false" },
  };
  const expectation = inspectReleaseEffectExpectation({
    before_checkpoint: checkpoint,
    effect_request_sha256: digest({ checkpoint, effect }),
    identity: { assets, source_commit: "c".repeat(40), version: "0.1.0-beta.1" },
    prior: { release_id: 12, assets: [{ id: 99, ...assets[0]! }] },
    effect,
  });
  const operation: Parameters<typeof durableExposure706>[0] = {
    before_checkpoint: checkpoint,
    destination: effect.destination,
    release_expectation: expectation,
    kind: "upload",
    policy_sha256: "d".repeat(64),
    ratification_sha256: "e".repeat(64),
    sequence: 1,
    id: "f".repeat(64),
    outcome: "succeeded",
    completed_effects: [
      {
        remote_identity: `github-release:boburning/portcove:release:12:immutable:${"a".repeat(64)}`,
        evidence_sha256: "b".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: null,
  };
  assert.deepEqual(durableExposure706(operation), { tag: "v0.1.0-beta.1", release_id: 12 });
  assert.deepEqual(
    durableExposure706({
      ...operation,
      outcome: "recovered",
      recovery: { resolution: "partial-effects-retained" },
    }),
    { tag: "v0.1.0-beta.1", release_id: 12 },
  );
  assert.equal(
    durableExposure706({
      ...operation,
      outcome: "recovered",
      completed_effects: [],
      recovery: { resolution: "effect-not-applied" },
    }),
    null,
  );
  assert.throws(() => durableExposure706({ ...operation, outcome: "ambiguous" }), /recovery/u);
  assert.throws(() => durableExposure706({ ...operation, completed_effects: [] }), /zero-effect/u);
});
void test("workspace version-only transforms preserve graph pin; external dependency/features cannot", () => {
  const graph = [
    { id: "portcove-core@0.1.0-beta.1:workspace", features: ["default"] },
    { id: "glib@0.18.5:registry+https://example.invalid", features: [] },
  ];
  assert.equal(
    risk706GraphDigest(graph),
    risk706GraphDigest([{ ...graph[0]!, id: "portcove-core@0.1.0-beta.2:workspace" }, graph[1]!]),
  );
  assert.notEqual(
    risk706GraphDigest(graph),
    risk706GraphDigest([
      graph[0]!,
      { ...graph[1]!, id: "glib@0.18.6:registry+https://example.invalid" },
    ]),
  );
  assert.notEqual(
    risk706GraphDigest(graph),
    risk706GraphDigest([{ ...graph[0]!, features: ["changed"] }, graph[1]!]),
  );
});

void test("actual caller pin association refuses candidate-measured policy and lock or graph substitution", () => {
  const f = fixture();
  const graph = [{ id: "glib@0.18.5:registry+https://example.invalid", features: [] }];
  f.profile.dependency_graph_sha256 = risk706GraphDigest(graph);
  const measurement = {
    candidate: {
      native: graph,
      sourceNativeInputsSha256: f.profile.native_inputs_sha256,
      lockSha256: "e".repeat(64),
    },
    scan: {
      lockSha256: "e".repeat(64),
      configSha256: f.profile.policy_sha256,
      sourceConfigSha256: f.profile.policy_sha256,
    },
    assessment: {
      dependencyGraphSha256: f.profile.dependency_graph_sha256,
      policySha256: f.profile.policy_sha256,
    },
  };
  assert.equal(
    inspectRisk706MeasurementPins(
      f.profile,
      measurement,
      f.profile.native_inputs_sha256,
      f.profile.policy_sha256,
    ).authority,
    "none",
  );
  assert.throws(
    () =>
      inspectRisk706MeasurementPins(
        f.profile,
        measurement,
        "f".repeat(64),
        f.profile.policy_sha256,
      ),
    /differs/u,
  );
  assert.throws(
    () =>
      inspectRisk706MeasurementPins(
        f.profile,
        measurement,
        f.profile.native_inputs_sha256,
        "f".repeat(64),
      ),
    /differs/u,
  );
  assert.throws(
    () =>
      inspectRisk706MeasurementPins(
        f.profile,
        { ...measurement, scan: { ...measurement.scan, lockSha256: "f".repeat(64) } },
        f.profile.native_inputs_sha256,
        f.profile.policy_sha256,
      ),
    /differs/u,
  );
  assert.throws(
    () =>
      inspectRisk706MeasurementPins(
        f.profile,
        {
          ...measurement,
          candidate: { ...measurement.candidate, native: [{ ...graph[0]!, features: ["new"] }] },
        },
        f.profile.native_inputs_sha256,
        f.profile.policy_sha256,
      ),
    /differs/u,
  );
});
void test("actual Git native input digest equals bounded provider tree traversal and refuses truncated/changed native source", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "risk706-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@portcove.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  for (const name of [
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "apps/desktop/src-tauri/src/main.rs",
    "crates/portcove-core/src/lib.rs",
  ]) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), "fixture\n");
  }
  git(["add", "."]);
  git(["commit", "-qm", "native baseline"]);
  const original = git(["rev-parse", "HEAD^{tree}"]).trim();
  const provider: GitHubRestReader = {
    request: (_method, endpoint) => {
      const sha = endpoint.slice(endpoint.lastIndexOf("/") + 1);
      const tree = git(["ls-tree", sha])
        .trimEnd()
        .split("\n")
        .map((line) => {
          const [mode, type, oid, filename] = line.split(/[\t ]/u);
          return { mode, type, sha: oid, path: filename };
        });
      return { status: 200, body: { sha, truncated: false, tree }, headers: new Map() };
    },
  };
  const expected = hash(git(["ls-tree", "HEAD", "--", ...nativePaths706]).trimEnd() + "\n");
  assert.equal(readRisk706NativeInputs(provider, original), expected);
  writeFileSync(path.join(root, "crates/portcove-core/src/lib.rs"), "genuine native change\n");
  git(["add", "."]);
  git(["commit", "-qm", "changed native"]);
  assert.notEqual(
    readRisk706NativeInputs(provider, git(["rev-parse", "HEAD^{tree}"]).trim()),
    expected,
  );
  assert.throws(
    () =>
      readRisk706NativeInputs(
        {
          request: () => ({
            status: 200,
            body: { sha: original, truncated: true, tree: [] },
            headers: new Map(),
          }),
        },
        original,
      ),
    /incomplete/u,
  );
});
void test("copied component/profile/context cannot authorize signing or publication", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("imported evidence cannot read provider"));
  await assert.rejects(
    authorizeActualLinuxRisk706({
      stage: "payload-signing",
      authority: "accepted-risk",
      linux_risk_profile: fixture().profile,
    }),
    /actual same-process/u,
  );
  await assert.rejects(
    requireVerifiedLinuxRiskAssessment706({ evidence_scope: "github.com" }),
    /actual same-process/u,
  );
  await assert.rejects(
    requireActualAdmissionCompilerReceipt706({ stage: "release-publication" }),
    /actual fixed admission/u,
  );
  await assert.rejects(
    authorizeActualSiteLinuxRisk706({}, {}, {} as never, "a".repeat(40), performance.now() + 1000),
    /actual keyless/u,
  );
  const signing = readFileSync(
    new URL("./release-payload-preparation.mts", import.meta.url),
    "utf8",
  );
  assert.ok(
    signing.indexOf("authorizeActualLinuxRisk706(context") <
      signing.indexOf('requestAssemblerToken(\n        "portcove-payload-signing"'),
  );
  const publication = readFileSync(
    new URL("./release-immutable-publication.mts", import.meta.url),
    "utf8",
  );
  assert.match(
    publication,
    /authorizeActualLinuxRisk706\(admissionContext, controls, state.checkpoint, deadline\)/u,
  );
});
