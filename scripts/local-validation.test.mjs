import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  buildPlan,
  classifyChanges,
  executePlan,
  formatCommand,
  parseNameStatus,
  requireFocusedArguments,
} from "./local-validation.mjs";

const allFilesExist = () => true;
const change = (path, options = {}) => ({ status: "M", path, ...options });
const ids = (plan) => plan.map((entry) => entry.id);

function planFor(paths) {
  const selection = classifyChanges(
    paths.map((path) => (typeof path === "string" ? change(path) : path)),
    { fileExists: allFilesExist },
  );
  return { selection, plan: buildPlan(selection, { mergeBase: "base-sha" }) };
}

test("parses modified, deleted, renamed, and copied Git records", () => {
  const records = parseNameStatus(
    Buffer.from("M\0docs/QUALITY.md\0D\0old.md\0R100\0old.rs\0new.rs\0C090\0a.ts\0b.ts\0"),
  );
  assert.deepEqual(records, [
    { status: "M", path: "docs/QUALITY.md" },
    { status: "D", path: "old.md" },
    { status: "R100", path: "new.rs", previousPath: "old.rs" },
    { status: "C090", path: "b.ts", previousPath: "a.ts" },
  ]);
});

test("also accepts name-status records with an embedded tab", () => {
  assert.deepEqual(parseNameStatus(Buffer.from("M\tdocs/QUALITY.md\0")), [
    { status: "M", path: "docs/QUALITY.md" },
  ]);
});

test("documentation-only changes stay on formatting and whitespace checks", () => {
  const { selection, plan } = planFor(["docs/QUALITY.md", "AGENTS.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt"]);
});

test("a Rust source change checks and tests only its affected package", () => {
  const { selection, plan } = planFor(["crates/portcove-core/src/database.rs"]);
  assert.deepEqual([...selection.packages], ["portcove-core"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-check:portcove-core",
    "rust-clippy:portcove-core",
    "rust-tests:portcove-core",
    "rust-docs:portcove-core",
  ]);
});

test("root Rust dependency changes compile and lint the workspace without local exhaustive tests", () => {
  const { plan } = planFor(["Cargo.lock"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-workspace-check",
    "rust-workspace-clippy",
    "dependency-policy",
  ]);
});

test("UI sources build, lint, and run import-related tests", () => {
  const { selection, plan } = planFor(["apps/desktop/src/view-model.ts"]);
  assert.equal(selection.uiFullTests, false);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "oxfmt",
    "ui-build",
    "ui-oxlint",
    "ui-related-tests",
    "ui-related-durations",
    "ui-theme-copy",
    "ui-copy",
  ]);
  const uiBuild = plan.find((entry) => entry.id === "ui-build");
  if (process.platform === "win32") {
    assert.equal(uiBuild.executable, process.execPath);
    assert.match(uiBuild.args[0], /node_modules[\\/]corepack[\\/]dist[\\/]corepack\.js$/);
  } else assert.equal(uiBuild.executable, "corepack");
});

test("frontend configuration changes use the complete small UI suite", () => {
  const { selection, plan } = planFor(["apps/desktop/package.json"]);
  assert.equal(selection.uiFullTests, true);
  assert.ok(ids(plan).includes("ui-tests"));
  assert.ok(!ids(plan).includes("ui-related-tests"));
});

test("transport changes select both language scopes and contract comparators", () => {
  const { selection, plan } = planFor([
    "apps/desktop/src/transport-types.generated.d.ts",
    "crates/portcove-core/src/types.rs",
  ]);
  assert.equal(selection.transport, true);
  assert.ok(selection.packages.has("portcove-core"));
  assert.ok(selection.nodeTests.has("scripts/transport-types.test.mjs"));
  assert.ok(ids(plan).includes("transport-export"));
  assert.ok(ids(plan).includes("transport-policy"));
});

test("workflow and justfile changes select exact contract tests and actionlint", () => {
  const { selection, plan } = planFor([".github/workflows/ci.yml", "justfile"]);
  assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
  assert.ok(ids(plan).includes("actionlint"));
  const nodeTests = plan.find((entry) => entry.id === "node-tests");
  assert.ok(nodeTests.args.includes("--test-reporter=./scripts/test-duration-reporter.mjs"));
});

test("changed Node implementations select sibling tests and syntax checks", () => {
  const { selection, plan } = planFor(["scripts/ci-health.mjs"]);
  assert.ok(selection.nodeTests.has("scripts/ci-health.test.mjs"));
  assert.ok(selection.nodeSyntax.has("scripts/ci-health.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/ci-health.mjs"));
  assert.ok(ids(plan).includes("node-tests"));
});

