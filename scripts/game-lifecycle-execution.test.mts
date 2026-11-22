import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isRecord } from "./runtime-values.mts";
import { executeGameLifecycleWorkflow } from "./game-lifecycle-workflow.mts";
import { executeGameLifecycle } from "./game-lifecycle-execution.mts";
import {
  gameLifecycleChecks,
  inspectGameLifecyclePreparation,
  verifyGameLifecyclePhaseFiles,
  verifyGameLifecyclePredicate,
} from "./game-lifecycle-receipt.mts";

const sourceVariant = { game_id: "fixture", variant_id: "source", representation_id: "raw" };

const job = {
  run_id: "917",
  run_attempt: 2,
  job_id: "918",
  platform: "windows-x86-64" as const,
};
const preparation = Buffer.from(
  JSON.stringify({
    schema_version: 100,
    command: "catalog.prepare-successor-evidence",
    ok: true,
    error: null,
    data: {
      rule_version: 1,
      selected_at: 50,
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

void test("empty eligible inventory emits no success or attestation inputs", async () => {
  assert.deepEqual(await executeGameLifecycle(job, undefined), {
    outcome: "no-eligible-input",
    authority: "none",
  });
});

void test("native phases bind fixed original evidence and fail before a partial predicate", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "game-lifecycle-"));
  const failure = await mkdtemp(path.join(tmpdir(), "game-lifecycle-"));
  const mismatch = await mkdtemp(path.join(tmpdir(), "game-lifecycle-"));
  const seen: string[] = [];
  const work = {
    output,
    preparation,
    executable_sha256: "f".repeat(64),
    source_variant: sourceVariant,
    phases: {
      async "acquire-exact-successor"() {
        seen.push("acquire-exact-successor");
        return {
          outcome: "passed",
          predecessor_install_id: "old",
          successor_install_id: "new",
          artifact_sha256: "e".repeat(64),
        };
      },
      async "verify-package-and-install"() {
        seen.push("verify-package-and-install");
        return { outcome: "passed", install_id: "new", checked_files: 4 };
      },
      async "launch-and-close"() {
        seen.push("launch-and-close");
        return {
          outcome: "passed",
          executable_sha256: "f".repeat(64),
          method: "identity-bound-native-main-window-close-request",
          source_variant: sourceVariant,
          exited_at: new Date(60000).toISOString(),
          exit_code: 0,
        };
      },
      async "retain-and-reopen-predecessor"() {
        seen.push("retain-and-reopen-predecessor");
        return { outcome: "passed", install_id: "old", checked_files: 3 };
      },
    },
  };
  try {
    const result = await executeGameLifecycle(job, work, () => 60);
    assert.equal(result.outcome, "ready-for-independent-attestation");
    assert.deepEqual(seen, gameLifecycleChecks);
    assert.deepEqual(await readFile(path.join(output, "successor-preparation.json")), preparation);
    const predicate: unknown = JSON.parse(
      await readFile(path.join(output, "predicate.json"), "utf8"),
    );
    assert.ok(
      isRecord(predicate) &&
        typeof predicate.preparation_sha256 === "string" &&
        typeof predicate.check_plan_sha256 === "string",
    );
    const receipt = verifyGameLifecyclePredicate(predicate, {
      ...job,
      preparation_sha256: predicate.preparation_sha256,
      executable_sha256: work.executable_sha256,
      check_plan_sha256: predicate.check_plan_sha256,
      selected_at: 50,
      now: 60,
    });
    assert.deepEqual(receipt.source_variant, sourceVariant);
    const prepared = inspectGameLifecyclePreparation(preparation);
    const bindings = {
      executable_sha256: work.executable_sha256,
      check_plan_sha256: predicate.check_plan_sha256,
    };
    await verifyGameLifecyclePhaseFiles(output, prepared, receipt, bindings);
    await assert.rejects(
      verifyGameLifecyclePhaseFiles(
        output,
        prepared,
        {
          ...receipt,
          reports: receipt.reports.map((row) => ({
            ...row,
            sha256: row.check === "launch-and-close" ? "1".repeat(64) : row.sha256,
          })),
        },
        bindings,
      ),
      /evidence differs from the attested digest/u,
    );
    await assert.rejects(
      verifyGameLifecyclePhaseFiles(
        output,
        prepared,
        {
          ...receipt,
          source_variant: { ...sourceVariant, variant_id: "foreign" },
        },
        bindings,
      ),
      /do not prove the exact acquisition/u,
    );

    await assert.rejects(
      executeGameLifecycle(
        job,
        {
          ...work,
          output: failure,
          phases: {
            ...work.phases,
            "verify-package-and-install": async () => ({ outcome: "skipped" }),
          },
        },
        () => 60,
      ),
    );
    const files = await readdir(failure);
    assert.ok(files.includes("terminal.json"));
    assert.ok(!files.includes("predicate.json"));
    assert.ok(!files.includes("launch-and-close.json"));
    await assert.rejects(
      executeGameLifecycle(
        job,
        {
          ...work,
          output: mismatch,
          phases: {
            ...work.phases,
            "retain-and-reopen-predecessor": async () => ({
              outcome: "passed",
              install_id: "other",
              checked_files: 3,
            }),
          },
        },
        () => 60,
      ),
      /do not prove the exact acquisition, launch and rollback/u,
    );
    assert.ok(!(await readdir(mismatch)).includes("predicate.json"));
    await assert.rejects(
      executeGameLifecycle(
        job,
        {
          ...work,
          output: mismatch,
          preparation: Buffer.from(
            preparation.toString().replace('"selected_at":50', '"selected_at":61'),
          ),
        },
        () => 60,
      ),
      /selection clock is in the future/u,
    );
    await assert.rejects(
      executeGameLifecycle(
        job,
        {
          ...work,
          output: mismatch,
          preparation: Buffer.from(
            preparation.toString().replace("windows-x86-64", "linux-x86-64"),
          ),
        },
        () => 60,
      ),
      /scope is incomplete or unsupported/u,
    );
  } finally {
    await rm(output, { recursive: true });
    await rm(failure, { recursive: true });
    await rm(mismatch, { recursive: true });
  }
});

void test("ordinary workflow writes attributable no-work without native job or predicate", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "game-lifecycle-workflow-"));
  const directory = path.join(parent, "empty");
  try {
    const identity = {
      run_id: job.run_id,
      run_attempt: job.run_attempt,
      source_commit: "b".repeat(40),
    };
    assert.deepEqual(await executeGameLifecycleWorkflow(directory, identity), {
      predicate_ready: false,
      native_job_id: null,
    });
    assert.deepEqual(await readdir(directory), ["terminal.json"]);
    const receipt: unknown = JSON.parse(
      await readFile(path.join(directory, "terminal.json"), "utf8"),
    );
    assert.ok(isRecord(receipt));
    assert.equal(receipt.outcome, "no-eligible-input");
    assert.equal(receipt.reason, "no-independently-admitted-hosted-library-pair");
    assert.equal(receipt.native_platform, "windows-x86-64");
    assert.equal(receipt.other_platforms, "native-producer-scope-unavailable");
    assert.equal(receipt.source_commit, identity.source_commit);
  } finally {
    await rm(parent, { recursive: true });
  }
});
