import { releaseEffectFixture } from "./fixtures/release-effect-fixture.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  capacityDigest as digest,
  inspectCapacityOperation,
  validateCapacityTransition,
} from "./release-capacity.mts";
import { assertCapacityExecutorEffectScope } from "./release-capacity-executor.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { pagesRecoveryOperationFixture } from "./fixtures/release-pages-recovery-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { readImmutableReleaseCustodyState } from "./release-immutable-publication.mts";
import {
  inspectPendingCandidateReleaseOperation,
  inspectPendingReleaseProducer,
  derivePendingReleaseAssets,
  planPendingReleaseAssets,
  observePendingCandidateRelease,
} from "./release-pending-release-recovery.mts";
import type { GitHubRestReader } from "./github-api.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const base = "repos/boburning/portcove";
const candidate = {
  phase: "publishing",
  version: "0.1.0-beta.1",
  source_commit: "b".repeat(40),
  prepared_commit: "c".repeat(40),
  prepared_tree: "d".repeat(40),
  transient_retries: 0,
  substantive_repairs: 0,
};
function operation(suffix: string, changes: Record<string, unknown> = {}) {
  const { site_expectation: discarded, ...original } = pagesRecoveryOperationFixture();
  assert.ok(discarded);
  const f = fixture();
  const release_expectation = releaseEffectFixture(
    original.before_checkpoint,
    {
      ...f.expected,
      assets: [
        ...f.expected.assets,
        { filename: "Portcove-SBOM.spdx.json", bytes: f.sbom.length, sha256: hash(f.sbom) },
      ],
    },
    suffix === "other" ? "publish" : suffix,
  );
  const value = {
    release_expectation,
    ...original,
    destination: `github-release:boburning/portcove:v${candidate.version}:${suffix}`,
    executor_identity: {
      ...original.executor_identity,
      workflow: productionControllerWorkflow,
      role: "release-publication",
    },
    ...changes,
  };
  const {
    id: previous,
    outcome,
    completed_effects,
    failure_evidence,
    recovery,
    ...identity
  } = value;
  assert.ok(previous);
  return {
    ...identity,
    id: digest(identity),
    outcome,
    completed_effects,
    failure_evidence,
    recovery,
  };
}
function fixture() {
  const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3","inert":true}');
  const known = [
    { filename: "Portcove.exe", bytes: 7, sha256: hash(Buffer.from("package")) },
    { filename: "Portcove.exe.sig", bytes: 9, sha256: hash(Buffer.from("signature")) },
    { filename: "SHA256SUMS.txt", bytes: 8, sha256: hash(Buffer.from("checksum")) },
  ];
  const expected = {
    version: candidate.version,
    source_commit: candidate.prepared_commit,
    assets: known,
    sbom_sha256: hash(sbom),
  };
  const release = {
    id: 321,
    tag_name: `v${candidate.version}`,
    target_commitish: candidate.prepared_commit,
    prerelease: true,
    draft: true,
    immutable: false,
    url: `https://api.github.com/${base}/releases/321`,
    html_url: `https://github.com/boburning/portcove/releases/tag/v${candidate.version}`,
    upload_url: `https://uploads.github.com/${base}/releases/321/assets{?name,label}`,
  };
  const assets = [
    ...known,
    { filename: "Portcove-SBOM.spdx.json", bytes: sbom.length, sha256: hash(sbom) },
  ].map((entry, index) => ({
    id: 500 + index,
    name: entry.filename,
    size: entry.bytes,
    digest: `sha256:${entry.sha256}`,
    state: "uploaded",
    url: `https://api.github.com/${base}/releases/assets/${500 + index}`,
    browser_download_url: `https://github.com/boburning/portcove/releases/download/v${candidate.version}/${entry.filename}`,
    download_count: 0,
  }));
  let present = true,
    tagCommit = candidate.prepared_commit;
  const requests: string[] = [];
  const api: GitHubRestReader = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      requests.push(endpoint);
      if (endpoint === `${base}/releases?per_page=100&page=1`)
        return { status: 200, body: present ? [release] : [], headers: new Map() };
      if (endpoint.startsWith(`${base}/git/ref/tags/`))
        return {
          status: 200,
          body: {
            ref: `refs/tags/v${candidate.version}`,
            object: { type: "commit", sha: tagCommit },
          },
          headers: new Map(),
        };
      if (endpoint === `${base}/releases/321/assets?per_page=100&page=1`)
        return { status: 200, body: assets, headers: new Map() };
      if (endpoint === `${base}/releases/321`)
        return { status: 200, body: release, headers: new Map() };
      assert.fail(`unexpected GET ${endpoint}`);
    },
  };
  return {
    expected,
    release,
    assets,
    api,
    sbom,
    requests,
    absent: () => {
      present = false;
    },
    wrongTag: () => {
      tagCommit = "f".repeat(40);
    },
  };
}
void test("pending Release readback requires exact current candidate tuple, fixed role and logical destination", () => {
  const raw = operation("upload:Portcove.exe");
  assert.equal(
    inspectPendingCandidateReleaseOperation(raw, candidate).destination,
    raw.destination,
  );
  for (const changed of [
    operation("upload:Portcove.exe", {
      candidate: { ...raw.candidate, prepared_commit: "f".repeat(40) },
    }),
    operation("upload:Portcove.exe", { candidate: { ...raw.candidate, transient_retries: 1 } }),
    operation("upload:Portcove.exe", {
      executor_identity: { ...raw.executor_identity, role: "payload-signing" },
    }),
    operation("other"),
    operation("upload:Portcove.exe", { outcome: "recovered" }),
  ])
    assert.throws(() => inspectPendingCandidateReleaseOperation(changed, candidate));
});
void test("original failed publisher can be read back only after its exact fixed job/run is terminal", () => {
  const op = inspectPendingCandidateReleaseOperation(operation("publish"), candidate),
    producer = op.executor_identity!;
  const run = {
    id: Number(producer.run_id),
    run_attempt: 1,
    head_sha: producer.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    actor: { id: Number(producer.actor_id) },
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: producer.job_id,
    run_id: Number(producer.run_id),
    run_attempt: 1,
    head_sha: producer.controller_revision,
    name: releaseControlPhaseProfile("release-publication").reader_name,
    status: "completed",
    conclusion: "failure",
    check_run_url: `https://api.github.com/${base}/check-runs/${String(producer.check_run_id)}`,
  };
  assert.equal(inspectPendingReleaseProducer(run, run, job, op).authority, "none");
  for (const changed of [
    { ...job, status: "in_progress" },
    { ...job, id: 999 },
    { ...job, name: "another job" },
  ])
    assert.throws(() => inspectPendingReleaseProducer(run, run, changed, op));
  assert.throws(() => inspectPendingReleaseProducer({ ...run, actor: { id: 999 } }, run, job, op));
});
void test("raw custody reader is closed and GET-only without inventing unknown document bytes", () => {
  const f = fixture();
  const result = readImmutableReleaseCustodyState(f.api, {
    version: candidate.version,
    source_commit: candidate.prepared_commit,
    asset_names: f.assets.map((entry) => entry.name),
  });
  assert.equal(result.assets.length, 4);
  for (const names of [
    [],
    ["../escape"],
    ["same", "SAME"],
    Array.from({ length: 33 }, (_, i) => `asset${i}`),
  ])
    assert.throws(() =>
      readImmutableReleaseCustodyState(f.api, {
        version: candidate.version,
        source_commit: candidate.prepared_commit,
        asset_names: names,
      }),
    );
});
void test("positive create/upload/publish readback yields data-only exact effect receipts and stable observational projection", async () => {
  const f = fixture();
  const read = () => f.sbom;
  for (const suffix of ["create-draft", "upload:Portcove.exe", "upload:Portcove-SBOM.spdx.json"]) {
    const op = inspectPendingCandidateReleaseOperation(operation(suffix), candidate);
    const before = await observePendingCandidateRelease(f.api, op, f.expected, read);
    assert.equal(before.authority, "none");
    f.assets[0]!.download_count++;
    const after = await observePendingCandidateRelease(f.api, op, f.expected, read);
    assert.equal(digest(before.projection), digest(after.projection));
  }
  f.release.draft = false;
  f.release.immutable = true;
  const op = inspectPendingCandidateReleaseOperation(operation("publish"), candidate);
  const result = await observePendingCandidateRelease(f.api, op, f.expected, read);
  assert.match(result.remote_identity, /:immutable:/);
  const retained = {
    ...op,
    completed_effects: [
      { remote_identity: result.remote_identity, evidence_sha256: result.evidence_sha256 },
    ],
  };
  assert.ok(inspectCapacityOperation(retained));
  f.assets[0]!.id += 100;
  f.assets[0]!.url = `https://api.github.com/${base}/releases/assets/${f.assets[0]!.id}`;
  await assert.rejects(
    observePendingCandidateRelease(f.api, retained, f.expected, read),
    /identity changed/,
  );
});
void test("absent SBOM length stays unknown for draft custody and cannot complete publication", async () => {
  const f = fixture();
  f.assets.pop();
  const unavailable = () => assert.fail("missing SBOM has no downloadable length or byte claim");
  const create = inspectPendingCandidateReleaseOperation(operation("create-draft"), candidate);
  const result = await observePendingCandidateRelease(f.api, create, f.expected, unavailable);
  assert.equal(result.projection.assets.length, 3);
  f.release.draft = false;
  f.release.immutable = true;
  const publish = inspectPendingCandidateReleaseOperation(operation("publish"), candidate);
  await assert.rejects(
    observePendingCandidateRelease(f.api, publish, f.expected, unavailable),
    /missing mandatory|prior asset identity changed/,
  );
});
void test("genuine six-package assembly excludes compiler-only provenance and matches maintained final publisher bytes", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const { accepted, policy } = await inspectTrustedAssemblyInput(f.request);
  assert.equal(accepted.files.length, 10);
  assert.equal(policy.packages.length, 6);
  const signatures = policy.packages
    .filter((p) => p.interface === "desktop" && ["nsis", "appimage"].includes(p.format))
    .map((p) => ({
      filename: `${artifactName(p, accepted.version)}.sig`,
      bytes: Buffer.from(`original signature ${p.id}\n`),
    }));
  assert.equal(signatures.length, 2);
  const sbom = Buffer.from("public SPDX fixture\n");
  const planned = planPendingReleaseAssets(accepted, policy, signatures, hash(sbom));
  assert.equal(planned.assets.length, 9);
  assert.ok(planned.assets.every((a) => !/^release-producer-|^SHA256SUMS-/u.test(a.filename)));
  const packages = policy.packages.map((p) => {
    const filename = artifactName(p, accepted.version);
    const item = accepted.files.find((a) => a.filename === filename)!;
    return { filename, bytes: item.bytes, sha256: item.sha256 };
  });
  // Execute the exact maintained publisher byte-finalization block, with inert
  // input/output adapters. No private session or publication authority is minted.
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(
    new URL("./release-immutable-publication.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    const files = [...packages];");
  const end = source.indexOf('    phase = "reservation-after";', start);
  assert.ok(start > 0 && end > start);
  const output = new Map<string, Buffer>();
  const finalize = runInNewContext(
    stripTypeScriptTypes(`(async()=>{${source.slice(start, end)}return files;})`),
    {
      packages,
      signatures,
      Buffer,
      path: await import("node:path"),
      assetsRoot: "/inert/assets",
      request: { sbom: "/inert/sbom" },
      policy,
      releaseSbomName: "Portcove-SBOM.spdx.json",
      sha: hash,
      parseReleaseChecksumManifest: () => {},
      boundedBytes: async () => sbom,
      writeFile: async (name: string, bytes: Buffer) => {
        output.set(name, Buffer.from(bytes));
      },
    },
  ) as () => Promise<{ filename: string; bytes: number; sha256: string }[]>;
  const actual = await finalize();
  assert.equal(
    digest(
      actual
        .filter((a) => a.filename !== "Portcove-SBOM.spdx.json")
        .sort((a, b) => a.filename.localeCompare(b.filename)),
    ),
    digest([...planned.assets].sort((a, b) => a.filename.localeCompare(b.filename))),
  );
  assert.equal(actual.length, 10);
  const checksum = [...output.entries()].find(([name]) => name.endsWith("SHA256SUMS.txt"))![1];
  assert.equal(hash(checksum), planned.assets.find((a) => a.filename === "SHA256SUMS.txt")!.sha256);
});

