import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  checkpointProofFixture,
  releaseCustodyFetch,
  fixedJobJournalAuthoritiesFixture,
} from "./fixtures/checkpoint-proof-fixture.mts";
import {
  verifyHistoricalCheckpointJob,
  verifyHistoricalHostedNativeJob,
  verifyHostedNativePhaseJob,
} from "./release-checkpoint-job-identity.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";
import {
  authenticateCoordinatorCheckpointEvidence,
  requireAuthenticatedCheckpointEvidence,
  authenticateFixedJobCoordinatorHistory,
} from "./release-coordinator-checkpoint-authentication.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { inspectCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import type { HistoricalJobProvider } from "./release-custody-provider.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { createHash } from "node:crypto";
import { createCheckpointHistoryReader } from "./release-coordinator-journal-api.mts";
import { isRecord } from "./runtime-values.mts";

async function root(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-authentication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function historical(f: ReturnType<typeof checkpointProofFixture>) {
  return { ...f.producer, job_id: Number(f.producer.job_id) };
}
const witnessed = Date.parse("2026-10-23T12:00:30.123Z");

void test("actual historical SDK refuses incomplete metadata in one attempt with the explicit reader credential", async (t) => {
  const f = checkpointProofFixture();
  const now = performance.now.bind(performance);
  let shift = 0;
  t.mock.method(performance, "now", () => now() + shift);
  for (const fault of ["non-200", "transient", "stream", "redirect", "late"] as const) {
    let sends = 0;
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      releaseCustodyFetch(f.provider, (_url, init) => {
        sends++;
        assert.equal(new Headers(init?.headers).get("authorization"), "token inert-checkpoint-sdk");
        assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
        assert.equal(init?.redirect, "manual");
        if (fault === "non-200") return Response.json(f.attempt, { status: 201 });
        if (fault === "transient")
          return Response.json({ message: "unavailable" }, { status: 503 });
        if (fault === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("incomplete body"));
              },
            }),
          );
        if (fault === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid" },
          });
        shift = 60001;
        return Response.json(f.attempt);
      }),
    );
    try {
      await assert.rejects(
        verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
          deadline: performance.now() + 60000,
          token: "inert-checkpoint-sdk",
        }),
      );
      assert.equal(sends, 1);
    } finally {
      shift = 0;
      fetch.mock.restore();
    }
  }
});

for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
  for (const state of ["live", "success", "failure", "contradictory", "future"] as const) {
    void test(`${platform} signed-stage custody is separate from terminal native history: ${state}`, async () => {
      const f = checkpointProofFixture();
      Object.assign(f.job, {
        name: hostedNativeJobProfile(platform).job,
        status: state === "success" || state === "failure" ? "completed" : "in_progress",
        conclusion:
          state === "failure"
            ? "failure"
            : state === "success" || state === "contradictory"
              ? "success"
              : null,
        completed_at: state === "success" || state === "failure" ? "2026-10-23T12:01:00Z" : null,
      });
      const observe = () =>
        verifyHostedNativePhaseJob(
          platform,
          historical(f),
          state === "future" ? Date.now() + 60000 : witnessed,
          {
            deadline: performance.now() + 60000,
            provider: f.provider,
          },
        );
      if (["failure", "contradictory", "future"].includes(state)) {
        await assert.rejects(observe, /native phase|timestamp/);
        return;
      }
      const first = await observe();
      const second = await observe();
      assert.deepEqual(first.witnessed_interval, {
        start: Date.parse(f.job.started_at),
        end: witnessed,
      });
      assert.deepEqual(first.witnessed_interval, second.witnessed_interval);
      assert.equal(first.custody_scope, "signed-stage-witness");
      assert.equal(first.journey_completion, "not-established");
      assert.equal(first.native_acceptance, "not-established");
      assert.equal(first.authority, "none");
      if (state === "live")
        await assert.rejects(
          () =>
            verifyHistoricalHostedNativeJob(platform, historical(f), witnessed, {
              deadline: performance.now() + 60000,
              provider: f.provider,
            }),
          /must complete successfully/,
        );
    });
  }
}

