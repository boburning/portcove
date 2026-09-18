import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPlan,
  classifyChanges,
  deduplicateCommands,
  executePlan,
  formatCommand,
  localChangesFromRaw,
  packagesWithDoctests,
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
  return {
    selection,
    plan: buildPlan(selection, {
      mergeBase: "base-sha",
      doctestPackages: new Set(["portcove-core", "portcove-release-tools", "portcove-desktop"]),
    }),
  };
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

test("incomplete diff discovery fails closed before selecting tests", () => {
  assert.throws(
    () => parseNameStatus(Buffer.from("R100\0crates/portcove-core/src/old.rs\0")),
    /incomplete git rename\/copy record/u,
  );
  assert.throws(
    () =>
      localChangesFromRaw(
        Buffer.from(":100644 100644 1111111 2222222 R100\0crates/portcove-core/src/old.rs\0"),
      ),
    /unsafe changed path|raw diff ended/u,
  );
});

test("shared local planning retains raw file modes and both rename paths", () => {
  const raw = Buffer.from(
    ":100644 100755 1111111 2222222 M\0docs/QUALITY.md\0" +
      ":100644 100644 1111111 2222222 R100\0old.rs\0new.rs\0",
  );
  assert.deepEqual(localChangesFromRaw(raw), [
    {
      status: "M",
      path: "docs/QUALITY.md",
      previousPath: undefined,
      oldMode: "100644",
      newMode: "100755",
    },
    {
      status: "R",
      path: "new.rs",
      previousPath: "old.rs",
      oldMode: "100644",
      newMode: "100644",
    },
  ]);
});

