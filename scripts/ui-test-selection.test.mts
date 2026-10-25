import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  renameSync,
  existsSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  resolveUiSelection,
  reconcileUiSelection,
  allowedUiSkippedFiles,
  uiShuffleSeed,
} from "./ui-test-selection.mts";
import type { UiModuleObservation, UiRunObservation } from "./ui-test-selection.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  parseCoverageArguments,
  frontendCoverageOptions,
  readCoveragePacket,
  coverageCustody,
  claimCoveragePacket,
  boundedCoverageRead,
  type CoveragePacket,
} from "./test-coverage-config.mts";
import { runMeasuredCoverage, readMeasuredCoverage } from "./test-coverage.mts";
import { retainCoverageMap } from "./coverage-maps.mts";
import { baselineTestEnvironment } from "./ci-baseline.mts";
import { isRecord } from "./runtime-values.mts";

void test("shuffled diagnostics reject ambiguous or unbounded seeds before runner initialization", () => {
  for (const seed of [undefined, "", "-1", "1.5", "01", "Infinity", "4294967296", "1e2"])
    assert.throws(() => uiShuffleSeed(seed), /decimal seed/);
  assert.equal(uiShuffleSeed("0"), 0);
  assert.equal(uiShuffleSeed("4294967295"), 4294967295);
  const result = spawnSync(process.execPath, ["scripts/run-ui-tests.mts", "shuffled", "-1"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /decimal seed/);
  assert.doesNotMatch(result.stdout, /admitted|RUN|passed/);
});

void test("literal UI paths reject omissions, ambiguous filters and outside files before execution", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ui-selection-"));
  try {
    mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src", "日本語.test.tsx");
    writeFileSync(file, "fixture");
    assert.deepEqual(
      resolveUiSelection(["src/日本語.test.tsx", file, "apps/desktop/src/日本語.test.tsx"], root),
      [file],
    );
    for (const input of ["src/missing.test.tsx", "src/*.test.tsx", "--filter", "src"])
      assert.throws(() => resolveUiSelection([file, input], root), /literal|missing|regular/);
    const outside = path.join(root, "..", path.basename(root) + ".test.tsx");
    writeFileSync(outside, "fixture");
    try {
      assert.throws(() => resolveUiSelection([outside], root), /outside/);
    } finally {
      rmSync(outside);
    }
    const source = path.join(root, "src", "source.tsx");
    writeFileSync(source, "source");
    assert.throws(() => resolveUiSelection([source], root), /test file/);
    assert.deepEqual(resolveUiSelection([source], root, "related"), [source]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const one = path.resolve("one.test.tsx");
const two = path.resolve("two.test.tsx");
const suite = (
  moduleId: string,
  state: "passed" | "skipped" | "failed" = "passed",
): UiModuleObservation => ({
  moduleId,
  state: () => state,
  ok: () => ["passed", "skipped"].includes(state),
  children: { allTests: () => [{ fullName: "control", result: () => ({ state }) }] },
});
const report = (testModules: UiModuleObservation[]): UiRunObservation => ({
  testModules,
  unhandledErrors: [],
});

void test("nonempty successful partial matches cannot claim the requested selection", () => {
  assert.throws(() => reconcileUiSelection(report([suite(one)]), [one, two]), /did not run/);
  assert.throws(() => reconcileUiSelection(report([suite(two)]), [one]), /Unexpected/);
  assert.throws(() => reconcileUiSelection(report([suite(one), suite(one)]), [one]), /duplicate/);
  assert.throws(
    () => reconcileUiSelection(report([suite(one, "skipped")]), [one]),
    /wholly skipped/,
  );
  assert.throws(() => reconcileUiSelection(report([suite(one, "failed")]), [one]), /failed/);
  assert.throws(
    () =>
      reconcileUiSelection({ ...report([suite(one)]), unhandledErrors: [new Error("unhandled")] }, [
        one,
      ]),
    /unsuccessful/,
  );
  assert.throws(
    () =>
      reconcileUiSelection(report([{ ...suite(one), children: { allTests: () => [] } }]), [one]),
    /no test evidence/,
  );
});

void test("complete selections distinguish observed suites, executed suites and skipped tests", () => {
  const selected = report([suite(one), suite(two, "skipped")]);
  assert.throws(() => reconcileUiSelection(selected, [one, two]), /wholly skipped/);
  const result = reconcileUiSelection(selected, [one, two], new Map([[two, "Owned diagnostic"]]));
  assert.deepEqual(result.requested_files, [one, two]);
  assert.deepEqual(result.discovered_files, [one, two]);
  assert.deepEqual(result.executed_files, [one]);
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.skipped_files, [{ file: two, reason: "Owned diagnostic" }]);
  assert.throws(
    () => reconcileUiSelection(selected, [one, two], new Map([[two, " "]])),
    /Invalid UI skipped-file permission/,
  );
  assert.throws(
    () => reconcileUiSelection(report([suite(one)]), [one], new Map([[two, "Foreign"]])),
    /Invalid UI skipped-file permission/,
  );
  assert.throws(
    () =>
      reconcileUiSelection(report([suite(two, "skipped")]), [two], new Map([[two, "Diagnostic"]])),
    /no runnable/,
  );
});

void test("only the exact disabled browser diagnostic receives an explicit skip reason", () => {
  const root = path.resolve("desktop");
  const probe = path.join(root, "src/browser/failure-probe.browser.test.tsx");
  const ordinary = path.join(root, "src/browser/ordinary.browser.test.tsx");
  const foreign = path.resolve("other/src/browser/failure-probe.browser.test.tsx");
  assert.deepEqual([...allowedUiSkippedFiles([ordinary, foreign], root, {})], []);
  assert.deepEqual(
    [...allowedUiSkippedFiles([probe], root, { VITE_PORTCOVE_BROWSER_TRACE_PROBE: "1" })],
    [],
  );
  const permissions = allowedUiSkippedFiles([probe, ordinary, foreign], root, {});
  assert.equal(permissions.size, 1);
  assert.match(permissions.get(probe) ?? "", /diagnostic/);
});

void test("exact wrapper rejects a mixed valid/missing request before invoking its runner", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/local-validation.mts",
      "test-ui",
      "apps/desktop/src/count-messages.test.ts",
      "apps/desktop/src/components/missing.test.tsx",
    ],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or not regular/);
  assert.doesNotMatch(result.stdout, /passed|reused/);
});