test("changed shell scripts run shellcheck across the maintained shell set", () => {
  const { plan } = planFor(["scripts/install-linux-desktop-prerequisites.sh"]);
  const shellLint = plan.find((entry) => entry.id === "shell-lint");
  assert.ok(shellLint);
  assert.ok(shellLint.args.includes("scripts/install-linux-desktop-prerequisites.sh"));
  assert.ok(shellLint.args.includes("scripts/bootstrap-quality-tools.sh"));
});

test("renames classify both the old and new ownership paths", () => {
  const { selection, plan } = planFor([
    change("docs/moved.md", {
      status: "R100",
      previousPath: "crates/portcove-cli/src/removed.rs",
    }),
  ]);
  assert.ok(selection.scopes.has("documentation"));
  assert.ok(selection.packages.has("portcove-cli"));
  assert.ok(selection.oxfmtFiles.has("docs/moved.md"));
  assert.ok(!selection.oxfmtFiles.has("crates/portcove-cli/src/removed.rs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("removed.rs"));
});

test("deleted files affect scope without becoming command arguments", () => {
  const { selection, plan } = planFor([{ status: "D", path: "scripts/retired-tool.test.mjs" }]);
  assert.ok(selection.scopes.has("tooling"));
  assert.ok(!selection.nodeTests.has("scripts/retired-tool.test.mjs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("retired-tool"));
});

test("retired frontend tool configuration remains owned after deletion", () => {
  const retired = [
    ".prettierignore",
    "prettier.config.mjs",
    "eslint.config.mjs",
    "apps/desktop/eslint.config.mjs",
  ];
  const selection = classifyChanges(
    retired.map((path) => ({ status: "D", path })),
    { fileExists: () => false },
  );
  assert.deepEqual([...selection.unknown], []);
  assert.equal(selection.ui, true);
  assert.equal(selection.uiFullTests, true);
});

test("non-ignored untracked files use the same deterministic mapping", () => {
  const selection = classifyChanges([{ status: "?", path: "scripts/local-validation.test.mjs" }], {
    fileExists: allFilesExist,
  });
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
});

test("every tracked repository path has an explicit local selection owner", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL("../", import.meta.url),
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const selection = classifyChanges(files.map((path) => ({ status: "M", path })));
  assert.deepEqual([...selection.unknown].sort(), []);
});

test("unknown paths fail instead of silently passing or choosing the full suite", () => {
  const selection = classifyChanges([change("new-subsystem/input.bin")], {
    fileExists: allFilesExist,
  });
  assert.throws(
    () => buildPlan(selection, { mergeBase: "base-sha" }),
    /no selection rule.*new-subsystem\/input\.bin/s,
  );
});

test("ordinary plans never invoke aggregate, deep, release, installer, or native gates", () => {
  const { plan } = planFor([
    "docs/QUALITY.md",
    "crates/portcove-core/src/database.rs",
    "apps/desktop/src/view-model.ts",
    "scripts/ci-health.mjs",
    ".github/workflows/ci.yml",
  ]);
  const rendered = plan.map(formatCommand).join("\n");
  for (const forbidden of [
    "just check",
    "just audit",
    "just deep",
    "release-preflight",
    "windows-qualification-session.integration",
    "desktop-test",
  ]) {
    assert.ok(!rendered.includes(forbidden), `unexpected ${forbidden}`);
  }
});

test("focused wrappers require an explicit selection", () => {
  assert.throws(() => requireFocusedArguments("test-rust", []), /requires an explicit/);
  assert.throws(
    () => requireFocusedArguments("test-node", ["--test-name-pattern", "x"]),
    /requires an explicit/,
  );
  assert.doesNotThrow(() =>
    requireFocusedArguments("test-rust", ["-p", "portcove-core", "database::"]),
  );
});

test("execution stops on the first failing stage", () => {
  const seen = [];
  const plan = [
    { id: "one", reason: "first", executable: "one", args: [], cwd: "." },
    { id: "two", reason: "second", executable: "two", args: [], cwd: "." },
    { id: "three", reason: "third", executable: "three", args: [], cwd: "." },
  ];
  assert.throws(
    () =>
      executePlan(plan, {
        spawn(executable) {
          seen.push(executable);
          return { status: executable === "two" ? 7 : 0 };
        },
      }),
    /two failed with exit code 7/,
  );
  assert.deepEqual(seen, ["one", "two"]);
});
