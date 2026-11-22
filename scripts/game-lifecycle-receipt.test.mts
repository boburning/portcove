import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  gameLifecycleChecks,
  verifyGameLifecyclePredicate,
  verifyAttestedGameLifecycle,
  verifyGameLifecycleJob,
} from "./game-lifecycle-receipt.mts";

const sourceVariant = { game_id: "fixture", variant_id: "source", representation_id: "raw" };

const expected = {
  preparation_sha256: "a".repeat(64),
  executable_sha256: "e".repeat(64),
  check_plan_sha256: "f".repeat(64),
  run_id: "1234567",
  run_attempt: 2,
  job_id: "12345678",
  platform: "windows-x86-64" as const,
  selected_at: 1010,
  now: 1100,
};

const valid = {
  source_variant: sourceVariant,
  schema: 1,
  preparation_sha256: expected.preparation_sha256,
  executable_sha256: expected.executable_sha256,
  check_plan_sha256: expected.check_plan_sha256,
  run_id: expected.run_id,
  run_attempt: expected.run_attempt,
  job_id: expected.job_id,
  platform: expected.platform,
  started_at: 1011,
  completed_at: 1050,
  checks: Object.fromEntries(
    gameLifecycleChecks.map((check) => [
      check,
      { outcome: "passed", evidence_sha256: "c".repeat(64) },
    ]),
  ),
};

void test("game lifecycle evidence needs the exact pair, native job and all mandatory results", () => {
  assert.deepEqual(verifyGameLifecyclePredicate(valid, expected), {
    started_at: 1011,
    completed_at: 1050,
    preparation_sha256: expected.preparation_sha256,
    source_variant: sourceVariant,
    reports: gameLifecycleChecks.map((check) => ({ check, sha256: "c".repeat(64) })),
  });
  for (const change of [
    { preparation_sha256: "b".repeat(64) },
    { executable_sha256: "b".repeat(64) },
    { check_plan_sha256: "b".repeat(64) },
    { run_attempt: 1 },
    { job_id: "999999" },
    { run_id: "999999" },
    { platform: "linux-x86-64" },
    { started_at: 1009 },
    { completed_at: 1101 },
    { checks: { ...valid.checks, "launch-and-close": "skipped" } },
    { checks: { ...valid.checks, "retain-and-reopen-predecessor": "failed" } },
    { checks: { "launch-and-close": "passed" } },
    { catalog_admission: true },
  ]) {
    assert.throws(() => verifyGameLifecyclePredicate({ ...valid, ...change }, expected));
  }
  assert.equal(verifyGameLifecyclePredicate(valid, { ...expected, now: 87450 }).completed_at, 1050);
});

void test("game lifecycle must match the original successful standard runner job", () => {
  const source_commit = "b".repeat(40);
  const attempt = {
    id: Number(expected.run_id),
    run_attempt: expected.run_attempt,
    repository: { id: 1354613114 },
    path: ".github/workflows/game-lifecycle-qualification.yml",
    head_branch: "main",
    head_sha: source_commit,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
  };
  const job = {
    id: Number(expected.job_id),
    run_id: Number(expected.run_id),
    run_attempt: expected.run_attempt,
    head_sha: source_commit,
    name: "Exact game lifecycle (Windows x64)",
    status: "completed",
    conclusion: "success",
    labels: ["windows-2022"],
    started_at: new Date(1010 * 1000).toISOString(),
    completed_at: new Date(1060 * 1000).toISOString(),
  };
  const binding = { ...expected, source_commit };
  assert.deepEqual(verifyGameLifecycleJob(attempt, job, binding), {
    started: 1010,
    completed: 1060,
  });
  for (const change of [
    { id: 999 },
    { run_attempt: 1 },
    { labels: ["self-hosted", "windows-2022"] },
    { conclusion: "failure" },
    { started_at: "invalid" },
  ])
    assert.throws(() => verifyGameLifecycleJob(attempt, { ...job, ...change }, binding));
  assert.throws(() => verifyGameLifecycleJob({ ...attempt, event: "pull_request" }, job, binding));
  assert.throws(() =>
    verifyGameLifecycleJob(
      { ...attempt, path: ".github/workflows/application-release-native.yml" },
      job,
      binding,
    ),
  );
});

