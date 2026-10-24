import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { inspectHostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import {
  collectHostedNativeReleaseQualification,
  verifiedHostedNativeReleaseQualification,
  prepareHostedNativeCustody,
  requirePreparedHostedNativeCustody,
  collectHistoricalHostedNativeQualification,
  verifiedHistoricalHostedNativeQualification,
} from "./release-hosted-native-acceptance.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import {
  verifiedNativeReleaseQualification,
  nativeQualificationTransportIdentity,
} from "./release-native-acceptance.mts";

async function root(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosted-native-receiver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(platform: "windows-x86_64" | "linux-x86_64" = "windows-x86_64") {
  const f = hostedNativeProofFixture(platform);
  const { grant_sha256: _grant, ...checkpointProducer } = f.producer;
  const provider = checkpointProofFixture(undefined, undefined, {
    ...checkpointProducer,
    job_id: String(f.producer.job_id),
  });
  provider.job.name = hostedNativeJobProfile(platform).job;
  provider.job.id = f.producer.job_id;
  provider.job.check_run_url = `https://api.github.com/repos/boburning/portcove/check-runs/${f.producer.check_run_id}`;
  provider.job.conclusion = "success";
  provider.job.started_at = "2026-10-20T11:59:00Z";
  provider.job.completed_at = "2026-10-20T12:01:00Z";
  provider.verification.verifiedTimestamps[0]!.timestamp = "2026-10-20T12:00:30Z";
  const prepared = inspectHostedNativeProofFiles(f.files, f.authorities, f.producer);
  const verification = { ...provider.verification, statement: prepared.statement };
  const expected = {
    producer: f.producer,
    platform_label: f.report.platform_label,
    stage: f.report.stage,
    candidate: f.report.candidate,
    journey: f.report.journey,
  };
  const faults = { source: false, workflow: false, harness: false, unavailable: false };
  let reads = 0;
  const api: GitHubRestReader = {
    request(method, route) {
      reads++;
      assert.equal(method, "GET");
      if (route.includes("/actions/"))
        return provider.api.request(
          method,
          route.replace(`/actions/jobs/${f.producer.job_id}`, "/actions/jobs/501"),
        );
      let body: unknown;
      if (route.endsWith(`git/commits/${f.report.producer.source_commit}`))
        body = {
          sha: f.report.producer.source_commit,
          tree: { sha: faults.source ? "e".repeat(40) : f.report.producer.source_tree },
        };
      else if (route.endsWith(`git/commits/${f.report.candidate.source_commit}`))
        body = {
          sha: f.report.candidate.source_commit,
          tree: { sha: f.report.candidate.source_tree },
        };
      else {
        const harness = route.includes(f.report.producer.harness.path),
          bytes = harness ? f.sourceFiles.harness : f.sourceFiles.workflow;
        body = {
          type: "file",
          path: harness ? f.report.producer.harness.path : productionControllerWorkflow,
          encoding: "base64",
          content:
            (harness && faults.harness) || (!harness && faults.workflow)
              ? Buffer.from("changed").toString("base64")
              : bytes.toString("base64"),
          size: bytes.length,
          sha: createHash("sha1")
            .update(Buffer.from(`blob ${bytes.length}\0`))
            .update(bytes)
            .digest("hex"),
        };
      }
      return { status: faults.unavailable ? 503 : 200, headers: new Map(), body };
    },
  };
  const options = {
    api,
    attestation: {
      environment: {},
      spawn(command: string, args: readonly string[]) {
        assert.equal(command, "gh");
        assert.equal(args[0], "attestation");
        assert.ok(args.includes("--deny-self-hosted-runners"));
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: verification }]),
          stderr: "",
        };
      },
    },
  };
  return { ...f, provider, verification, expected, faults, options, reads: () => reads };
}

void test("default historical receiver verifies original bytes but cannot mint current native admission or archival custody", async (t) => {
  const directory = await root(t),
    f = fixture();
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-historical-reader";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], settings: SpawnSyncOptionsWithStringEncoding) => {
      assert.equal(settings.env?.GH_TOKEN, "inert-historical-reader");
      if (args[0] === "attestation") return f.options.attestation.spawn(command, args);
      assert.equal(command, "gh");
      const response = f.options.api.request("GET", args[2]!);
      return {
        status: 0,
        stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(response.body)}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  await withReadOnlyReleaseChildren(directory, async () => {
    const history = await collectHistoricalHostedNativeQualification(
      directory,
      f.authorities,
      f.expected,
      f.files,
      performance.now() + 60000,
    );
    assert.equal(history.kind, "verified-hosted-native-history");
    assert.equal(history.evidence_scope, "github.com"); // Synthetic provider through the builtin seam.
    const original = await verifiedHistoricalHostedNativeQualification(history);
    assert.deepEqual(original?.candidate, f.report.candidate);
    assert.equal(await verifiedHostedNativeReleaseQualification(history), undefined);
    assert.equal(
      await verifiedHistoricalHostedNativeQualification(structuredClone(history)),
      undefined,
    );
    await assert.rejects(verifiedNativeReleaseQualification(history));
    await assert.rejects(prepareHostedNativeCustody([history, {}]), /actual private/);
    const current = await collectHostedNativeReleaseQualification(
      directory,
      f.authorities,
      f.expected,
      f.files,
      performance.now() + 60000,
    );
    assert.equal(await verifiedHistoricalHostedNativeQualification(current), undefined);
    await appendFile(path.join(history.capture_directory, "report.json"), "\n");
    await assert.rejects(
      verifiedHistoricalHostedNativeQualification(history),
      /retained proof changed/,
    );
  });
});

