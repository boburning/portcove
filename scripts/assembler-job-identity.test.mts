import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { performance } from "node:perf_hooks";
import {
  verifyAssemblerJobIdentity,
  jobIdentityRefusalCode,
  controllerToolBootstrapProfile,
  verifyControllerToolBootstrapJobIdentity,
  verifyHostedNativeJobIdentity,
  verifyHostedNativeAttestationIdentity,
  requireVerifiedHostedNativeJobIdentity,
  verifyClassificationWriterJobIdentity,
  verifyProductionClassificationWriterJobIdentity,
  verifyProductionClassificationObserverJobIdentity,
  verifyProtectionObserverJobIdentity,
  verifyPayloadSignerJobIdentity,
  verifyCapacityExecutorJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
  verifyReleaseInputReaderJobIdentity,
  verifyReleaseControlReaderJobIdentity,
  controllerOidcSubject,
  requestAssemblerToken,
} from "./assembler-job-identity.mts";

void test("OIDC token acquisition cannot start or return after its existing monotonic phase deadline", async (t) => {
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    clock = 2001;
    return new Response(JSON.stringify({ value: "inert-token" }));
  };
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-runner-bearer",
  };
  await assert.rejects(
    requestAssemblerToken("fixture-audience", env, fetcher, 999),
    /phase deadline/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    requestAssemblerToken("fixture-audience", env, fetcher, 2000),
    /phase deadline/,
  );
  assert.equal(calls, 1);
});
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  releaseControlPhaseProfile,
  isMaintenanceReleaseControlPhase,
  inspectReleaseControlPhase,
} from "./release-control-phases.mts";
import {
  expected,
  jwk,
  assemblerIdentityFixture as fixture,
} from "./fixtures/assembler-identity-fixture.mts";

