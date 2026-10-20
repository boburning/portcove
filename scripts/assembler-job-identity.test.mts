import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  verifyAssemblerJobIdentity,
  verifyClassificationWriterJobIdentity,
  verifyProtectionObserverJobIdentity,
  verifyPayloadSignerJobIdentity,
  verifyCapacityExecutorJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
  verifyReleaseInputReaderJobIdentity,
  verifyReleaseControlReaderJobIdentity,
  controllerOidcSubject,
} from "./assembler-job-identity.mts";
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