for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
  void test(`${platform} receiver binds exact signed bytes and original successful native job without branding injected evidence`, async (t) => {
    const directory = await root(t),
      f = fixture(platform);
    const receipt = await collectHostedNativeReleaseQualification(
      directory,
      f.authorities,
      f.expected,
      f.files,
      performance.now() + 60000,
      f.options,
    );
    assert.equal(receipt.evidence_scope, "injected-provider");
    assert.equal(await verifiedHostedNativeReleaseQualification(receipt), undefined);
    await assert.rejects(prepareHostedNativeCustody([receipt, {}]), /actual private/);
    assert.equal(
      await verifiedHostedNativeReleaseQualification(structuredClone(receipt)),
      undefined,
    );
    const proof: unknown = JSON.parse(
      await readFile(path.join(receipt.capture_directory, "verification.json"), "utf8"),
    );
    assert.ok(isRecord(proof) && isRecord(proof.job));
    assert.equal(proof.job.job_id, f.producer.job_id);
    assert.equal(proof.job.platform_label, platform);
    assert.equal(proof.authority, "none");
    assert.equal(f.reads(), 8);
  });
}

for (const fault of [
  "source",
  "workflow",
  "harness",
  "unavailable",
  "issuer",
  "statement",
  "timestamp",
  "late-timestamp",
  "before-teardown",
  "failed-job",
  "wrong-job",
  "changed-job",
  "changed-attempt",
] as const) {
  void test(`hosted native receiver refuses ${fault} and retains original proof and failure phase`, async (t) => {
    const directory = await root(t),
      f = fixture();
    if (["source", "workflow", "harness", "unavailable"].includes(fault))
      f.faults[fault as keyof typeof f.faults] = true;
    if (fault === "issuer") f.verification.signature.certificate.issuer = "https://wrong.invalid";
    if (fault === "statement") f.verification.statement.subject[0]!.digest.sha256 = "e".repeat(64);
    if (fault === "timestamp") f.verification.verifiedTimestamps[0]!.timestamp = "invalid";
    if (fault === "late-timestamp")
      f.verification.verifiedTimestamps[0]!.timestamp = "2026-10-20T12:02:00Z";
    if (fault === "before-teardown")
      f.verification.verifiedTimestamps[0]!.timestamp = "2026-10-20T12:00:01Z";
    if (fault === "failed-job") f.provider.job.conclusion = "failure";
    if (fault === "wrong-job") f.provider.job.name = "Coordinate application release";
    if (fault === "changed-job" || fault === "changed-attempt") f.provider.faults.value = fault;
    await assert.rejects(
      collectHostedNativeReleaseQualification(
        directory,
        f.authorities,
        f.expected,
        f.files,
        performance.now() + 60000,
        f.options,
      ),
      /refused during/,
    );
    const [name] = await readdir(directory);
    assert.ok(name);
    const retained = path.join(directory, name);
    assert.deepEqual(await readFile(path.join(retained, "report.json")), f.files.report);
    const failure: unknown = JSON.parse(
      await readFile(path.join(retained, "failure.json"), "utf8"),
    );
    assert.ok(isRecord(failure) && typeof failure.phase === "string");
    assert.equal(failure.status, "refused");
    assert.ok(["source", "signature", "historical-job"].includes(failure.phase));
    assert.ok(f.reads() <= 8);
  });
}

void test("hosted native receiver refuses changed opportunity and exhausted or unbounded original deadline before provider reads", async (t) => {
  const directory = await root(t),
    f = fixture();
  await assert.rejects(
    collectHostedNativeReleaseQualification(
      directory,
      f.authorities,
      { ...f.expected, candidate: { ...f.expected.candidate, artifact_id: 999 } },
      f.files,
      performance.now() + 60000,
      f.options,
    ),
    /independently expected/,
  );
  for (const deadline of [performance.now() - 1, performance.now() + 150000])
    await assert.rejects(
      collectHostedNativeReleaseQualification(
        directory,
        f.authorities,
        f.expected,
        f.files,
        deadline,
        f.options,
      ),
      /deadline/,
    );
  assert.equal(f.reads(), 0);
  assert.deepEqual(await readdir(directory), []);
});