void test("native parent identity getter requires original default issuer/provider binding and preserves expiry and wrong-source refusals", async (t) => {
  const platform = "linux-x86_64";
  const wanted = {
    ...expected,
    run_attempt: 1,
    audience: "portcove-hosted-native-linux-v1",
    subject: controllerOidcSubject(expected.controller_ref, "production-native-linux"),
  };
  const good = fixture(
    { aud: wanted.audience, sub: wanted.subject, environment: "production-native-linux" },
    {},
    {
      workflow: productionControllerWorkflow,
      job: "Qualify hosted Linux installed continuity",
      runAttempt: 1,
    },
  );
  const injected = await verifyHostedNativeJobIdentity(platform, good.token, wanted, good);
  assert.throws(
    () => requireVerifiedHostedNativeJobIdentity(injected, platform, wanted),
    /original unexpired/,
  );
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
  t.mock.method(
    childProcess,
    "spawnSync",
    (
      command: string,
      args: readonly string[],
      options: Parameters<typeof good.transport.spawn>[2],
    ) => good.transport.spawn(command, args, options) as ReturnType<typeof childProcess.spawnSync>,
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const actual = await verifyHostedNativeJobIdentity(platform, good.token, wanted, {
    transport: { cwd: process.cwd(), deadline: performance.now() + 10000 },
  });
  requireVerifiedHostedNativeJobIdentity(actual, platform, wanted);
  assert.equal(actual.authority, "none");
  assert.equal(actual.native_acceptance, "not-established");
  for (const copy of [{ ...actual }, JSON.parse(JSON.stringify(actual)) as unknown])
    assert.throws(() => requireVerifiedHostedNativeJobIdentity(copy, platform, wanted));
  assert.throws(() => requireVerifiedHostedNativeJobIdentity(actual, "windows-x86_64", wanted));
  assert.throws(() =>
    requireVerifiedHostedNativeJobIdentity(actual, platform, { ...wanted, run_id: "9989" }),
  );
  for (const now of [NaN, Infinity, -1, Date.parse(actual.expires_at)])
    assert.throws(() => requireVerifiedHostedNativeJobIdentity(actual, platform, wanted, now));
  actual.job_id = 502;
  assert.throws(() => requireVerifiedHostedNativeJobIdentity(actual, platform, wanted));
});

void test("hosted native identity binds the fixed platform parent without granting native acceptance", async () => {
  for (const [platform, job, environment, audience] of [
    [
      "windows-x86_64",
      "Qualify hosted Windows installed continuity",
      "production-native-windows",
      "portcove-hosted-native-windows-v1",
    ],
    [
      "linux-x86_64",
      "Qualify hosted Linux installed continuity",
      "production-native-linux",
      "portcove-hosted-native-linux-v1",
    ],
  ] as const) {
    const wanted = {
      ...expected,
      audience,
      subject: controllerOidcSubject(expected.controller_ref, environment),
    };
    const claims = { aud: audience, sub: wanted.subject, environment };
    const location = { workflow: productionControllerWorkflow, job };
    const good = fixture(claims, {}, location);
    const actual = await verifyHostedNativeJobIdentity(platform, good.token, wanted, good);
    assert.equal(actual.job_id, 501);
    assert.equal(actual.check_run_id, "777");
    assert.equal(actual.platform_label, platform);
    assert.equal(actual.evidence_scope, "injected-provider");
    assert.equal(actual.native_acceptance, "not-established");
    assert.equal(actual.candidate_isolation, "unproven");
    assert.equal(actual.installed_continuity, "unproven");
    assert.equal(actual.authority, "none");
    for (const patch of [
      { environment: undefined },
      { sha: "f".repeat(40) },
      { run_attempt: "3" },
      { runner_environment: "self-hosted" },
      {
        workflow_ref: `boburning/portcove/.github/workflows/hosted-native-continuity.yml@${expected.controller_ref}`,
      },
    ]) {
      const bad = fixture({ ...claims, ...patch }, {}, location);
      await assert.rejects(verifyHostedNativeJobIdentity(platform, bad.token, wanted, bad));
      assert.equal(bad.counts().requests, 0);
    }
    const wrongJob = fixture(claims, {}, { ...location, job: "Trusted package assembly" });
    await assert.rejects(
      verifyHostedNativeJobIdentity(platform, wrongJob.token, wanted, wrongJob),
      /trusted assembly job/,
    );
    const other = platform === "windows-x86_64" ? "linux-x86_64" : "windows-x86_64";
    await assert.rejects(
      verifyHostedNativeJobIdentity(other, good.token, wanted, good),
      /audience\/environment/,
    );
    const selectedAudience = fixture({ ...claims, aud: "candidate-selected" }, {}, location);
    await assert.rejects(
      verifyHostedNativeJobIdentity(
        platform,
        selectedAudience.token,
        { ...wanted, audience: "candidate-selected" },
        selectedAudience,
      ),
      /audience\/environment/,
    );
    assert.equal(selectedAudience.counts().keyReads, 0);
  }
});

void test("native attestation audience authenticates only its fixed job and cannot become a native-parent identity", async () => {
  const platform = "linux-x86_64";
  const wanted = {
    ...expected,
    audience: "sigstore",
    subject: controllerOidcSubject(expected.controller_ref, "production-native-linux"),
  };
  const claims = { aud: "sigstore", sub: wanted.subject, environment: "production-native-linux" };
  const location = {
    workflow: productionControllerWorkflow,
    job: "Qualify hosted Linux installed continuity",
  };
  const good = fixture(claims, {}, location);
  const identity = await verifyHostedNativeAttestationIdentity(platform, good.token, wanted, good);
  assert.equal(identity.job_id, 501);
  assert.equal(identity.authority, "none");
  assert.throws(() => requireVerifiedHostedNativeJobIdentity(identity, platform, wanted));
  await assert.rejects(verifyHostedNativeJobIdentity(platform, good.token, wanted, good));
  for (const patch of [
    { environment: "production-native-windows" },
    { sha: "f".repeat(40) },
    { run_attempt: "3" },
    { runner_environment: "self-hosted" },
  ]) {
    const bad = fixture({ ...claims, ...patch }, {}, location);
    await assert.rejects(verifyHostedNativeAttestationIdentity(platform, bad.token, wanted, bad));
  }
  const wrongJob = fixture(claims, {}, { ...location, job: "Trusted package assembly" });
  await assert.rejects(
    verifyHostedNativeAttestationIdentity(platform, wrongJob.token, wanted, wrongJob),
  );
  await assert.rejects(
    verifyHostedNativeAttestationIdentity("windows-x86_64", good.token, wanted, good),
  );
  await assert.rejects(
    verifyHostedNativeAttestationIdentity(
      platform,
      good.token,
      { ...wanted, audience: "candidate-selected" },
      good,
    ),
  );
});

void test("complete admission binds its protected environment while original read-only reader remains tag bound", async () => {
  const profile = releaseControlPhaseProfile("admission");
  assert.equal(profile.reader_environment, "production-release-admission");
  const wanted = {
    ...expected,
    audience: profile.reader_audience,
    subject: controllerOidcSubject(expected.controller_ref, profile.reader_environment),
  };
  const claims = {
    aud: wanted.audience,
    sub: wanted.subject,
    environment: profile.reader_environment,
  };
  const location = { workflow: productionControllerWorkflow, job: profile.reader_name };
  const good = fixture(claims, {}, location);
  assert.equal(
    (await verifyReleaseControlReaderJobIdentity("admission", good.token, wanted, good)).job_id,
    501,
  );
  for (const override of [
    { environment: undefined },
    { environment: "production-payload-signing" },
    { sub: controllerOidcSubject(expected.controller_ref) },
  ]) {
    const bad = fixture({ ...claims, ...override }, {}, location);
    await assert.rejects(
      verifyReleaseControlReaderJobIdentity("admission", bad.token, wanted, bad),
    );
    assert.equal(bad.counts().requests, 0);
  }
  const legacyExpected = { ...expected, audience: profile.reader_audience };
  const legacy = fixture({ aud: legacyExpected.audience }, {}, location);
  assert.equal(
    (await verifyReleaseInputReaderJobIdentity(legacy.token, legacyExpected, legacy)).job_id,
    501,
  );
  const cross = fixture(claims, {}, location);
  await assert.rejects(verifyReleaseInputReaderJobIdentity(cross.token, wanted, cross));
});

void test("fixed role phase deadline caps each provider boundary and refuses expiry without another request", async (t) => {
  const f = fixture();
  await assert.rejects(
    verifyAssemblerJobIdentity(f.token, expected, {
      ...f,
      transport: { ...f.transport, deadline: performance.now() - 1 },
    }),
    /phase deadline/,
  );
  assert.equal(f.counts().keyReads, 0);
  assert.equal(f.counts().requests, 0);
  const deadline = performance.now() + 1000;
  const timeouts: number[] = [];
  const transport = {
    ...f.transport,
    deadline,
    spawn: (...args: Parameters<typeof f.transport.spawn>) => {
      const timeout = args[2]?.timeout;
      assert.equal(typeof timeout, "number");
      timeouts.push(Number(timeout));
      return f.transport.spawn(args[0], args[1], { ...args[2], timeout: 15000 });
    },
  };
  const result = await verifyAssemblerJobIdentity(f.token, expected, { ...f, transport });
  assert.equal(result.evidence_scope, "injected-provider");
  assert.ok(timeouts.length > 1 && timeouts.every((timeout) => timeout > 0 && timeout <= 1000));
  const late = fixture();
  let clock = Math.floor(performance.now());
  t.mock.method(performance, "now", () => clock);
  await assert.rejects(
    verifyAssemblerJobIdentity(late.token, expected, {
      transport: { ...late.transport, deadline: clock + 1000 },
      readKeys: async () => {
        const result = await late.readKeys();
        clock += 1001;
        return result;
      },
    }),
    /phase deadline/,
  );
  assert.equal(late.counts().requests, 0);
  const lateApi = fixture();
  await assert.rejects(
    verifyAssemblerJobIdentity(lateApi.token, expected, {
      readKeys: lateApi.readKeys,
      transport: {
        cwd: lateApi.transport.cwd,
        deadline: clock + 1000,
        spawn: (command, args, settings) => {
          assert.ok(Number(settings.timeout) <= 1000);
          const result = lateApi.transport.spawn(command, args, { ...settings, timeout: 15000 });
          clock += 1001;
          return result;
        },
      },
    }),
    /phase deadline/,
  );
  assert.equal(lateApi.counts().requests, 1);
});
void test("capacity executor roles require their exact signed job, not another trusted role or matching name", async () => {
  for (const [role, name, environment] of [
    ["coordinator", "Coordinate application release", "production-release-coordinator"],
    [
      "release-publication",
      "Publish immutable application release",
      "production-release-publication",
    ],
    ["site-publication", "Publish authenticated application site", "github-pages"],
    ["payload-signing", "Sign admitted updater payloads", "production-payload-signing"],
    ["tuf-releases", "Sign authenticated Releases metadata", "production-tuf-releases"],
    ["tuf-preview", "Sign authenticated Preview metadata", "production-tuf-preview"],
    ["tuf-stable", "Sign authenticated Stable metadata", "production-tuf-stable"],
    ["tuf-snapshot", "Sign authenticated Snapshot metadata", "production-tuf-snapshot"],
    ["tuf-timestamp", "Sign authenticated Timestamp metadata", "production-tuf-timestamp"],
  ] as const) {
    const subject = controllerOidcSubject(expected.controller_ref, environment);
    const binding = { ...expected, subject };
    const f = fixture(
      { sub: subject, ...(environment ? { environment } : {}) },
      {},
      { workflow: productionControllerWorkflow, job: name },
    );
    const actual = await verifyCapacityExecutorJobIdentity(role, f.token, binding, f);
    assert.equal(actual.role, role);
    assert.equal(actual.job_id, 501);
    assert.equal(actual.evidence_scope, "injected-provider");
    const otherEnvironment = fixture(
      {
        sub: controllerOidcSubject(
          expected.controller_ref,
          "production-release-protection-observer",
        ),
        environment: "production-release-protection-observer",
      },
      {},
      { workflow: productionControllerWorkflow, job: name },
    );
    await assert.rejects(
      verifyCapacityExecutorJobIdentity(role, otherEnvironment.token, binding, otherEnvironment),
    );
    const wrong = fixture();
    await assert.rejects(verifyCapacityExecutorJobIdentity(role, wrong.token, binding, wrong));
    if (environment) {
      const unprotected = fixture(
        { sub: expected.subject },
        {},
        { workflow: productionControllerWorkflow, job: name },
      );
      await assert.rejects(
        verifyCapacityExecutorJobIdentity(role, unprotected.token, binding, unprotected),
      );
    }
    f.faults.value = "name-only";
    await assert.rejects(verifyCapacityExecutorJobIdentity(role, f.token, binding, f));
  }
});
void test("payload signer role requires its own signed check-run and fixed job profile", async () => {
  const wanted = {
    ...expected,
    subject: controllerOidcSubject(expected.controller_ref, "production-payload-signing"),
  };
  const claims = { sub: wanted.subject, environment: "production-payload-signing" };
  const f = fixture(
    claims,
    {},
    { workflow: productionControllerWorkflow, job: "Sign admitted updater payloads" },
  );
  const result = await verifyPayloadSignerJobIdentity(f.token, wanted, f);
  assert.equal(result.job_id, 501);
  assert.equal(result.check_run_id, "777");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  const assembler = fixture();
  await assert.rejects(verifyPayloadSignerJobIdentity(assembler.token, wanted, assembler));
  const nameOnly = fixture(
    claims,
    {},
    { workflow: productionControllerWorkflow, job: "Sign admitted updater payloads" },
  );
  nameOnly.faults.value = "name-only";
  await assert.rejects(verifyPayloadSignerJobIdentity(nameOnly.token, wanted, nameOnly));
  for (const change of [
    { environment: "production-tuf-releases" },
    { sub: expected.subject },
    { environment: undefined },
  ]) {
    const wrong = fixture(
      { ...claims, ...change },
      {},
      { workflow: productionControllerWorkflow, job: "Sign admitted updater payloads" },
    );
    await assert.rejects(verifyPayloadSignerJobIdentity(wrong.token, wanted, wrong));
  }
});

void test("coordinator controls require their exact isolated job, subject and environment", async () => {
  const profile = releaseControlPhaseProfile("coordinator");
  const wanted = {
    ...expected,
    audience: profile.reader_audience,
    subject: controllerOidcSubject(expected.controller_ref, profile.reader_environment),
  };
  const claims = {
    aud: wanted.audience,
    sub: wanted.subject,
    environment: profile.reader_environment,
  };
  const producer = { workflow: productionControllerWorkflow, job: profile.reader_name };
  const positive = fixture(claims, {}, producer);
  assert.equal(
    (await verifyReleaseControlReaderJobIdentity("coordinator", positive.token, wanted, positive))
      .job_id,
    501,
  );
  for (const change of [
    { environment: "github-pages" },
    { sub: expected.subject },
    { environment: undefined },
  ]) {
    const wrong = fixture({ ...claims, ...change }, {}, producer);
    await assert.rejects(
      verifyReleaseControlReaderJobIdentity("coordinator", wrong.token, wanted, wrong),
    );
  }
  assert.equal(isMaintenanceReleaseControlPhase("coordinator"), true);
});

void test("Release publication reader requires its own protected environment and refuses tag-only or another role", async () => {
  const profile = releaseControlPhaseProfile("release-publication");
  const wanted = {
    ...expected,
    audience: profile.reader_audience,
    subject: controllerOidcSubject(expected.controller_ref, profile.reader_environment),
  };
  const claims = {
    aud: wanted.audience,
    sub: wanted.subject,
    environment: profile.reader_environment,
  };
  const job = { workflow: productionControllerWorkflow, job: profile.reader_name };
  const actual = fixture(claims, {}, job);
  assert.equal(
    (
      await verifyReleaseControlReaderJobIdentity(
        "release-publication",
        actual.token,
        wanted,
        actual,
      )
    ).job_id,
    501,
  );
  for (const change of [
    { environment: "production-payload-signing" },
    { sub: expected.subject },
    { environment: undefined },
  ]) {
    const wrong = fixture({ ...claims, ...change }, {}, job);
    await assert.rejects(
      verifyReleaseControlReaderJobIdentity("release-publication", wrong.token, wanted, wrong),
    );
  }
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
      environment: "production-release-classification" as const,
    },
    {
      verify: verifyProtectionObserverJobIdentity,
      job: "Observe release input protections",
      environment: "production-release-protection-observer" as const,
    },
  ];
  for (const role of roles) {
    const roleExpected = {
      ...expected,
      subject: controllerOidcSubject(expected.controller_ref, role.environment),
    };
    const claims = { sub: roleExpected.subject, environment: role.environment };
    const f = fixture(claims, {}, { workflow, job: role.job });
    assert.equal((await role.verify(f.token, roleExpected, f)).workflow, workflow);
    await assert.rejects(verifyAssemblerJobIdentity(f.token, expected, f));
    const other = roles.find((value) => value !== role)!;
    await assert.rejects(other.verify(f.token, expected, f));
    const wrongWorkflow = fixture(
      claims,
      {},
      { workflow: ".github/workflows/other.yml", job: role.job },
    );
    await assert.rejects(role.verify(wrongWorkflow.token, roleExpected, wrongWorkflow));
  }
});

