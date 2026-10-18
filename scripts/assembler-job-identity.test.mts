import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { verifyAssemblerJobIdentity } from "./assembler-job-identity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";

// Disposable in-memory test signing key. No production key or token is used.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
const expected = {
  audience: "portcove-trusted-assembly",
  subject: "fixture independently expected subject",
  controller_revision: "a".repeat(40),
  controller_ref: "refs/tags/portcove-production-controller-fixture",
  actor_id: "1122",
  run_id: "9988",
  run_attempt: 2,
};

function fixture(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: expected.audience,
    sub: expected.subject,
    exp: now + 300,
    nbf: now - 2,
    iat: now - 2,
    repository: "boburning/portcove",
    repository_id: "1354613114",
    actor_id: expected.actor_id,
    ref: expected.controller_ref,
    ref_type: "tag",
    sha: expected.controller_revision,
    workflow_sha: expected.controller_revision,
    workflow_ref: `boburning/portcove/${productionControllerWorkflow}@${expected.controller_ref}`,
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: expected.run_id,
    run_attempt: "2",
    check_run_id: "777",
    ...overrides,
  };
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture", ...headerOverrides })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const faults = { value: "" };
  let requests = 0;
  let keyReads = 0;
  let runReads = 0;
  const readKeys = async () => {
    keyReads++;
    return { keys: faults.value === "keys" ? [jwk, jwk] : [jwk] };
  };
  const job = (id: number) => ({
    id,
    run_id: 9988,
    run_attempt: 2,
    head_sha: expected.controller_revision,
    status: "completed",
    name: "Other job",
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${1000 + id}`,
  });
  const transport = {
    cwd: process.cwd(),
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => {
      assert.equal(command, "gh");
      assert.deepEqual(args.slice(-4), ["--method", "GET", "--hostname", "github.com"]);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.equal(options.timeout, 15_000);
      assert.equal(options.input, undefined);
      requests++;
      const endpoint = args[2]!;
      let body: unknown;
      if (endpoint.endsWith("/actions/runs/9988")) {
        runReads++;
        body = {
          id: 9988,
          run_attempt: faults.value === "attempt" ? 3 : 2,
          head_sha:
            faults.value === "drift" && runReads > 1
              ? "b".repeat(40)
              : expected.controller_revision,
          path: productionControllerWorkflow,
          event: "workflow_dispatch",
          status: "in_progress",
          repository: { id: 1354613114, full_name: "boburning/portcove" },
          head_repository: { id: 1354613114 },
        };
      } else if (endpoint.endsWith("/actions/jobs/501")) {
        body = {
          ...job(501),
          status: faults.value === "job-completed" ? "completed" : "in_progress",
          name: "Trusted package assembly",
          check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
        };
      } else {
        assert.ok(endpoint.includes("/attempts/2/jobs?per_page=100&page="));
        const second = endpoint.endsWith("page=2");
        const selected = {
          ...job(faults.value === "duplicate" ? 1 : 501),
          head_sha: faults.value === "job-source" ? "b".repeat(40) : expected.controller_revision,
          status: "in_progress",
          name: "Trusted package assembly",
          check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${faults.value === "name-only" ? "778" : "777"}`,
        };
        body = {
          total_count: faults.value === "count" && second ? 102 : 101,
          jobs: second
            ? faults.value === "missing"
              ? []
              : [selected]
            : Array.from({ length: 100 }, (_, index) => job(index + 1)),
        };
      }
      return {
        status: 0,
        stdout: `HTTP/2.0 ${faults.value === "api-status" ? 503 : 200} Fixture\r\nContent-Type: application/json\r\n\r\n${faults.value === "api-json" ? "{malformed" : JSON.stringify(body)}`,
        stderr: "",
      };
    },
  };
  return { token, faults, readKeys, transport, counts: () => ({ requests, keyReads }) };
}

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
