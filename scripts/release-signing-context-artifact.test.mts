import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import {
  inspectSigningContextArchive,
  prepareSigningContextArtifact,
  prepareSigningContextPredicate,
  receiveSigningContextArtifact,
  requireReceivedSigningContext,
  requireRetainedSigningContext,
  signingContextPredicateType,
  handoffSigningContextArtifact,
} from "./release-signing-context-artifact.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
void test("retained context rechecks its original deadline after asynchronous full-tree read", async () => {
  // Execute the actual private function in an inert closure. This does not mint
  // a module-owned receipt or bypass the production receiver's private brand.
  const source = await readFile(
    new URL("./release-signing-context-artifact.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function readReceivedSigningContext("),
    end = source.indexOf("\nexport function requireReceivedSigningContext", start);
  assert.ok(start > 0 && end > start);
  for (const provider of ["retained", "fresh"] as const) {
    let clock = 0;
    const receipt = {},
      received = new WeakMap([
        [
          receipt,
          {
            public_evidence: [],
            context: "fixture",
            directory: "fixture",
            files: [],
            manifest: {},
            active() {
              if (clock >= 10) throw new Error("fixture deadline exhausted");
            },
            refresh() {},
          },
        ],
      ]);
    const run = vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nreadReceivedSigningContext`,
      {
        received,
        digest,
        identities: (value: unknown) => value,
        readBoundedReleaseContextFiles: async () => {
          clock = 11;
          return [];
        },
        structuredClone,
        Object,
      },
    ) as (receipt: object, deadline: undefined, provider: string) => Promise<unknown>;
    await assert.rejects(run(receipt, undefined, provider), /deadline exhausted/);
  }
});
void test("context upload handoff cannot start from imported custody or renew an expired phase", async () => {
  const pending = { checkpoint: "a".repeat(40), operation_id: "b".repeat(64) };
  await assert.rejects(
    handoffSigningContextArtifact({}, {}, pending, performance.now() + 1000),
    /actual private/,
  );
  await assert.rejects(
    handoffSigningContextArtifact({}, {}, pending, performance.now() - 1),
    /deadline/,
  );
});
function fixture() {
  const files = new Map(
    [
      ["context.json", Buffer.from("{}")],
      ["trusted-root.json", Buffer.from("public root")],
      ["offline-targets.json", Buffer.from("offline public targets")],
      ["payload.json", Buffer.from("public keys")],
      ["prior/repository-manifest.json", Buffer.from("{}")],
      ["records/reconstruction-manifest.json", Buffer.from("{}")],
      ["records/releases/1.0.0/windows-x86_64/nsis.json", Buffer.from("record fixture")],
    ].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)) as [string, Buffer][],
  );
  const identities = [...files].map(([name, bytes]) => ({
    path: name,
    bytes: bytes.length,
    sha256: hash(bytes),
  }));
  const controller = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "123",
    run_attempt: 1,
  };
  const binding = {
    aggregate_sha256: "c".repeat(64),
    native_checks: [{ id: 11 }, { id: 22 }],
    pending_obligations: ["post-sign-native-compatible-update-rollback-journal"],
    records_sha256: digest(
      identities
        .filter((entry) => entry.path.startsWith("records/releases/"))
        .map((entry) => ({ ...entry, path: entry.path.slice(8) })),
    ),
    run_attempt: 1,
    run_id: "456",
    sbom_sha256: "d".repeat(64),
    signatures_sha256: "e".repeat(64),
    source_commit: "f".repeat(40),
    source_tree: "1".repeat(40),
    version: "1.0.0",
  };
  const facts = { checkpoint: "2".repeat(40), fixture: true };
  const manifest = {
    schema_version: 1,
    kind: "release-signing-context",
    controller,
    control_facts: { fixture: true },
    previous_site_pins: {
      root_sha256: "3".repeat(64),
      repository_sha256: "4".repeat(64),
      site_generation_sha256: "5".repeat(64),
    },
    binding,
    facts,
    facts_sha256: digest(facts),
    files: identities,
    authority: "none",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    packed = Buffer.concat([...files.values()]);
  const archiveFor = (bytes = manifestBytes, content = packed) =>
    createAuditZip([
      ["signing-context-manifest.json", bytes],
      ["signing-context-bytes.bin", content],
    ]);
  const archive = archiveFor(),
    bundle = createAuditZip([
      ["signing-context-attestation.json", Buffer.from("fixture public bundle")],
    ]);
  const expected = {
    ...controller,
    artifact: { id: 101, sha256: hash(archive) },
    bundle: { id: 202, sha256: hash(bundle) },
    manifest_sha256: hash(manifestBytes),
    binding_sha256: digest(binding),
    facts_sha256: digest(facts),
  };
  const artifactIdentity = { id: 101, bytes: archive.length, sha256: hash(archive) };
  const producer = { run_id: "123", run_attempt: 1, job_id: 501, check_run_id: "777" };
  const predicate = {
    schema_version: 1,
    role: "release-signing-context",
    controller,
    producer,
    artifact: artifactIdentity,
    manifest_sha256: hash(manifestBytes),
    binding,
    facts_sha256: digest(facts),
    stage: "payload-signing",
    publication_admission: "not-established",
    authority: "none",
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: signingContextPredicateType,
    subject: [
      { name: "release-signing-context-manifest", digest: { sha256: hash(manifestBytes) } },
    ],
    predicate,
  };
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: `https://github.com/boburning/portcove/${productionControllerWorkflow}@${controller.controller_ref}`,
    buildSignerDigest: controller.controller_revision,
    sourceRepositoryDigest: controller.controller_revision,
    sourceRepositoryRef: controller.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: "https://github.com/boburning/portcove/actions/runs/123/attempts/1",
  };
  let requests = 0,
    downloads = 0;
  const faults = { value: "" };
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null as string | null,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const options = {
    api: {
      request(method: string, endpoint: string) {
        requests++;
        assert.equal(method, "GET");
        assert.ok(endpoint.startsWith("repos/boburning/portcove/"));
        if (endpoint.includes("git/commits/"))
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: { sha: controller.controller_revision, tree: { sha: controller.source_tree } },
          };
        if (endpoint.includes("actions/jobs/"))
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: {
              id: 501,
              run_id: 123,
              run_attempt: 1,
              head_sha: controller.controller_revision,
              name: "Sign admitted updater payloads",
              status: "completed",
              conclusion: faults.value === "job-failure" ? "failure" : "success",
              check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${faults.value === "job" ? "778" : "777"}`,
            },
          };
        if (endpoint.includes("actions/artifacts/")) {
          const isBundle = endpoint.endsWith("/202"),
            bytes = isBundle ? bundle : archive;
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: {
              id: isBundle ? 202 : 101,
              name: `trusted-payload-signing-context${isBundle ? "-attestation" : ""}-123-1`,
              expired: false,
              digest: `sha256:${faults.value === "drift" && requests > 7 ? "0".repeat(64) : hash(bytes)}`,
              size_in_bytes: bytes.length,
              workflow_run: {
                id: 123,
                repository_id: 1354613114,
                head_repository_id: 1354613114,
                head_sha: controller.controller_revision,
              },
            },
          };
        }
        return { status: 200, headers: new Map<string, string>(), body: run };
      },
    },
    download: (endpoint: string) => {
      downloads++;
      return endpoint.includes("/202/") ? Buffer.from(bundle) : Buffer.from(archive);
    },
    spawn: (_command: string, args: readonly string[]) => {
      assert.ok(
        args.includes("--deny-self-hosted-runners") &&
          args.includes("--source-digest") &&
          args.includes(controller.controller_revision),
      );
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            verificationResult: {
              signature: {
                certificate:
                  faults.value === "certificate"
                    ? { ...certificate, sourceRepositoryIdentifier: "1" }
                    : certificate,
              },
              verifiedTimestamps: [{}],
              statement,
            },
          },
        ]),
        stderr: "",
      };
    },
  };
  return {
    files,
    manifest,
    manifestBytes,
    packed,
    archive,
    archiveFor,
    expected,
    options,
    faults,
    run,
    counts: () => ({ requests, downloads }),
  };
}
void test("bounded context ZIP has exactly two fixed members and complete packed public-file identity", () => {
  const f = fixture();
  const inspected = inspectSigningContextArchive(f.archive);
  assert.equal(inspected.authority, "none");
  assert.deepEqual([...inspected.files], [...f.files]);
  for (const archive of [
    f.archiveFor(f.manifestBytes, Buffer.concat([f.packed, Buffer.from("extra")])),
    f.archiveFor(Buffer.from(JSON.stringify({ ...f.manifest, files: f.manifest.files.slice(1) }))),
    f.archiveFor(Buffer.from(JSON.stringify({ ...f.manifest, facts_sha256: "0".repeat(64) }))),
    createAuditZip([["context.json", Buffer.from("{}")]]),
  ])
    assert.throws(() => inspectSigningContextArchive(archive));
});
void test("successful exact payload context survives a later sibling workflow failure but not a failed producer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-completed-component-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  f.run.status = "completed";
  f.run.conclusion = "failure";
  const result = await receiveSigningContextArtifact(
    root,
    f.expected,
    performance.now() + 5000,
    f.options,
  );
  assert.equal(result.evidence_scope, "injected-provider");
  await assert.rejects(requireReceivedSigningContext(result), /actual authenticated/);
  for (const fault of ["job-failure", "job"]) {
    const failed = fixture();
    failed.run.status = "completed";
    failed.run.conclusion = "failure";
    failed.faults.value = fault;
    await assert.rejects(
      receiveSigningContextArtifact(
        root,
        failed.expected,
        performance.now() + 5000,
        failed.options,
      ),
      /retain/,
    );
  }
  const impossible = fixture();
  impossible.run.conclusion = "failure";
  await assert.rejects(
    receiveSigningContextArtifact(
      root,
      impossible.expected,
      performance.now() + 5000,
      impossible.options,
    ),
    /retain/,
  );
});
void test("injected complete provider/attestation path proves data association but cannot mint actual context brand", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const result = await receiveSigningContextArtifact(
    root,
    f.expected,
    performance.now() + 5000,
    f.options,
  );
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.publication_admission, "not-established");
  assert.deepEqual(f.counts(), { requests: 12, downloads: 2 });
  await assert.rejects(requireReceivedSigningContext(result), /actual authenticated/);
  await assert.rejects(
    requireRetainedSigningContext(result, performance.now() + 1000),
    /actual authenticated/,
  );
  assert.deepEqual(f.counts(), { requests: 12, downloads: 2 });
  for (const fault of ["job", "certificate", "drift"]) {
    const changed = fixture();
    changed.faults.value = fault;
    await assert.rejects(
      receiveSigningContextArtifact(
        root,
        changed.expected,
        performance.now() + 5000,
        changed.options,
      ),
      /retain/,
    );
  }
});
void test("the fixed default transport shares one finite context read budget across the complete callable graph", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-default-transport-")),
    f = fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Simulated provider at the OS transport boundary only. The maintained
  // default receiver still performs all archive/certificate/producer joins;
  // production has no imported-proof or test-only constructor.
  const mocked = t.mock.method(
    childProcess,
    "spawnSync",
    (command: unknown, args: readonly string[]) => {
      assert.equal(command, "gh");
      let stdout: string | Buffer;
      if (args[0] === "attestation") stdout = f.options.spawn("gh", args).stdout;
      else {
        const endpoint = args.find((value) => value.startsWith("repos/boburning/portcove/"));
        assert.ok(endpoint);
        if (endpoint.endsWith("/zip")) stdout = f.options.download(endpoint);
        else {
          const response = f.options.api.request("GET", endpoint);
          stdout = `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(response.body)}`;
        }
      }
      return {
        pid: 1,
        output: [],
        status: 0,
        signal: null,
        stdout,
        stderr: typeof stdout === "string" ? "" : Buffer.alloc(0),
      };
    },
  );
  syncBuiltinESMExports();
  try {
    const receipt = await receiveSigningContextArtifact(
      root,
      f.expected,
      performance.now() + 15000,
    );
    assert.equal(receipt.evidence_scope, "github.com");
    for (let round = 0; round < 62; round++) await requireReceivedSigningContext(receipt);
    assert.deepEqual(f.counts(), { requests: 384, downloads: 2 });
    await assert.rejects(requireReceivedSigningContext(receipt), /readback budget exceeded/);
    assert.deepEqual(f.counts(), { requests: 384, downloads: 2 });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
void test("missing private producer receipt and exhausted receiver budget refuse before effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-context-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareSigningContextArtifact({}, root), /same-process/);
  await assert.rejects(
    prepareSigningContextPredicate(
      {},
      { artifact_id: 1, sha256: "0".repeat(64) },
      {},
      performance.now() + 1000,
    ),
    /private/,
  );
  const f = fixture();
  await assert.rejects(
    receiveSigningContextArtifact(root, f.expected, performance.now() - 1, f.options),
    /deadline/,
  );
  assert.deepEqual(f.counts(), { requests: 0, downloads: 0 });
  assert.deepEqual(await readdir(root), []);
});

void test("existing pinned attestation verifier respects the remaining role budget before and after execution", (t) => {
  const f = fixture();
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  const spawn: NonNullable<
    NonNullable<Parameters<typeof verifyControllerArtifactStatement>[5]>["spawn"]
  > = (command, args, settings) => {
    calls++;
    assert.equal(settings.timeout, 1000);
    const result = f.options.spawn(command, args);
    clock += 1001;
    return result;
  };
  assert.throws(
    () =>
      verifyControllerArtifactStatement(
        os.tmpdir(),
        "manifest.json",
        "attestation.json",
        f.expected,
        signingContextPredicateType,
        { spawn, deadline: 999 },
      ),
    /deadline/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      verifyControllerArtifactStatement(
        os.tmpdir(),
        "manifest.json",
        "attestation.json",
        f.expected,
        signingContextPredicateType,
        { spawn, deadline: 2000 },
      ),
    /deadline/,
  );
  assert.equal(calls, 1);
});
