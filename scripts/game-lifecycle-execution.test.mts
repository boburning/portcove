import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeGameLifecycle } from "./game-lifecycle-execution.mts";
import { gameLifecycleChecks } from "./game-lifecycle-receipt.mts";

const job = {
  run_id: "917",
  run_attempt: 2,
  job_id: "918",
  platform: "windows-x86-64" as const,
};
const preparation = Buffer.from(
  JSON.stringify({
    command: "catalog.prepare-successor-evidence",
    ok: true,
    data: {
      rule_version: 1,
      selected_at: 50,
      predecessor: { platform: job.platform },
      successor: { platform: job.platform },
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
  const seen: string[] = [];
  const work = {
    output,
    preparation,
    executable_sha256: "f".repeat(64),
    phases: {
      async "acquire-exact-successor"() {
        seen.push("acquire-exact-successor");
        return { outcome: "passed" };
      },
      async "verify-package-and-install"() {
        seen.push("verify-package-and-install");
        return { outcome: "passed" };
      },
      async "launch-and-close"() {
        seen.push("launch-and-close");
        return { outcome: "passed" };
      },
      async "retain-and-reopen-predecessor"() {
        seen.push("retain-and-reopen-predecessor");
        return { outcome: "passed" };
      },
    },
  };
  try {
    const result = await executeGameLifecycle(job, work, () => 60);
    assert.equal(result.outcome, "ready-for-independent-attestation");
    assert.deepEqual(seen, gameLifecycleChecks);
    assert.deepEqual(await readFile(path.join(output, "successor-preparation.json")), preparation);
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
  } finally {
    await rm(output, { recursive: true });
    await rm(failure, { recursive: true });
  }
});
