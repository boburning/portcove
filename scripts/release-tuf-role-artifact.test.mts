import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  readAttestedTufRoleArtifact,
  receiveTufRoleArtifact,
  requireReceivedTufRoleArtifact,
  requireRetainedTufRoleArtifact,
  tufRolePredicateType,
  recheckTufRoleArtifactCustody,
  readAttestedCatalogRoleArtifact,
  requireReceivedCatalogRoleArtifact,
  catalogRolePredicateType,
} from "./release-tuf-role-artifact.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import type { RetainedGitHubSpawn } from "./github-cli.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(catalog = false) {
  const phase = catalog ? "catalog-definitions" : "tuf-releases",
    filename = catalog ? "official-definitions.json" : "releases.json",
    predicateType = catalog ? catalogRolePredicateType : tufRolePredicateType;
  const controller = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-test",
    run_id: "12345",
    run_attempt: 1,
  };
  const producer = {
    controller_revision: controller.controller_revision,
    execution_ref: controller.controller_ref,
    workflow: productionControllerWorkflow,
    run_id: "12345",
    run_attempt: 1,
    job_id: 501,
    check_run_id: "777",
    actor_id: "1234",
    role: phase,
  };
  const envelope = Buffer.from("inert-fixture-role-signature-not-authenticated"),
    envelopeIdentity = {
      filename,
      bytes: envelope.length,
      sha256: hash(envelope),
    };
  const pending = { checkpoint: "c".repeat(40), operation_id: "d".repeat(64) };
  const manifest = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      producer,
      pending,
      input_binding_sha256: "e".repeat(64),
      files: [envelopeIdentity],
      authority: "none",
    }),
  );
  const archive = createAuditZip([
    [filename, envelope],
    ["signing-output-manifest.json", manifest],
  ]);
  const bundle = createAuditZip([["role-attestation.json", Buffer.from("inert-sigstore-bundle")]]);
  const expected = {
    role: catalog ? "definitions" : "releases",
    ...(catalog ? { purpose: "catalog" } : {}),
    controller,
    artifact: { id: 900, sha256: hash(archive) },
    bundle: { id: 901, sha256: hash(bundle) },
    context_manifest_sha256: "f".repeat(64),
    context_binding_sha256: "e".repeat(64),
    context_facts_sha256: "1".repeat(64),
  };
  const workflow_run = {
    id: 12345,
    repository_id: 1354613114,
    head_repository_id: 1354613114,
    head_sha: controller.controller_revision,
  };
  const artifact = {
    id: 900,
    name: `trusted-${phase}-output-12345-1`,
    size_in_bytes: archive.length,
    digest: `sha256:${hash(archive)}`,
    expired: false,
    workflow_run,
  };
  const bundleArtifact = {
    ...artifact,
    id: 901,
    name: `trusted-${phase}-attestation-12345-1`,
    size_in_bytes: bundle.length,
    digest: `sha256:${hash(bundle)}`,
  };
  const predicate = {
    schema_version: 1,
    role: phase,
    controller,
    producer,
    artifact: { id: 900, bytes: archive.length, sha256: hash(archive), name: artifact.name },
    manifest_sha256: hash(manifest),
    context_manifest_sha256: expected.context_manifest_sha256,
    context_binding_sha256: expected.context_binding_sha256,
    context_facts_sha256: expected.context_facts_sha256,
    envelope: envelopeIdentity,
    pending,
    publication_admission: "not-established",
    authority: "none",
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: catalog ? "catalog-role-output-manifest" : "tuf-role-output-manifest",
        digest: { sha256: hash(manifest) },
      },
    ],
    predicateType,
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
    runInvocationURI: "https://github.com/boburning/portcove/actions/runs/12345/attempts/1",
  };
  const run = {
    id: 12345,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: 501,
    run_id: 12345,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
    status: "completed",
    conclusion: "success",
    name: releaseControlPhaseProfile(phase).reader_name,
  };
  const calls: string[] = [];
  const metadata = {
    async attempt(runId: string, attempt: number) {
      assert.equal(runId, "12345");
      assert.equal(attempt, 1);
      calls.push("attempt");
      return structuredClone(run);
    },
    async job(id: number) {
      assert.equal(id, 501);
      calls.push("job");
      return structuredClone(job);
    },
    async artifact(id: number) {
      assert.ok(id === 900 || id === 901);
      calls.push(`artifact:${id}`);
      return structuredClone(id === 900 ? artifact : bundleArtifact);
    },
  };
  let verifications = 0,
    downloads = 0;
  const options = {
    metadata,
    download: (endpoint: string) => {
      downloads++;
      assert.ok(
        endpoint === "repos/boburning/portcove/actions/artifacts/900/zip" ||
          endpoint === "repos/boburning/portcove/actions/artifacts/901/zip",
      );
      return Buffer.from(endpoint.includes("/900/") ? archive : bundle);
    },
    spawn: ((_command, argv) => {
      verifications++;
      assert.ok(argv.includes("--deny-self-hosted-runners"));
      assert.ok(argv.includes(controller.controller_revision));
      assert.ok(argv.includes(predicateType));
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            verificationResult: { signature: { certificate }, verifiedTimestamps: [{}], statement },
          },
        ]),
      };
    }) as RetainedGitHubSpawn,
  };
  return {
    expected,
    options,
    artifact,
    bundleArtifact,
    predicate,
    certificate,
    job,
    run,
    calls,
    downloads: () => downloads,
    verifications: () => verifications,
  };
}
void test("catalog injected role transport verifies distinct producer/context/subject and cannot mint actual catalog or app custody", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-role-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(true),
    result = await readAttestedCatalogRoleArtifact(
      root,
      f.expected,
      performance.now() + 30000,
      f.options,
    );
  assert.equal(result.expected.role, "definitions");
  assert.equal(result.envelope.filename, "official-definitions.json");
  assert.equal(result.evidence_scope, "injected-provider");
  await assert.rejects(() => requireReceivedCatalogRoleArtifact(result));
  await assert.rejects(() => requireReceivedTufRoleArtifact(result));
  await assert.rejects(() =>
    readAttestedTufRoleArtifact(root, f.expected, performance.now() + 30000, f.options),
  );
  f.predicate.context_binding_sha256 = "9".repeat(64);
  await assert.rejects(() =>
    readAttestedCatalogRoleArtifact(root, f.expected, performance.now() + 30000, f.options),
  );
});
void test("injected existing attestation + completed numeric role custody is data only and preserves failed downstream-run lineage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-role-custody-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(),
    result = await readAttestedTufRoleArtifact(
      root,
      f.expected,
      performance.now() + 350000,
      f.options,
    );
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.custody.producer.job_id, 501);
  assert.equal(result.custody.producer.check_run_id, "777");
  assert.equal(f.verifications(), 1);
  assert.equal(f.downloads(), 3);
  assert.equal(f.calls.length, 11);
  assert.equal(
    await readFile(result.envelope.path, "utf8"),
    "inert-fixture-role-signature-not-authenticated",
  );
  await assert.rejects(requireReceivedTufRoleArtifact(result), /actual current/u);
  await assert.rejects(
    requireRetainedTufRoleArtifact(result, performance.now() + 1000),
    /actual current/u,
  );
  assert.equal(f.calls.length, 11);
  await assert.rejects(
    receiveTufRoleArtifact({}, root, f.expected, performance.now() + 10000),
    /actual authenticated/u,
  );
});
void test("wrong attestation context/certificate and producer/run/artifact association retain sanitized refusal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-role-custody-refusals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.expected.context_binding_sha256 = "0".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.predicate.context_manifest_sha256 = "0".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.certificate.sourceRepositoryIdentifier = "1234";
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.check_run_url = f.job.check_run_url.replace("777", "501");
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.name = "Sign authenticated Preview metadata";
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.conclusion = "failure";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.run_attempt = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.bundleArtifact.workflow_run.head_sha = "0".repeat(40);
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(
      readAttestedTufRoleArtifact(root, f.expected, performance.now() + 10000, f.options),
      /TUF role custody refused/u,
    );
  }
  for (const name of await readdir(root)) {
    const refusal = await readFile(path.join(root, name, "refusal.json"), "utf8");
    assert.equal((JSON.parse(refusal) as { authority: string }).authority, "none");
  }
});
void test("TUF receiver refuses unknown fields and expired phase before directory or transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-role-before-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  for (const raw of [
    { ...f.expected, accepted: true },
    { ...f.expected, role: "targets" },
    { ...f.expected, bundle: f.expected.artifact },
  ])
    await assert.rejects(
      readAttestedTufRoleArtifact(root, raw, performance.now() + 10000, f.options),
    );
  await assert.rejects(
    readAttestedTufRoleArtifact(root, f.expected, performance.now() - 1, f.options),
    /deadline/u,
  );
  await assert.rejects(
    readAttestedTufRoleArtifact(root, f.expected, performance.now() + 601000, f.options),
    /deadline/u,
  );
  assert.deepEqual(await readdir(root), []);
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloads(), 0);
});
void test("locked SDK metadata and retained archive/verifier share the original role deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-role-default-transports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(),
    previous = process.env.GH_HOST,
    timeouts: number[] = [];
  process.env.GH_HOST = "ambient.invalid";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previous;
  });
  let now = 100.25;
  t.mock.method(performance, "now", () => now);
  const deadline = now + 5000;
  let effectiveDeadline = deadline;
  const recordTimeout = (timeout: unknown, commandCap: number) => {
    assert.ok(typeof timeout === "number" && Number.isSafeInteger(timeout));
    // Transports retain their own caps and floor/ceil millisecond rounding.
    // Their common invariant is the same shrinking absolute phase deadline,
    // rather than a globally nonincreasing sequence across different commands.
    assert.ok(timeout > 0 && timeout <= Math.min(commandCap, Math.ceil(effectiveDeadline - now)));
    timeouts.push(timeout);
    now += 0.125; // The mocked child consumes original-clock time, never resets it.
  };
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghs_SYNTHETIC_ROLE";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const result = await readAttestedTufRoleArtifact(root, f.expected, deadline, {
    fetch: async (input, settings) => {
      const request = new Request(input, settings);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token ghs_SYNTHETIC_ROLE");
      assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
      assert.ok(now < effectiveDeadline);
      now += 0.125;
      const prefix = "/repos/boburning/portcove/actions";
      const route = url.pathname;
      assert.ok(
        [
          `${prefix}/artifacts/900`,
          `${prefix}/artifacts/901`,
          `${prefix}/jobs/501`,
          `${prefix}/runs/12345/attempts/1`,
        ].includes(route),
      );
      const data = route.startsWith(`${prefix}/artifacts/`)
        ? await f.options.metadata.artifact(Number(route.split("/").at(-1)))
        : route === `${prefix}/jobs/501`
          ? await f.options.metadata.job(501)
          : await f.options.metadata.attempt("12345", 1);
      return Response.json(data);
    },
    spawn: (command, argv, settings) => {
      assert.equal(command, "gh");
      assert.equal(argv[0], "attestation");
      assert.equal(settings.env?.GH_HOST, "github.com");
      assert.equal(settings.env?.NODE_OPTIONS, undefined);
      assert.equal(settings.env?.HTTPS_PROXY, undefined);
      recordTimeout(settings.timeout, 30000);
      return f.options.spawn(command, argv, settings);
    },
    archiveSpawn: (command, argv, settings) => {
      assert.equal(command, "gh");
      assert.equal(argv[argv.indexOf("--hostname") + 1], "github.com");
      assert.equal(settings.env?.GH_HOST, "github.com");
      recordTimeout(settings.timeout, 30000);
      const endpoint = argv.find((value) => value.startsWith("repos/boburning/portcove/"));
      assert.ok(endpoint);
      return { status: 0, stdout: f.options.download(endpoint) };
    },
  }).catch(async (error: unknown) => {
    const names = await readdir(root);
    const phase = await readFile(path.join(root, names[0]!, "refusal.json"), "utf8");
    throw new Error(`fixture boundary failed ${phase}; timeouts ${timeouts.join(",")}`, {
      cause: error,
    });
  });
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(timeouts.length, 4);
  assert.equal(f.calls.length, 11);
  const tight = now + 500;
  effectiveDeadline = tight;
  await recheckTufRoleArtifactCustody(result, tight);
  assert.deepEqual(f.calls.slice(11), ["artifact:900", "artifact:901", "job"]);
  await recheckTufRoleArtifactCustody(result, now + 300000);
  assert.equal(f.calls.length, 17);
  now = tight;
  await assert.rejects(recheckTufRoleArtifactCustody(result, now + 300000), /deadline/u);
  assert.equal(f.calls.length, 17);
});
