import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.env.GITHUB_REPOSITORY, "boburning/portcove");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");

const tests = [
  "release_selection_cache_key",
  "release::tests::github_",
  "unchanged_definition::",
  "providers::exact_tests::exact_history_github",
];
const selected = tests.map((test) => `test(${test})`).join(" | ");
const result = spawnSync(process.execPath, [
  "scripts/run-rust-tests.mts", "--locked", "-p", "portcove-core", "--lib",
  "--features", "qualification-fixtures", "-E", selected,
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
