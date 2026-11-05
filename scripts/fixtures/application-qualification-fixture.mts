import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowJobs } from "../qualification-coverage.mts";
import { discoverCiPlan } from "../select-ci-plan.mts";
import { isRecord } from "../runtime-values.mts";

export function windowsApplicationQualificationFixture(source: string) {
  const run = {
    id: 123,
    run_attempt: 1,
    path: ".github/workflows/qualification.yml",
    head_sha: source,
    head_branch: "main",
    event: "schedule",
    status: "completed",
    conclusion: "success",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const definitions = workflowJobs(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const names = [
    "classify",
    "provenance",
    "frontend_full",
    "catalog_full",
    "rust_quality_full",
    "rust_clippy",
    "windows_storage",
    "qualification_core_archive",
    "rust_workspace_tests",
  ].map((id) => {
    const name = definitions[id]?.name;
    assert.equal(typeof name, "string");
    return String(name);
  });
  const strategy = definitions.rust_tests?.strategy;
  assert.ok(
    isRecord(strategy) && isRecord(strategy.matrix) && Array.isArray(strategy.matrix.shard),
  );
  for (const shard of strategy.matrix.shard) {
    assert.equal(typeof shard, "string");
    names.push(String(definitions.rust_tests?.name).replace("${{ matrix.shard }}", String(shard)));
  }
  names.push(
    String(definitions.rust_docs?.name).replace("${{ matrix.platform }}", "windows-x86_64"),
  );
  const jobs = names.map((name, index) => ({
    id: index + 1,
    name: `qualify / ${name}`,
    run_id: run.id,
    run_attempt: 1,
    head_sha: source,
    status: "completed",
    conclusion: "success",
  }));
  const plan = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: source,
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-windows-x86_64-v1",
  });
  return { run, jobs: { total_count: jobs.length, jobs }, plan };
}