function coverageFixture(t: TestContext) {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "coverage-control-"));
  const files = {
    ".node-version": process.version.slice(1) + "\n",
    ".gitignore": "work/\n",
    "scripts/decision.mts":
      'export function choose(flag: boolean): string {\n  if (flag) {\n    return "taken";\n  }\n  return "UNEXECUTED";\n}\n',
    "scripts/decision.test.mts":
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport {choose} from "./decision.mts";\ntest("takes one branch",()=>assert.equal(choose(true),"taken"));\ntest("retains maintained module mocking", async(t)=>{t.mock.module("./dependency.mts", {namedExports:{value:42}});assert.equal((await import("./dependency.mts")).value,42);});\n',
    "scripts/dependency.mts": "export const value = 0;\n",
    "scripts/decision-fixture.mts": "export const fixture = 1;\n",
    "scripts/decision.generated.mts": "export const generated = 1;\n",
    "apps/desktop/src/decision.ts": "export const decision = 1;\n",
    "apps/desktop/src/decision.test.ts": "// configuration control only\n",
    "apps/desktop/src/browser/decision.browser.test.tsx": "// configuration control only\n",
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  return root;
}

function coverageGit(root: string) {
  const emptyConfig = path.join(root, "empty-git-config");
  writeFileSync(emptyConfig, "");
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
  };
  for (const args of [
    ["init", "--initial-branch=main", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Coverage fixture",
      "-c",
      "user.email=coverage@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(root, "empty-hooks")}`,
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
}

function coveragePacket(root: string, selectedMode: "node" | "frontend-unit" | "frontend-browser") {
  const directory = path.join(root, "work/test-coverage", randomUUID());
  mkdirSync(path.join(directory, "coverage"), { recursive: true });
  mkdirSync(path.join(directory, "maps"));
  const request = parseCoverageArguments(
    selectedMode === "node"
      ? [selectedMode, "--module", "scripts/decision.mts", "--test", "scripts/decision.test.mts"]
      : [
          selectedMode,
          "--module",
          "src/decision.ts",
          "--test",
          selectedMode === "frontend-unit"
            ? "src/decision.test.ts"
            : "src/browser/decision.browser.test.tsx",
        ],
    root,
  );
  const packet: CoveragePacket = {
    format_version: 1,
    root,
    directory,
    request,
    node: process.version,
    custody: coverageCustody(directory),
  };
  const filename = path.join(directory, "request.json");
  writeFileSync(filename, JSON.stringify(packet));
  return { packet, filename };
}

void test("coverage selection refuses missing modules, fixtures, duplicates and mixed runtimes", (t) => {
  const root = coverageFixture(t);
  const valid = ["node", "--module", "scripts/decision.mts", "--test", "scripts/decision.test.mts"];
  assert.deepEqual(parseCoverageArguments(valid, root).modules, ["scripts/decision.mts"]);
  for (const module of [
    "scripts/missing.mts",
    "scripts/*.mts",
    "../outside.mts",
    "scripts/decision.test.mts",
    "scripts/decision-fixture.mts",
    "scripts/decision.generated.mts",
  ])
    assert.throws(
      () =>
        parseCoverageArguments(
          ["node", "--module", module, "--test", "scripts/decision.test.mts"],
          root,
        ),
      module,
    );
  assert.throws(
    () => parseCoverageArguments([...valid, "--module", "scripts/decision.mts"], root),
    /Duplicate/u,
  );
  assert.throws(
    () =>
      parseCoverageArguments(
        [
          "frontend-unit",
          "--module",
          "src/decision.ts",
          "--test",
          "src/browser/decision.browser.test.tsx",
        ],
        root,
      ),
    /separate/u,
  );
  assert.throws(
    () =>
      parseCoverageArguments(
        ["frontend-browser", "--module", "src/decision.ts", "--test", "src/decision.test.ts"],
        root,
      ),
    /separate/u,
  );
  assert.throws(
    () => parseCoverageArguments([...valid, "--coverage-lines", "100"], root),
    /arguments/u,
  );
});

void test("coverage refuses redirected and replaced output directories and bounds file reads", (t) => {
  const root = coverageFixture(t);
  const outside = path.join(root, "unowned-output");
  mkdirSync(outside);
  const redirected = coveragePacket(root, "node");
  const output = path.join(redirected.packet.directory, "coverage");
  renameSync(output, output + "-retained");
  symlinkSync(outside, output, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => readCoveragePacket(root, redirected.filename),
    /physical identity|redirected/u,
  );
  assert.throws(() => claimCoveragePacket(redirected.packet), /physical identity|redirected/u);
  assert.equal(existsSync(path.join(outside, "coverage-started.json")), false);
  assert.equal(existsSync(path.join(redirected.packet.directory, "coverage-started.json")), false);
  const replaced = coveragePacket(root, "node");
  const previous = path.join(replaced.packet.directory, "coverage");
  renameSync(previous, previous + "-retained");
  mkdirSync(previous);
  assert.throws(() => claimCoveragePacket(replaced.packet), /physical identity/u);
  const oversized = path.join(root, "oversized.json");
  writeFileSync(oversized, Buffer.alloc(257));
  assert.throws(() => boundedCoverageRead(oversized, 256), /exceeds byte limit/u);
  assert.equal(boundedCoverageRead(oversized, 257).length, 257);
  const limited = coveragePacket(root, "node");
  const module = path.join(root, "scripts/decision.mts");
  for (let index = 0; index < 64; index++)
    retainCoverageMap(
      limited.packet,
      module,
      "bounded control",
      { control: true },
      "budget control",
    );
  assert.throws(
    () => retainCoverageMap(limited.packet, module, "overflow", {}, "budget control"),
    /observation limit/u,
  );
  assert.equal(
    readFileSync(path.join(limited.packet.directory, "maps/00/generated.js"), "utf8"),
    "bounded control",
  );
});

void test(
  "coverage rejects a real POSIX FIFO before opening it",
  { skip: process.platform === "win32" ? "POSIX FIFO control runs on POSIX hosts" : false },
  (t) => {
    const root = coverageFixture(t);
    const fifo = path.join(root, "coverage-fifo");
    const created = spawnSync("mkfifo", [fifo], { timeout: 5000, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import assert from 'node:assert/strict';import {boundedCoverageRead} from ${JSON.stringify(new URL("./test-coverage-config.mts", import.meta.url).href)};assert.throws(()=>boundedCoverageRead(${JSON.stringify(fifo)},256),/regular file/);`,
      ],
      { timeout: 5000, encoding: "utf8", env: baselineTestEnvironment(process.env) },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  },
);

void test("coverage opt-in separates projects, preserves old evidence and leaves ordinary selection untouched", (t) => {
  assert.deepEqual(frontendCoverageOptions("absent", {}), {});
  const root = coverageFixture(t);
  for (const selectedMode of ["frontend-unit", "frontend-browser"] as const) {
    const { packet, filename } = coveragePacket(root, selectedMode);
    const options = frontendCoverageOptions(root, { PORTCOVE_UI_COVERAGE_PACKET: filename });
    assert.deepEqual(
      options.project,
      selectedMode === "frontend-unit"
        ? ["unit"]
        : ["browser", "browser-locale", "browser-forced-colors"],
    );
    assert.equal(options.coverage?.provider, "v8");
    assert.equal(options.coverage?.reportsDirectory, path.join(packet.directory, "coverage"));
    assert.equal(Object.hasOwn(options.coverage ?? {}, "thresholds"), false);
    assert.throws(
      () => frontendCoverageOptions(root, { PORTCOVE_UI_COVERAGE_PACKET: filename }),
      /EEXIST/u,
    );
  }
  const { packet, filename } = coveragePacket(root, "frontend-unit");
  const old = path.join(packet.directory, "coverage/coverage-final.json");
  writeFileSync(old, "retained failure");
  assert.throws(
    () => frontendCoverageOptions(root, { PORTCOVE_UI_COVERAGE_PACKET: filename }),
    /already contains/u,
  );
  assert.equal(readFileSync(old, "utf8"), "retained failure");
  writeFileSync(filename, JSON.stringify({ ...packet, node: "wrong-runtime" }));
  assert.throws(() => readCoveragePacket(root, filename), /runtime identity/u);
});

const executeCoverageFixture: NonNullable<Parameters<typeof runMeasuredCoverage>[2]> = async (
  execution,
) => {
  const environment = baselineTestEnvironment(execution.environment);
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, execution.args, {
    cwd: execution.root,
    env: environment,
    windowsHide: true,
    timeout: 30_000,
    stdio: ["ignore", execution.stdout, execution.stderr],
  });
  assert.equal(result.error, undefined);
  return result.status ?? 1;
};

void test(
  "actual pinned Node coverage exposes an unexecuted TypeScript branch and original source lines",
  { timeout: 60_000 },
  async (t) => {
    const root = coverageFixture(t);
    coverageGit(root);
    const request = parseCoverageArguments(
      ["node", "--module", "scripts/decision.mts", "--test", "scripts/decision.test.mts"],
      root,
    );
    const result = await runMeasuredCoverage(root, request, executeCoverageFixture);
    assert.equal(
      result.status,
      0,
      JSON.stringify(result.receipt) +
        readFileSync(path.join(result.directory, "tests.stderr.log"), "utf8"),
    );
    assert.equal(result.receipt.complete, true);
    const detail = result.receipt.coverage?.modules[0]?.detail;
    assert.ok(isRecord(detail) && Array.isArray(detail.branches));
    assert.ok(detail.branches.some((branch: unknown) => isRecord(branch) && branch.count === 0));
    const lcov = readFileSync(path.join(result.directory, "coverage/lcov.info"), "utf8");
    assert.match(lcov, /decision\.mts/u);
    assert.match(lcov, /^DA:5,0$/mu);
    const mapping = result.receipt.coverage?.mappings[0];
    assert.ok(mapping);
    const generated = readFileSync(path.join(mapping.directory, "generated.js"), "utf8");
    const map = JSON.parse(
      readFileSync(path.join(mapping.directory, "source-map.json"), "utf8"),
    ) as unknown;
    assert.ok(isRecord(map) && map.kind === "identity-utf16-offsets");
    const original = readFileSync(path.join(root, "scripts/decision.mts"), "utf8");
    assert.equal(map.mapped_prefix_length, original.length);
    assert.equal(generated.length, map.generated_length);
    assert.equal(generated.indexOf('return "UNEXECUTED"'), original.indexOf('return "UNEXECUTED"'));
    assert.equal(generated.split("\n")[4], original.split("\n")[4]);
    assert.doesNotMatch(generated, /flag: boolean/u);
    const copied = readFileSync(
      path.join(result.directory, "observed-source/scripts/decision.mts"),
    );
    assert.equal(
      createHash("sha256").update(copied).digest("hex"),
      result.receipt.source.sources.find((source) => source.file === "scripts/decision.mts")
        ?.sha256,
    );
    assert.deepEqual(
      readMeasuredCoverage({
        format_version: 1,
        root,
        directory: result.directory,
        request,
        node: process.version,
        custody: coverageCustody(result.directory),
      }).missing,
      [],
    );
    const summary = readFileSync(path.join(result.directory, "coverage/node-coverage.json"));
    writeFileSync(
      path.join(root, "scripts/decision.test.mts"),
      'import test from "node:test";\nimport {choose} from "./decision.mts";\ntest("original failed assertion",()=>{choose(true);throw new Error("ORIGINAL_FAILURE");});\n',
    );
    const failed = await runMeasuredCoverage(root, request, executeCoverageFixture);
    assert.equal(failed.status, 1);
    assert.equal(failed.receipt.original_exit_status, 1);
    assert.equal(failed.receipt.complete, false);
    assert.match(
      readFileSync(path.join(failed.directory, "tests.stdout.log"), "utf8"),
      /ORIGINAL_FAILURE/u,
    );
    assert.deepEqual(
      readFileSync(path.join(result.directory, "coverage/node-coverage.json")),
      summary,
    );
  },
);

void test(
  "compiled-source observation refuses selected-module mocks and load hooks registered after preload",
  { timeout: 60_000 },
  async (t) => {
    const root = coverageFixture(t);
    coverageGit(root);
    const request = parseCoverageArguments(
      ["node", "--module", "scripts/decision.mts", "--test", "scripts/decision.test.mts"],
      root,
    );
    for (const source of [
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("mock selected module",async(t)=>{t.mock.module("./decision.mts",{namedExports:{choose:()=>"tampered"}});assert.equal((await import("./decision.mts")).choose(),"tampered");});\n',
      `import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
registerHooks({load(url,context,next){const result=next(url,context);return url.endsWith("/decision.mts")?{...result,format:"module",source:'export function choose(){return "tampered";}'}:result;}});
test("rewrite after preload",async()=>assert.equal((await import("./decision.mts")).choose(),"tampered"));
`,
    ]) {
      writeFileSync(path.join(root, "scripts/decision.test.mts"), source);
      const result = await runMeasuredCoverage(root, request, executeCoverageFixture);
      assert.equal(result.receipt.complete, false);
      assert.notEqual(result.status, 0);
      assert.equal(result.receipt.coverage, null);
      const log = readFileSync(path.join(result.directory, "tests.stdout.log"), "utf8");
      const observations: unknown[] = log
        .split("\n")
        .filter((line) => line.startsWith("Node test case observation: "))
        .map((line) => JSON.parse(line.slice("Node test case observation: ".length)) as unknown);
      assert.ok(
        observations.some((row) => isRecord(row) && row.outcome === "passed"),
        log + readFileSync(path.join(result.directory, "tests.stderr.log"), "utf8"),
      );
    }
  },
);

void test(
  "coverage refuses missing measurements and source changes while retaining original command status",
  { timeout: 60_000 },
  async (t) => {
    const root = coverageFixture(t);
    coverageGit(root);
    const request = parseCoverageArguments(
      ["node", "--module", "scripts/decision.mts", "--test", "scripts/decision.test.mts"],
      root,
    );
    const absent = await runMeasuredCoverage(root, request, async () => 0);
    assert.equal(absent.status, 1);
    assert.equal(absent.receipt.original_exit_status, 0);
    assert.equal(absent.receipt.complete, false);
    const replaced = await runMeasuredCoverage(root, request, async (execution) => {
      const packet = readCoveragePacket(root, execution.environment.PORTCOVE_NODE_COVERAGE_PACKET!);
      const directory = path.join(packet.directory, "coverage");
      renameSync(directory, directory + "-retained");
      mkdirSync(directory);
      return 7;
    });
    assert.equal(replaced.status, 7);
    assert.equal(replaced.receipt.original_exit_status, 7);
    assert.equal(replaced.receipt.complete, false);
    assert.match(replaced.receipt.failure!, /physical identity/u);
    const retained: unknown = JSON.parse(
      readFileSync(path.join(replaced.directory, "receipt.json"), "utf8"),
    );
    assert.ok(
      isRecord(retained) && retained.original_exit_status === 7 && retained.complete === false,
    );
    writeFileSync(
      path.join(root, "scripts/decision.test.mts"),
      'import test from "node:test";\nimport {appendFileSync} from "node:fs";\nimport {choose} from "./decision.mts";\ntest("mutates selected source",()=>{choose(true);appendFileSync("scripts/decision.mts","// changed after observation\\n");});\n',
    );
    const changed = await runMeasuredCoverage(root, request, executeCoverageFixture);
    assert.equal(changed.receipt.original_exit_status, 0);
    assert.equal(changed.status, 1);
    assert.ok(changed.receipt.changed_sources.includes("scripts/decision.mts"));
    assert.equal(changed.receipt.complete, false);
  },
);
