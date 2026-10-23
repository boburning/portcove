import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkStagedNodeTestInventory, requireNodeTestInventory } from "./node-test-inventory.mts";
import {
  annotatedNodeCommands,
  commandTokens,
  generateNodeCommands,
  parseNodeTestSuites,
} from "./node-test-suites.mts";

const first = "scripts/first.test.mts";
function surfaces(files = [first]) {
  const command = `# node-suite: contracts\nnode --test --test-timeout=30000 ${files.join(" ")}`;
  return {
    workflow: `jobs:\n  contracts:\n    if: needs.classify.outputs.mode == 'qualification'\n    steps:\n      - run: |\n${command
      .split("\n")
      .map((line) => `          ${line}`)
      .join("\n")}\n`,
    local: `check:\n${command
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n`,
    registry: JSON.stringify({
      format_version: 1,
      suites: { contracts: { arguments: ["--test", "--test-timeout=30000"], files } },
    }),
  };
}
function fixture(context: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-node-index-é-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q");
  git("config", "user.name", "Inventory fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", path.join(root, "disabled-hooks"));
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(root, "scripts"));
  const writeSurfaces = (files = [first]) => {
    const value = surfaces(files);
    writeFileSync(path.join(root, ".github/workflows/ci.yml"), value.workflow);
    writeFileSync(path.join(root, "justfile"), value.local);
    writeFileSync(path.join(root, "scripts/node-test-suites.json"), value.registry);
  };
  writeSurfaces();
  writeFileSync(path.join(root, "scripts/run-windows-qualification.ps1"), "");
  writeFileSync(path.join(root, "scripts/first.test.mts"), "// owned test\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  return { root, git, writeSurfaces };
}

void test("the shared inventory check retains required and local coverage independently", () => {
  const { workflow, local, registry } = surfaces();
  assert.throws(() => requireNodeTestInventory([], "", "", "", registry), /nonempty/);
  assert.throws(
    () => requireNodeTestInventory([first], "jobs: {}", local, "", registry),
    /required CI/,
  );
  assert.throws(
    () => requireNodeTestInventory([first], workflow, "", "", registry),
    /local quality/,
  );
  requireNodeTestInventory([first], workflow, local, "", registry);
});

void test("unrelated staged changes require no inventories or checkout mutation", (context) => {
  const { root, git } = fixture(context);
  writeFileSync(path.join(root, "note.txt"), "unrelated\n");
  git("add", "note.txt");
  const before = git("status", "--porcelain");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: false, files: 0 });
  assert.equal(git("status", "--porcelain"), before);
});

void test("unstaged registrations cannot hide an incomplete indexed test addition", (context) => {
  const { root, git, writeSurfaces } = fixture(context);
  writeFileSync(path.join(root, "scripts/new.test.mts"), "// new test\n");
  git("add", "scripts/new.test.mts");
  writeSurfaces([first, "scripts/new.test.mts"]);
  const before = git("diff");
  assert.throws(
    () => checkStagedNodeTestInventory(root),
    /new.test.mts is absent from required CI/,
  );
  assert.equal(git("diff"), before);
  git("add", ".github/workflows/ci.yml");
  assert.throws(() => checkStagedNodeTestInventory(root), /generated command differs/);
  git("add", "scripts/node-test-suites.json");
  assert.throws(() => checkStagedNodeTestInventory(root), /generated command differs/);
  // Updating the local generated consumer completes the independently staged migration.
  git("add", "justfile");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 2 });
  assert.equal(readFileSync(path.join(root, "scripts/new.test.mts"), "utf8"), "// new test\n");
});

void test("renamed tests and inventory-only removals are checked against the index", (context) => {
  const { root, git, writeSurfaces } = fixture(context);
  git("mv", "scripts/first.test.mts", "scripts/renamed.test.mts");
  assert.throws(() => checkStagedNodeTestInventory(root), /absent indexed file/);
  writeSurfaces(["scripts/renamed.test.mts"]);
  git("add", ".");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 1 });
  git("commit", "-qm", "rename");
  writeFileSync(path.join(root, "justfile"), "");
  git("add", "justfile");
  assert.throws(() => checkStagedNodeTestInventory(root), /local quality/);
});