for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
  for (const attemptState of ["in_progress", "completed-success", "completed-failure"] as const) {
    void test(`historical ${platform} completed-job custody remains usable in ${attemptState} attempt without native acceptance`, async () => {
      const f = checkpointProofFixture();
      f.job.name = hostedNativeJobProfile(platform).job;
      f.job.conclusion = "success";
      const provider: HistoricalJobProvider = {
        ...f.provider,
        async attempt(run, selectedAttempt) {
          const result = await f.provider.attempt(run, selectedAttempt);
          assert.ok(isRecord(result));
          return {
            ...result,
            status: attemptState === "in_progress" ? "in_progress" : "completed",
            conclusion:
              attemptState === "completed-success"
                ? "success"
                : attemptState === "completed-failure"
                  ? "failure"
                  : null,
          };
        },
      };
      const result = await verifyHistoricalHostedNativeJob(platform, historical(f), witnessed, {
        deadline: performance.now() + 60000,
        provider,
      });
      assert.equal(result.requests, 4);
      assert.equal(result.platform_label, platform);
      assert.equal(result.required_environment, hostedNativeJobProfile(platform).environment);
      assert.equal(result.native_acceptance, "not-established");
      assert.equal(result.evidence_scope, "injected-provider");
      assert.equal(result.authority, "none");
      assert.equal(Object.hasOwn(result, "role"), false);
    });
  }
  for (const fault of [
    "failed-job",
    "running-job",
    "wrong-job",
    "wrong-check",
    "changed-job",
    "changed-attempt",
    "duplicate",
    "incomplete",
    "wrong-source",
    "wrong-actor",
  ] as const) {
    void test(`historical ${platform} native custody refuses ${fault}`, async () => {
      const f = checkpointProofFixture();
      f.job.name = hostedNativeJobProfile(platform).job;
      f.job.conclusion = fault === "failed-job" ? "failure" : "success";
      if (fault === "running-job") f.job.status = "in_progress";
      if (fault === "wrong-job") f.job.name = "Coordinate application release";
      if (fault === "wrong-check") f.job.check_run_url += "9";
      if (fault === "wrong-source") f.attempt.head_sha = "9".repeat(40);
      if (fault === "wrong-actor") f.attempt.actor.id = 99;
      f.faults.value = fault;
      const provider: HistoricalJobProvider = {
        ...f.provider,
        async attempt(run, selectedAttempt) {
          const result = await f.provider.attempt(run, selectedAttempt);
          assert.ok(isRecord(result));
          return { ...result, status: "in_progress", conclusion: null };
        },
      };
      await assert.rejects(
        () =>
          verifyHistoricalHostedNativeJob(platform, historical(f), witnessed, {
            deadline: performance.now() + 60000,
            provider,
          }),
        /historical|original/,
      );
      assert.ok(f.calls.length <= 4);
    });
  }
}
function options(f: ReturnType<typeof checkpointProofFixture>) {
  return {
    attestation: {
      environment: {},
      spawn(command: string, args: readonly string[]) {
        assert.equal(command, "gh");
        assert.equal(args[0], "attestation");
        assert.ok(args.includes("--deny-self-hosted-runners"));
        assert.equal(args[args.indexOf("--signer-digest") + 1], f.producer.controller_revision);
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: f.verification }]),
          stderr: "",
        };
      },
    },
    job: { provider: f.provider },
  };
}