for (const fault of ["none", "retained-bytes", "changed-job", "expired"] as const) {
  void test(`synthetic provider exercises default receiver and private admission getter: ${fault}`, async (t) => {
    const directory = await root(t),
      f = fixture();
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-native-reader-token";
    t.after(() => {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let clockShift = 0;
    const originalNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => originalNow() + clockShift);
    t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: readonly string[], settings: SpawnSyncOptionsWithStringEncoding) => {
        assert.equal(settings.env?.GH_TOKEN, "inert-native-reader-token");
        assert.equal(settings.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        assert.equal(settings.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
        assert.equal(settings.env?.NODE_OPTIONS, undefined);
        if (args[0] === "attestation") return f.options.attestation.spawn(command, args);
        assert.equal(command, "gh");
        const response = f.options.api.request("GET", args[2]!);
        return {
          status: 0,
          stdout: `HTTP/2.0 ${response.status} Fixture\r\n\r\n${JSON.stringify(response.body)}`,
          stderr: "",
        };
      },
    );
    syncBuiltinESMExports();
    await withReadOnlyReleaseChildren(directory, async () => {
      const reportBytes = Buffer.from(f.files.report);
      const artifactId = f.report.candidate.artifact_id;
      const pending = collectHostedNativeReleaseQualification(
        directory,
        f.authorities,
        f.expected,
        f.files,
        performance.now() + 60000,
      );
      // Neither mutations after the first await nor a serialized receipt can
      // alter or manufacture the private binding. The provider remains inert.
      f.files.report.fill(0);
      f.expected.candidate.artifact_id = 999;
      const receipt = await pending;
      assert.equal(
        await verifiedHostedNativeReleaseQualification(structuredClone(receipt)),
        undefined,
      );
      assert.deepEqual(
        await readFile(path.join(receipt.capture_directory, "report.json")),
        reportBytes,
      );
      if (fault === "retained-bytes")
        await appendFile(path.join(receipt.capture_directory, "report.json"), "\n");
      if (fault === "changed-job") f.provider.faults.value = "changed-job";
      if (fault === "expired") clockShift = 60001;
      if (fault !== "none") {
        await assert.rejects(
          verifiedNativeReleaseQualification(receipt),
          /retained proof changed|historical|deadline/,
        );
        return;
      }
      const report = await verifiedNativeReleaseQualification(receipt);
      assert.ok(report.hosted_job);
      assert.equal(report.check, undefined);
      assert.equal(report.candidate.artifact_id, artifactId);
      assert.equal(report.hosted_job.job_id, f.producer.job_id);
      assert.ok(Object.isFrozen(report.hosted_job));
      assert.ok(report.evidence_ids.some((id) => id.startsWith("native-job:")));
      assert.equal(Object.hasOwn(nativeQualificationTransportIdentity(report), "check_id"), false);
      assert.equal(f.reads(), 12);
    });
  });
}

for (const expireFirst of [false, true]) {
  void test(`synthetic default provider pair custody preserves private originals and all original deadlines: ${expireFirst}`, async (t) => {
    const directory = await root(t),
      fixtures = [fixture("linux-x86_64"), fixture("windows-x86_64")];
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-native-custody-reader";
    t.after(() => {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let selected = fixtures[0]!;
    let expireOnSecond = false,
      clockShift = 0;
    const originalNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => originalNow() + clockShift);
    const byDirectory = new Map<string, typeof selected>();
    t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: readonly string[], settings: SpawnSyncOptionsWithStringEncoding) => {
        assert.equal(settings.env?.GH_TOKEN, "inert-native-custody-reader");
        assert.ok(settings.cwd && typeof settings.cwd === "string");
        const f = byDirectory.get(settings.cwd) ?? selected;
        byDirectory.set(settings.cwd, f);
        if (args[0] === "attestation") return f.options.attestation.spawn(command, args);
        if (expireOnSecond && f === fixtures[1] && args[2]?.includes("/actions/jobs/"))
          clockShift = 31000;
        const response = f.options.api.request("GET", args[2]!);
        return {
          status: 0,
          stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(response.body)}`,
          stderr: "",
        };
      },
    );
    syncBuiltinESMExports();
    await withReadOnlyReleaseChildren(directory, async () => {
      const proofs = [];
      for (const f of fixtures) {
        selected = f;
        proofs.push(
          await collectHostedNativeReleaseQualification(
            directory,
            f.authorities,
            f.expected,
            f.files,
            performance.now() + (f === fixtures[0] ? 30000 : 60000),
          ),
        );
      }
      const custody = await prepareHostedNativeCustody(proofs);
      assert.equal(custody.durable_custody, "not-established");
      if (expireFirst) {
        expireOnSecond = true;
        await assert.rejects(requirePreparedHostedNativeCustody(custody), /deadline/);
        for (const [i, proof] of proofs.entries())
          assert.deepEqual(
            await readFile(path.join(proof.capture_directory, "capture.json")),
            fixtures[i]!.files.capture,
          );
        return;
      }
      const captured = await requirePreparedHostedNativeCustody(custody);
      assert.equal(captured.sha256, custody.sha256);
      assert.equal(captured.proofs.length, 2);
      await assert.rejects(
        requirePreparedHostedNativeCustody(structuredClone(custody)),
        /actual prepared/,
      );
      await appendFile(path.join(proofs[0]!.capture_directory, "capture.json"), "\n");
      await assert.rejects(requirePreparedHostedNativeCustody(custody), /retained proof changed/);
    });
  });
}
