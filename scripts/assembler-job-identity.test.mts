import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  verifyAssemblerJobIdentity,
  verifyClassificationWriterJobIdentity,
  verifyProtectionObserverJobIdentity,
  verifyPayloadSignerJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
  verifyReleaseInputReaderJobIdentity,
} from "./assembler-job-identity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  expected,
  jwk,
  assemblerIdentityFixture as fixture,
} from "./fixtures/assembler-identity-fixture.mts";
void test("payload signer role requires its own signed check-run and fixed job profile", async () => {
  const f = fixture(
    {},
    {},
    { workflow: productionControllerWorkflow, job: "Sign admitted updater payloads" },
  );
  const result = await verifyPayloadSignerJobIdentity(f.token, expected, f);
  assert.equal(result.job_id, 501);
  assert.equal(result.check_run_id, "777");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  const assembler = fixture();
  await assert.rejects(verifyPayloadSignerJobIdentity(assembler.token, expected, assembler));
  const nameOnly = fixture(
    {},
    {},
    { workflow: productionControllerWorkflow, job: "Sign admitted updater payloads" },
  );
  nameOnly.faults.value = "name-only";
  await assert.rejects(verifyPayloadSignerJobIdentity(nameOnly.token, expected, nameOnly));
});

void test("signed check-run identity resolves the independent numeric job through complete attempt pages", async () => {
  const f = fixture();
  const value = await verifyAssemblerJobIdentity(f.token, expected, f);
  assert.equal(value.job_id, 501);
  assert.equal(value.check_run_id, "777");
  assert.equal(value.run_attempt, 2);
  assert.equal(value.evidence_scope, "injected-provider");
  assert.equal(value.kind, "oidc-job-identity-only");
  assert.equal(value.authority, "none");
  assert.equal(value.protection_enforcement, "unproven");
  assert.equal(value.artifact_production, "unproven");
  assert.equal(value.code_execution, "unproven");
  assert.equal(JSON.stringify(value).includes(f.token), false);
  assert.deepEqual(f.counts(), { requests: 5, keyReads: 1 });
});

void test("forged, expired, changed or unsupported OIDC claims never reach the job API", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [claims, header] of [
    [{ actor_id: "999" }, {}],
    [{ exp: now - 1 }, {}],
    [{ nbf: now + 300 }, {}],
    [{ aud: "other" }, {}],
    [{ repository_id: "1" }, {}],
    [{ workflow_sha: "b".repeat(40) }, {}],
    [{ job_workflow_ref: "other reusable workflow" }, {}],
    [{ check_run_id: 777 }, {}],
    [{}, { alg: "none" }],
    [{}, { jku: "https://attacker.invalid/keys" }],
  ]) {
    const f = fixture(claims, header);
    await assert.rejects(verifyAssemblerJobIdentity(f.token, expected, f));
    assert.equal(f.counts().requests, 0);
  }
  const f = fixture();
  const parts = f.token.split(".");
  parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
  await assert.rejects(verifyAssemblerJobIdentity(parts.join("."), expected, f), /signature/u);
  assert.equal(f.counts().requests, 0);
});

void test("ambiguous keys, missing pages, duplicated jobs, name-only matches and run drift refuse", async () => {
  for (const fault of [
    "keys",
    "missing",
    "count",
    "duplicate",
    "name-only",
    "drift",
    "attempt",
    "job-source",
    "job-completed",
    "api-status",
    "api-json",
  ]) {
    const f = fixture();
    f.faults.value = fault;
    await assert.rejects(verifyAssemblerJobIdentity(f.token, expected, f));
    if (fault === "keys") assert.equal(f.counts().requests, 0);
  }
});

void test("missing, malformed, unsupported and undersized signing keys refuse before API reads", async () => {
  const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
    format: "jwk",
  });
  for (const key of [
    { ...jwk, kid: "missing" },
    { ...jwk, kty: "EC" },
    { ...jwk, alg: "HS256" },
    { ...jwk, use: "enc" },
    { ...jwk, n: "!" },
    { ...jwk, e: "!" },
    { ...jwk, ...small },
  ]) {
    const f = fixture();
    await assert.rejects(
      verifyAssemblerJobIdentity(f.token, expected, {
        transport: f.transport,
        readKeys: async () => ({ keys: [key] }),
      }),
    );
    assert.equal(f.counts().requests, 0);
  }
  const f = fixture({}, { kid: undefined });
  await assert.rejects(verifyAssemblerJobIdentity(f.token, expected, f), /header/u);
  assert.deepEqual(f.counts(), { requests: 0, keyReads: 0 });
});

void test("a token expiring during the first API response cannot produce an identity receipt", async (t) => {
  const f = fixture();
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const transport = {
    ...f.transport,
    spawn: (...args: Parameters<typeof f.transport.spawn>) => {
      const result = f.transport.spawn(...args);
      clock += 600 * 1000;
      return result;
    },
  };
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, expected, { readKeys: f.readKeys, transport }),
    /expired/u,
  );
  assert.equal(f.counts().requests, 1);
});

void test("default key collection pins the HTTPS issuer and bounds bytes before parsing", async (t) => {
  const f = fixture();
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    },
  );
  const value = await verifyAssemblerJobIdentity(f.token, expected, { transport: f.transport });
  assert.equal(value.job_id, 501);
  mocked.mock.mockImplementation(
    async () => new Response(new Uint8Array(128 * 1024 + 1), { status: 200 }),
  );
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, expected, { transport: f.transport }),
    /byte bound/u,
  );
  mocked.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, expected, { transport: f.transport }),
    /unavailable/u,
  );
  mocked.mock.mockImplementation(async () => new Response("{broken", { status: 200 }));
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, expected, { transport: f.transport }),
    /malformed/u,
  );
});

void test("fixed control profiles accept only their exact workflow/job and reject cross-role credentials", async () => {
  const workflow = ".github/workflows/release-reviewed-inputs.yml";
  const roles = [
    {
      verify: verifyClassificationWriterJobIdentity,
      job: "Persist independently reviewed classification",
    },
    { verify: verifyProtectionObserverJobIdentity, job: "Observe release input protections" },
  ];
  for (const role of roles) {
    const f = fixture({}, {}, { workflow, job: role.job });
    assert.equal((await role.verify(f.token, expected, f)).workflow, workflow);
    await assert.rejects(verifyAssemblerJobIdentity(f.token, expected, f));
    const other = roles.find((value) => value !== role)!;
    await assert.rejects(other.verify(f.token, expected, f));
    const wrongWorkflow = fixture(
      {},
      {},
      { workflow: ".github/workflows/other.yml", job: role.job },
    );
    await assert.rejects(role.verify(wrongWorkflow.token, expected, wrongWorkflow));
  }
});

void test("production observer and reader profiles cannot reuse each other's job or the separate review workflow", async () => {
  const workflow = ".github/workflows/application-update-production.yml";
  const observer = fixture(
    {},
    {},
    { workflow, job: "Observe production release input protections" },
  );
  const reader = fixture({}, {}, { workflow, job: "Authenticate release control inputs" });
  assert.equal(
    (await verifyProductionProtectionObserverJobIdentity(observer.token, expected, observer))
      .job_id,
    501,
  );
  assert.equal(
    (await verifyReleaseInputReaderJobIdentity(reader.token, expected, reader)).job_id,
    501,
  );
  await assert.rejects(verifyReleaseInputReaderJobIdentity(observer.token, expected, observer));
  await assert.rejects(
    verifyProductionProtectionObserverJobIdentity(reader.token, expected, reader),
  );
  await assert.rejects(verifyProtectionObserverJobIdentity(observer.token, expected, observer));
});
