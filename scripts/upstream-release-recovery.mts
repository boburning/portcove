/** One fixed public-only continuation; no payload producer or general recovery service. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readGitHubReleaseAsset } from "./github-binary.mts";
import { isRecord } from "./runtime-values.mts";
import {
  retainedRehearsal,
  retainedRecovery,
  rehearsalExecution,
  rehearsalOrigin,
  rehearsalExecutionRef,
} from "./upstream-release-identity.mts";
import {
  readRehearsalAttemptObservations,
  assertRehearsalProtection,
  inspectRehearsalBudget,
} from "./upstream-release-runtime.mts";
import {
  rehearsalApi,
  readRehearsalManifest,
  inspectRehearsalFeed,
} from "./upstream-release-rehearsal.mts";
import { verifyImmutableRehearsal } from "./upstream-release-publication.mts";

export function inspectRetainedRecoveryHistory(attempts: unknown[], contexts: unknown[]) {
  assert.equal(attempts.length, 4);
  assert.equal(contexts.length, 4);
  for (const [index, expectedStep] of [
    "Inject controlled post-publication interruption",
    "Bound actual cumulative runtime and remaining native jobs",
  ].entries()) {
    const context = contexts[index];
    const collection = attempts[index];
    assert.ok(
      isRecord(context) &&
        context.id === Number(retainedRehearsal.run_id) &&
        context.head_sha === retainedRehearsal.source &&
        context.head_branch === retainedRehearsal.ref.slice("refs/tags/".length) &&
        context.run_attempt === index + 1 &&
        context.status === "completed" &&
        context.conclusion === "failure",
    );
    assert.ok(
      isRecord(collection) &&
        Array.isArray(collection.jobs) &&
        collection.total_count === 10 &&
        collection.jobs.length === 10,
    );
    const jobs = collection.jobs;
    for (const name of [
      "package",
      "provenance",
      "sign",
      "baseline",
      "installed",
      "acceptance",
      "draft",
    ])
      assert.equal(
        jobs.filter(
          (row) =>
            isRecord(row) &&
            row.name === name &&
            row.conclusion === "success" &&
            row.status === "completed",
        ).length,
        1,
      );
    const failures = jobs.filter((row) => isRecord(row) && row.conclusion === "failure");
    assert.equal(failures.length, 1);
    const feed: unknown = failures[0];
    assert.ok(isRecord(feed) && feed.name === "feed" && Array.isArray(feed.steps));
    assert.deepEqual(
      feed.steps
        .filter((step) => isRecord(step) && step.conclusion === "failure")
        .map((step) => (isRecord(step) ? step.name : null)),
      [expectedStep],
    );
    for (const name of ["public_installed", "readback"])
      assert.equal(
        jobs.filter(
          (row) =>
            isRecord(row) &&
            row.name === name &&
            row.conclusion === "skipped" &&
            Array.isArray(row.steps) &&
            row.steps.length === 0,
        ).length,
        1,
      );
  }
  const previous = contexts[2];
  assert.ok(isRecord(previous));
  assert.equal(previous.id, Number(retainedRecovery.run_id));
  assert.equal(previous.head_sha, retainedRecovery.source);
  assert.equal(previous.head_branch, retainedRecovery.ref.slice("refs/tags/".length));
  assert.equal(previous.run_attempt, 1);
  assert.equal(previous.status, "completed");
  assert.equal(previous.conclusion, "failure");
  const rows = attempts[2];
  assert.ok(isRecord(rows) && Array.isArray(rows.jobs));
  assert.equal(rows.total_count, 4);
  assert.equal(rows.jobs.length, 4);
  const jobs: unknown[] = rows.jobs;
  for (const [name, conclusion] of [
    ["recovery", "success"],
    ["feed", "success"],
    ["public_installed", "failure"],
    ["readback", "skipped"],
  ]) {
    const matching = jobs.filter((row) => isRecord(row) && row.name === name);
    assert.equal(matching.length, 1);
    const row = matching[0];
    assert.ok(isRecord(row) && Array.isArray(row.steps));
    assert.equal(row.status, "completed");
    assert.equal(row.conclusion, conclusion);
    if (name === "readback") assert.deepEqual(row.steps, []);
    if (name === "public_installed")
      assert.deepEqual(
        row.steps
          .filter((step) => isRecord(step) && step.conclusion === "failure")
          .map((step) => (isRecord(step) ? step.name : null)),
        ["Exercise compiled HTTPS metadata and actual GitHub payload through installed UI"],
      );
  }
  return inspectRehearsalBudget("recovery", attempts, contexts);
}

async function preflight() {
  const executor = rehearsalExecution();
  const runs = rehearsalApi(
    `actions/workflows/upstream-release-rehearsal.yml/runs?head_sha=${executor.source}&per_page=100`,
  );
  assert.ok(
    isRecord(runs) &&
      runs.total_count === 1 &&
      Array.isArray(runs.workflow_runs) &&
      runs.workflow_runs.length === 1 &&
      isRecord(runs.workflow_runs[0]) &&
      runs.workflow_runs[0].id === Number(executor.run_id),
    "only one control continuation is admitted",
  );
  const { attempts, contexts } = readRehearsalAttemptObservations();
  const budget = inspectRetainedRecoveryHistory(attempts, contexts);
  await assertRehearsalProtection("recovery");
  const signed = "work/upstream-signed";
  const manifestBytes = await readFile(`${signed}/rehearsal.json`);
  assert.equal(
    createHash("sha256").update(manifestBytes).digest("hex"),
    retainedRehearsal.manifest_sha256,
  );
  await readRehearsalManifest(signed);
  const immutable = await verifyImmutableRehearsal(signed, "recovery");
  assert.equal(immutable.observed.release_id, retainedRehearsal.release_id);
  const assets = rehearsalApi(`releases/${retainedRehearsal.release_id}/assets?per_page=100`);
  assert.ok(Array.isArray(assets) && assets.length === 15);
  for (const file of immutable.files) {
    const asset: unknown = assets.find((value) => isRecord(value) && value.name === file.name);
    assert.ok(isRecord(asset) && typeof asset.id === "number" && Number.isSafeInteger(asset.id));
    const bytes = readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${asset.id}`, {
      cwd: process.cwd(),
      maxBytes: file.bytes,
      timeoutMs: 120000,
    });
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const candidate = inspectRehearsalFeed(JSON.parse(await readFile(`${signed}/feed.json`, "utf8")));
  assert.equal(candidate.length, 15);
  for (const file of candidate) {
    const response = await fetch(
      `https://boburning.github.io/portcove/rehearsal/${retainedRehearsal.run_id}-1/application/${file.path}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "Cache-Control": "no-cache" },
      },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    let total = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      const value: unknown = chunk;
      assert.ok(value instanceof Uint8Array);
      total += value.byteLength;
      assert.ok(total <= 2 * 1024 ** 2);
      chunks.push(value);
    }
    assert.ok(
      Buffer.concat(chunks).equals(Buffer.from(file.text)),
      "published candidate feed changed; no rollback or republication is admitted",
    );
  }
  await writeFile(
    "work/upstream-recovery-preflight.json",
    `${JSON.stringify({
      scope: "one-retained-public-cohort",
      origin: rehearsalOrigin(),
      origin_ref: retainedRehearsal.ref,
      executor,
      executor_ref: rehearsalExecutionRef,
      immutable_release: retainedRehearsal.release_id,
      verified_assets: 15,
      candidate_files: candidate.length,
      budget,
      original_deadline: retainedRehearsal.original_deadline,
      historical_observation_deadline: retainedRehearsal.deadline,
      production: false,
    })}\n`,
    { flag: "wx" },
  );
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/upstream-release-recovery.mts"))
  await preflight();