void test("production observer and reader profiles cannot reuse each other's job or the separate review workflow", async () => {
  const workflow = ".github/workflows/application-update-production.yml";
  const observerExpected = {
    ...expected,
    subject: controllerOidcSubject(
      expected.controller_ref,
      "production-release-protection-observer",
    ),
  };
  const observer = fixture(
    { sub: observerExpected.subject, environment: "production-release-protection-observer" },
    {},
    { workflow, job: "Observe production release input protections" },
  );
  const reader = fixture({}, {}, { workflow, job: "Authenticate release control inputs" });
  assert.equal(
    (
      await verifyProductionProtectionObserverJobIdentity(
        observer.token,
        observerExpected,
        observer,
      )
    ).job_id,
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

void test("direct workflow identity accepts only a complete exact mirror of executing claims", async () => {
  const mirror = {
    job_workflow_ref: `boburning/portcove/${productionControllerWorkflow}@${expected.controller_ref}`,
    job_workflow_sha: expected.controller_revision,
  };
  const direct = fixture(mirror);
  assert.equal((await verifyAssemblerJobIdentity(direct.token, expected, direct)).job_id, 501);
  for (const patch of [
    { job_workflow_ref: mirror.job_workflow_ref },
    { job_workflow_sha: mirror.job_workflow_sha },
    { ...mirror, job_workflow_ref: mirror.job_workflow_ref + "-other" },
    { ...mirror, job_workflow_sha: "b".repeat(40) },
    { ...mirror, job_workflow_sha: null },
  ]) {
    const other = fixture(patch);
    await assert.rejects(verifyAssemblerJobIdentity(other.token, expected, other), (error) => {
      assert.equal(jobIdentityRefusalCode(error), "claim-reusable-workflow");
      return true;
    });
    assert.equal(other.counts().requests, 0);
  }
});

void test("signed identity refusals expose only verifier-selected codes", async () => {
  for (const [patch, code] of [
    [{ sub: "private wrong subject" }, "claim-sub"],
    [{ check_run_id: 501 }, "claim-check_run_id"],
    [{ job_workflow_ref: "private reusable workflow" }, "claim-reusable-workflow"],
  ] as const) {
    const bad = fixture(patch);
    await assert.rejects(verifyAssemblerJobIdentity(bad.token, expected, bad), (error) => {
      assert.equal(jobIdentityRefusalCode(error), code);
      return true;
    });
    assert.equal(bad.counts().requests, 0);
  }
  assert.equal(
    jobIdentityRefusalCode(Object.assign(new Error("private"), { code: "claim-sub" })),
    undefined,
  );
});

void test("immutable owner/repository subjects and exact environment profiles refuse legacy and cross-role claims", async () => {
  const workflow = productionControllerWorkflow;
  const profile = { workflow, job: "Publish authenticated application site" };
  const siteExpected = {
    ...expected,
    subject: controllerOidcSubject(expected.controller_ref, "github-pages"),
  };
  const claims = { sub: siteExpected.subject, environment: "github-pages" };
  const positive = fixture(claims, {}, profile);
  assert.equal(
    (
      await verifyReleaseControlReaderJobIdentity(
        "site-publication",
        positive.token,
        siteExpected,
        positive,
      )
    ).job_id,
    501,
  );
  for (const patch of [
    { sub: `repo:boburning/portcove:environment:github-pages` },
    { sub: siteExpected.subject.replace("@43177418/", "@43177419/") },
    { sub: siteExpected.subject.replace("@1354613114:", "@1354613115:") },
    { sub: expected.subject },
    { environment: undefined },
    { environment: "production-release-protection-observer" },
    { repository_owner_id: "43177419" },
  ]) {
    const bad = fixture({ ...claims, ...patch }, {}, profile);
    await assert.rejects(
      verifyReleaseControlReaderJobIdentity("site-publication", bad.token, siteExpected, bad),
    );
    assert.equal(bad.counts().requests, 0);
  }
  const tagWithEnvironment = fixture({ environment: "github-pages" });
  await assert.rejects(
    verifyAssemblerJobIdentity(tagWithEnvironment.token, expected, tagWithEnvironment),
  );
  assert.equal(tagWithEnvironment.counts().requests, 0);
  const legacySubject = `repo:boburning/portcove:ref:${expected.controller_ref}`;
  const legacy = fixture({ sub: legacySubject });
  await assert.rejects(
    verifyAssemblerJobIdentity(legacy.token, { ...expected, subject: legacySubject }, legacy),
  );
  assert.equal(legacy.counts().keyReads, 0);
  await assert.rejects(
    verifyReleaseControlReaderJobIdentity("site-publication", positive.token, expected, positive),
  );
});

void test("five TUF roles bind separate fixed environment/job identities and one protected metadata observer", async () => {
  for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
    const phase = `tuf-${role}` as const;
    const profile = releaseControlPhaseProfile(phase);
    assert.equal(profile.reader_job, `tuf_${role}`);
    assert.equal(profile.reader_environment, `production-tuf-${role}`);
    assert.equal(profile.observer_job, "metadata_protection_observation");
    assert.equal(isMaintenanceReleaseControlPhase(phase), true);
    const wanted = {
      ...expected,
      audience: profile.reader_audience,
      subject: controllerOidcSubject(expected.controller_ref, profile.reader_environment),
    };
    const claims = {
      aud: wanted.audience,
      sub: wanted.subject,
      environment: profile.reader_environment,
    };
    const f = fixture(
      claims,
      {},
      { workflow: productionControllerWorkflow, job: profile.reader_name },
    );
    assert.equal(
      (await verifyReleaseControlReaderJobIdentity(phase, f.token, wanted, f)).job_id,
      501,
    );
    for (const patch of [
      { environment: undefined },
      { environment: "github-pages" },
      { sub: expected.subject },
      { sub: wanted.subject.replace("@43177418/", "@1/") },
    ]) {
      const bad = fixture(
        { ...claims, ...patch },
        {},
        { workflow: productionControllerWorkflow, job: profile.reader_name },
      );
      await assert.rejects(verifyReleaseControlReaderJobIdentity(phase, bad.token, wanted, bad));
      assert.equal(bad.counts().requests, 0);
    }
    const other = releaseControlPhaseProfile(role === "releases" ? "tuf-preview" : "tuf-releases");
    const crossJob = fixture(
      claims,
      {},
      { workflow: productionControllerWorkflow, job: other.reader_name },
    );
    await assert.rejects(
      verifyReleaseControlReaderJobIdentity(phase, crossJob.token, wanted, crossJob),
    );
    const observerExpected = {
      ...wanted,
      audience: profile.observer_audience,
      subject: controllerOidcSubject(expected.controller_ref, profile.observer_environment),
    };
    const observer = fixture(
      {
        aud: observerExpected.audience,
        sub: observerExpected.subject,
        environment: profile.observer_environment,
      },
      {},
      { workflow: productionControllerWorkflow, job: profile.observer_name },
    );
    assert.equal(
      (
        await verifyProductionProtectionObserverJobIdentity(
          observer.token,
          observerExpected,
          observer,
          phase,
        )
      ).job_id,
      501,
    );
  }
  assert.equal(isMaintenanceReleaseControlPhase("site-publication"), true);
  for (const phase of [
    "admission",
    "payload",
    "release-publication",
    "tuf-root",
    "tuf-targets",
    "tuf-unknown",
    null,
  ])
    assert.equal(isMaintenanceReleaseControlPhase(phase), false);
  assert.throws(() => inspectReleaseControlPhase("tuf-root"));
});

void test("complete controller D1 jobs authenticate distinct environments and actual signed source", async () => {
  for (const [verify, name, environment, audience] of [
    [
      verifyProductionClassificationWriterJobIdentity,
      "Persist independently reviewed classification",
      "production-release-classification",
      "portcove-release-classification-v1",
    ],
    [
      verifyProductionClassificationObserverJobIdentity,
      "Observe release input protections",
      "production-release-protection-observer",
      "portcove-release-classification-protection-v1",
    ],
  ] as const) {
    const wanted = {
      ...expected,
      audience,
      subject: controllerOidcSubject(expected.controller_ref, environment),
    };
    const claims = { aud: audience, sub: wanted.subject, environment };
    const location = { workflow: productionControllerWorkflow, job: name };
    const good = fixture(claims, {}, location);
    assert.equal((await verify(good.token, wanted, good)).job_id, 501);
    for (const bad of [
      fixture({ ...claims, environment: "production-payload-signing" }, {}, location),
      fixture(
        claims,
        {},
        { ...location, workflow: ".github/workflows/release-reviewed-inputs.yml" },
      ),
      fixture({ ...claims, iss: "https://wrong.example" }, {}, location),
    ])
      await assert.rejects(verify(bad.token, wanted, bad));
  }
});

void test("classification signed identity cannot outlive its original job deadline", async () => {
  const environment = "production-release-classification";
  const wanted = {
    ...expected,
    audience: "portcove-release-classification-v1",
    subject: controllerOidcSubject(expected.controller_ref, environment),
  };
  const good = fixture(
    { aud: wanted.audience, sub: wanted.subject, environment },
    {},
    {
      workflow: productionControllerWorkflow,
      job: "Persist independently reviewed classification",
    },
  );
  await assert.rejects(
    verifyProductionClassificationWriterJobIdentity(good.token, wanted, {
      ...good,
      transport: { ...good.transport, deadline: performance.now() - 1 },
    }),
    /deadline/,
  );
  assert.equal(good.counts().requests, 0);
});

void test("fixed identity provider receives only the reader token when the worker holds a storage token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-identity-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({
    GH_TOKEN: "inert-reader",
    PORTCOVE_STORAGE_APP_TOKEN: "inert-storage-writer",
  })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
  const f = fixture();
  const transport = {
    ...f.transport,
    spawn: (...args: Parameters<typeof f.transport.spawn>) => {
      assert.equal(args[2]?.env?.GH_TOKEN, "inert-reader");
      assert.equal(args[2]?.env?.PORTCOVE_STORAGE_APP_TOKEN, undefined);
      return f.transport.spawn(...args);
    },
  };
  const result = await withReadOnlyReleaseChildren(root, () =>
    verifyAssemblerJobIdentity(f.token, expected, { ...f, transport }),
  );
  assert.equal(result.job_id, 501);
  assert.ok(f.counts().requests > 0);
});