for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
  void test(`historical ${conclusion} job authenticates partial-effect provenance without successful-effect credit`, async () => {
    const f = checkpointProofFixture();
    f.job.conclusion = conclusion;
    const result = await verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
      deadline: performance.now() + 60000,
      provider: f.provider,
    });
    assert.equal(result.requests, 4);
    assert.equal(result.effect_outcome, "not-established");
    assert.equal(result.authority, "none");
    assert.ok(f.calls[0]!.endsWith("/attempts/2"));
    assert.equal(
      f.calls.some((route) => route.endsWith("/actions/runs/9988")),
      false,
    );
  });
}
for (const fault of [
  "wrong-name",
  "wrong-check",
  "unstarted",
  "skipped",
  "duplicate",
  "duplicate-check",
  "incomplete",
  "changed-job",
  "changed-attempt",
  "foreign-actor",
  "foreign-repository",
  "wrong-ref",
  "wrong-attempt",
]) {
  void test(`historical checkpoint refuses ${fault} with bounded GET-only collection`, async () => {
    const f = checkpointProofFixture();
    f.faults.value = fault;
    if (fault === "wrong-name") f.job.name = "Trusted package assembly";
    if (fault === "wrong-check") f.job.check_run_url += "9";
    if (fault === "unstarted") f.job.started_at = "";
    if (fault === "skipped") f.job.conclusion = "skipped";
    if (fault === "foreign-actor") f.attempt.triggering_actor.id = 99;
    if (fault === "foreign-repository") f.attempt.repository.id = 99;
    if (fault === "wrong-ref") f.attempt.head_branch = "main";
    if (fault === "wrong-attempt") f.attempt.run_attempt = 3;
    await assert.rejects(
      () =>
        verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
          deadline: performance.now() + 60000,
          provider: f.provider,
        }),
      /historical|original/,
    );
    assert.ok(f.calls.length <= 4);
  });
}
void test("witnessed time must belong to the started original job, including its reported final-second precision", async () => {
  for (const time of ["2026-10-23T11:59:59.999Z", "2026-10-23T12:01:01Z"]) {
    const f = checkpointProofFixture();
    await assert.rejects(
      () =>
        verifyHistoricalCheckpointJob("coordinator", historical(f), Date.parse(time), {
          deadline: performance.now() + 60000,
          provider: f.provider,
        }),
      /outside the original/,
    );
  }
  const f = checkpointProofFixture();
  await verifyHistoricalCheckpointJob(
    "coordinator",
    historical(f),
    Date.parse("2026-10-23T12:01:00.999Z"),
    { deadline: performance.now() + 60000, provider: f.provider },
  );
});
void test("injected signature/job verification retains original bytes but cannot mint actual-provider custody", async (t) => {
  const directory = await root(t),
    f = checkpointProofFixture();
  const receipt = await authenticateCoordinatorCheckpointEvidence(
    directory,
    f.checkpoint,
    f.configuration,
    f.evidence,
    f.expected,
    performance.now() + 60000,
    options(f),
  );
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.deepEqual(
    await readFile(path.join(receipt.capture_directory, "transition.json")),
    f.evidence.subject,
  );
  assert.deepEqual(
    await readFile(path.join(receipt.capture_directory, "bundle.sigstore.json")),
    f.evidence.bundle,
  );
  assert.throws(
    () => requireAuthenticatedCheckpointEvidence(receipt, f.checkpoint.checkpoint, f.configuration),
    /actual current/,
  );
  assert.throws(
    () =>
      requireAuthenticatedCheckpointEvidence(
        { ...receipt, evidence_scope: "github.com" },
        f.checkpoint.checkpoint,
        f.configuration,
      ),
    /actual current/,
  );
});
for (const fault of ["issuer", "statement", "timestamp", "late-timestamp"]) {
  void test(`checkpoint authentication refuses ${fault} and retains the captured failure`, async (t) => {
    const directory = await root(t),
      f = checkpointProofFixture();
    if (fault === "issuer") f.verification.signature.certificate.issuer = "https://foreign.invalid";
    if (fault === "statement")
      f.verification.statement.predicate.producer = { ...f.producer, job_id: "999" };
    if (fault === "timestamp") f.verification.verifiedTimestamps[0]!.timestamp = "invalid";
    if (fault === "late-timestamp")
      f.verification.verifiedTimestamps.push({
        type: "tlog",
        uri: "https://rekor.sigstore.dev",
        timestamp: "2026-10-23T12:02:00Z",
      });
    await assert.rejects(
      authenticateCoordinatorCheckpointEvidence(
        directory,
        f.checkpoint,
        f.configuration,
        f.evidence,
        f.expected,
        performance.now() + 60000,
        options(f),
      ),
      /capture retained/,
    );
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    const files = await readdir(path.join(directory, names[0]!));
    assert.ok(files.includes("failure.txt") && files.includes("bundle.sigstore.json"));
    assert.equal(files.includes("verification.json"), false);
  });
}
void test("changed independent producer and exhausted deadline refuse before capture or verifier execution", async (t) => {
  const directory = await root(t),
    f = checkpointProofFixture();
  const bad = { ...f.expected, producer: { ...f.producer, configuration_sha256: "f".repeat(64) } };
  await assert.rejects(
    authenticateCoordinatorCheckpointEvidence(
      directory,
      f.checkpoint,
      f.configuration,
      f.evidence,
      bad,
      performance.now() + 60000,
      options(f),
    ),
    /independently expected/,
  );
  await assert.rejects(
    authenticateCoordinatorCheckpointEvidence(
      directory,
      f.checkpoint,
      f.configuration,
      f.evidence,
      f.expected,
      performance.now() - 1,
      options(f),
    ),
    /deadline/,
  );
  assert.deepEqual(await readdir(directory), []);
  assert.equal(f.calls.length, 0);
});
void test("default isolated verification mints only same-process evidence and removes journal/OIDC credentials from GH children", async (t) => {
  const directory = await root(t),
    f = checkpointProofFixture();
  const keys = ["GH_TOKEN", "PORTCOVE_COORDINATOR_JOURNAL_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GH_TOKEN = "inert-read-only-token";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-journal-secret";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "inert-oidc-secret";
  t.after(() => {
    for (const [key, value] of prior)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], settings: SpawnSyncOptionsWithStringEncoding) => {
      assert.equal(command, "gh");
      assert.equal(settings.env?.GH_TOKEN, "inert-read-only-token");
      assert.equal(settings.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
      assert.equal(settings.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(settings.env?.NODE_OPTIONS, undefined);
      assert.equal(args[0], "attestation");
      return options(f).attestation.spawn(command, args);
    },
  );
  syncBuiltinESMExports();
  t.mock.method(
    globalThis,
    "fetch",
    releaseCustodyFetch(f.provider, (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "token inert-read-only-token");
    }),
  );
  await withReadOnlyReleaseChildren(directory, async () => {
    const receipt = await authenticateCoordinatorCheckpointEvidence(
      directory,
      f.checkpoint,
      f.configuration,
      f.evidence,
      f.expected,
      performance.now() + 60000,
    );
    assert.deepEqual(
      requireAuthenticatedCheckpointEvidence(receipt, f.checkpoint.checkpoint, f.configuration),
      f.evidence,
    );
    assert.throws(
      () => requireAuthenticatedCheckpointEvidence(receipt, "f".repeat(40), f.configuration),
      /actual current/,
    );
    assert.throws(
      () =>
        requireAuthenticatedCheckpointEvidence(receipt, f.checkpoint.checkpoint, {
          schema_version: 1,
          namespace: "portcove-other",
        }),
      /actual current/,
    );
  });
});

void test("authentication snapshots evidence and expected bindings before asynchronous capture", async (t) => {
  const directory = await root(t),
    f = checkpointProofFixture();
  const original = {
    subject: Buffer.from(f.evidence.subject),
    bundle: Buffer.from(f.evidence.bundle),
  };
  const other = checkpointProofFixture({ ...f.checkpoint, checkpoint: "f".repeat(40) });
  const injected = options(f);
  injected.attestation.spawn = (_command: string, args: readonly string[]) => {
    const captured = JSON.parse(readFileSync(args[args.indexOf("--bundle") + 1]!, "utf8")) as {
      dsseEnvelope: { payload: string };
    };
    const statement: unknown = JSON.parse(
      Buffer.from(captured.dsseEnvelope.payload, "base64").toString(),
    );
    return {
      status: 0,
      stdout: JSON.stringify([{ verificationResult: { ...f.verification, statement } }]),
      stderr: "",
    };
  };
  const pending = authenticateCoordinatorCheckpointEvidence(
    directory,
    f.checkpoint,
    f.configuration,
    f.evidence,
    f.expected,
    performance.now() + 60000,
    injected,
  );
  assert.equal(f.evidence.subject.length, other.evidence.subject.length);
  assert.equal(f.evidence.bundle.length, other.evidence.bundle.length);
  f.evidence.subject.set(other.evidence.subject);
  f.evidence.bundle.set(other.evidence.bundle);
  f.expected.producer.workflow_sha256 = "f".repeat(64);
  f.configuration.namespace = "portcove-other";
  f.checkpoint.blob.contents = "changed after initial validation";
  const receipt = await pending;
  assert.deepEqual(
    await readFile(path.join(receipt.capture_directory, "transition.json")),
    original.subject,
  );
  assert.deepEqual(
    await readFile(path.join(receipt.capture_directory, "bundle.sigstore.json")),
    original.bundle,
  );
  const metadata = JSON.parse(
    await readFile(path.join(receipt.capture_directory, "verification.json"), "utf8"),
  ) as { producer: { workflow_sha256: string } };
  assert.equal(metadata.producer.workflow_sha256, "3".repeat(64));
});

for (const fault of [
  "complete",
  "empty",
  "total-drift",
  "duplicate-page",
  "stalled-link",
  "foreign-link",
  "terminal-link",
  "cap",
  "over-cap",
]) {
  void test(`historical checkpoint pagination ${fault} never substitutes a partial inventory`, async () => {
    const f = checkpointProofFixture();
    const count =
      fault === "cap" ? 1600 : fault === "over-cap" ? 1601 : fault === "empty" ? 0 : 101;
    const jobs = Array.from({ length: count }, (_, index) => ({
      ...f.job,
      id: index === count - 1 ? 501 : index + 1000,
      name: index === count - 1 ? f.job.name : "Other job",
      check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${index === count - 1 ? 777 : index + 10000}`,
    }));
    let pages = 0;
    const provider: HistoricalJobProvider = {
      ...f.provider,
      async jobs(run, attempt, page) {
        pages++;
        const values = jobs.slice((page - 1) * 100, page * 100);
        if (fault === "duplicate-page" && page === 2) values[0] = jobs[0]!;
        const hasNext = page * 100 < count || fault === "terminal-link";
        const nextPage = fault === "stalled-link" ? page : page + 1;
        const host = fault === "foreign-link" ? "foreign.invalid" : "api.github.com";
        return {
          next: hasNext
            ? `https://${host}/repositories/1354613114/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${nextPage}`
            : null,
          body: {
            total_count: fault === "total-drift" && page === 2 ? count + 1 : count,
            jobs: values,
          },
        };
      },
    };
    const run = () =>
      verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
        deadline: performance.now() + 60000,
        provider,
      });
    if (fault === "complete" || fault === "cap") {
      const result = await run();
      assert.equal(result.requests, fault === "cap" ? 19 : 5);
    } else await assert.rejects(run, /historical checkpoint/);
    assert.ok(pages <= 16);
  });
}