test("active instruction changes run their semantic contracts", () => {
  const { selection, plan } = planFor(["docs/QUALITY.md", "AGENTS.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/repository-settings.test.mjs",
    "scripts/repository-skills.test.mjs",
  ]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("documentation targets run the dynamic link contract", () => {
  const { selection, plan } = planFor(["docs/ARCHITECTURE.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mjs"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("repository skill changes run the dynamic skill contract", () => {
  const { selection, plan } = planFor([".agents/skills/portcove-release-validation/SKILL.md"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mjs"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("a Rust source change checks and tests only its affected package", () => {
  const { selection, plan } = planFor(["crates/portcove-core/src/database.rs"]);
  assert.deepEqual([...selection.packages], ["portcove-core"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-clippy:portcove-core",
    "rust-tests:portcove-core",
    "rust-docs:portcove-core",
  ]);
});

test("mapped module-local Rust changes run the owned focused group", () => {
  const { plan } = planFor(["crates/portcove-core/src/source_report.rs"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-clippy:portcove-core",
    "rust-tests:portcove-core:source-inspection",
    "rust-docs:portcove-core",
  ]);
  const tests = plan.find((entry) => entry.id.endsWith(":source-inspection"));
  assert.equal(tests.args.at(-2), "-E");
  assert.match(tests.args.at(-1), /source_report/u);
  assert.match(tests.reason, /explicit test-impact ownership/u);
});

test("mapped Rust responsibilities run one attributable guarded union", () => {
  const { plan } = planFor([
    "crates/portcove-core/src/source_report.rs",
    "crates/portcove-core/src/release/observation.rs",
  ]);
  const union = plan.find((entry) => entry.id === "rust-tests:portcove-core:union");
  assert.deepEqual(union.args, [
    "scripts/run-rust-tests.mjs",
    "--impact-union",
    "portcove-core",
    "release-discovery",
    "source-inspection",
  ]);
  assert.match(union.reason, /release-discovery/u);
  assert.match(union.reason, /source-inspection/u);
  assert.ok(!ids(plan).includes("rust-tests:portcove-core"));
});

test("mapped renames and an unavailable impact contract use the broad package fallback", () => {
  const renamed = planFor([
    change("crates/portcove-core/src/source_report.rs", {
      status: "R100",
      previousPath: "crates/portcove-core/src/source_summary.rs",
    }),
  ]).plan;
  assert.ok(ids(renamed).includes("rust-tests:portcove-core"));
  assert.ok(!ids(renamed).some((id) => id.endsWith(":source-inspection")));

  const selection = classifyChanges([change("crates/portcove-core/src/source_report.rs")], {
    fileExists: allFilesExist,
  });
  const unavailable = buildPlan(selection, {
    mergeBase: "base-sha",
    rustTestImpactMap: null,
    rustTestImpactLoadError: "impact map could not be read",
  });
  const tests = unavailable.find((entry) => entry.id === "rust-tests:portcove-core");
  assert.ok(tests);
  assert.match(tests.reason, /complete portcove-core test inventory/u);
  assert.match(tests.reason, /impact map could not be read/u);
});

test("bin-only Rust packages do not schedule an invalid doctest command", () => {
  const { plan } = planFor(["crates/portcove-cli/src/main.rs"]);
  assert.ok(ids(plan).includes("rust-tests:portcove-cli"));
  assert.ok(!ids(plan).includes("rust-docs:portcove-cli"));
});

test("doctest capability comes from Cargo target metadata", () => {
  const packages = packagesWithDoctests({
    packages: [
      { name: "library", targets: [{ kind: ["lib"], doctest: true }] },
      { name: "binary", targets: [{ kind: ["bin"], doctest: false }] },
    ],
  });
  assert.deepEqual([...packages], ["library"]);
});

test("Clippy owns equivalent Rust compilation before the broad workspace test fallback", () => {
  const { plan } = planFor(["Cargo.lock"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-workspace-clippy",
    "dependency-policy",
    "rust-workspace-tests",
  ]);
});

test("supported local Rust compilation and tests acquire admission before starting work", () => {
  const focused = planFor(["crates/portcove-core/src/database.rs"]).plan;
  assert.ok(!ids(focused).includes("rust-check:portcove-core"));
  for (const id of ["rust-clippy:portcove-core", "rust-docs:portcove-core"]) {
    const entry = focused.find((candidate) => candidate.id === id);
    assert.ok(entry, `missing ${id}`);
    assert.equal(entry.executable, process.execPath);
    assert.deepEqual(entry.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--guard-command"]);
  }
  const focusedTests = focused.find((candidate) => candidate.id === "rust-tests:portcove-core");
  assert.ok(focusedTests);
  assert.equal(focusedTests.executable, process.execPath);
  assert.deepEqual(focusedTests.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--locked"]);

  const workspace = planFor(["Cargo.lock"]).plan;
  assert.ok(!ids(workspace).includes("rust-workspace-check"));
  for (const id of ["rust-workspace-clippy"]) {
    const entry = workspace.find((candidate) => candidate.id === id);
    assert.ok(entry, `missing ${id}`);
    assert.equal(entry.executable, process.execPath);
    assert.deepEqual(entry.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--guard-command"]);
  }
  const workspaceTests = workspace.find((candidate) => candidate.id === "rust-workspace-tests");
  assert.ok(workspaceTests);
  assert.equal(workspaceTests.executable, process.execPath);
  assert.deepEqual(workspaceTests.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--locked"]);
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
  assert.equal(uiBuild.executable, "corepack");
  assert.equal(uiBuild.args[0], "pnpm");
  const durations = plan.find((entry) => entry.id === "ui-related-durations");
  assert.ok(durations.args.includes("--allow-empty"));
});

test("frontend configuration changes use the complete small UI suite", () => {
  const { selection, plan } = planFor(["apps/desktop/package.json"]);
  assert.equal(selection.uiFullTests, true);
  assert.ok(ids(plan).includes("ui-tests"));
  assert.ok(!ids(plan).includes("ui-related-tests"));
  assert.ok(!ids(plan).includes("ui-theme-copy"));
  assert.ok(!ids(plan).includes("ui-copy"));
  const scripts = JSON.parse(
    readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  ).scripts;
  const aggregateCommands = scripts.test.split(/\s*&&\s*/u);
  assert.ok(aggregateCommands.includes("node scripts/check-theme.mjs"));
  assert.ok(aggregateCommands.includes("node scripts/check-copy.mjs"));
});

test("command-identical obligations execute once while retaining every selection reason", () => {
  const duplicate = {
    id: "second-lint",
    reason: "second owner",
    executable: "lint",
    args: ["--all"],
    cwd: ".",
    obligation: "complete-lint",
  };
  const plan = deduplicateCommands([
    { ...duplicate, id: "first-lint", reason: "first owner" },
    duplicate,
    { id: "tests", reason: "tests", executable: "test", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["first-lint", "tests"]);
  assert.deepEqual(plan[0].selectedIds, ["first-lint", "second-lint"]);
  assert.match(plan[0].reason, /first owner; also selected as second-lint: second owner/u);

  const seen = [];
  executePlan(plan, {
    spawn(executable) {
      seen.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(seen, ["lint", "test"]);
});

test("command-identical stages with different evidence roles remain distinct", () => {
  const plan = deduplicateCommands([
    {
      id: "first",
      reason: "first role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "first-evidence",
    },
    {
      id: "second",
      reason: "second role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "second-evidence",
    },
  ]);
  assert.deepEqual(ids(plan), ["first", "second"]);
});

test("a reused stage id cannot hide conflicting commands or obligations", () => {
  assert.throws(
    () =>
      deduplicateCommands([
        { id: "same", reason: "one", executable: "one", args: [], cwd: "." },
        { id: "same", reason: "two", executable: "two", args: [], cwd: "." },
      ]),
    /selected conflicting commands or obligations/u,
  );
  assert.throws(
    () =>
      deduplicateCommands([
        {
          id: "same",
          reason: "compile",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "compile",
        },
        {
          id: "same",
          reason: "security",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "security",
        },
      ]),
    /selected conflicting commands or obligations/u,
  );
});

test("an exactly repeated stage id retains every selection reason", () => {
  const plan = deduplicateCommands([
    { id: "same", reason: "first", executable: "same", args: [], cwd: "." },
    { id: "same", reason: "second", executable: "same", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["same"]);
  assert.deepEqual(plan[0].selectedIds, ["same"]);
  assert.match(plan[0].reason, /first; also selected as same: second/u);
});

test("Oxc configuration changes retain formatting, lint, UI, fixture, and workflow contracts", () => {
  for (const config of [".oxfmtrc.json", ".oxlintrc.json"]) {
    const { selection, plan } = planFor([config]);
    const selected = ids(plan);
    assert.equal(selection.uiFullTests, true);
    assert.ok(selected.includes("oxfmt"));
    assert.ok(selected.includes("ui-build"));
    assert.ok(selected.includes("ui-oxlint"));
    assert.ok(selected.includes("ui-tests"));
    assert.ok(selected.includes("oxc-fixtures"));
    assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
    const fixtures = plan.find((entry) => entry.id === "oxc-fixtures");
    assert.ok(fixtures.args.includes(config === ".oxfmtrc.json" ? "oxfmt" : "oxlint"));
  }
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
  assert.ok(ids(plan).includes("oxlint"));
  assert.ok(ids(plan).includes("node-tests"));
});

test("heavy Rust runner and lock changes select both guarded execution contracts", () => {
  const { selection, plan } = planFor([
    "scripts/heavy-rust-test-lock.mjs",
    "scripts/run-rust-tests.mjs",
    "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  ]);
  assert.ok(selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/run-rust-tests.test.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/heavy-rust-test-lock.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/run-rust-tests.mjs"));
  assert.ok(ids(plan).includes("node-tests"));

  const fixtureOnly = planFor(["scripts/fixtures/windows-process-tree-supervisor.rs.txt"]);
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mjs"));
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/run-rust-tests.test.mjs"));
});

test("changed shell scripts run shellcheck across the maintained shell set", () => {
  const { plan } = planFor(["scripts/install-linux-desktop-prerequisites.sh"]);
  const shellLint = plan.find((entry) => entry.id === "shell-lint");
  assert.ok(shellLint);
  assert.ok(shellLint.args.includes("scripts/install-linux-desktop-prerequisites.sh"));
  assert.ok(shellLint.args.includes("scripts/bootstrap-quality-tools.sh"));
  assert.ok(shellLint.args.includes("scripts/test-linux-package-ownership.sh"));
});

test("release-script changes select deterministic release contracts without packaged qualification", () => {
  const { selection, plan } = planFor(["scripts/release-preflight.ps1"]);
  for (const contract of [
    "scripts/check-release-metadata.test.mjs",
    "scripts/release-package-policy.test.mjs",
    "scripts/release-coordinator.test.mjs",
    "scripts/release-workflow.test.mjs",
    "scripts/windows-qualification-session.test.mjs",
    "scripts/ci-workflow.test.mjs",
  ])
    assert.ok(selection.nodeTests.has(contract));
  const rendered = plan.map(formatCommand).join("\n");
  assert.ok(!rendered.includes("windows-qualification-session.integration.test.mjs"));
  assert.ok(!rendered.includes("desktop-test"));
});

test("bootstrap manifest changes select cache, doctor, and quality contracts", () => {
  const { selection, plan } = planFor([".config/tool-bootstrap.json"]);
  assert.deepEqual([...selection.unknown], []);
  for (const file of [
    "scripts/tool-cache.test.mjs",
    "scripts/quality-tools.test.mjs",
    "scripts/dev-doctor.test.mjs",
  ])
    assert.ok(selection.nodeTests.has(file));
  assert.ok(ids(plan).includes("node-tests"));
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

test("the exact development scenario entry selects full UI coverage without admitting other HTML", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection } = planFor([{ status, path: "apps/desktop/scenarios.html" }]);
    assert.equal(selection.ui, true);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.unknown.size, 0);
  }
  const renamed = classifyChanges(
    [
      {
        status: "R100",
        previousPath: "apps/desktop/scenarios.html",
        path: "apps/desktop/unknown.html",
      },
    ],
    { fileExists: allFilesExist },
  );
  assert.equal(renamed.uiFullTests, true);
  assert.ok(renamed.unknown.has("apps/desktop/unknown.html"));
});

test("unknown paths refuse local execution until a focused rule owns them", () => {
  const selection = classifyChanges([change("new-subsystem/input.bin")], {
    fileExists: allFilesExist,
  });
  assert.throws(
    () => buildPlan(selection, { mergeBase: "base-sha" }),
    /no selection rule.*new-subsystem\/input\.bin/su,
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
