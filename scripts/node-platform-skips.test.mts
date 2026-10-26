import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { createNodePlatformSkipInventory } from "./node-platform-skips.mts";
import { parseNodeTestSuites } from "./node-test-suites.mts";
import { requireNodeTestInventory } from "./node-test-inventory.mts";

const file = "scripts/owned.test.mts";
const contract = {
  platform: "linux" as const,
  owner: "contracts",
  prerequisite: "Linux process identity",
  reason: "Linux-only fixture; use the complete contracts qualification owner.",
  cases: ["owned Linux case"],
};
const observe = (name = contract.cases[0], skipped = false, nesting = 0) => ({
  type: "test:pass",
  data: { name, entryFile: path.resolve(file), nesting, skip: skipped, details: { type: "test" } },
});
void test("platform skip observations preserve their declared reason and actual intended route", () => {
  for (const platform of ["linux", "win32"] as const) {
    const inventory = createNodePlatformSkipInventory(
      [file],
      [],
      { [file]: contract },
      { platform },
    );
    inventory.capture(observe(undefined, platform !== "linux"));
    const result = inventory.finish();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.contracts, [
      {
        file,
        name: "owned Linux case",
        category: "platform",
        platform: "linux",
        prerequisite: contract.prerequisite,
        reason: contract.reason,
        qualification_owner: "contracts",
        observations: 1,
      },
    ]);
  }
});
void test("platform contracts reject missing, duplicate, unregistered and wrong-platform outcomes", () => {
  for (const events of [
    [],
    [observe(), observe()],
    [observe(undefined, true)],
    [observe(), observe("new skip", true)],
    [observe(), observe("nested new skip", true, 1)],
  ]) {
    const inventory = createNodePlatformSkipInventory(
      [file],
      [],
      { [file]: contract },
      { platform: "linux" },
    );
    for (const event of events) inventory.capture(event);
    assert.ok(inventory.finish().errors.length);
  }
  const todo = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: contract },
    { platform: "linux" },
  );
  todo.capture({ ...observe(), data: { ...observe().data, todo: "deferred" } });
  assert.match(todo.finish().errors.join(";"), /intended execution route/u);
  const wrongHost = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: contract },
    { platform: "win32" },
  );
  wrongHost.capture(observe());
  assert.match(wrongHost.finish().errors.join(";"), /intended execution route/u);
});
void test("filtered selections and other files cannot claim complete platform execution", () => {
  const filtered = createNodePlatformSkipInventory([file], ["--test-name-pattern=other"], {
    [file]: contract,
  });
  assert.equal(filtered.finish().evaluation, "not_evaluated_filtered_invocation");
  assert.deepEqual(filtered.finish().errors, []);
  const other = createNodePlatformSkipInventory(["scripts/other.test.mts"], [], {
    [file]: contract,
  });
  other.capture(observe());
  assert.deepEqual(other.finish().contracts, []);
});
void test("platform contracts use names independently from line and declaration order", () => {
  const contracts = { [file]: { ...contract, cases: ["first", "second"] } };
  const inventory = createNodePlatformSkipInventory([file], [], contracts, { platform: "linux" });
  for (const [index, name] of ["second", "first"].entries())
    inventory.capture({ ...observe(name), data: { ...observe(name).data, line: 700 - index } });
  assert.deepEqual(inventory.finish().errors, []);
});
void test("requested paths resolve from the caller while ownership paths resolve from the registry", () => {
  const root = path.join(process.cwd(), "nested", "registry");
  const entryFile = path.join(root, file);
  const inventory = createNodePlatformSkipInventory(
    [path.relative(process.cwd(), entryFile)],
    [],
    { [file]: contract },
    { root, platform: "linux" },
  );
  inventory.capture({ ...observe(), data: { ...observe().data, entryFile } });
  assert.equal(inventory.finish().contracts.length, 1);
  assert.deepEqual(inventory.finish().errors, []);
});
void test("skipped and TODO suites cannot bypass platform ownership at any nesting", () => {
  for (const nesting of [0, 1])
    for (const marker of ["skip", "todo"]) {
      const inventory = createNodePlatformSkipInventory(
        [file],
        [],
        { [file]: contract },
        { platform: "linux" },
      );
      inventory.capture(observe());
      inventory.capture({
        type: "test:pass",
        data: {
          name: "unknown suite",
          entryFile: path.resolve(file),
          nesting,
          details: { type: "suite" },
          [marker]: true,
        },
      });
      assert.match(inventory.finish().errors.join(";"), /Unregistered skipped or todo suite/u);
    }
  const activeSuite = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: contract },
    { platform: "linux" },
  );
  activeSuite.capture(observe());
  activeSuite.capture({
    type: "test:pass",
    data: { entryFile: path.resolve(file), details: { type: "suite" } },
  });
  assert.deepEqual(activeSuite.finish().errors, []);
});
void test("actual pinned Node nested-suite deferrals reach the platform observer", (t) => {
  let unproven = false;
  const root = disposableDirectory(t, path.join(os.tmpdir(), "platform-suite-events-"), {
    drain() {
      assert.ok(!unproven, "Native suite worker exit unproven; retain " + root);
    },
  });
  const fixture = path.join(root, "owned.test.mjs");
  writeFileSync(
    fixture,
    "import {test,describe} from 'node:test'; test('owned Linux case',()=>{}); describe('outer',()=>{describe.skip('hidden skip',()=>{}); describe.todo('hidden todo',()=>{});});",
  );
  const controller = path.join(root, "inspect.mjs");
  writeFileSync(
    controller,
    `
    import {run} from 'node:test';
    import {createNodePlatformSkipInventory} from ${JSON.stringify(new URL("./node-platform-skips.mts", import.meta.url).href)};
    const file=process.argv[2];
    const inventory=createNodePlatformSkipInventory([file],[],{'owned.test.mjs':${JSON.stringify(contract)}},{root:${JSON.stringify(root)},platform:'linux'});
    for await(const event of run({files:[file]})) inventory.capture(event);
    console.log(JSON.stringify(inventory.finish()));
  `,
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [controller, fixture], {
    encoding: "utf8",
    env: environment,
    timeout: 15000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
  unproven = !!result.error || !!result.signal || result.status === null;
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed: unknown = JSON.parse(result.stdout);
  assert.ok(
    typeof observed === "object" &&
      observed !== null &&
      "errors" in observed &&
      "contracts" in observed,
  );
  assert.deepEqual(observed.errors, ["Unregistered skipped or todo suite in owned.test.mjs"]);
  assert.ok(Array.isArray(observed.contracts) && observed.contracts.length === 1);
});
function registry(override: unknown = contract) {
  return JSON.stringify({
    format_version: 2,
    suites: { contracts: { arguments: ["--test"] } },
    tests: [{ file, memberships: [["contracts", 0]], platform_skips: override }],
  });
}
void test("the single ownership record resolves skip metadata and qualification ownership", () => {
  const parsed = parseNodeTestSuites(registry());
  assert.deepEqual(parsed.platformSkips, { [file]: contract });
  assert.deepEqual(parsed.qualificationOwners, { [file]: { "linux-x86_64": "contracts" } });
  for (const malformed of [
    { ...contract, owner: "absent" },
    { ...contract, platform: "unknown" },
    { ...contract, prerequisite: "" },
    { ...contract, reason: "" },
    { ...contract, cases: [] },
    { ...contract, cases: ["same", "same"] },
    { ...contract, unexpected: true },
  ])
    assert.throws(() => parseNodeTestSuites(registry(malformed)));
});
void test("disabled, filtered, wrong-platform and removed producers cannot satisfy a skip route", () => {
  const run = "# node-suite: contracts\nnode --test " + file;
  const local =
    "check:\n" +
    run
      .split("\n")
      .map((line) => "    " + line)
      .join("\n") +
    "\n";
  const job = {
    "runs-on": "ubuntu-22.04",
    if: "needs.classify.outputs.mode == 'qualification'",
    steps: [{ run }],
  };
  const workflow = (value: unknown) => "jobs: " + JSON.stringify(value);
  assert.doesNotThrow(() =>
    requireNodeTestInventory([file], workflow({ contracts: job }), local, "", registry()),
  );
  for (const jobs of [
    {},
    { contracts: { ...job, if: false } },
    { contracts: { ...job, "runs-on": "windows-latest" } },
    { contracts: { ...job, "runs-on": "unproven-runner" } },
    { contracts: { ...job, steps: [{ if: false, run }] } },
    {
      contracts: {
        ...job,
        steps: [{ run: run.replace("--test ", "--test --test-name-pattern=other ") }],
      },
    },
  ])
    assert.throws(() => requireNodeTestInventory([file], workflow(jobs), local, "", registry()));
  const filteredRegistry = JSON.parse(registry()) as {
    suites: { contracts: { arguments: string[] } };
  };
  filteredRegistry.suites.contracts.arguments.push("--test-name-pattern=other");
  const filteredJob = {
    ...job,
    steps: [{ run: run.replace("--test ", "--test --test-name-pattern=other ") }],
  };
  assert.throws(
    () =>
      requireNodeTestInventory(
        [file],
        workflow({ contracts: filteredJob }),
        local,
        "",
        JSON.stringify(filteredRegistry),
      ),
    /complete linux-x86_64 qualification owner/u,
  );
});