void test("selected empty seed requires exact setup bytes, modern capacity contract and no reservation/effects", async (t) => {
  const directory = await root(t),
    authorities = fixedJobJournalAuthoritiesFixture(),
    f = checkpointProofFixture();
  const input = {
    schema_version: 2,
    active_candidate: null,
    controller: { capacity_attempt: { ...capacityFixture(), schema_version: 2 } },
  };
  const checkpoint = {
    ...f.checkpoint,
    previous: null,
    blob: {
      ...f.checkpoint.blob,
      contents: JSON.stringify({ schema_version: 1, previous: null, input }),
    },
  };
  authorities.journal_seed = {
    checkpoint: checkpoint.checkpoint,
    state_sha256: createHash("sha256").update(checkpoint.blob.contents).digest("hex"),
  };
  const api: CoordinatorRemoteApi = {
    request() {
      assert.fail("seed has no provider proof lookup");
    },
    graphql() {
      assert.fail("head is separately checked by owner");
    },
  };
  const source = {
    revision: f.producer.controller_revision,
    execution_ref: f.producer.controller_ref,
    workflow_sha256: f.producer.workflow_sha256,
    actor_id: f.producer.actor_id,
  };
  const result = await authenticateFixedJobCoordinatorHistory(
    directory,
    checkpoint,
    authorities,
    source,
    performance.now() + 60000,
    api,
  );
  assert.equal(result.kind, "ratified-initial-seed");
  const storageAuthorities = {
    ...authorities,
    kind: "three-app-fixed-jobs-v1",
    storage_setup_plan_sha256: "7".repeat(64),
    apps: { ...authorities.apps, storage_writer: { app_id: 90001, installation_id: 90002 } },
  };
  const upgraded = await authenticateFixedJobCoordinatorHistory(
    directory,
    checkpoint,
    storageAuthorities,
    source,
    performance.now() + 60000,
    api,
  );
  assert.equal(upgraded.kind, "ratified-initial-seed");
  assert.equal(upgraded.checkpoint, result.checkpoint);
  assert.deepEqual(storageAuthorities.journal_seed, authorities.journal_seed);
  assert.equal(storageAuthorities.setup_plan_sha256, authorities.setup_plan_sha256);
  const changed = [
    { ...checkpoint, previous: "a".repeat(40) },
    { ...checkpoint, blob: { ...checkpoint.blob, contents: checkpoint.blob.contents + " " } },
  ];
  for (const value of changed)
    await assert.rejects(
      authenticateFixedJobCoordinatorHistory(
        directory,
        value,
        authorities,
        source,
        performance.now() + 60000,
        api,
      ),
      /seed/,
    );
  for (const value of [
    { ...input, active_candidate: { version: "0.1.0" } },
    {
      ...input,
      controller: {
        capacity_attempt: { ...input.controller.capacity_attempt, prior_operations: [{}] },
      },
    },
    { ...input, schema_version: 1, controller: { free_capacity_available: true } },
  ]) {
    const seeded = {
      ...checkpoint,
      blob: { ...checkpoint.blob, contents: JSON.stringify({ input: value }) },
    };
    const appointed = {
      ...authorities,
      journal_seed: {
        checkpoint: seeded.checkpoint,
        state_sha256: createHash("sha256").update(seeded.blob.contents).digest("hex"),
      },
    };
    await assert.rejects(
      authenticateFixedJobCoordinatorHistory(
        directory,
        seeded,
        appointed,
        source,
        performance.now() + 60000,
        api,
      ),
      /seed/,
    );
  }
});

