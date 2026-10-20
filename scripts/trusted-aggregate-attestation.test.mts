import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assemblerIdentityFixture, expected } from "./fixtures/assembler-identity-fixture.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";
import {
  prepareAggregateAttestation,
  verifyAggregateAttestation,
  verifyUploadedAggregate,
  aggregatePredicateType,
  stageAggregatePackages,
} from "./trusted-aggregate-attestation.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test("fixed finalizer staging materializes all six beta packages and checksum without replacing prior bytes", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const directory = path.join(f.root, "publication-packages");
  const result = await stageAggregatePackages(directory, f.archive, f.request, hash(f.archive));
  assert.equal(result.authority, "none");
  assert.equal(result.files.length, 7);
  assert.deepEqual((await readdir(directory)).sort(), f.entries.map(([name]) => name).sort());
  for (const [name, bytes] of f.entries)
    assert.deepEqual(await readFile(path.join(directory, name)), bytes);
  await assert.rejects(
    stageAggregatePackages(directory, f.archive, f.request, hash(f.archive)),
    /EEXIST/,
  );
  for (const [name, bytes] of f.entries)
    assert.deepEqual(await readFile(path.join(directory, name)), bytes);
});

void test("changed aggregate member retains earlier verified files while wrong archive pin writes nothing", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const never = path.join(f.root, "never-materialized");
  await assert.rejects(
    stageAggregatePackages(never, f.archive, f.request, "0".repeat(64)),
    /archive differs/,
  );
  await assert.rejects(readdir(never));
  const changed = createAuditZip(
    f.entries.map(
      ([name, bytes, options], index) =>
        [
          name,
          index === f.entries.length - 1 ? Buffer.alloc(bytes.length, 120) : bytes,
          options,
        ] as const,
    ),
  );
  const partial = path.join(f.root, "retained-partial");
  await assert.rejects(
    stageAggregatePackages(partial, changed, f.request, hash(changed)),
    /retain partial state/,
  );
  const retained = await readdir(partial);
  assert.equal(retained.length, f.entries.length - 1);
  for (const name of retained)
    assert.deepEqual(
      await readFile(path.join(partial, name)),
      f.entries.find(([filename]) => filename === name)![1],
    );
});
async function fixture(t: test.TestContext, profile: "full" | "initial-beta-win-linux" = "full") {
  const f = await trustedAssemblyFixture(t, profile);
  const aggregate = await assembleTrustedRelease(f.root, f.input, f.request);
  const entries = await Promise.all(
    aggregate.output_files.map(
      async (file) =>
        [
          file.filename,
          await readFile(path.join(aggregate.assets, file.filename)),
          { descriptor: true },
        ] as const,
    ),
  );
  const archive = createAuditZip(entries);
  const upload = { artifact_id: 99, sha256: hash(archive) };
  const identity = assemblerIdentityFixture();
  const state = { drift: false, reads: 0, payload: archive };
  const metadata = () => ({
    id: 99,
    name: `trusted-release-final-${expected.run_id}-${expected.run_attempt}`,
    size_in_bytes: state.payload.length,
    digest: `sha256:${state.drift && state.reads > 1 ? "0".repeat(64) : hash(state.payload)}`,
    expired: false,
    created_at: "2026-10-18T00:00:00Z",
    expires_at: null,
    workflow_run: {
      id: Number(expected.run_id),
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: expected.controller_revision,
    },
  });
  const options = {
    cwd: f.root,
    identity,
    download: () => state.payload,
    spawn: (
      _command: string,
      args: readonly string[],
      settings: SpawnSyncOptionsWithStringEncoding,
    ) => {
      state.reads++;
      assert.deepEqual(args, [
        "api",
        "repos/boburning/portcove/actions/artifacts/99",
        "--include",
        "--method",
        "GET",
        "--hostname",
        "github.com",
      ]);
      assert.equal(settings.maxBuffer, 128 * 1024);
      assert.equal(settings.timeout, 15000);
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata())}`,
        stderr: "",
      };
    },
  };
  return { ...f, aggregate, archive, entries, upload, identity, state, options };
}

void test("new opaque aggregate members bind fresh signed own-job identity without accepting a supplied identity receipt", async (t) => {
  const f = await fixture(t);
  const result = await prepareAggregateAttestation(
    f.identity.token,
    expected,
    f.request,
    [1, 2, 3, 4],
    f.upload,
    f.options,
  );
  assert.equal(result.predicate_type, aggregatePredicateType);
  assert.equal(result.subject_digest, `sha256:${f.upload.sha256}`);
  assert.equal(result.predicate.assembler.job_id, 501);
  assert.equal(result.predicate.assembler.check_run_id, "777");
  assert.equal(result.predicate.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.predicate.original_compiler, null);
  assert.equal(result.predicate.release_authorization, "not-evaluated");
  assert.equal(JSON.stringify(result).includes(f.identity.token), false);
  assert.deepEqual(f.identity.counts(), { requests: 5, keyReads: 1 });
  assert.equal(f.state.reads, 2);
  assert.deepEqual(
    result.predicate.output_files,
    f.aggregate.output_files.sort((a, b) => a.filename.localeCompare(b.filename)),
  );
});

void test("beta attestation binds the selected two-platform aggregate without inventing compiler acceptance", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const result = await prepareAggregateAttestation(
    f.identity.token,
    expected,
    f.request,
    [1, 2],
    f.upload,
    f.options,
  );
  assert.equal(result.predicate.output_files.length, 7);
  assert.equal(result.predicate.original_compiler, null);
  assert.equal(result.authority, "none");
});

void test("old artifact IDs, wrong member bytes, forged identity and provider drift cannot form an accepted aggregate binding", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAggregateAttestation(
      f.identity.token,
      expected,
      f.request,
      [1, 2, 3, 99],
      f.upload,
      f.options,
    ),
    /new artifact/u,
  );
  assert.equal(f.state.reads, 0);
  const changed = createAuditZip(
    f.entries.map(([name, bytes, opts], i) => [
      name,
      i ? bytes : Buffer.alloc(bytes.length, 120),
      opts,
    ]),
  );
  f.state.payload = changed;
  await assert.rejects(
    prepareAggregateAttestation(
      f.identity.token,
      expected,
      f.request,
      [1, 2, 3, 4],
      { artifact_id: 99, sha256: hash(changed) },
      f.options,
    ),
    /member bytes differ/u,
  );
  f.state.payload = f.archive;
  const sameIdentityWrongBytes = {
    ...f.options,
    download: () => {
      const copy = Buffer.from(f.archive);
      copy[40]! ^= 1;
      return copy;
    },
  };
  await assert.rejects(
    prepareAggregateAttestation(
      f.identity.token,
      expected,
      f.request,
      [1, 2, 3, 4],
      f.upload,
      sameIdentityWrongBytes,
    ),
    /digest differs/u,
  );
  await assert.rejects(
    prepareAggregateAttestation("forged", expected, f.request, [1, 2, 3, 4], f.upload, f.options),
  );
  f.state.reads = 0;
  f.state.drift = true;
  await assert.rejects(
    prepareAggregateAttestation(
      f.identity.token,
      expected,
      f.request,
      [1, 2, 3, 4],
      f.upload,
      f.options,
    ),
    /provider identity differs|changed during binding/u,
  );
});

async function verificationFixture(t: test.TestContext, withPublic = false) {
  const f = await fixture(t, withPublic ? "initial-beta-win-linux" : "full");
  const publicInputs = withPublic ? await releasePublicBuildProvenanceFixture(t) : null;
  const candidate = publicInputs
    ? { ...f.request, schema_version: 3, public_build_inputs: publicInputs.binding }
    : f.request;
  const ids = withPublic ? [1, 2] : [1, 2, 3, 4];
  const options = publicInputs
    ? {
        ...f.options,
        evidenceRequest: publicInputs.expected,
        evidence: { api: publicInputs.api },
        download: (endpoint: string) =>
          endpoint.includes("/99/") ? f.state.payload : publicInputs.download(endpoint),
      }
    : f.options;
  const prepared = await prepareAggregateAttestation(
    f.identity.token,
    expected,
    candidate,
    ids,
    f.upload,
    options,
  );
  // Synthetic successful CLI boundary, never cryptographic/production evidence.
  const predicate = { ...prepared.predicate, evidence_scope: "github.com" };
  const workflowUri = `https://github.com/boburning/portcove/${productionControllerWorkflow}@${expected.controller_ref}`;
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: workflowUri,
    buildSignerDigest: expected.controller_revision,
    sourceRepositoryDigest: expected.controller_revision,
    sourceRepositoryRef: expected.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`,
  };
  const value = [
    {
      verificationResult: {
        signature: { certificate },
        verifiedTimestamps: [{ timestamp: "synthetic" }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: aggregatePredicateType,
          subject: [{ name: prepared.subject_name, digest: { sha256: f.upload.sha256 } }],
          predicate,
        },
      },
    },
  ];
  const verificationExpected = {
    controller_revision: expected.controller_revision,
    controller_ref: expected.controller_ref,
    run_id: expected.run_id,
    run_attempt: expected.run_attempt,
    artifact_id: 99,
    sha256: f.upload.sha256,
    bytes: f.archive.length,
    candidate,
    candidate_artifact_ids: ids,
  };
  const calls: readonly string[][] = [];
  const spawn = (
    _command: string,
    args: readonly string[],
    settings: SpawnSyncOptionsWithStringEncoding,
  ) => {
    (calls as string[][]).push([...args]);
    assert.equal(settings.timeout, 30000);
    assert.equal(settings.maxBuffer, 1024 * 1024);
    for (const [flag, wanted] of [
      ["--signer-digest", expected.controller_revision],
      ["--source-digest", expected.controller_revision],
      ["--source-ref", expected.controller_ref],
      ["--predicate-type", aggregatePredicateType],
    ])
      assert.equal(args[args.indexOf(flag!) + 1], wanted);
    assert.ok(args.includes("--bundle") && args.includes("--deny-self-hosted-runners"));
    return { status: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  return { ...f, value, verificationExpected, calls, spawn, publicInputs };
}

void test("schema3 aggregate attestation independently verifies public archives and binds their exact provenance into verification", async (t) => {
  const f = await verificationFixture(t, true);
  assert.ok(f.publicInputs);
  assert.equal(f.publicInputs.state.reads, 2);
  const result = await verifyAggregateAttestation(
    f.root,
    f.archive,
    Buffer.from("synthetic bundle"),
    f.verificationExpected,
    { spawn: f.spawn },
  );
  assert.equal(result.authority, "none");
  const predicate = f.value[0]!.verificationResult.statement.predicate;
  assert.deepEqual(predicate.public_build_inputs, f.publicInputs.binding);
  assert.match(predicate.public_build_inputs_scope!, /no compiler-content or execution claim/);
  const changed = structuredClone(f.verificationExpected);
  assert.ok("public_build_inputs" in changed.candidate);
  changed.candidate.public_build_inputs.manifest_sha256 = "f".repeat(64);
  await assert.rejects(
    verifyAggregateAttestation(f.root, f.archive, Buffer.from("synthetic bundle"), changed, {
      spawn: f.spawn,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.match(error.cause.message, /association differs/);
      return true;
    },
  );
});

void test("schema3 attester refuses altered public build bytes before obtaining its assembler identity", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const p = await releasePublicBuildProvenanceFixture(t);
  p.publicFiles.set(
    "tauri.release-public.conf.json",
    Buffer.from('{"bundle":{"createUpdaterArtifacts":false}}'),
  );
  p.replacePublicArchive();
  await assert.rejects(
    prepareAggregateAttestation(
      f.identity.token,
      expected,
      { ...f.request, schema_version: 3, public_build_inputs: p.binding },
      [1, 2],
      f.upload,
      { ...f.options, evidenceRequest: p.expected, evidence: { api: p.api }, download: p.download },
    ),
    CoordinatorRemoteError,
  );
  assert.deepEqual(f.identity.counts(), { requests: 0, keyReads: 0 });
});

void test("missing or changed aggregate checksum manifest and excess member length refuse before identity verification", async (t) => {
  const f = await fixture(t);
  const cases = [
    createAuditZip(f.entries.filter(([name]) => name !== "SHA256SUMS.txt")),
    createAuditZip(
      f.entries.map(([name, bytes, opts]) => [
        name,
        name === "SHA256SUMS.txt" ? Buffer.alloc(bytes.length, 48) : bytes,
        opts,
      ]),
    ),
    createAuditZip(
      f.entries.map(([name, bytes, opts], i) => [
        name,
        i ? bytes : Buffer.concat([bytes, Buffer.from("excess")]),
        opts,
      ]),
    ),
  ];
  for (const archive of cases) {
    f.state.payload = archive;
    await assert.rejects(
      prepareAggregateAttestation(
        f.identity.token,
        expected,
        f.request,
        [1, 2, 3, 4],
        { artifact_id: 99, sha256: hash(archive) },
        f.options,
      ),
    );
    assert.deepEqual(f.identity.counts(), { requests: 0, keyReads: 0 });
  }
});

void test("omitted candidate artifacts refuse in producer and consumer before creating predicate or verification output", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAggregateAttestation(f.identity.token, expected, f.request, [1], f.upload, f.options),
    /matrix is incomplete/u,
  );
  assert.equal(f.state.reads, 0);
  assert.equal(f.identity.counts().requests, 0);
  const before = await readdir(f.root);
  await assert.rejects(
    verifyAggregateAttestation(
      f.root,
      f.archive,
      Buffer.from("synthetic"),
      {
        controller_revision: expected.controller_revision,
        controller_ref: expected.controller_ref,
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        artifact_id: 99,
        sha256: f.upload.sha256,
        bytes: f.archive.length,
        candidate: f.request,
        candidate_artifact_ids: [1],
      },
      {
        spawn: () => {
          assert.fail("incomplete matrix reached verifier");
        },
      },
    ),
    /matrix is incomplete/u,
  );
  assert.deepEqual(await readdir(f.root), before);
});

void test("existing CLI verified certificate and predicate bind the exact subject, controller run and complete candidate members", async (t) => {
  const f = await verificationFixture(t);
  const result = await verifyAggregateAttestation(
    f.root,
    f.archive,
    Buffer.from("synthetic offline bundle"),
    f.verificationExpected,
    { spawn: f.spawn },
  );
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.original_compiler, null);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    await readFile(path.join(result.directory, "input", "aggregate.zip")),
    f.archive,
  );
  assert.equal(result.assembler.job_id, 501);
});

void test("verified-but-wrong certificate/subject/predicate and ambiguous results fail closed with retained evidence", async (t) => {
  const f = await verificationFixture(t);
  const baseline = structuredClone(f.value);
  const mutate = [
    () => {
      f.value[0]!.verificationResult.signature.certificate.sourceRepositoryIdentifier = "1";
    },
    () => {
      f.value[0]!.verificationResult.signature.certificate.runInvocationURI += "0";
    },
    () => {
      f.value[0]!.verificationResult.signature.certificate.buildSignerDigest = "b".repeat(40);
    },
    () => {
      f.value[0]!.verificationResult.statement.subject[0]!.digest.sha256 = "0".repeat(64);
    },
    () => {
      f.value[0]!.verificationResult.statement.predicate.candidate.source_tree = "c".repeat(40);
    },
    () => {
      f.value[0]!.verificationResult.statement.predicate.output_files.pop();
    },
    () => {
      f.value[0]!.verificationResult.statement.predicate.assembler.job_id = 0;
    },
    () => {
      f.value[0]!.verificationResult.statement.predicate.evidence_scope = "injected-provider";
    },
    () => {
      f.value[0]!.verificationResult.verifiedTimestamps.length = 0;
    },
    () => {
      f.value.push(structuredClone(f.value[0]!));
    },
  ];
  for (const change of mutate) {
    f.value.splice(0, f.value.length, ...structuredClone(baseline));
    change();
    await assert.rejects(
      verifyAggregateAttestation(
        f.root,
        f.archive,
        Buffer.from("synthetic"),
        f.verificationExpected,
        { spawn: f.spawn },
      ),
      /retain owned directory/u,
    );
  }
  const retained = (await readdir(f.root)).filter((name) =>
    name.startsWith("aggregate-attestation-"),
  );
  assert.equal(retained.length, mutate.length);
  for (const directory of retained)
    assert.deepEqual((await readdir(path.join(f.root, directory, "input"))).sort(), [
      "aggregate.zip",
      "attestation.json",
    ]);
});

async function uploadedFixture(t: test.TestContext) {
  const f = await verificationFixture(t);
  const state = {
    reads: 0,
    fault: "",
    downloaded: false,
    bundle: createAuditZip([
      ["aggregate-attestation.json", Buffer.from("synthetic offline bundle"), { descriptor: true }],
    ]),
  };
  const supplied = {
    ...f.verificationExpected,
    bundle_artifact_id: 100,
    bundle_sha256: hash(state.bundle),
  };
  const apiCalls: string[] = [];
  const downloadCalls: string[] = [];
  const options = {
    spawn: (
      command: string,
      args: readonly string[],
      settings: SpawnSyncOptionsWithStringEncoding,
    ) => {
      if (args[0] !== "api") return f.spawn(command, args, settings);
      state.reads++;
      apiCalls.push(args[1]!);
      assert.equal(settings.timeout, 15000);
      assert.equal(settings.maxBuffer, 128 * 1024);
      assert.deepEqual(args.slice(2), ["--include", "--method", "GET", "--hostname", "github.com"]);
      const endpoint = args[1]!;
      let body: unknown;
      if (endpoint.includes("/actions/runs/")) {
        assert.ok(
          [
            `repos/boburning/portcove/actions/runs/${expected.run_id}`,
            `repos/boburning/portcove/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`,
          ].includes(endpoint),
        );
        body = {
          id: Number(expected.run_id),
          run_attempt:
            state.fault === "attempt-drift" && state.downloaded ? 3 : expected.run_attempt,
          head_sha: expected.controller_revision,
          repository: { id: 1354613114, full_name: "boburning/portcove" },
          head_repository: { id: 1354613114 },
          path: productionControllerWorkflow,
          event: "workflow_dispatch",
          status: "in_progress",
          conclusion: null,
        };
      } else {
        const bundle = endpoint.endsWith("/100");
        assert.ok(bundle || endpoint.endsWith("/99"));
        body = {
          id: bundle ? 100 : 99,
          name: `trusted-release-${bundle ? "attestation" : "final"}-${expected.run_id}-${expected.run_attempt}`,
          size_in_bytes: bundle ? state.bundle.length : f.archive.length,
          digest: `sha256:${bundle ? (state.fault === "bundle-drift" && state.downloaded ? "0".repeat(64) : supplied.bundle_sha256) : supplied.sha256}`,
          expired: state.fault === "expired",
          created_at: "2026-10-18T00:00:00Z",
          expires_at: null,
          workflow_run: {
            id: Number(expected.run_id),
            repository_id: 1354613114,
            head_repository_id: 1354613114,
            head_sha: state.fault === "source" ? "b".repeat(40) : expected.controller_revision,
          },
        };
      }
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
        stderr: "",
      };
    },
    download: (endpoint: string) => {
      downloadCalls.push(endpoint);
      state.downloaded = true;
      if (state.fault === "secret") throw new Error("Bearer private-provider-text");
      if (endpoint.endsWith("/99/zip")) return f.archive;
      assert.equal(endpoint, "repos/boburning/portcove/actions/artifacts/100/zip");
      return state.fault === "changed-bytes" ? Buffer.alloc(state.bundle.length, 1) : state.bundle;
    },
  };
  return { ...f, state, supplied, options, apiCalls, downloadCalls };
}

void test("downstream consumer acquires exact opaque IDs in a still-active controller then invokes the existing pinned verifier", async (t) => {
  const f = await uploadedFixture(t);
  const result = await verifyUploadedAggregate(f.root, f.supplied, f.options);
  assert.equal(result.authority, "none");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.original_compiler, null);
  assert.equal(result.api_requests, 8);
  assert.equal(result.bundle_artifact_id, 100);
  assert.equal(f.calls.length, 1);
  assert.equal(f.downloadCalls.length, 2);
  assert.equal(f.apiCalls.filter((endpoint) => endpoint.includes("/attempts/2")).length, 2);
});

void test("downstream drift, expired/mismatched provider objects, changed ZIPs and provider exceptions refuse with exact sanitized association", async (t) => {
  for (const fault of [
    "attempt-drift",
    "bundle-drift",
    "expired",
    "source",
    "changed-bytes",
    "secret",
  ]) {
    const f = await uploadedFixture(t);
    f.state.fault = fault;
    await assert.rejects(
      verifyUploadedAggregate(f.root, f.supplied, f.options),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.doesNotMatch(JSON.stringify(error.evidence), /Bearer|private-provider-text/u);
        const evidence = error.evidence as {
          artifact_id: number;
          bundle_artifact_id: number;
          directory: string;
        };
        assert.equal(evidence.artifact_id, 99);
        assert.equal(evidence.bundle_artifact_id, 100);
        assert.match(evidence.directory, /aggregate-verification-/u);
        return true;
      },
    );
    if (["expired", "source"].includes(fault)) assert.equal(f.downloadCalls.length, 0);
  }
});

void test("bundle ZIP aliases, extra members and oversized declarations refuse before the signature verifier", async (t) => {
  for (const entries of [
    [["nested/aggregate-attestation.json", Buffer.from("x")]],
    [
      ["aggregate-attestation.json", Buffer.from("x")],
      ["other.json", Buffer.from("y")],
    ],
    [["aggregate-attestation.json", Buffer.alloc(512 * 1024 + 1, 1)]],
  ] as [string, Buffer][][]) {
    const f = await uploadedFixture(t);
    f.state.bundle = createAuditZip(entries);
    f.supplied.bundle_sha256 = hash(f.state.bundle);
    await assert.rejects(verifyUploadedAggregate(f.root, f.supplied, f.options));
    assert.equal(f.calls.length, 0);
  }
});