void test("journal pins exact original provider object/preimage, and legacy missing expectations remain held", async () => {
  const f = fixture();
  const op = inspectPendingCandidateReleaseOperation(operation("upload:Portcove.exe"), candidate);
  assert.equal(op.completed_effects.length, 0);
  // A recreated Release with identical bytes is a different provider object.
  f.release.id = 322;
  f.release.url = `https://api.github.com/${base}/releases/322`;
  f.release.upload_url = `https://uploads.github.com/${base}/releases/322/assets{?name,label}`;
  const remapped: GitHubRestReader = {
    request(method, endpoint) {
      return f.api.request(method, endpoint.replace("/releases/322", "/releases/321"));
    },
  };
  await assert.rejects(
    observePendingCandidateRelease(remapped, op, f.expected, () => f.sbom),
    /provider ID changed/,
  );
  const legacy = operation("upload:Portcove.exe");
  const { release_expectation: _ignored, id: _id, ...rest } = legacy;
  const { outcome, completed_effects, failure_evidence, recovery, ...identity } = rest;
  const old = {
    ...identity,
    id: digest(identity),
    outcome,
    completed_effects,
    failure_evidence,
    recovery,
  };
  assert.ok(inspectCapacityOperation(old));
  assert.throws(() => inspectPendingCandidateReleaseOperation(old, candidate));
  const capacity = capacityFixture();
  const input = {
    schema_version: 2,
    active_candidate: candidate,
    controller: { capacity_attempt: { ...capacity, operation: old, prior_operations: [] } },
  };
  assert.doesNotThrow(() =>
    validateCapacityTransition(input, structuredClone(input), "a".repeat(40)),
  );
  const before = {
    ...input,
    controller: { capacity_attempt: { ...capacity, operation: null, prior_operations: [] } },
  };
  assert.throws(
    () => validateCapacityTransition(before, input, "a".repeat(40)),
    /exact provider preimage/,
  );
  const request = {
    kind: "upload" as const,
    destination: op.destination,
    release_expectation: op.release_expectation,
  };
  assert.doesNotThrow(() => assertCapacityExecutorEffectScope("release-publication", request));
  assert.throws(() => assertCapacityExecutorEffectScope("coordinator", request));
  assert.throws(() =>
    assertCapacityExecutorEffectScope("release-publication", {
      kind: "upload",
      destination: op.destination,
    }),
  );
  assert.throws(() =>
    assertCapacityExecutorEffectScope("release-publication", {
      ...request,
      destination: op.destination.replace("Portcove.exe", "different.exe"),
    }),
  );
  for (const change of [
    { ...op.release_expectation, before_checkpoint: "f".repeat(40) },
    { ...op.release_expectation, effect_request_sha256: "f".repeat(64) },
    { ...op.release_expectation, prior: { ...op.release_expectation!.prior, release_id: 322 } },
  ])
    assert.throws(() => inspectCapacityOperation({ ...op, release_expectation: change }));
});
void test("missing, partial, wrong bytes and changed tag never become no-effect or a repeated POST", async () => {
  const cases = [
    "absent",
    "missing-target",
    "partial-publish",
    "wrong-digest",
    "wrong-sbom-bytes",
    "wrong-tag",
  ];
  for (const selected of cases) {
    const f = fixture(),
      suffix = selected === "partial-publish" ? "publish" : "upload:Portcove.exe";
    if (selected === "absent") f.absent();
    if (selected === "wrong-tag") f.wrongTag();
    if (selected === "missing-target") f.assets.splice(0, 1);
    if (selected === "partial-publish") {
      f.release.draft = true;
      f.release.immutable = false;
    }
    if (selected === "wrong-digest") f.assets[0]!.digest = `sha256:${"f".repeat(64)}`;
    const read = () => (selected === "wrong-sbom-bytes" ? Buffer.from("tampered") : f.sbom);
    const op = inspectPendingCandidateReleaseOperation(operation(suffix), candidate);
    await assert.rejects(observePendingCandidateRelease(f.api, op, f.expected, read));
    assert.ok(f.requests.length > 0); // The fake API itself rejects every non-GET.
  }
});
void test("copied context/Tough claims cannot derive pending Release expectations", async () => {
  await assert.rejects(
    derivePendingReleaseAssets({}, {}, {}, candidate, Number.MAX_SAFE_INTEGER),
    /actual keyless TUF/,
  );
});

