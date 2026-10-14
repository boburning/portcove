import assert from "node:assert/strict";
import test from "node:test";
import { isRepositoryLintInput, runOxlint } from "./run-oxlint.mjs";

const diagnostic = (code) => ({
  filename: "fixture.tsx",
  severity: "error",
  code,
  message: "fixture violation",
  labels: [{ span: { line: 2, column: 3 } }],
});
const report = (diagnostics = [], extra = {}) =>
  JSON.stringify({ diagnostics, number_of_files: 1, number_of_rules: 2, ...extra });
function execute(results, targets = ["apps/desktop/src/fixture.tsx"]) {
  const invocations = [];
  let output = "";
  const status = runOxlint(targets, {
    spawn: (command, args, options) => {
      invocations.push({ command, args, options });
      return results[invocations.length - 1];
    },
    out: (text) => {
      output += text;
    },
    error: (text) => {
      output += text;
    },
  });
  return { status, output, invocations };
}
const success = { status: 0, stdout: report() };
test("runs each applicable pass exactly once and renders both captured failure reports", () => {
  const result = execute([
    { status: 2, stdout: report([diagnostic("jsx-a11y(alt-text)")]) },
    { status: 1, stdout: report([diagnostic("typescript(no-floating-promises)")]) },
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.invocations.length, 2);
  assert.ok(!result.invocations[0].args.includes("--type-aware"));
  assert.ok(result.invocations[1].args.includes("--type-aware"));
  assert.match(result.output, /\[standard\] fixture.tsx:2:3 error jsx-a11y\(alt-text\)/u);
  assert.match(result.output, /\[type-aware\].*no-floating-promises/u);
  for (const call of result.invocations)
    assert.deepEqual(call.args.slice(-2), ["--format", "json"]);
});
for (const [name, results, expected] of [
  ["success", [success, success], 0],
  [
    "standard failure followed by success",
    [{ status: 2, stdout: report([diagnostic("standard")]) }, success],
    2,
  ],
  ["typed failure", [success, { status: 1, stdout: report([diagnostic("typed")]) }], 1],
  ["malformed JSON", [{ status: 0, stdout: "not JSON" }, success], 1],
  ["empty file inventory", [{ status: 0, stdout: report([], { number_of_files: 0 }) }, success], 1],
  ["empty rule inventory", [success, { status: 0, stdout: report([], { number_of_rules: 0 }) }], 1],
  [
    "missing diagnostic inventory",
    [{ status: 0, stdout: report(undefined, { diagnostics: null }) }, success],
    1,
  ],
  ["spawn failure", [{ error: new Error("spawn failed"), status: null }, success], 1],
  ["signal termination", [{ signal: "SIGTERM", status: null }, success], 1],
  ["missing status", [{ stdout: report() }, success], 1],
  ["nonzero process without diagnostics", [{ status: 7, stdout: report() }, success], 7],
  [
    "diagnostic with erroneous zero status",
    [{ status: 0, stdout: report([diagnostic("unexpected")]) }, success],
    1,
  ],
]) {
  test(`retains ${name} outcome without retrying`, () => {
    const result = execute(results);
    assert.equal(result.status, expected);
    assert.equal(result.invocations.length, 2);
  });
}
test("JavaScript-only targets do not invoke the type-aware pass", () => {
  const result = execute([success], ["scripts/fixture.mjs"]);
  assert.equal(result.status, 0);
  assert.equal(result.invocations.length, 1);
});
test("lint input ownership covers actual scan paths and configurations without assets or prose", () => {
  for (const file of [
    "scripts/tool.mjs",
    "scripts/tool.test.ts",
    "apps/desktop/scripts/tool.js",
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/a.css",
    "apps/desktop/vite.config.ts",
    "apps/desktop/tsconfig.orchestration.json",
    "apps/desktop/stylelint.config.mjs",
    "package.json",
    "apps/desktop/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".node-version",
    ".oxlintrc.json",
    ".npmrc",
    ".gitignore",
  ])
    assert.equal(isRepositoryLintInput(file), true, file);
  for (const file of [
    "docs/QUALITY.md",
    "scripts/README.md",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/public/icon.png",
    "apps/desktop/src/artwork.png",
    "apps/desktop/src/locale.json",
  ])
    assert.equal(isRepositoryLintInput(file), false, file);
});
