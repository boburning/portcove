import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseDocument } from "yaml";
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

void test("equivalent qualification expressions preserve executable routes in the real workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const local = readFileSync(new URL("../justfile", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./run-windows-qualification.ps1", import.meta.url), "utf8");
  const registryText = readFileSync(new URL("./node-test-suites.json", import.meta.url), "utf8");
  const registry = parseNodeTestSuites(registryText);
  const files = [...new Set(Object.values(registry.suites).flatMap((suite) => suite.files))];
  for (const condition of [
    "needs.classify.outputs.mode\n == 'qualification'",
    "${{\n needs.classify.outputs.mode\n == 'qualification'\n}}",
  ]) {
    const document = parseDocument(workflow);
    document.setIn(["jobs", "catalog_full", "if"], condition);
    requireNodeTestInventory(files, document.toString(), local, runner, registryText);
  }
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

void test("Just storage aliases, execution defaults and recipe attributes cannot move or echo tests", () => {
  const { workflow, local, registry } = surfaces();
  const storage = local.replace("    node --test", "    {{storage}} node --test");
  const declared = 'storage := "node scripts/dev-storage.mts run --"\n' + storage;
  requireNodeTestInventory([first], workflow, declared, "", registry);
  for (const bad of [
    declared.replace('storage := "node scripts/dev-storage.mts run --"', 'storage := "echo"'),
    storage,
    'set working-directory := "apps/desktop"\n' + local,
    'set shell := ["echo"]\n' + local,
    'set\t windows-shell := ["cmd.exe", "/c", "echo"]\n' + local,
    'set\tshell := ["echo"]\n' + local,
    'export\tNODE_OPTIONS := "--import=./skip-tests.mts"\n' + local,
    'import\t"echo-shell.just"\n' + local,
    "mod\techo_shell\n" + local,
    '[working-directory: "apps/desktop"]\n' + local,
    "[unix]\n" + local,
  ])
    assert.throws(
      () => requireNodeTestInventory([first], workflow, bad, "", registry),
      /local quality/,
    );
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

function ownedRegistry() {
  return {
    format_version: 2,
    suites: {
      contracts: { arguments: ["--test", "--test-timeout=30000"] },
      reverse: { arguments: ["--test", "--test-concurrency=1"] },
    },
    tests: [
      {
        file: first,
        memberships: [
          ["contracts", 100],
          ["reverse", 200],
        ],
      },
      {
        file: "scripts/second.test.mts",
        memberships: [
          ["contracts", 200],
          ["reverse", 100],
        ],
      },
    ],
  };
}

void test("maintained module-mock flag is literal and cannot enable arbitrary module loading", () => {
  const value = ownedRegistry();
  value.suites.contracts.arguments.push("--experimental-test-module-mocks");
  const parsed = parseNodeTestSuites(JSON.stringify(value));
  assert.ok(parsed.suites.contracts?.arguments.includes("--experimental-test-module-mocks"));
  for (const unsupported of [
    "--experimental-test-module-mocks=anything",
    "--import=arbitrary.mts",
    "--require=arbitrary.cjs",
  ]) {
    const changed = structuredClone(value);
    changed.suites.contracts.arguments.push(unsupported);
    assert.throws(() => parseNodeTestSuites(JSON.stringify(changed)), /Unsupported/);
  }
});

void test("one ownership record projects independent suite orders and preserves executable coverage", () => {
  const owned = ownedRegistry();
  const registry = parseNodeTestSuites(JSON.stringify(owned));
  assert.deepEqual(registry, {
    format_version: 1,
    suites: {
      contracts: {
        arguments: ["--test", "--test-timeout=30000"],
        files: [first, "scripts/second.test.mts"],
      },
      reverse: {
        arguments: ["--test", "--test-concurrency=1"],
        files: ["scripts/second.test.mts", first],
      },
    },
  });
  const reordered = { ...owned, tests: [...owned.tests].reverse() };
  assert.deepEqual(parseNodeTestSuites(JSON.stringify(reordered)), registry);
  const workflow =
    "jobs:\n  contracts:\n    if: needs.classify.outputs.mode == 'qualification'\n    steps:\n      - run: |\n          # node-suite: contracts\n          node --test scripts/old.test.mts\n";
  const local = "check:\n    # node-suite: reverse\n    node --test scripts/old.test.mts\n";
  const generatedWorkflow = generateNodeCommands(workflow, registry);
  const generatedLocal = generateNodeCommands(local, registry);
  requireNodeTestInventory(
    [first, "scripts/second.test.mts"],
    generatedWorkflow,
    generatedLocal,
    "",
    JSON.stringify(owned),
  );
  assert.match(
    generatedWorkflow,
    /--test-timeout=30000 scripts\/first\.test\.mts scripts\/second\.test\.mts/u,
  );
  assert.match(
    generatedLocal,
    /--test-concurrency=1 scripts\/second\.test\.mts scripts\/first\.test\.mts/u,
  );
  assert.equal(generateNodeCommands(generatedWorkflow, registry), generatedWorkflow);
  assert.equal(generateNodeCommands(generatedLocal, registry), generatedLocal);
});

void test("ownership records reject ambiguous identities, memberships, positions and mixed formats", () => {
  const valid = ownedRegistry();
  const firstEntry = valid.tests[0];
  assert.ok(firstEntry);
  const bad: unknown[] = [
    { ...valid, tests: [] },
    { ...valid, suites: {} },
    { ...valid, tests: [...valid.tests, structuredClone(firstEntry)] },
    { ...valid, tests: [{ ...firstEntry, file: "../outside.test.mts" }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [] }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [["missing", 100]] }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [["contracts", -1]] }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [["contracts", 0.5]] }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [["contracts", null]] }] },
    {
      ...valid,
      tests: [{ ...firstEntry, memberships: [["contracts", Number.MAX_SAFE_INTEGER + 1]] }],
    },
    {
      ...valid,
      tests: [
        {
          ...firstEntry,
          memberships: [
            ["contracts", 100],
            ["contracts", 200],
          ],
        },
      ],
    },
    { ...valid, tests: [{ ...firstEntry, memberships: [["contracts", 100, "ignored"]] }] },
    { ...valid, tests: [{ ...firstEntry, files: [first] }] },
    { ...valid, tests: [{ ...firstEntry, memberships: { contracts: 100 } }] },
    { ...valid, tests: [{ ...firstEntry, memberships: [["constructor", 100]] }] },
    {
      ...valid,
      tests: valid.tests.map((entry) => ({
        ...entry,
        memberships: [
          ["contracts", 100],
          ["reverse", 200],
        ],
      })),
    },
    { ...valid, suites: { ...valid.suites, empty: { arguments: ["--test"] } } },
    { ...valid, suites: { ...valid.suites, contracts: { arguments: ["--test"], files: [first] } } },
    {
      ...valid,
      suites: { ...valid.suites, contracts: { arguments: ["--test", "--test-force-exit"] } },
    },
    { ...valid, files: [first] },
    { ...valid, tests: "not records" },
    { ...valid, format_version: 3 },
  ];
  for (const value of bad)
    assert.throws(() => parseNodeTestSuites(JSON.stringify(value)), JSON.stringify(value));
});