void test("source-bound coordinator pending continuation verifies custody then resolves only exact positive readback", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(
    new URL("./release-candidate-signing-recovery.mts", import.meta.url),
    "utf8",
  );
  const start = source.lastIndexOf("      if (pendingRelease) {"),
    end = source.indexOf(
      "      await guard();\n      await refreshCapacityExecutor(executor);",
      start,
    );
  assert.ok(start > source.indexOf("await requireActualTufPublication(publication, deadline);"));
  assert.ok(end > start);
  let mode = "positive",
    observations = 0,
    settlements = 0;
  const calls: string[] = [];
  const pending = inspectPendingCandidateReleaseOperation(operation("publish"), candidate);
  const context = {
    pendingRelease: pending,
    context: {},
    publication: {},
    toolsReceipt: {},
    active: candidate,
    deadline: 170000,
    api: {},
    input: { repository: "bare", remote_configuration: {} },
    directory: "private",
    environment: {},
    base,
    executor: {},
    assert,
    digest,
    String,
    derivePendingReleaseAssets: async () => {
      calls.push("actual-context-Tough");
      return {};
    },
    guard: async () => {
      calls.push("fresh-controls-current-CP");
    },
    get: () => ({ terminal: true }),
    inspectPendingReleaseProducer: () => ({ original: true }),
    requireRetainedActualTufPublication: async () => {
      calls.push("retained-Tough");
    },
    observePendingCandidateRelease: async () => {
      observations++;
      calls.push("GET-only-observation");
      if (mode === "missing") throw new Error("missing original target");
      return {
        projection: { stable: mode === "drift" ? observations : 1 },
        remote_identity: "original",
        evidence_sha256: "a".repeat(64),
      };
    },
    recoverOwnedCapacityEffect: async (
      _executor: unknown,
      input: { checkpoint: string },
      readback: (raw: unknown) => Promise<unknown>,
    ) => {
      calls.push("actual-coordinator-exclusive-recovery");
      assert.equal(input.checkpoint, "before");
      const result = await readback(
        mode === "wrong-intent" ? { ...pending, id: "f".repeat(64) } : pending,
      );
      assert.ok(result && typeof result === "object" && "resolution" in result);
      assert.equal(result.resolution, "effect-completed");
      settlements++;
      return { checkpoint: "after" };
    },
  };
  const run = runInNewContext(
    stripTypeScriptTypes(
      "(async()=>{let checkpoint='before',phase='';\n" +
        source.slice(start, end) +
        "\nreturn checkpoint;})",
    ),
    context,
  ) as () => Promise<string>;
  assert.equal(await run(), "after");
  assert.equal(settlements, 1);
  assert.equal(calls[0], "actual-context-Tough");
  assert.ok(calls.includes("retained-Tough"));
  for (mode of ["missing", "drift", "wrong-intent"]) {
    observations = 0;
    settlements = 0;
    calls.length = 0;
    await assert.rejects(run());
    assert.equal(settlements, 0);
    if (mode === "missing") assert.ok(!calls.includes("actual-coordinator-exclusive-recovery"));
  }
});