void test("fixed Windows runtime verifiers use the configured SDK and preserve original job custody", async (t) => {
  const token = "inert-windows-runtime-reader";
  let routes: string[] = [];
  let activeFixture: ReturnType<typeof fixture>;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.origin === "https://token.actions.githubusercontent.com") {
      assert.equal(url.pathname, "/.well-known/jwks");
      assert.equal(headers.has("authorization"), false);
      routes.push("jwks");
      return Response.json({ keys: [jwk] });
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.redirect, "manual");
    assert.equal(headers.get("authorization"), `token ${token}`);
    const page = url.searchParams.get("page");
    if (page) assert.equal(url.searchParams.get("per_page"), "100");
    const route = page ? `${url.pathname}?per_page=100&page=${page}` : url.pathname;
    routes.push(route);
    return Response.json(activeFixture.metadata(route));
  });
  for (const role of ["bootstrap", "native"] as const) {
    const native = role === "native";
    const profile = native
      ? {
          audience: "portcove-hosted-native-windows-v1",
          job: "Qualify hosted Windows installed continuity",
        }
      : controllerToolBootstrapProfile("windows-x86_64");
    const environment = native ? "production-native-windows" : undefined;
    const wanted = {
      ...expected,
      run_attempt: 1,
      audience: profile.audience,
      subject: controllerOidcSubject(expected.controller_ref, environment),
    };
    activeFixture = fixture(
      {
        aud: wanted.audience,
        sub: wanted.subject,
        ...(environment ? { environment } : {}),
      },
      {},
      {
        workflow: productionControllerWorkflow,
        job: profile.job,
        runAttempt: 1,
        ...(!native ? { labels: ["windows-2022"] } : {}),
      },
    );
    routes = [];
    const transport = { sdkToken: token, deadline: performance.now() + 10000 };
    const actual = native
      ? await verifyHostedNativeJobIdentity("windows-x86_64", activeFixture.token, wanted, {
          transport,
        })
      : await verifyControllerToolBootstrapJobIdentity(
          activeFixture.token,
          wanted,
          { transport },
          "windows-x86_64",
        );
    assert.equal(actual.evidence_scope, "github.com");
    assert.equal(actual.authority, "none");
    assert.equal(actual.job_id, 501);
    assert.equal(actual.check_run_id, "777");
    assert.equal(actual.api_requests, 5);
    const run = "/repos/boburning/portcove/actions/runs/9988";
    assert.deepEqual(routes, [
      "jwks",
      run,
      `${run}/attempts/1/jobs?per_page=100&page=1`,
      `${run}/attempts/1/jobs?per_page=100&page=2`,
      "/repos/boburning/portcove/actions/jobs/501",
      run,
    ]);
  }
});