void test("comments, disabled jobs or steps, wrong lanes and unreachable recipes cannot register tests", () => {
  const { workflow, local, registry } = surfaces();
  for (const bad of [
    "jobs: {}\n# scripts/first.test.mts\n",
    workflow.replace("needs.classify.outputs.mode == 'qualification'", "false"),
    workflow.replace("      - run:", "      - if: false\n        run:"),
    workflow.replace(
      "needs.classify.outputs.mode == 'qualification'",
      "needs.classify.outputs.mode == 'fast'",
    ),
    workflow.replace("# node-suite: contracts", "# node-suite: missing"),
    workflow.replace("scripts/first.test.mts", "scripts/first.test.mts.extra"),
    workflow.replace("node --test", "# node --test"),
    workflow.replace("      - run:", "      - continue-on-error: true\n        run:"),
    workflow.replace("      - run:", "      - working-directory: apps/desktop\n        run:"),
    workflow
      .replace("          # node-suite:", "          if false; then\n          # node-suite:")
      .replace("scripts/first.test.mts\n", "scripts/first.test.mts\n          fi\n"),
  ])
    assert.throws(() => requireNodeTestInventory([first], bad, local, "", registry));
  for (const bad of [
    "# scripts/first.test.mts",
    local.replace("check:", "# check:"),
    local.replace("    node", "        node"),
    local.replace("    # node-suite", "    if false; then\n    # node-suite"),
  ])
    assert.throws(() => requireNodeTestInventory([first], workflow, bad, "", registry));
});

void test("the Windows payload counts only through active callers and its reviewed mutex envelope", () => {
  const file = "scripts/windows-qualification-session.integration.test.mts";
  const registry = JSON.stringify({
    format_version: 1,
    suites: { "mutex-owned-payload": { arguments: ["--test"], files: [file] } },
  });
  const runner = readFileSync(new URL("./run-windows-qualification.ps1", import.meta.url), "utf8");
  const workflow =
    "jobs:\n  qualification:\n    if: needs.classify.outputs.mode == 'qualification'\n    runs-on: windows-latest\n    steps:\n      - run: ./scripts/run-windows-qualification.ps1\n";
  const local =
    "qualification:\n    pwsh -NoLogo -NoProfile -File scripts/run-windows-qualification.ps1\n";
  requireNodeTestInventory([file], workflow, local, runner, registry);
  assert.throws(
    () =>
      requireNodeTestInventory(
        [file],
        workflow.replace("      - run:", "      - if: false\n        run:"),
        local,
        runner,
        registry,
      ),
    /required CI/,
  );
  assert.throws(
    () =>
      requireNodeTestInventory(
        [file],
        workflow,
        local.replace("    pwsh", "    # pwsh"),
        runner,
        registry,
      ),
    /local quality/,
  );
  for (const altered of [
    `if ($false) {\n${runner}\n}`,
    runner.replace("$exitCode = $LASTEXITCODE", "$exitCode = 0"),
    runner.replace("$mutex.ReleaseMutex()", "# disabled release"),
    runner.replace("& node --test", "# & node --test"),
  ])
    assert.throws(() => requireNodeTestInventory([file], workflow, local, altered, registry));
});

void test("shell text, directory changes and unsupported statements never grant executable coverage", () => {
  const { workflow, local, registry } = surfaces();
  const command =
    "# node-suite: contracts\nnode --test --test-timeout=30000 scripts/first.test.mts";
  const indent = (body: string, spaces: number) =>
    body
      .split("\n")
      .map((line) => " ".repeat(spaces) + line)
      .join("\n");
  for (const [before, after] of [
    ["cd apps/desktop\n", ""],
    [": <<'NO_EXEC'\n", "\nNO_EXEC"],
    ["<#\n", "\n#>"],
    ["function node { :; }\n", ""],
    ["node scripts/check.mts | cat\n", ""],
  ]) {
    const body = `${before}${command}${after}`;
    assert.throws(
      () =>
        requireNodeTestInventory(
          [first],
          workflow.replace(indent(command, 10), indent(body, 10)),
          local,
          "",
          registry,
        ),
      /required CI/,
    );
    assert.throws(
      () =>
        requireNodeTestInventory(
          [first],
          workflow,
          local.replace(indent(command, 4), indent(body, 4)),
          "",
          registry,
        ),
      /local quality/,
    );
  }
});

void test("generation preserves literal quoting, wrappers and exact ordered arguments", () => {
  assert.deepEqual(commandTokens('node --test-name-pattern="Windows reader sharing"'), [
    "node",
    "--test-name-pattern=Windows reader sharing",
  ]);
  const registry = parseNodeTestSuites(surfaces().registry);
  const source = "    # node-suite: contracts\n    {{storage}} node --test scripts/old.test.mts\n";
  assert.throws(() => annotatedNodeCommands(source, registry), /differs/);
  const generated = generateNodeCommands(source, registry);
  assert.match(
    generated,
    /\{\{storage\}\} node --test --test-timeout=30000 scripts\/first.test.mts/u,
  );
  assert.equal(annotatedNodeCommands(generated, registry).length, 1);
  assert.equal(generateNodeCommands(generated, registry), generated);
  assert.throws(
    () => generateNodeCommands("# node-suite: contracts\n# disabled", registry),
    /Missing executable/,
  );
  assert.throws(
    () =>
      parseNodeTestSuites(surfaces().registry.replace("--test-timeout=30000", "--test-force-exit")),
    /Unsupported/,
  );
});
