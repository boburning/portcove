import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  inspectAggregateUploadExpectation,
  assertAggregateUploadCandidate,
} from "./release-aggregate-contract.mts";
import { inspectCapacityOperation, capacityDigest } from "./release-capacity.mts";
import { assertCapacityExecutorEffectScope } from "./release-capacity-executor.mts";
import {
  handoffAdmittedAggregateUpload,
  readAdmittedAggregateUpload,
} from "./release-aggregate-upload.mts";
import {
  nextControllerTransport,
  acknowledgeControllerTransport,
} from "./release-controller-transport.mts";
import {
  inspectAdmittedAggregateResume,
  runFixedAdmittedAggregateConfiguration,
} from "./release-admitted-aggregate-controller.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { assemblerIdentityFixture, expected } from "./fixtures/assembler-identity-fixture.mts";
import {
  controllerOidcSubject,
  verifyAdmittedAssemblerJobIdentity,
  verifyAssemblerJobIdentity,
} from "./assembler-job-identity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import {
  withReadOnlyReleaseChildren,
  readOnlyReleaseChildEnvironment,
} from "./release-readonly-child-environment.mts";
import { createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const producer = {
  role: "aggregate-assembly",
  run_id: "9988",
  run_attempt: 2,
  job_id: 501,
  check_run_id: "777",
  actor_id: "1122",
  controller_revision: "a".repeat(40),
  execution_ref: "refs/tags/portcove-production-controller-fixture",
  workflow: productionControllerWorkflow,
};
const expectation = {
  assembly_sha256: "a".repeat(64),
  files: [{ filename: "package.zip", bytes: 23, sha256: "b".repeat(64) }],
};

void test("actual GH transport entrypoints inherit only captured read token and private config in the admitted scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-readonly-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = [
    "GH_TOKEN",
    "PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "PORTCOVE_TUF_RELEASES_KEY",
    "NODE_OPTIONS",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `inert-${key}`;
  t.after(() => {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  assert.equal(readOnlyReleaseChildEnvironment(), undefined);
  await withReadOnlyReleaseChildren(root, async () => {
    const child = readOnlyReleaseChildEnvironment()!;
    assert.equal(child.GH_TOKEN, "inert-GH_TOKEN");
    for (const key of keys.filter((key) => key !== "GH_TOKEN")) assert.equal(child[key], undefined);
    assert.ok(child.GH_CONFIG_DIR?.startsWith(root));
    assert.equal(child.HOME, child.GH_CONFIG_DIR);
    child.GH_TOKEN = "local-copy-mutation";
    assert.equal(readOnlyReleaseChildEnvironment()!.GH_TOKEN, "inert-GH_TOKEN");
    createGitHubRunner({
      spawn(_command, _args, options) {
        assert.equal(options.env?.GH_TOKEN, "inert-GH_TOKEN");
        assert.equal(options.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
        return { status: 0, stdout: "HTTP/2 200\r\n\r\n{}", stderr: "" };
      },
    })(["api", "repos/boburning/portcove"]);
    readGitHubArtifactArchive("repos/boburning/portcove/actions/artifacts/1/zip", {
      cwd: root,
      maxBytes: 22,
      timeoutMs: 1000,
      spawn(_command, _args, options) {
        assert.equal(options.env?.GH_TOKEN, "inert-GH_TOKEN");
        assert.equal(options.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        return { status: 0, stdout: Buffer.alloc(22) };
      },
    });
  });
  assert.equal(readOnlyReleaseChildEnvironment(), undefined);
  assert.equal(
    process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN,
    "inert-PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
  );
});

void test("actual aggregate pending handoff uses admission-only pump and exact provider locator ACK", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-admitted-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  process.env.GITHUB_RUN_ID = producer.run_id;
  process.env.GITHUB_RUN_ATTEMPT = String(producer.run_attempt);
  t.after(() => {
    for (const [key, value] of [
      ["GITHUB_RUN_ID", saved.run],
      ["GITHUB_RUN_ATTEMPT", saved.attempt],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const directory = path.join(root, "assembled");
  await mkdir(path.join(directory, "assets"), { recursive: true });
  const bytes = Buffer.from("frozen opaque package");
  await writeFile(path.join(directory, "assets", "package.zip"), bytes);
  const expected = {
    assembly_sha256: expectation.assembly_sha256,
    files: [{ filename: "package.zip", bytes: bytes.length, sha256: sha(bytes) }],
  };
  const deadline = performance.now() + 10000;
  const handoff = handoffAdmittedAggregateUpload(
    root,
    directory,
    producer,
    { checkpoint: "1".repeat(40), operation_id: "2".repeat(64) },
    expected,
    deadline,
  );
  const event = await nextControllerTransport(root, "admission", 1, deadline);
  assert.equal(event.kind, "aggregate");
  if (event.kind !== "aggregate") assert.fail("fixed aggregate route required");
  assert.equal(event.files[0]!.path, path.join(directory, "assets", "package.zip"));
  await acknowledgeControllerTransport(root, "admission", 1, {
    artifact_id: 998,
    sha256: "3".repeat(64),
  });
  assert.deepEqual(await handoff, { artifact_id: 998, sha256: "3".repeat(64) });
  await assert.rejects(
    acknowledgeControllerTransport(root, "admission", 1, {
      artifact_id: 999,
      sha256: "4".repeat(64),
    }),
  );
});

void test("aggregate upload preimage is hash-bound in existing pending identity and fixed executor scope", () => {
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate: {
      source_commit: "b".repeat(40),
      prepared_commit: "c".repeat(40),
      version: "0.1.0-beta.1",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "github-actions:boburning/portcove:admitted-aggregate",
    kind: "upload",
    sequence: 1,
    executor_nonce: "d".repeat(64),
    executor_identity: producer,
    receipt_limit: 1,
    aggregate_expectation: expectation,
    policy_sha256: "e".repeat(64),
    ratification_sha256: "f".repeat(64),
  };
  const operation = {
    ...identity,
    id: capacityDigest(identity),
    outcome: "pending",
    completed_effects: [],
    failure_evidence: null,
    recovery: null,
  };
  assert.deepEqual(inspectCapacityOperation(operation)?.aggregate_expectation, expectation);
  const request = {
    kind: "upload" as const,
    destination: identity.destination,
    aggregate_expectation: expectation,
  };
  assert.doesNotThrow(() => assertCapacityExecutorEffectScope("aggregate-assembly", request));
  for (const role of ["coordinator", "payload-signing", "site-publication"] as const)
    assert.throws(() => assertCapacityExecutorEffectScope(role, request));
  assert.throws(
    () =>
      inspectCapacityOperation({
        ...operation,
        aggregate_expectation: { ...expectation, assembly_sha256: "1".repeat(64) },
      }),
    /identity differs/u,
  );
  const { aggregate_expectation: _removed, ...without } = operation;
  assert.throws(() => inspectCapacityOperation(without), /identity differs/u);
  for (const files of [
    [],
    [...expectation.files, ...expectation.files],
    [{ ...expectation.files[0], filename: "../escape" }],
    [{ ...expectation.files[0], bytes: 512 * 1024 ** 2 + 1 }],
  ])
    assert.throws(() => inspectAggregateUploadExpectation({ ...expectation, files }));
});

void test("admitted assembler signed environment profile cannot substitute for legacy plain-ref assembly", async () => {
  const subject = controllerOidcSubject(expected.controller_ref, "production-release-admission");
  const f = assemblerIdentityFixture(
    { sub: subject, environment: "production-release-admission" },
    {},
    { workflow: productionControllerWorkflow, job: "Authenticate release control inputs" },
  );
  const selected = { ...expected, subject };
  const actual = await verifyAdmittedAssemblerJobIdentity(f.token, selected, {
    readKeys: f.readKeys,
    transport: f.transport,
  });
  assert.equal(actual.evidence_scope, "injected-provider");
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, selected, { readKeys: f.readKeys, transport: f.transport }),
  );
  const old = assemblerIdentityFixture();
  await assert.rejects(
    verifyAdmittedAssemblerJobIdentity(old.token, expected, {
      readKeys: old.readKeys,
      transport: old.transport,
    }),
  );
});

void test("actual bounded archive member readback brackets complete inventory and refuses drift/missing/duplicate", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const aggregate = await assembleTrustedRelease(f.root, f.input, f.request);
  const entries = await Promise.all(
    aggregate.output_files.map(
      async (file) =>
        [file.filename, await readFile(path.join(aggregate.assets, file.filename))] as const,
    ),
  );
  const archive = createAuditZip(entries);
  const wanted = {
    assembly_sha256: capacityDigest(f.request),
    files: aggregate.output_files.slice().sort((a, b) => (a.filename < b.filename ? -1 : 1)),
  };
  const metadata = {
    id: 99,
    name: "trusted-release-final-9988-2",
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${sha(archive)}`,
    workflow_run: {
      id: 9988,
      head_sha: producer.controller_revision,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
    },
  };
  const exercise = (fault: string) => {
    let reads = 0;
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        assert.equal(
          endpoint,
          "repos/boburning/portcove/actions/runs/9988/artifacts?per_page=100&page=1",
        );
        reads++;
        const value =
          fault === "drift" && reads > 1
            ? { ...metadata, digest: `sha256:${"0".repeat(64)}` }
            : fault === "source"
              ? {
                  ...metadata,
                  workflow_run: { ...metadata.workflow_run, head_sha: "0".repeat(40) },
                }
              : metadata;
        const artifacts =
          fault === "missing"
            ? []
            : fault === "duplicate"
              ? [value, { ...value, id: 100 }]
              : [value];
        return {
          status: 200,
          body: { total_count: artifacts.length, artifacts },
          headers: new Map<string, string>(),
        };
      },
    };
    return readAdmittedAggregateUpload(
      api,
      producer,
      wanted,
      f.request,
      f.root,
      performance.now() + 10000,
      undefined,
      () => (fault === "bytes" ? Buffer.alloc(archive.length) : archive),
    );
  };
  const result = await exercise("");
  assert.deepEqual(result.artifact, { id: 99, sha256: sha(archive) });
  for (const fault of ["missing", "duplicate", "source", "bytes", "drift"])
    await assert.rejects(exercise(fault));
});

void test("building resume needs exact retained stage and never reinterprets imported eligibility", async () => {
  const candidate = {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    prepared_commit: "3".repeat(40),
    prepared_tree: "4".repeat(40),
    intent_sha256: "5".repeat(64),
    version: "0.19.0-preview.1",
    phase: "building",
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: { run_id: 123, attempt: 1, revision: "3".repeat(40) },
  };
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: "6".repeat(40),
    locators: [{ kind: "native-check", id: "12345", sha256: "7".repeat(64) }],
  };
  const retained = {
    ...candidate,
    stage_evidence: [
      {
        phase: "building",
        attempts: [
          {
            previous_checkpoint: "a".repeat(40),
            evidence_sha256: capacityDigest(proof),
            proof,
            release_run: candidate.release_run,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      },
    ],
  };
  assert.equal(inspectAdmittedAggregateResume(retained), "resume");
  assert.equal(inspectAdmittedAggregateResume({ ...candidate, phase: "qualifying" }), "advance");
  assert.throws(() => inspectAdmittedAggregateResume(candidate));
  assert.throws(() => inspectAdmittedAggregateResume({ ...retained, transient_retries: 1 }));
  assert.throws(() => inspectAdmittedAggregateResume({ ...retained, phase: "publishing" }));
  const publishing = {
    ...retained,
    phase: "publishing",
    stage_evidence: [
      retained.stage_evidence[0]!,
      { ...retained.stage_evidence[0]!, phase: "publishing" },
    ],
  };
  assert.equal(inspectAdmittedAggregateResume(publishing), "readback");
  assert.throws(() => assertAggregateUploadCandidate(publishing), /building phase/u);
  assert.throws(
    () =>
      inspectAdmittedAggregateResume({
        ...publishing,
        release_run: { ...candidate.release_run, run_id: 124 },
      }),
    /stage\/run/u,
  );
  await assert.rejects(runFixedAdmittedAggregateConfiguration({}, "/unused", 0), /deadline/u);
});
