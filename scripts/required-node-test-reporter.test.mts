import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { isRecord } from "./runtime-values.mts";

const reporter = new URL("./required-node-test-reporter.mts", import.meta.url).href;

function execute(
  context: TestContext,
  sources: Record<string, string>,
  flags: string[] = [],
  transform?: string,
) {
  let unproven = false;
  const root = disposableDirectory(context, path.join(tmpdir(), "portcove-required-node-"), {
    drain() {
      assert.ok(!unproven, `Node fixture child exit unproven; retained ${root}`);
    },
  });
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, name + ".test.mjs");
    writeFileSync(file, source);
    return file;
  });
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  let selectedReporter = reporter;
  if (transform) {
    const wrapper = path.join(root, "reporter.mjs");
    writeFileSync(
      wrapper,
      `import required from ${JSON.stringify(reporter)};
      export default async function* report(source) {
        async function* altered() {
          for await (const event of source) { ${transform} }
        }
        yield* required(altered());
      }`,
    );
    selectedReporter = pathToFileURL(wrapper).href;
  }
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=5000", `--test-reporter=${selectedReporter}`, ...flags, ...files],
    { cwd: root, env: environment, encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  if (result.error || result.signal) unproven = true;
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const rows = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("Node test execution inventory: "));
  assert.equal(rows.length, 1, result.stdout + result.stderr);
  const inventory: unknown = JSON.parse(rows[0]!.slice("Node test execution inventory: ".length));
  assert.ok(isRecord(inventory));
  return { ...result, inventory, files };
}

void test("required Node execution preserves parameter instances, suites and explicit individual skips", (context) => {
  const result = execute(
    context,
    {
      cases: `import test, {describe} from 'node:test';
      import assert from 'node:assert/strict';
      for (const value of [1,2]) test('parameter',()=>assert.ok(value));
      test('intentional',{skip:'covered by the owning platform route'},()=>{});
      describe('group',()=>test('nested',()=>{}));`,
    },
    ["--test-name-pattern", "parameter|intentional|group|nested"],
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.inventory.complete, true);
  assert.equal(result.inventory.passed, 3);
  assert.equal(result.inventory.skipped, 1);
  assert.deepEqual(result.inventory.filters, [
    "--test-name-pattern",
    "parameter|intentional|group|nested",
  ]);
  assert.match(String(result.inventory.discovery_case_inventory), /unavailable/u);
  assert.match(String(result.inventory.selected_case_inventory), /unavailable/u);
});

void test("a stale Node name filter refuses the successful file wrapper after draining native output", (context) => {
  const result = execute(
    context,
    { cases: "import test from 'node:test'; test('actual contract',()=>{});" },
    ["--test-name-pattern=renamed-away"],
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 0);
  assert.equal(result.inventory.native_failure, false);
  assert.equal(result.inventory.complete, false);
  assert.match(result.stdout, /Node test file observation:/u);
  assert.match(result.stderr, /Required Node family has no executed cases/u);
});

void test("an empty Node file cannot substitute for an executed test definition", (context) => {
  const result = execute(context, { empty: "" });
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 0);
  assert.equal(result.inventory.complete, false);
  assert.match(result.stderr, /Required Node family has no executed cases/u);
});