void test("indexed additions, renames and removals change one ownership record before generation", (context) => {
  const { root, git } = fixture(context);
  const value = {
    format_version: 2,
    suites: { contracts: { arguments: ["--test", "--test-timeout=30000"] } },
    tests: [{ file: first, memberships: [["contracts", 100]] }],
  };
  const publish = () => {
    const registry = parseNodeTestSuites(JSON.stringify(value));
    writeFileSync(path.join(root, "scripts/node-test-suites.json"), JSON.stringify(value));
    for (const file of [".github/workflows/ci.yml", "justfile"]) {
      const destination = path.join(root, file);
      writeFileSync(destination, generateNodeCommands(readFileSync(destination, "utf8"), registry));
    }
    git("add", ".");
  };
  publish();
  git("commit", "-qm", "single-record ownership");
  const unchanged = git("status", "--porcelain");
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: false, files: 0 });
  assert.equal(git("status", "--porcelain"), unchanged);

  writeFileSync(path.join(root, "scripts/added.test.mts"), "// owned added test\n");
  value.tests.push({ file: "scripts/added.test.mts", memberships: [["contracts", 200]] });
  publish();
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 2 });
  git("commit", "-qm", "added ownership");

  git("mv", "scripts/added.test.mts", "scripts/renamed.test.mts");
  const added = value.tests[1];
  assert.ok(added);
  added.file = "scripts/renamed.test.mts";
  publish();
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 2 });
  git("commit", "-qm", "renamed ownership");

  git("rm", "scripts/renamed.test.mts");
  value.tests.pop();
  publish();
  assert.deepEqual(checkStagedNodeTestInventory(root), { checked: true, files: 1 });
});

void test("the ownership parser and registry retain independent inventory and workflow consumers", async () => {
  const { classifyChanges } = await import("./ordinary-validation.mts");
  for (const file of ["scripts/node-test-suites.mts", "scripts/node-test-suites.json"]) {
    for (const change of [
      { status: "M", path: file },
      { status: "A", path: file },
      { status: "D", path: file },
      { status: "R100", path: "docs/moved.md", previousPath: file },
      { status: "R100", previousPath: "docs/moved.md", path: file },
    ]) {
      const selected = classifyChanges([change], { fileExists: () => false });
      assert.ok(
        selected.nodeTests.has("scripts/node-test-inventory.test.mts"),
        JSON.stringify(change),
      );
      assert.ok(selected.nodeTests.has("scripts/ci-workflow.test.mts"), JSON.stringify(change));
    }
  }
});