void test("failed receipt verification can retry the same read-only input", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "game-lifecycle-repeat-"));
  const subject = Buffer.from(
    JSON.stringify({
      schema_version: 100,
      command: "catalog.prepare-successor-evidence",
      ok: true,
      error: null,
      data: {
        rule_version: 1,
        selected_at: expected.selected_at,
        anchor_observations: [{}],
        predecessor: {
          platform: "windows-x86-64",
          tag: "old",
          artifact_sha256: "a".repeat(64),
          definition: { stable_id: "fixture" },
          channel: "stable",
          coordinates: { setup: "b".repeat(64), launch: "c".repeat(64), data: "d".repeat(64) },
          variants: [sourceVariant],
        },
        successor: {
          platform: "windows-x86-64",
          tag: "new",
          artifact_sha256: "e".repeat(64),
          definition: { stable_id: "fixture" },
          channel: "stable",
          coordinates: { setup: "b".repeat(64), launch: "c".repeat(64), data: "d".repeat(64) },
          variants: [sourceVariant],
        },
      },
    }),
  );
  const preparation_sha256 = createHash("sha256").update(subject).digest("hex");
  const source_commit = "b".repeat(40);
  const file = "successor-preparation.json";
  await writeFile(path.join(parent, file), subject, { flag: "wx" });
  let calls = 0;
  let reviewedCheckPlan = expected.check_plan_sha256;
  let reviewedChecks = valid.checks;
  const directories: string[] = [];
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-job-reader";
  const stub = mock.method(childProcess, "spawnSync", (...parameters: unknown[]) => {
    calls++;
    const options = parameters[2];
    assert.ok(isRecord(options) && typeof options.cwd === "string");
    assert.notEqual(options.cwd, parent);
    directories.push(options.cwd);
    const response = [
      {
        verificationResult: {
          verifiedTimestamps: [{}],
          signature: {
            certificate: {
              issuer: "https://token.actions.githubusercontent.com",
              sourceRepositoryIdentifier: "1354613114",
              sourceRepositoryURI: "https://github.com/boburning/portcove",
              buildSignerURI:
                "https://github.com/boburning/portcove/.github/workflows/game-lifecycle-qualification.yml@refs/heads/main",
              buildSignerDigest: source_commit,
              sourceRepositoryDigest: source_commit,
              sourceRepositoryRef: "refs/heads/main",
              runnerEnvironment: "github-hosted",
              runInvocationURI: `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`,
            },
          },
          statement: {
            _type: "https://in-toto.io/Statement/v1",
            predicateType: "https://github.com/boburning/portcove/attestations/game-lifecycle/v1",
            subject: [{ name: file, digest: { sha256: preparation_sha256 } }],
            predicate: {
              ...valid,
              check_plan_sha256: reviewedCheckPlan,
              checks: reviewedChecks,
              preparation_sha256,
            },
          },
        },
      },
    ];
    return {
      status: 0,
      stdout: JSON.stringify(response),
      stderr: "",
      pid: 1,
      output: [null, "", ""],
    };
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      verifyAttestedGameLifecycle(parent, { ...expected, preparation_sha256, source_commit }),
      /ENOENT|public input/u,
    );
    await assert.rejects(
      verifyAttestedGameLifecycle(parent, { ...expected, preparation_sha256, source_commit }),
      /ENOENT|public input/u,
    );
    assert.equal(calls, 2);
    assert.notEqual(directories[0], directories[1]);
    assert.deepEqual(await readdir(parent), [file]);
    for (const scratch of directories) await assert.rejects(readdir(scratch), /ENOENT/u);
    const persist = async (name: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(path.join(parent, `${name}.json`), bytes, { flag: "wx" });
      return createHash("sha256").update(bytes).digest("hex");
    };
    reviewedCheckPlan = await persist("check-plan", {
      schema: 1,
      rule_version: 1,
      checks: gameLifecycleChecks,
    });
    const observations = {
      "acquire-exact-successor": {
        predecessor_install_id: "old",
        successor_install_id: "new",
        artifact_sha256: "e".repeat(64),
      },
      "verify-package-and-install": { install_id: "new", checked_files: 10 },
      "launch-and-close": {
        executable_sha256: expected.executable_sha256,
        source_variant: sourceVariant,
        exit_code: 0,
        exited_at: new Date(1040 * 1000).toISOString(),
        method: "identity-bound-native-main-window-close-request",
      },
      "retain-and-reopen-predecessor": { install_id: "old", checked_files: 9 },
    };
    reviewedChecks = {};
    for (const check of gameLifecycleChecks) {
      reviewedChecks[check] = {
        outcome: "passed",
        evidence_sha256: await persist(check, { ...observations[check], check, outcome: "passed" }),
      };
    }
    const provider = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith(`/attempts/${expected.run_attempt}`))
        return Response.json({
          id: Number(expected.run_id),
          run_attempt: expected.run_attempt,
          repository: { id: 1354613114 },
          path: ".github/workflows/game-lifecycle-qualification.yml",
          head_branch: "main",
          head_sha: source_commit,
          status: "completed",
          conclusion: "success",
          event: "workflow_dispatch",
        });
      assert.ok(url.pathname.endsWith(`/jobs/${expected.job_id}`));
      return Response.json({
        id: Number(expected.job_id),
        run_id: Number(expected.run_id),
        run_attempt: expected.run_attempt,
        head_sha: source_commit,
        name: "Exact game lifecycle (Windows x64)",
        status: "completed",
        conclusion: "success",
        labels: ["windows-2022"],
        started_at: new Date(1010 * 1000).toISOString(),
        completed_at: new Date(1060 * 1000).toISOString(),
      });
    });
    try {
      const verified = await verifyAttestedGameLifecycle(parent, {
        ...expected,
        preparation_sha256,
        source_commit,
        check_plan_sha256: reviewedCheckPlan,
      });
      assert.equal(verified.authority, "none");
      assert.deepEqual(verified.source_variant, sourceVariant);
      assert.match(verified.verification_sha256, /^[a-f0-9]{64}$/u);
      assert.equal(provider.mock.callCount(), 2);
      assert.equal(calls, 3);
      assert.ok(!(await readdir(parent)).includes("source-attestation-verification.json"));
    } finally {
      provider.mock.restore();
    }
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    await rm(parent, { recursive: true });
  }
});