void test("async identity operations refuse incomplete pages, contradictory Check identity and changed readback", async () => {
  const profile = controllerToolBootstrapProfile("windows-x86_64");
  const wanted = { ...expected, run_attempt: 1, audience: profile.audience };
  for (const fault of ["", "missing", "count", "name-only", "job-completed", "drift"]) {
    const f = fixture(
      { aud: wanted.audience },
      {},
      {
        workflow: productionControllerWorkflow,
        job: profile.job,
        runAttempt: 1,
        labels: ["windows-2022"],
      },
    );
    f.faults.value = fault;
    const deadline = performance.now() + 10000;
    const pending = verifyControllerToolBootstrapJobIdentity(
      f.token,
      wanted,
      {
        readKeys: f.readKeys,
        transport: {
          sdkToken: "inert-windows-runtime-reader",
          deadline,
          async read(route, bound) {
            assert.equal(bound, deadline);
            return f.metadata(route);
          },
        },
      },
      "windows-x86_64",
    );
    if (fault) await assert.rejects(pending);
    else {
      const result = await pending;
      assert.equal(result.evidence_scope, "injected-provider");
      assert.equal(result.api_requests, 5);
    }
  }
});

void test("Windows SDK collection cancels a stalled body at issuer expiry", async (t) => {
  const profile = controllerToolBootstrapProfile("windows-x86_64");
  const wanted = { ...expected, run_attempt: 1, audience: profile.audience };
  const now = Math.floor(Date.now() / 1000);
  t.mock.method(Date, "now", () => now * 1000);
  const f = fixture(
    { aud: wanted.audience, exp: now + 1 },
    {},
    {
      workflow: productionControllerWorkflow,
      job: profile.job,
      runAttempt: 1,
      labels: ["windows-2022"],
    },
  );
  let dispatched = 0;
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    dispatched++;
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
  });
  const keepAlive = setTimeout(() => {}, 1500);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(
    verifyControllerToolBootstrapJobIdentity(
      f.token,
      wanted,
      {
        readKeys: f.readKeys,
        transport: {
          sdkToken: "inert-windows-runtime-reader",
          deadline: performance.now() + 10000,
        },
      },
      "windows-x86_64",
    ),
  );
  assert.equal(dispatched, 1);
  assert.equal(cancelled, true);
  await assert.rejects(
    verifyControllerToolBootstrapJobIdentity(
      f.token,
      wanted,
      {
        readKeys: f.readKeys,
        transport: { sdkToken: "", deadline: performance.now() + 10000 },
      },
      "windows-x86_64",
    ),
  );
  assert.equal(dispatched, 1);
});

