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
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { verifyHistoricalCheckpointJob } from "./release-checkpoint-job-identity.mts";
import {
  authenticateCoordinatorCheckpointEvidence,
  requireAuthenticatedCheckpointEvidence,
} from "./release-coordinator-checkpoint-authentication.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";

async function root(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-authentication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function historical(f: ReturnType<typeof checkpointProofFixture>) {
  return { ...f.producer, job_id: Number(f.producer.job_id) };
}
const witnessed = Date.parse("2026-10-23T12:00:30.123Z");
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
    job: { api: f.api },
  };
}

for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
  void test(`historical ${conclusion} job authenticates partial-effect provenance without successful-effect credit`, () => {
    const f = checkpointProofFixture();
    f.job.conclusion = conclusion;
    const result = verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
      cwd: process.cwd(),
      deadline: performance.now() + 60000,
      api: f.api,
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
  void test(`historical checkpoint refuses ${fault} with bounded GET-only collection`, () => {
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
    assert.throws(
      () =>
        verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
          cwd: process.cwd(),
          deadline: performance.now() + 60000,
          api: f.api,
        }),
      /historical|original/,
    );
    assert.ok(f.calls.length <= 4);
  });
}
void test("witnessed time must belong to the started original job, including its reported final-second precision", () => {
  for (const time of ["2026-10-23T11:59:59.999Z", "2026-10-23T12:01:01Z"]) {
    const f = checkpointProofFixture();
    assert.throws(
      () =>
        verifyHistoricalCheckpointJob("coordinator", historical(f), Date.parse(time), {
          cwd: process.cwd(),
          deadline: performance.now() + 60000,
          api: f.api,
        }),
      /outside the original/,
    );
  }
  const f = checkpointProofFixture();
  assert.doesNotThrow(() =>
    verifyHistoricalCheckpointJob(
      "coordinator",
      historical(f),
      Date.parse("2026-10-23T12:01:00.999Z"),
      { cwd: process.cwd(), deadline: performance.now() + 60000, api: f.api },
    ),
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
      if (args[0] === "attestation") return options(f).attestation.spawn(command, args);
      const response = f.api.request("GET", args[2]!);
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(response.body)}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
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
  void test(`historical checkpoint pagination ${fault} never substitutes a partial inventory`, () => {
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
    const api = {
      request(method: string, endpoint: string) {
        if (!endpoint.includes("/jobs?")) return f.api.request(method, endpoint);
        assert.equal(method, "GET");
        pages++;
        const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
        const values = jobs.slice((page - 1) * 100, page * 100);
        if (fault === "duplicate-page" && page === 2) values[0] = jobs[0]!;
        const hasNext = page * 100 < count || fault === "terminal-link";
        const nextPage = fault === "stalled-link" ? page : page + 1;
        const host = fault === "foreign-link" ? "foreign.invalid" : "api.github.com";
        return {
          status: 200,
          headers: new Map(
            hasNext
              ? [
                  [
                    "link",
                    `<https://${host}/repositories/1354613114/actions/runs/9988/attempts/2/jobs?per_page=100&page=${nextPage}>; rel="next"`,
                  ],
                ]
              : [],
          ),
          body: {
            total_count: fault === "total-drift" && page === 2 ? count + 1 : count,
            jobs: values,
          },
        };
      },
    };
    const run = () =>
      verifyHistoricalCheckpointJob("coordinator", historical(f), witnessed, {
        cwd: process.cwd(),
        deadline: performance.now() + 60000,
        api,
      });
    if (fault === "complete" || fault === "cap") {
      const result = run();
      assert.equal(result.requests, fault === "cap" ? 19 : 5);
    } else assert.throws(run, /historical checkpoint/);
    assert.ok(pages <= 16);
  });
}
