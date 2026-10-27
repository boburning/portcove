import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { createNodePlatformSkipInventory, nodeCaseSelected } from "./node-platform-skips.mts";
import { parseNodeTestSuites } from "./node-test-suites.mts";
import { requireNodeTestInventory } from "./node-test-inventory.mts";
import { isRecord } from "./runtime-values.mts";

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
void test(
  "declared top-level filter selection agrees with actual Node execution",
  { timeout: 30_000 },
  (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-route-filters-"));
    const fixture = path.join(root, "selection.test.mjs"),
      output = path.join(root, "executed.txt");
    const names = [
      "owned platform case",
      "pnpm uses configured storage",
      "direct just recipes",
      "another case",
    ];
    writeFileSync(
      fixture,
      `import {test} from 'node:test';import {appendFileSync} from 'node:fs';for(const name of ${JSON.stringify(names)})test(name,()=>appendFileSync(${JSON.stringify(output)},name+'\\n'));`,
    );
    for (const filters of [
      [],
      ["--test-name-pattern=owned|pnpm"],
      ["--test-name-pattern=/^OWNED/i"],
      ["--test-name-pattern=owned", "--test-name-pattern=pnpm"],
      ["--test-skip-pattern", "pnpm uses|direct just recipes"],
    ]) {
      writeFileSync(output, "");
      const environment: Record<string, string | undefined> = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--test", ...filters, fixture], {
        env: environment,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 128 * 1024,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const executed = readFileSync(output, "utf8").trim().split("\n").filter(Boolean);
      assert.deepEqual(
        names.filter((name) => nodeCaseSelected(name, filters) === true),
        executed,
      );
    }
    assert.equal(nodeCaseSelected("owned", ["--test-name-pattern=/owned/g"]), null);
    assert.equal(nodeCaseSelected("owned", ["--test-name-pattern"]), null);
  },
);
void test("a selected declared route cannot disappear behind a complementary file filter", () => {
  const filters = ["--test-skip-pattern", "pnpm uses|direct just recipes"];
  const missing = createNodePlatformSkipInventory(
    [file],
    filters,
    { [file]: contract },
    { platform: "linux" },
  );
  assert.match(missing.finish().errors.join("\n"), /missing or ambiguous/u);
  const observed = createNodePlatformSkipInventory(
    [file],
    filters,
    { [file]: contract },
    { platform: "linux" },
  );
  observed.capture(observe());
  assert.deepEqual(observed.finish().errors, []);
  assert.equal(observed.finish().evaluation, "not_evaluated_filtered_invocation");
});
void test("one file retains distinct platform routes and detects disappearance on its intended host", () => {
  const routes = [
    contract,
    { ...contract, platform: "win32" as const, cases: ["owned Windows case"] },
  ];
  for (const platform of ["linux", "win32"] as const) {
    const inventory = createNodePlatformSkipInventory([file], [], { [file]: routes }, { platform });
    inventory.capture(observe(contract.cases[0], platform !== "linux"));
    inventory.capture(observe("owned Windows case", platform !== "win32"));
    assert.deepEqual(inventory.finish().errors, []);
    const missing = createNodePlatformSkipInventory([file], [], { [file]: routes }, { platform });
    missing.capture(observe(contract.cases[0], platform !== "linux"));
    assert.match(missing.finish().errors.join("\n"), /missing or ambiguous/u);
  }
  const mac = { ...contract, platform: "darwin" as const };
  const disappeared = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: mac },
    { platform: "darwin" },
  );
  disappeared.capture(observe(undefined, true));
  assert.match(disappeared.finish().errors.join("\n"), /differs from intended/u);
});
void test("explicit acceptance stays missing until its declared environment exists and then must execute", () => {
  const route = {
    ...contract,
    platform: ["linux", "win32", "darwin"] as const,
    category: "explicit-acceptance" as const,
    required_environment: ["PORTCOVE_FIXTURE_TOOL"],
    intended_route: "Run the reviewed actual-tool acceptance with its verified tool",
  };
  for (const available of [false, true]) {
    const environment = available ? { PORTCOVE_FIXTURE_TOOL: "selected" } : {};
    const inventory = createNodePlatformSkipInventory(
      [file],
      [],
      { [file]: route },
      { environment },
    );
    inventory.capture(observe(undefined, !available));
    assert.deepEqual(inventory.finish().errors, []);
    const wrong = createNodePlatformSkipInventory([file], [], { [file]: route }, { environment });
    wrong.capture(observe(undefined, available));
    assert.match(wrong.finish().errors.join("\n"), /differs from intended/u);
  }
});
void test("prerequisite skips require the original specific reason instead of accepting arbitrary new skips", () => {
  const route = {
    ...contract,
    platform: ["linux", "win32", "darwin"] as const,
    category: "prerequisite" as const,
    skip_reason_prefix: "Symlink prerequisite: ",
    intended_route: "Execute the complete owner with symlink privilege",
  };
  for (const reason of [false, "Symlink prerequisite: EPERM", "unrelated new skip"] as const) {
    const inventory = createNodePlatformSkipInventory([file], [], { [file]: route });
    const event = observe();
    inventory.capture({ ...event, data: { ...event.data, skip: reason } });
    assert.equal(inventory.finish().errors.length === 0, reason !== "unrelated new skip");
  }
});
void test("ordinary Linux owner prerequisites are evaluated without treating a root skip as execution", () => {
  const route = {
    ...contract,
    category: "prerequisite" as const,
    requires_non_root: true as const,
  };
  for (const uid of [0, 1000]) {
    const inventory = createNodePlatformSkipInventory(
      [file],
      [],
      { [file]: route },
      { platform: "linux", uid },
    );
    inventory.capture(observe(undefined, uid === 0));
    assert.deepEqual(inventory.finish().errors, []);
    const wrong = createNodePlatformSkipInventory(
      [file],
      [],
      { [file]: route },
      { platform: "linux", uid },
    );
    wrong.capture(observe(undefined, uid !== 0));
    assert.match(wrong.finish().errors.join("\n"), /differs from intended/u);
  }
});
void test("unknown appointed-artifact availability retains its explicit skip reason and original failure", () => {
  const route = {
    ...contract,
    category: "explicit-acceptance" as const,
    skip_reason_prefix: "Appointed artifacts unavailable",
    intended_route: "Run the maintained disposable signer/verifier fixture",
  };
  const inventory = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: route },
    { platform: "linux" },
  );
  const event = observe();
  inventory.capture({
    ...event,
    data: { ...event.data, skip: "Appointed artifacts unavailable: verifier missing" },
  });
  assert.deepEqual(inventory.finish().errors, []);
  const failed = createNodePlatformSkipInventory(
    [file],
    [],
    { [file]: { ...route, required_environment: ["PORTCOVE_MISSING_FIXTURE_TOOL"] } },
    { environment: {}, platform: "linux" },
  );
  failed.capture({ ...event, type: "test:fail" });
  assert.deepEqual(failed.finish().errors, []);
});
void test("registered files cannot introduce a skip without a declaration while isolated reporter fixtures remain separate", () => {
  const inventory = createNodePlatformSkipInventory([file], [], {}, { registered: [file] });
  inventory.capture(observe(undefined, true));
  assert.match(inventory.finish().errors.join("\n"), /Unregistered skipped/u);
  const fixture = createNodePlatformSkipInventory([file], [], {}, { registered: [] });
  fixture.capture(observe(undefined, true));
  assert.deepEqual(fixture.finish().errors, []);
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
        intended_route: "contracts",
        required_environment: [],
        original_skip_reason: null,
        selected: true,
        requires_non_root: false,
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
    "import {test,describe} from 'node:test'; test('owned Linux case',()=>{}); describe('outer',()=>{test('owned nested case',()=>{}); describe.skip('hidden skip',()=>{}); describe.todo('hidden todo',()=>{});});",
  );
  const controller = path.join(root, "inspect.mjs");
  writeFileSync(
    controller,
    `
    import {run} from 'node:test';
    import {createNodePlatformSkipInventory} from ${JSON.stringify(new URL("./node-platform-skips.mts", import.meta.url).href)};
    const file=process.argv[2];
    const filtered=process.argv[3]==='filtered';
    const routes=[${JSON.stringify(contract)},{...${JSON.stringify(contract)},suite:'outer',cases:['owned nested case']}];
    const inventory=createNodePlatformSkipInventory([file],filtered?['--test-name-pattern=outer']:[],{'owned.test.mjs':routes},{root:${JSON.stringify(root)},platform:'linux'});
    const nativeMarkers=[];
    for await(const event of run({files:[file],...(filtered?{testNamePatterns:[/outer/]}:{})})) {
      const data=event.data;
      if((event.type==='test:pass'||event.type==='test:fail') && data?.details?.type==='suite') {
        if(data.skip===true||typeof data.skip==='string') nativeMarkers.push('skip:'+data.name+':'+data.nesting);
        if(data.todo===true||typeof data.todo==='string') nativeMarkers.push('todo:'+data.name+':'+data.nesting);
      }
      inventory.capture(event);
    }
    console.log(JSON.stringify({...inventory.finish(),nativeMarkers:nativeMarkers.sort()}));
  `,
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  for (const mode of ["unfiltered", "filtered"]) {
    const result = spawnSync(process.execPath, [controller, fixture, mode], {
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
        "contracts" in observed &&
        "nativeMarkers" in observed,
    );
    assert.deepEqual(observed.nativeMarkers, ["skip:hidden skip:1", "todo:hidden todo:1"]);
    assert.deepEqual(observed.errors, ["Unregistered skipped or todo suite in owned.test.mjs"]);
    assert.ok(Array.isArray(observed.contracts) && observed.contracts.length === 2);
    const nested: unknown = observed.contracts[1];
    assert.ok(isRecord(nested));
    assert.equal(nested.observations, 1);
    assert.equal(nested.selected, true);
  }
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
  assert.deepEqual(parsed.platformSkips, { [file]: [contract] });
  assert.deepEqual(parsed.qualificationOwners, { [file]: { "linux-x86_64": "contracts" } });
  for (const malformed of [
    { ...contract, owner: "absent" },
    { ...contract, platform: "unknown" },
    { ...contract, prerequisite: "" },
    { ...contract, reason: "" },
    { ...contract, cases: [] },
    { ...contract, cases: ["same", "same"] },
    { ...contract, unexpected: true },
    { ...contract, suite: "" },
    { ...contract, suite: [] },
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