for (const fault of [
  "",
  "catalog-history",
  "source",
  "setup",
  "role",
  "issuer",
  "job",
  "changed-proof",
]) {
  void test(`selected retained history ${fault || "authenticates exact fixed-source job"} never falls back to unsigned seed`, async (t) => {
    const directory = await root(t),
      authorities = fixedJobJournalAuthoritiesFixture();
    const f = checkpointProofFixture(
      undefined,
      undefined,
      {
        configuration_sha256: releaseCanonicalDigest(authorities),
        run_attempt: 1,
      },
      fault === "catalog-history" ? "catalog-definitions" : "coordinator",
    );
    const source = {
      revision: f.producer.controller_revision,
      execution_ref: f.producer.controller_ref,
      workflow_sha256: f.producer.workflow_sha256,
      actor_id: f.producer.actor_id,
    };
    if (fault === "source") source.revision = "e".repeat(40);
    if (fault === "setup") authorities.setup_plan_sha256 = "e".repeat(64);
    if (fault === "issuer") f.verification.signature.certificate.issuer = "https://wrong.invalid";
    if (fault === "job") f.faults.value = "changed-job";
    const objects = inspectCoordinatorCheckpointEvidence(f.checkpoint, f.configuration, f.evidence);
    const values = new Map<string, unknown>(
      objects.objects.map((object) => {
        const body = object.body;
        const value =
          object.kind === "blobs" && "content" in body
            ? { sha: object.oid, ...body, size: Buffer.from(body.content, "base64").length }
            : object.kind === "trees"
              ? { sha: object.oid, ...body, truncated: false }
              : { sha: object.oid, ...body, tree: { sha: "tree" in body ? body.tree : "" } };
        return [`repos/boburning/portcove/git/${object.kind}/${object.oid}`, value] as const;
      }),
    );
    let snapshots = 0,
      proofSnapshots = 0,
      reads = 0,
      verifies = 0;
    const api: CoordinatorRemoteApi = {
      request(method, endpoint) {
        assert.equal(method, "GET");
        reads++;
        if (endpoint.endsWith("/actions/jobs/501"))
          return {
            status: 200,
            headers: new Map(),
            body: { ...f.job, name: fault === "role" ? "Generic Actions job" : f.job.name },
          };
        assert.ok(values.has(endpoint));
        return { status: 200, headers: new Map(), body: values.get(endpoint) };
      },
      graphql(_query, variables) {
        snapshots++;
        if (typeof variables.state === "string")
          return {
            data: {
              repository: {
                databaseId: 1354613114,
                nameWithOwner: "boburning/portcove",
                state: {
                  prefix: "refs/heads/",
                  name: variables.state.slice("refs/heads/".length),
                  target: { __typename: "Commit", oid: f.checkpoint.checkpoint },
                },
                intent: null,
              },
            },
          };
        proofSnapshots++;
        const name = String(variables.name);
        return {
          data: {
            repository: {
              databaseId: 1354613114,
              nameWithOwner: "boburning/portcove",
              ref: {
                prefix: "refs/tags/",
                name: name.slice("refs/tags/".length),
                target: {
                  __typename: "Commit",
                  oid:
                    fault === "changed-proof" && proofSnapshots === 2
                      ? "f".repeat(40)
                      : objects.update.afterOid,
                },
              },
            },
          },
        };
      },
    };
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-history-job-token";
    t.after(() => {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: readonly string[], settings: SpawnSyncOptionsWithStringEncoding) => {
        assert.equal(command, "gh");
        assert.equal(settings.env?.GH_TOKEN, "inert-history-job-token");
        assert.equal(settings.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        if (args[0] === "attestation") {
          verifies++;
          return options(f).attestation.spawn(command, args);
        }
        assert.fail("unexpected retained CLI route");
      },
    );
    syncBuiltinESMExports();
    const custodyFetch = releaseCustodyFetch(f.provider, (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "token inert-history-job-token",
      );
    });
    t.mock.method(
      globalThis,
      "fetch",
      async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(raw instanceof Request ? raw.url : raw);
        if (
          url.href === "https://api.github.com/graphql" ||
          url.pathname.startsWith("/repos/boburning/portcove/git/") ||
          (url.pathname === `/repos/boburning/portcove/actions/jobs/${f.producer.job_id}` &&
            reads === 4)
        ) {
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "token inert-history-job-token",
          );
          if (url.pathname === "/graphql") {
            assert.ok(typeof init?.body === "string");
            const input: unknown = JSON.parse(init.body);
            assert.ok(
              isRecord(input) && typeof input.query === "string" && isRecord(input.variables),
            );
            return Response.json(api.graphql(input.query, input.variables));
          }
          return Response.json(api.request("GET", url.pathname.slice(1)).body);
        }
        return custodyFetch(raw, init);
      },
    );
    await withReadOnlyReleaseChildren(directory, async () => {
      const deadline = performance.now() + 60000;
      const reader = createCheckpointHistoryReader(
        directory,
        f.checkpoint.checkpoint,
        f.configuration,
        deadline,
      );
      await reader.assertCurrentUnclaimedHead();
      const run = () =>
        authenticateFixedJobCoordinatorHistory(
          directory,
          f.checkpoint,
          authorities,
          source,
          deadline,
          reader.api,
        );
      if (fault && fault !== "catalog-history") await assert.rejects(run());
      else {
        const result = await run();
        assert.equal(result.kind, "authenticated-retained-checkpoint");
        assert.ok("authenticated" in result && result.authenticated);
        assert.deepEqual(
          requireAuthenticatedCheckpointEvidence(
            result.authenticated,
            f.checkpoint.checkpoint,
            f.configuration,
          ),
          f.evidence,
        );
        assert.equal(verifies, 1);
        await reader.assertCurrentUnclaimedHead();
        assert.equal(reads + snapshots, 9);
      }
      if (["source", "setup", "role", "changed-proof"].includes(fault)) assert.equal(verifies, 0);
    });
  });
}