void test("aggregate queue status cannot substitute for the signed exact active job", async () => {
  const profile = releaseControlPhaseProfile("coordinator");
  const wanted = {
    ...expected,
    run_attempt: 1,
    audience: profile.reader_audience,
    subject: controllerOidcSubject(expected.controller_ref, profile.reader_environment),
  };
  const cases = [
    { before: "queued", after: "queued" },
    { before: "queued", after: "in_progress" },
    { before: "in_progress", after: "queued" },
    {
      before: "queued",
      after: "queued",
      jobFault: "job-completed",
      refusal: /selected assembler job changed/,
    },
    {
      before: "queued",
      after: "queued",
      jobFault: "name-only",
      refusal: /does not identify one active/,
    },
    {
      before: "queued",
      after: "queued",
      jobFault: "job-inventory-terminal",
      refusal: /does not identify one active/,
    },
    {
      before: "queued",
      after: "queued",
      jobFault: "job-reread-terminal",
      refusal: /selected assembler job changed/,
    },
    { before: "queued", after: "completed", refusal: /attempt is not active/ },
    { before: "waiting", after: "in_progress", refusal: /attempt is not active/ },
    {
      before: "queued",
      after: "queued",
      conclusion: "cancelled",
      refusal: /attempt is not active/,
    },
    { before: "queued", after: "queued", jobFault: "drift", refusal: /run identity differs/ },
  ];
  for (const scenario of cases) {
    const f = fixture(
      { aud: wanted.audience, sub: wanted.subject, environment: profile.reader_environment },
      {},
      { workflow: productionControllerWorkflow, job: profile.reader_name, runAttempt: 1 },
    );
    f.faults.value = scenario.jobFault ?? "";
    let parentReads = 0;
    const result = verifyReleaseControlReaderJobIdentity("coordinator", f.token, wanted, {
      readKeys: f.readKeys,
      transport: {
        sdkToken: "inert-coordinator-reader",
        deadline: performance.now() + 10000,
        async read(route) {
          const response = f.metadata(route);
          if (!route.endsWith("/actions/runs/9988")) return response;
          return {
            ...(response as object),
            status: parentReads++ === 0 ? scenario.before : scenario.after,
            conclusion: scenario.conclusion ?? null,
          };
        },
      },
    });
    if (scenario.refusal) await assert.rejects(result, scenario.refusal);
    else {
      const verified = await result;
      assert.equal(verified.job_id, 501);
      assert.equal(verified.api_requests, 5);
      assert.equal(verified.authority, "none");
      assert.equal(parentReads, 2);
    }
  }
});