void test("a skipped-only Node family remains distinct from an accidental zero-match selection", (context) => {
  const result = execute(context, {
    cases: `import test from 'node:test';
    test('platform',{skip:'the intended platform must execute this family'},()=>{});
    test.todo('pending contract');`,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 0);
  assert.equal(result.inventory.skipped, 1);
  assert.equal(result.inventory.todo, 1);
  assert.match(result.stderr, /only skipped or todo cases/u);
  assert.match(result.stdout, /the intended platform must execute this family/u);
});

void test("the required Node gate preserves primary assertion failure output and native status", (context) => {
  const result = execute(context, {
    cases: `import test from 'node:test';
    import assert from 'node:assert/strict'; test('original failure',()=>assert.fail('primary-failure-identity'));`,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.inventory.failed, 1);
  assert.equal(result.inventory.native_failure, true);
  assert.match(result.stdout, /primary-failure-identity/u);
  assert.doesNotMatch(result.stderr, /Required Node family/u);
});

void test("the required Node gate preserves abnormal worker exit without counting it as a case", (context) => {
  const result = execute(context, { worker: "process.exit(7);" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.inventory.passed, 0);
  assert.equal(result.inventory.failed, 0);
  assert.equal(result.inventory.native_failure, true);
  assert.match(result.stdout, /Worker process failure: .*"exitCode":7/u);
  assert.doesNotMatch(result.stderr, /Required Node family/u);
});

void test("filtered multi-file Node families retain zero-match file summaries beside actual execution", (context) => {
  const result = execute(
    context,
    {
      selected: "import test from 'node:test'; test('selected contract',()=>{});",
      filtered: "import test from 'node:test'; test('other contract',()=>{});",
    },
    ["--test-name-pattern=selected contract"],
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.inventory.passed, 1);
  assert.equal(result.inventory.complete, true);
  assert.deepEqual(result.inventory.requested_files, result.files);
  const files = result.inventory.files;
  assert.ok(Array.isArray(files) && files.length === 2);
  assert.ok(files.every((file: unknown) => isRecord(file) && file.observed === true));
});

void test("lost Node case outcomes refuse despite a nonempty surviving case and successful native counts", (context) => {
  const result = execute(
    context,
    {
      cases: `import test from 'node:test';
    test('first',()=>{}); test('second',()=>{});`,
    },
    [],
    `if (event.type === 'test:pass' && event.data.entryFile && event.data.name === 'first') continue;
     yield event;`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 1);
  assert.equal(result.inventory.native_failure, false);
  assert.match(result.stderr, /outcomes differ from the native entry-file test count/u);
});

void test("duplicate Node terminal events cannot inflate executed instance counts", (context) => {
  const result = execute(
    context,
    { cases: "import test from 'node:test'; test('actual',()=>{});" },
    [],
    `yield event;
     if (event.type === 'test:pass' && event.data.entryFile) yield event;`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 1);
  assert.match(result.stderr, /Duplicate Node case execution instance/u);
});

void test("missing Node terminal summary refuses after preserving the actual successful case", (context) => {
  const result = execute(
    context,
    { cases: "import test from 'node:test'; test('actual',()=>{});" },
    [],
    `if (event.type === 'test:summary' && event.data.file === undefined) continue;
     yield event;`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 1);
  assert.match(result.stderr, /no terminal runner summary/u);
});

void test("a missing Node file summary cannot conceal a dropped case behind a surviving pass", (context) => {
  const result = execute(
    context,
    {
      cases: `import test from 'node:test';
    test('first',()=>{}); test('second',()=>{});`,
    },
    [],
    `if (event.type === 'test:pass' && event.data.entryFile && event.data.name === 'first') continue;
     if (event.type === 'test:summary' && event.data.file !== undefined) continue;
     yield event;`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 1);
  assert.equal(result.inventory.native_failure, false);
  assert.match(result.stderr, /no valid native entry-file summary/u);
});

void test("malformed Node file summaries stay incomplete rather than disappearing from reconciliation", (context) => {
  const result = execute(
    context,
    { cases: "import test from 'node:test'; test('actual',()=>{});" },
    [],
    `if (event.type === 'test:summary' && event.data.file !== undefined) {
       yield { ...event, data: { ...event.data, counts: { ...event.data.counts, tests: 'invalid' } } };
       continue;
     }
     yield event;`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.inventory.passed, 1);
  assert.match(result.stderr, /Malformed Node entry-file summary/u);
});

void test("skip-registry reporting failure retains the original native failure", async () => {
  const { createNodeExecutionInventory } = await import("./required-node-test-reporter.mts");
  const inventory = createNodeExecutionInventory(["scripts/fixture.test.mts"], [], {
    registryError: "controlled ownership read failure",
  });
  inventory.capture({
    type: "test:fail",
    data: { details: { error: { failureType: "testCodeFailure" } } },
  } as unknown as import("node:test/reporters").TestEvent);
  const result = inventory.finish();
  assert.equal(result.native_failure, true);
  assert.equal(result.complete, false);
  assert.ok(result.errors.includes("controlled ownership read failure"));
});
