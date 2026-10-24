import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readRustTestImpactMap,
  selectRustTestImpact,
  validateRustTestImpactMap,
  runnableImpactTests,
  runRustImpactUnion,
  selectWorkspaceRustImpact,
  runnableWorkspaceImpactTests,
  runWorkspaceRustImpact,
} from "./rust-test-impact.mts";
import { buildValidationPlan, linuxRuntimeDiagnosticsRequired } from "./validation-plan.mts";

interface FixtureTest {
  ignored: boolean;
  "filter-match": { status: string };
}
interface FixtureSuite {
  "package-name": string;
  "binary-id": string;
  status: string;
  testcases: Record<string, FixtureTest>;
}
interface FixtureInventory {
  "test-count": number;
  "rust-suites": { "portcove-core": FixtureSuite } & Record<string, FixtureSuite>;
}
function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture entry is missing");
  return value;
}
const map = readRustTestImpactMap();
const modified = (path: string) => ({ status: "M", path });

type FixtureRunner = NonNullable<
  NonNullable<Parameters<typeof runWorkspaceRustImpact>[1]>["spawnSync"]
>;
const binaryMetadata = () => ({
  "rust-build-meta": {},
  "rust-binaries": {
    "portcove-core": {
      "binary-id": "portcove-core",
      "binary-path": path.resolve("fixture-core-binary"),
    },
  },
});
const cargoMetadata = () => ({ packages: [{}], workspace_members: ["fixture"], resolve: {} });
function withMetadataFixture(run: FixtureRunner): FixtureRunner {
  return (command, args, options) => {
    if (args.includes("binaries-only"))
      return { status: 0, stdout: JSON.stringify(binaryMetadata()) };
    if (command === "cargo" && args[0] === "metadata")
      return { status: 0, stdout: JSON.stringify(cargoMetadata()) };
    return run(command, args, options);
  };
}

const workspacePlan = (files: string[]) =>
  buildValidationPlan({
    changes: files.map((file) => ({
      status: "M",
      oldMode: "100644",
      newMode: "100644",
      oldPath: file,
      newPath: file,
    })),
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
void test("Linux diagnostics omit only independent regular release-tool Rust edits", () => {
  const releaseFile = "crates/portcove-release-tools/src/definition_repository/policy.rs";
  assert.equal(linuxRuntimeDiagnosticsRequired(workspacePlan([releaseFile])), false);
  assert.equal(
    linuxRuntimeDiagnosticsRequired(
      workspacePlan([releaseFile, "crates/portcove-release-tools/tests/verification.rs"]),
    ),
    false,
  );
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".config/nextest.toml",
    "crates/portcove-release-tools/Cargo.toml",
    "crates/portcove-release-tools/build.rs",
    "crates/portcove-release-tools/src/testdata/fixture.json",
    "crates/portcove-diagnostics/src/lib.rs",
    "crates/portcove-core/src/path.rs",
    "crates/portcove-cli/src/startup.rs",
    "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
    "unknown-rust-consumer",
  ]) {
    assert.equal(linuxRuntimeDiagnosticsRequired(workspacePlan([file])), true, file);
    assert.equal(linuxRuntimeDiagnosticsRequired(workspacePlan([releaseFile, file])), true, file);
  }
  const change = workspacePlan([releaseFile]).changes[0];
  assert.ok(change);
  for (const delta of [
    { status: "D", newMode: "000000" },
    { status: "R", oldPath: "crates/portcove-core/src/previous.rs" },
    { newMode: "100755" },
  ]) {
    const plan = buildValidationPlan({
      changes: [{ ...change, ...delta }],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(linuxRuntimeDiagnosticsRequired(plan), true, JSON.stringify(delta));
  }
  const added = buildValidationPlan({
    changes: [{ ...change, status: "A", oldMode: "000000" }],
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.equal(linuxRuntimeDiagnosticsRequired(added), false);
  for (const delta of [
    { status: "C", oldPath: "crates/portcove-release-tools/src/previous.rs" },
    { oldMode: null },
  ]) {
    const blocked = buildValidationPlan({
      changes: [{ ...change, ...delta }],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(blocked.mode, "blocked");
    assert.throws(() => linuxRuntimeDiagnosticsRequired(blocked), /Blocked plan/u);
  }
  const unsafe = buildValidationPlan({
    changes: [{ ...change, newMode: "120000" }],
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.throws(() => linuxRuntimeDiagnosticsRequired(unsafe), /Blocked plan/u);
  assert.throws(() => linuxRuntimeDiagnosticsRequired(workspacePlan([])), /Blocked plan/u);
  assert.equal(
    linuxRuntimeDiagnosticsRequired(
      buildValidationPlan({ changes: [], eventName: "schedule", checkout: "b".repeat(40) }),
    ),
    true,
  );
  assert.equal(linuxRuntimeDiagnosticsRequired(workspacePlan(["docs/FAQ.md"])), false);
});

void test("Linux diagnostics exclusion retains the release-tool dependency boundary", () => {
  const root = new URL("../", import.meta.url);
  const manifests = execFileSync("git", ["ls-files", "-z", "--", "Cargo.toml", "**/Cargo.toml"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  assert.ok(manifests.includes("crates/portcove-diagnostics/Cargo.toml"));
  assert.ok(manifests.includes("crates/portcove-cli/Cargo.toml"));
  assert.ok(manifests.includes("crates/portcove-core/Cargo.toml"));
  for (const file of manifests) {
    if (file === "crates/portcove-release-tools/Cargo.toml") continue;
    const content = readFileSync(new URL(file, root), "utf8");
    const consumers =
      file === "Cargo.toml" ? content.replace(/^members\s*=\s*\[[\s\S]*?\]/mu, "") : content;
    assert.doesNotMatch(consumers, /portcove[-_]release[-_]tools/u, file);
  }
});

void test("workspace impact preserves package qualification and broad fallback boundaries", () => {
  const narrow = selectWorkspaceRustImpact(
    workspacePlan(["crates/portcove-core/src/source_report.rs"]),
  );
  assert.equal(narrow.length, 1);
  assert.match(requiredFixture(narrow[0]).filter, /package\(=portcove-core\)/u);
  assert.deepEqual(
    selectWorkspaceRustImpact(workspacePlan(["crates/portcove-core/src/types.rs"])).map(
      (g) => g.filter,
    ),
    ["package(=portcove-core)"],
  );
  for (const file of [
    "Cargo.lock",
    "unknown/input.bin",
    "crates/future-crate/src/lib.rs",
    "crates/portcove-diagnostics/src/sessions.rs",
  ])
    assert.deepEqual(
      selectWorkspaceRustImpact(workspacePlan([file])).map((g) => g.filter),
      ["all()"],
    );
  const missing = selectWorkspaceRustImpact(
    workspacePlan(["crates/portcove-core/src/source_report.rs"]),
    null,
  );
  assert.deepEqual(
    missing.map((g) => g.filter),
    ["package(=portcove-core)"],
  );
  const artwork = selectWorkspaceRustImpact(workspacePlan(["crates/portcove-core/src/artwork.rs"]));
  assert.ok(artwork.some((g) => g.packageName === "portcove-cli"));
});
void test("Windows runner and timing inputs keep mixed fixture plans workspace-wide across changes and renames", () => {
  const fixture = "crates/portcove-core/src/definition_publisher_policy_tests.rs";
  assert.deepEqual(
    selectWorkspaceRustImpact(workspacePlan([fixture])).map((group) => group.id),
    ["portcove-core:publisher-policy-fixtures"],
  );
  for (const file of ["scripts/windows-rust-tests.mts", ".config/rust-test-timing-hints.json"]) {
    for (const change of [
      { status: "M", path: file },
      { status: "A", path: file },
      { status: "D", path: file },
      { status: "R100", path: "docs/windows-test-routing.md", previousPath: file },
      { status: "R100", path: file, previousPath: "docs/windows-test-routing.md" },
    ]) {
      const label = JSON.stringify(change);
      const plan = buildValidationPlan({
        changes: [
          ...workspacePlan([fixture]).changes,
          {
            status: change.status,
            oldPath: change.previousPath ?? change.path,
            newPath: change.path,
            oldMode: change.status === "A" ? "000000" : "100644",
            newMode: change.status === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.equal(plan.mode, "fast", label);
      assert.equal(plan.fallback, null, label);
      assert.deepEqual(
        selectWorkspaceRustImpact(plan).map(({ id, filter }) => ({ id, filter })),
        [{ id: "workspace", filter: "all()" }],
        label,
      );
    }
  }
});
void test("runtime diagnostics preserve the complete fixture binary across Desktop, Core and fixture changes", () => {
  const fixture = "crates/portcove-cli/tests/runtime_diagnostics.rs";
  // Select the binary, including nested module unit tests without this name prefix.
  const expected =
    "package(=portcove-cli) & (binary(=runtime_diagnostics) | binary(=host_diagnostics) | binary(=desktop_host_diagnostics))";
  for (const file of [
    "apps/desktop/src-tauri/src/diagnostics.rs",
    "apps/desktop/src-tauri/src/host_startup.rs",
    "apps/desktop/src-tauri/src/diagnostics_writer.rs",
    "apps/desktop/src-tauri/src/diagnostics_writer_tests.rs",
    "apps/desktop/src-tauri/src/diagnostics_events.rs",
    "apps/desktop/src-tauri/src/diagnostics_events_tests.rs",
    "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
    "crates/portcove-core/src/runtime_diagnostics.rs",
    "crates/portcove-core/src/support_bundle.rs",
    "crates/portcove-core/src/operation.rs",
    "crates/portcove-core/src/service.rs",
    "crates/portcove-core/src/preparation_execution.rs",
    "crates/portcove-core/src/tool_process.rs",
    "crates/portcove-cli/tests/host_diagnostics.rs",
    "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
    fixture,
  ]) {
    const groups = selectWorkspaceRustImpact(workspacePlan([file]));
    assert.equal(groups.filter((group) => group.packageName === "portcove-cli").length, 1, file);
    assert.ok(
      groups.some((group) => group.filter === expected),
      file,
    );
    assert.equal(
      groups.some((group) => group.packageName === "portcove-desktop"),
      file.startsWith("apps/desktop/src-tauri/"),
    );
  }
  const combined = selectWorkspaceRustImpact(
    workspacePlan([
      "apps/desktop/src-tauri/src/diagnostics_writer.rs",
      "crates/portcove-cli/tests/machine_contract/artwork.rs",
    ]),
  );
  assert.ok(combined.some((group) => group.filter === expected));
  assert.ok(combined.some((group) => group.id === "portcove-cli:artwork-fixtures"));
  const alreadyCovered = selectWorkspaceRustImpact(
    workspacePlan(["apps/desktop/src-tauri/src/diagnostics_writer.rs", fixture]),
  );
  assert.equal(alreadyCovered.filter((group) => group.packageName === "portcove-cli").length, 1);
  assert.ok(
    !selectWorkspaceRustImpact(workspacePlan(["apps/desktop/src-tauri/src/unrelated.rs"])).some(
      (group) => group.packageName === "portcove-cli",
    ),
  );
});

void test("runtime diagnostics use complete CLI fallback for uncertain cross-package changes", () => {
  const writer = "apps/desktop/src-tauri/src/diagnostics_writer.rs";
  const plan = workspacePlan([writer]);
  const absentGroup = structuredClone(map);
  requiredFixture(absentGroup.packages["portcove-cli"]).groups = requiredFixture(
    absentGroup.packages["portcove-cli"],
  ).groups.filter((group) => group.id !== "runtime-diagnostics");
  for (const incomplete of [null, absentGroup]) {
    assert.equal(
      selectWorkspaceRustImpact(plan, incomplete).find(
        (group) => group.packageName === "portcove-cli",
      )?.filter,
      "package(=portcove-cli)",
    );
  }
  for (const change of [
    { status: "D", oldMode: "100644", newMode: "000000", oldPath: writer, newPath: writer },
    {
      status: "R100",
      oldMode: "100644",
      newMode: "100644",
      oldPath: writer,
      newPath: "apps/desktop/src-tauri/src/moved_writer.rs",
    },
    {
      status: "R100",
      oldMode: "100644",
      newMode: "100644",
      oldPath: "apps/desktop/src-tauri/src/former_writer.rs",
      newPath: writer,
    },
  ]) {
    const changed = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(
      selectWorkspaceRustImpact(changed).find((group) => group.packageName === "portcove-cli")
        ?.filter,
      "package(=portcove-cli)",
    );
  }
  const broad = selectWorkspaceRustImpact(
    workspacePlan([writer, "crates/portcove-cli/src/main.rs"]),
  ).filter((group) => group.packageName === "portcove-cli");
  assert.equal(broad.length, 1);
  assert.equal(broad[0]?.filter, "package(=portcove-cli)");
});
void test("workspace inventory permits multiple packages but rejects incomplete identity/count records", () => {
  const complete = inventory(["core"]);
  complete["rust-suites"]["portcove-cli"] = {
    ...complete["rust-suites"]["portcove-core"],
    "package-name": "portcove-cli",
    "binary-id": "portcove-cli",
  };
  complete["test-count"] = 2;
  assert.equal(runnableWorkspaceImpactTests(complete).size, 2);
  const filtered = structuredClone(complete);
  requiredFixture(filtered["rust-suites"]["portcove-cli"]).status = "skipped";
  requiredFixture(filtered["rust-suites"]["portcove-cli"]).testcases = {};
  filtered["test-count"] = 1;
  assert.throws(() => runnableWorkspaceImpactTests(filtered));
  assert.equal(runnableWorkspaceImpactTests(filtered, { allowSkipped: true }).size, 1);
  requiredFixture(filtered["rust-suites"]["portcove-cli"]).testcases = requiredFixture(
    complete["rust-suites"]["portcove-cli"],
  ).testcases;
  assert.throws(() => runnableWorkspaceImpactTests(filtered, { allowSkipped: true }));
  assert.throws(() => runnableWorkspaceImpactTests({ ...complete, "test-count": 3 }));
  complete["rust-suites"]["portcove-cli"]["binary-id"] = "wrong";
  assert.throws(() => runnableWorkspaceImpactTests(complete));
});
void test("workspace groups and their exact union use identical all-target build scope before guarded execution", () => {
  const calls: string[][] = [];
  const responses = [
    inventory(["a", "shared", "b"]),
    inventory(["a", "shared"]),
    inventory(["shared", "b"]),
    inventory(["a", "shared", "b"]),
  ];
  const p = workspacePlan([
    "crates/portcove-core/src/source_report.rs",
    "crates/portcove-core/src/release/observation.rs",
  ]);
  const status = runWorkspaceRustImpact(p, {
    map,
    report() {},
    spawnSync: withMetadataFixture((_command, args) => {
      calls.push(args);
      return args[1] === "list"
        ? { status: 0, stdout: JSON.stringify(responses.shift()) }
        : { status: 9 };
    }),
  });
  assert.equal(status, 9);
  for (const args of calls) {
    if (args[1] === "list") {
      assert.equal(args[2], "--binaries-metadata");
      assert.equal(args[4], "--cargo-metadata");
    } else assert.deepEqual(args.slice(2, 5), ["--locked", "--workspace", "--all-targets"]);
  }
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["list", "list", "list", "list", "run"],
  );
  for (const data of [
    [inventory(["a"]), inventory([])],
    [inventory(["a", "b"]), inventory(["a"]), inventory(["b"]), inventory(["a"])],
    [inventory(["a"]), inventory(["unexpected"])],
  ]) {
    assert.throws(() =>
      runWorkspaceRustImpact(p, {
        map,
        report() {},
        spawnSync: withMetadataFixture((_command, args) => {
          assert.equal(args[1], "list");
          return { status: 0, stdout: JSON.stringify(data.shift()) };
        }),
      }),
    );
  }
});

function inventory(names: string[]): FixtureInventory {
  return {
    "test-count": names.length,
    "rust-suites": {
      "portcove-core": {
        "package-name": "portcove-core",
        "binary-id": "portcove-core",
        status: "listed",
        testcases: Object.fromEntries(
          names.map((name) => [
            name,
            {
              ignored: false,
              "filter-match": { status: "matches" },
            },
          ]),
        ),
      },
    },
  };
}

void test("multi-group metadata prepares the original compilation scope once and cleans every terminal path", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-impact-metadata-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = workspacePlan([
    "crates/portcove-core/src/source_report.rs",
    "crates/portcove-core/src/release/observation.rs",
  ]);
  for (const kind of ["workspace", "package"] as const) {
    for (const terminal of [
      "success",
      "test-status",
      "list-error",
      "run-error",
      "transport-status",
    ] as const) {
      const prepared: [string, string[]][] = [];
      const listings: string[][] = [];
      const original = new Error(`original ${terminal}`);
      let snapshotDirectory = "";
      let runCalls = 0;
      let transportCalls = 0;
      const runner: FixtureRunner = (command, args, options) => {
        if (args.includes("binaries-only") || command === "cargo") {
          prepared.push([command, args]);
          return withMetadataFixture(() => assert.fail("unexpected preparation"))(
            command,
            args,
            options,
          );
        }
        if (args[1] === "list") {
          const files = [requiredFixture(args[3]), requiredFixture(args[5])];
          assert.equal(args[2], "--binaries-metadata");
          assert.equal(args[4], "--cargo-metadata");
          snapshotDirectory = path.dirname(files[0]!);
          assert.equal(path.dirname(files[1]!), snapshotDirectory);
          assert.equal(path.dirname(snapshotDirectory), root);
          assert.deepEqual(JSON.parse(readFileSync(files[0]!, "utf8")), binaryMetadata());
          assert.deepEqual(JSON.parse(readFileSync(files[1]!, "utf8")), cargoMetadata());
          if (listings.length) assert.deepEqual(files, listings[0]);
          listings.push(files);
          if (terminal === "list-error") return { error: original };
          return { status: 0, stdout: JSON.stringify(inventory(["shared"])) };
        }
        if (command === process.execPath) {
          transportCalls++;
          assert.deepEqual(args, ["scripts/check-transport-contract.mts"]);
          return { status: terminal === "transport-status" ? 8 : 0 };
        }
        runCalls++;
        assert.deepEqual(args.slice(0, 5), [
          "nextest",
          "run",
          "--locked",
          ...(kind === "workspace" ? ["--workspace", "--all-targets"] : ["-p", "portcove-core"]),
        ]);
        assert.ok(
          !args.includes("--binaries-metadata"),
          "execution must retain normal compilation",
        );
        if (terminal === "run-error") return { error: original };
        return { status: terminal === "test-status" ? 9 : 0 };
      };
      const invoke = () => {
        const dependencies = { map, spawnSync: runner, report() {}, inventoryTempRoot: root };
        return kind === "workspace"
          ? runWorkspaceRustImpact(plan, dependencies)
          : runRustImpactUnion(
              "portcove-core",
              ["catalog-contract", "definition-delivery"],
              dependencies,
            );
      };
      if (terminal === "list-error" || terminal === "run-error")
        assert.throws(invoke, (error) => error === original);
      else
        assert.equal(
          invoke(),
          terminal === "test-status"
            ? 9
            : terminal === "transport-status" && kind === "workspace"
              ? 8
              : 0,
        );
      assert.deepEqual(prepared, [
        [
          "cargo-nextest",
          [
            "nextest",
            "list",
            "--locked",
            ...(kind === "workspace" ? ["--workspace", "--all-targets"] : ["-p", "portcove-core"]),
            "--list-type",
            "binaries-only",
            "--message-format",
            "json",
          ],
        ],
        ["cargo", ["metadata", "--locked", "--format-version", "1"]],
      ]);
      assert.equal(listings.length, terminal === "list-error" ? 1 : kind === "workspace" ? 4 : 3);
      assert.equal(runCalls, terminal === "list-error" ? 0 : 1);
      assert.equal(
        transportCalls,
        kind === "workspace" && ["success", "transport-status"].includes(terminal) ? 1 : 0,
      );
      assert.equal(existsSync(snapshotDirectory), false);
      assert.deepEqual(readdirSync(root), []);
    }
  }
});

void test("metadata preparation refuses original process failures and incomplete identities before listing", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-impact-metadata-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = new Error("original metadata spawn failure");
  const cases: {
    stage: "binaries" | "cargo";
    result: ReturnType<FixtureRunner>;
    expected: RegExp | Error;
  }[] = [
    { stage: "binaries", result: { error: original }, expected: original },
    {
      stage: "binaries",
      result: { status: 12, stderr: "retained binary failure" },
      expected: /retained binary failure/u,
    },
    { stage: "cargo", result: { error: original }, expected: original },
    {
      stage: "cargo",
      result: { status: 13, stderr: "retained cargo failure" },
      expected: /retained cargo failure/u,
    },
    ...[
      "",
      "not-json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ "rust-build-meta": {}, "rust-binaries": {} }),
      JSON.stringify({
        ...binaryMetadata(),
        "rust-binaries": { wrong: { "binary-id": "different", "binary-path": process.execPath } },
      }),
      JSON.stringify({
        ...binaryMetadata(),
        "rust-binaries": { wrong: { "binary-id": "wrong", "binary-path": "relative" } },
      }),
    ].map((stdout) => ({
      stage: "binaries" as const,
      result: { status: 0, stdout },
      expected: /./u,
    })),
    ...[
      "null",
      "{}",
      JSON.stringify({ ...cargoMetadata(), resolve: null }),
      JSON.stringify({ ...cargoMetadata(), packages: [] }),
      JSON.stringify({ ...cargoMetadata(), workspace_members: [] }),
    ].map((stdout) => ({ stage: "cargo" as const, result: { status: 0, stdout }, expected: /./u })),
  ];
  for (const { stage, result, expected } of cases) {
    const invoke = () =>
      runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
        map,
        report() {},
        inventoryTempRoot: root,
        spawnSync(command, args, options) {
          if (stage === "binaries" || command === "cargo") return result;
          assert.ok(
            args.includes("binaries-only"),
            "invalid metadata must never reach listing or execution",
          );
          return withMetadataFixture(() => assert.fail())(command, args, options);
        },
      });
    if (expected instanceof Error) assert.throws(invoke, (error) => error === expected);
    else assert.throws(invoke, expected);
    assert.deepEqual(readdirSync(root), []);
  }
});

void test("missing or changed private metadata refuses after a listing and before the next listing or execution", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-impact-metadata-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const when of ["after-list", "between-lists", "before-run"] as const) {
    for (const mutation of ["remove", "same-length-rewrite"] as const) {
      let file = "";
      let listings = 0;
      let reports = 0;
      const mutate = () => {
        if (mutation === "remove") rmSync(file);
        else {
          const bytes = readFileSync(file);
          bytes[0] = bytes[0] === 32 ? 123 : 32;
          writeFileSync(file, bytes);
        }
      };
      assert.throws(
        () =>
          runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
            map,
            inventoryTempRoot: root,
            report() {
              reports++;
              if (
                (when === "between-lists" && reports === 1) ||
                (when === "before-run" && reports === 3)
              )
                mutate();
            },
            spawnSync: withMetadataFixture((_command, args) => {
              assert.equal(args[1], "list", "changed metadata must never reach execution");
              file = requiredFixture(args[3]);
              listings++;
              if (when === "after-list") mutate();
              return { status: 0, stdout: JSON.stringify(inventory(["shared"])) };
            }),
          }),
        /metadata changed|ENOENT/u,
      );
      assert.equal(listings, when === "before-run" ? 3 : 1);
      assert.deepEqual(readdirSync(root), []);
    }
  }
});

void test("impact union proves all groups before executing each distinct test once", () => {
  const calls: string[][] = [];
  const reports: string[] = [];
  const inventories = [
    inventory(["a", "shared"]),
    inventory(["b", "shared"]),
    inventory(["a", "b", "shared"]),
  ];
  const status = runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
    map,
    report: (message) => reports.push(message),
    spawnSync: withMetadataFixture((command, args) => {
      calls.push([command, ...args]);
      return args[1] === "list"
        ? { status: 0, stdout: JSON.stringify(inventories.shift()) }
        : { status: 7 };
    }),
  });
  assert.equal(status, 7);
  assert.deepEqual(
    calls.map((call) => call[2]),
    ["list", "list", "list", "run"],
  );
  assert.equal(
    requiredFixture(requiredFixture(calls[2]).at(-3)),
    requiredFixture(requiredFixture(calls[3]).at(-1)),
  );
  assert.match(reports.join("\n"), /union: 3 distinct runnable tests/u);
});

void test("empty groups, incomplete inventories and union drift stop before test execution", () => {
  for (const inventories of [
    [inventory(["a"]), inventory([])],
    [inventory(["a"]), inventory(["b"]), inventory(["a"])],
    [inventory(["a"]), inventory(["b"]), inventory(["a", "unexpected"])],
    [{ ...inventory(["a"]), "test-count": 2 }],
    [{ ...inventory(["a"]), "rust-suites": {} }],
  ]) {
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
        map,
        report() {},
        spawnSync: withMetadataFixture((_command, args) => {
          assert.equal(args[1], "list");
          return { status: 0, stdout: JSON.stringify(inventories.shift()) };
        }),
      }),
    );
  }
  const ignored = inventory(["ignored"]);
  requiredFixture(
    requiredFixture(ignored["rust-suites"]["portcove-core"]).testcases.ignored,
  ).ignored = true;
  assert.equal(runnableImpactTests(ignored, "portcove-core").size, 0);
  assert.throws(() => runnableImpactTests(inventory(["a"]), "wrong-package"));
});

void test("impact union rejects unknown or repeated group IDs and preserves inventory errors", () => {
  for (const ids of [["unknown", "catalog-contract"], ["catalog-contract", "catalog-contract"], []])
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ids, {
        map,
        spawnSync() {
          assert.fail();
        },
      }),
    );
  for (const result of [
    { status: 1, stderr: "inventory failure" },
    { error: new Error("spawn failed") },
    { status: 0, stdout: "invalid json" },
  ])
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
        map,
        spawnSync: withMetadataFixture(() => result),
      }),
    );
});

void test("the versioned map owns unique tracked paths and nonempty filters", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: new URL("../", import.meta.url) })
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  for (const config of Object.values(map.packages))
    for (const group of config.groups) {
      assert.ok(group.filter.length > 0);
      for (const path of group.paths) assert.ok(tracked.has(path), `${path} is not tracked`);
    }
});

void test("module-local changes select their owned groups and union mixed impacts", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    modified("crates/portcove-core/src/source_report.rs"),
    modified("crates/portcove-core/src/release/observation.rs"),
  ]);
  assert.equal(selected.mode, "focused");
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["release-discovery", "source-inspection"],
  );
  assert.match(requiredFixture(selected.groups[0]).reason, /release discovery/u);
  assert.match(requiredFixture(selected.groups[1]).reason, /source discovery/u);
});

void test("source import selects its complete family and discovery consumers", () => {
  const paths = [
    "crates/portcove-core/src/source_import.rs",
    "crates/portcove-core/src/source_import_tests.rs",
  ] as const;
  const before = structuredClone(map);
  requiredFixture(before.packages["portcove-core"]).groups = requiredFixture(
    before.packages["portcove-core"],
  ).groups.filter((group) => group.id !== "source-import");
  assert.equal(selectRustTestImpact(before, "portcove-core", paths.map(modified)).mode, "broad");
  const selected = selectRustTestImpact(map, "portcove-core", paths.map(modified));
  assert.equal(selected.mode, "focused");
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["source-import"],
  );
  assert.equal(
    requiredFixture(selected.groups[0]).filter,
    "test(/^source_import::tests::/) | test(/^source_discovery::tests::/)",
  );
  for (const shared of ["operation.rs", "service.rs", "database.rs", "types.rs", "lib.rs"]) {
    assert.equal(
      selectRustTestImpact(map, "portcove-core", [
        ...paths.map(modified),
        modified(`crates/portcove-core/src/${shared}`),
      ]).mode,
      "broad",
      shared,
    );
  }
  for (const change of [
    { status: "D", path: paths[0] },
    { status: "R", path: paths[0], previousPath: "crates/portcove-core/src/old_import.rs" },
    { status: "M", path: "crates/portcove-core/src/new_import_helper.rs" },
  ])
    assert.equal(selectRustTestImpact(map, "portcove-core", [change]).mode, "broad");
});

void test("publisher policy fixture changes retain nested and connected consumers", () => {
  const paths = [
    "crates/portcove-core/src/definition_publisher_policy_tests.rs",
    "crates/portcove-core/src/definition_launch_assessment_tests.rs",
    "crates/portcove-core/src/definition_authority_tests.rs",
    "crates/portcove-core/src/definition_refresh_tests.rs",
    "crates/portcove-core/src/definition_compiled_client_tests.rs",
  ];
  const expected =
    "test(/^definition_repository::tests::publisher_policy_tests::/) | test(/^definition_repository::tests::publication_connected::/)";
  for (const path of paths) {
    for (const status of ["A", "M"]) {
      const selected = selectRustTestImpact(map, "portcove-core", [{ status, path }]);
      assert.equal(selected.mode, "focused");
      assert.deepEqual(
        selected.groups.map((group) => group.id),
        ["publisher-policy-fixtures"],
      );
      assert.equal(requiredFixture(selected.groups[0]).filter, expected);
    }
    for (const change of [
      { status: "D", path },
      { status: "R", path, previousPath: "crates/portcove-core/src/former_policy_tests.rs" },
      { status: "R", path: "crates/portcove-core/src/moved_policy_tests.rs", previousPath: path },
    ])
      assert.equal(selectRustTestImpact(map, "portcove-core", [change]).mode, "broad");
    for (const shared of [
      "definition_publisher_policy.rs",
      "test_fixture.rs",
      "service.rs",
      "database.rs",
      "lib.rs",
    ]) {
      assert.equal(
        selectRustTestImpact(map, "portcove-core", [
          modified(path),
          modified(`crates/portcove-core/src/${shared}`),
        ]).mode,
        "broad",
        shared,
      );
    }
  }
  const mixed = selectRustTestImpact(map, "portcove-core", [
    modified(paths[0]!),
    modified("crates/portcove-core/src/source_import_tests.rs"),
  ]);
  assert.deepEqual(
    mixed.groups.map((group) => group.id),
    ["publisher-policy-fixtures", "source-import"],
  );
});

void test("private CLI fixtures select their full owned families and shared helper consumers", () => {
  const cases = [
    [
      "preparation.rs",
      "preparation-fixtures",
      "binary(=machine_contract) & (test(/^preparation_contract::/) | test(/^launch_contract::/))",
    ],
    [
      "launch.rs",
      "preparation-fixtures",
      "binary(=machine_contract) & (test(/^preparation_contract::/) | test(/^launch_contract::/))",
    ],
    [
      "retained_builds.rs",
      "retained-build-fixtures",
      "binary(=machine_contract) & test(/^retained_build_contract::/)",
    ],
    [
      "self_service.rs",
      "self-service-fixtures",
      "binary(=machine_contract) & test(/^self_service_contract::/)",
    ],
    [
      "definition_capabilities.rs",
      "definition-capability-fixtures",
      "binary(=machine_contract) & test(/^definition_capability_contract::/)",
    ],
    [
      "human_presentation.rs",
      "human-presentation-fixtures",
      "binary(=machine_contract) & test(/^human_presentation::/)",
    ],
  ] as const;
  for (const [file, group, filter] of cases) {
    const path = `crates/portcove-cli/tests/machine_contract/${file}`;
    for (const status of ["A", "M"]) {
      const selected = selectRustTestImpact(map, "portcove-cli", [{ status, path }]);
      assert.equal(selected.mode, "focused");
      assert.deepEqual(
        selected.groups.map((item) => item.id),
        [group],
      );
      assert.equal(requiredFixture(selected.groups[0]).filter, filter);
    }
    for (const change of [
      { status: "D", path },
      { status: "R", path, previousPath: "crates/portcove-cli/tests/old_fixture.rs" },
      { status: "R", path: "crates/portcove-cli/tests/moved_fixture.rs", previousPath: path },
    ])
      assert.equal(selectRustTestImpact(map, "portcove-cli", [change]).mode, "broad");
    for (const shared of [
      "src/main.rs",
      "src/args.rs",
      "tests/machine_contract.rs",
      "tests/new_fixture.rs",
    ]) {
      assert.equal(
        selectRustTestImpact(map, "portcove-cli", [
          modified(path),
          modified(`crates/portcove-cli/${shared}`),
        ]).mode,
        "broad",
        shared,
      );
    }
  }
  const mixed = selectRustTestImpact(map, "portcove-cli", [
    modified("crates/portcove-cli/tests/machine_contract/launch.rs"),
    modified("crates/portcove-cli/tests/machine_contract/preparation.rs"),
    modified("crates/portcove-cli/tests/machine_contract/human_presentation.rs"),
  ]);
  assert.deepEqual(
    mixed.groups.map((group) => group.id),
    ["human-presentation-fixtures", "preparation-fixtures"],
  );
  // This module exists only in Windows qualification builds; do not give it
  // an ordinary route whose runtime inventory would be empty.
  assert.equal(
    selectRustTestImpact(map, "portcove-cli", [
      modified("crates/portcove-cli/tests/machine_contract/source_discovery.rs"),
    ]).mode,
    "broad",
  );
});

void test("private library-import assertions select their whole module without narrowing implementation", () => {
  const path = "crates/portcove-core/src/import_execution_tests.rs";
  for (const status of ["A", "M"]) {
    const selected = selectRustTestImpact(map, "portcove-core", [{ status, path }]);
    assert.equal(selected.mode, "focused");
    assert.deepEqual(
      selected.groups.map((group) => group.id),
      ["library-import-fixtures"],
    );
    assert.equal(requiredFixture(selected.groups[0]).filter, "test(/^import_execution::tests::/)");
  }
  for (const shared of [
    "import_execution.rs",
    "import_journal.rs",
    "library_import.rs",
    "test_fixture.rs",
    "service.rs",
    "database.rs",
    "types.rs",
    "new_import_tests.rs",
  ]) {
    assert.equal(
      selectRustTestImpact(map, "portcove-core", [
        modified(path),
        modified(`crates/portcove-core/src/${shared}`),
      ]).mode,
      "broad",
      shared,
    );
  }
  for (const change of [
    { status: "D", path },
    { status: "R", path, previousPath: "crates/portcove-core/src/old_import_tests.rs" },
    { status: "R", path: "crates/portcove-core/src/moved_import_tests.rs", previousPath: path },
  ])
    assert.equal(selectRustTestImpact(map, "portcove-core", [change]).mode, "broad");
  const mixed = selectRustTestImpact(map, "portcove-core", [
    modified(path),
    modified("crates/portcove-core/src/source_import.rs"),
  ]);
  assert.deepEqual(
    mixed.groups.map((group) => group.id),
    ["library-import-fixtures", "source-import"],
  );
});

void test("private backup assertions own their complete module without narrowing recovery or service", () => {
  const path = "crates/portcove-core/src/service/tests/backups.rs";
  for (const status of ["A", "M"]) {
    const selected = selectRustTestImpact(map, "portcove-core", [{ status, path }]);
    assert.equal(selected.mode, "focused");
    assert.deepEqual(
      selected.groups.map((group) => group.id),
      ["backup-fixtures"],
    );
    assert.equal(requiredFixture(selected.groups[0]).filter, "test(/^service::tests::backups::/)");
  }
  for (const shared of [
    "service/backups.rs",
    "service.rs",
    "recovery.rs",
    "operation.rs",
    "library.rs",
    "database.rs",
    "test_fixture.rs",
    "lib.rs",
    "service/tests/new_backup_tests.rs",
  ]) {
    assert.equal(
      selectRustTestImpact(map, "portcove-core", [
        modified(path),
        modified(`crates/portcove-core/src/${shared}`),
      ]).mode,
      "broad",
      shared,
    );
  }
  for (const change of [
    { status: "D", path },
    { status: "R", path, previousPath: "crates/portcove-core/src/old_backup_tests.rs" },
    { status: "R", path: "crates/portcove-core/src/moved_backup_tests.rs", previousPath: path },
  ])
    assert.equal(selectRustTestImpact(map, "portcove-core", [change]).mode, "broad");
  const mixed = selectRustTestImpact(map, "portcove-core", [
    modified(path),
    modified("crates/portcove-core/src/source_import_tests.rs"),
  ]);
  assert.deepEqual(
    mixed.groups.map((group) => group.id),
    ["backup-fixtures", "source-import"],
  );
});

void test("artwork resolution owns all direct and transfer consumers with conservative shared fallback", () => {
  const path = "crates/portcove-core/src/artwork.rs";
  const filter =
    "test(/^artwork_tests::/) | test(/^import_execution::tests::/) | test(/^library_move::tests::/) | test(/^library_transfer::tests::/)";
  for (const status of ["A", "M"]) {
    const selected = selectRustTestImpact(map, "portcove-core", [{ status, path }]);
    assert.equal(selected.mode, "focused");
    assert.deepEqual(
      selected.groups.map((group) => group.id),
      ["artwork-resolution"],
    );
    assert.equal(requiredFixture(selected.groups[0]).filter, filter);
  }
  for (const shared of [
    "artwork_store.rs",
    "artwork_image.rs",
    "artwork_ingestion.rs",
    "transfer_copy.rs",
    "import_execution.rs",
    "library_move.rs",
    "library_transfer.rs",
    "test_fixture.rs",
    "service.rs",
    "database.rs",
    "types.rs",
    "lib.rs",
    "unknown_artwork.rs",
  ]) {
    assert.equal(
      selectRustTestImpact(map, "portcove-core", [
        modified(path),
        modified(`crates/portcove-core/src/${shared}`),
      ]).mode,
      "broad",
      shared,
    );
  }
  for (const change of [
    { status: "D", path },
    { status: "R", path, previousPath: "crates/portcove-core/src/old_artwork.rs" },
    { status: "R", path: "crates/portcove-core/src/moved_artwork.rs", previousPath: path },
  ])
    assert.equal(selectRustTestImpact(map, "portcove-core", [change]).mode, "broad");
  const mixed = selectRustTestImpact(map, "portcove-core", [
    modified(path),
    modified("crates/portcove-core/src/import_execution_tests.rs"),
  ]);
  assert.deepEqual(
    mixed.groups.map((group) => group.id),
    ["artwork-resolution", "library-import-fixtures"],
  );
  assert.equal(requiredFixture(mixed.groups[0]).filter, filter);
  const retained = selectRustTestImpact(map, "portcove-core", [
    modified(path),
    modified("crates/portcove-core/src/installed_contract.rs"),
  ]);
  assert.deepEqual(
    retained.groups.map((group) => group.id),
    ["artwork-resolution", "definition-delivery"],
  );
});

void test("source import mixed with inspection preserves both groups and overlapping consumers", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    modified("crates/portcove-core/src/source_import.rs"),
    modified("crates/portcove-core/src/source_discovery.rs"),
  ]);
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["source-import", "source-inspection"],
  );
  for (const group of selected.groups) assert.match(group.filter, /source_discovery::tests::/u);
});

void test("cross-cutting, manifest, unmapped addition, rename, and deletion changes use the broad fallback", () => {
  for (const change of [
    modified("crates/portcove-core/src/types.rs"),
    modified("crates/portcove-core/Cargo.toml"),
    { status: "A", path: "crates/portcove-core/src/new_module.rs" },
    {
      status: "R",
      path: "crates/portcove-core/src/source_report.rs",
      previousPath: "crates/portcove-core/src/old_report.rs",
    },
    { status: "D", path: "crates/portcove-core/src/source_report.rs" },
  ]) {
    const selected = selectRustTestImpact(map, "portcove-core", [change]);
    assert.equal(selected.mode, "broad", JSON.stringify(change));
    assert.match(selected.reason, /complete portcove-core test inventory/u);
  }
});

void test("an explicitly mapped addition uses its reviewed focused group", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    { status: "A", path: "crates/portcove-core/catalog/catalog-current-authoring.json" },
  ]);
  assert.equal(selected.mode, "focused");
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["catalog-contract"],
  );
  assert.match(selected.reason, /added or modified Rust path/u);
});

void test("one unmapped path makes an otherwise focused mixed change broad", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    modified("crates/portcove-core/src/source_report.rs"),
    modified("crates/portcove-core/src/service.rs"),
  ]);
  assert.equal(selected.mode, "broad");
  assert.match(selected.reason, /service\.rs is outside the explicit focused map/u);
});

void test("adding explicit ownership turns a representative broad fixture into a focused group", () => {
  const fixture = modified("crates/portcove-core/src/source_report.rs");
  const withoutOwnership = structuredClone(map);
  const sourceGroup = requiredFixture(
    requiredFixture(withoutOwnership.packages["portcove-core"]).groups.find(
      (group) => group.id === "source-inspection",
    ),
  );
  sourceGroup.paths = sourceGroup.paths.filter((path) => path !== fixture.path);
  assert.equal(selectRustTestImpact(withoutOwnership, "portcove-core", [fixture]).mode, "broad");
  assert.equal(selectRustTestImpact(map, "portcove-core", [fixture]).mode, "focused");
});

void test("missing package ownership and malformed maps fail closed", () => {
  assert.equal(selectRustTestImpact(null, "portcove-core", [modified("any.rs")]).mode, "broad");
  const selected = selectRustTestImpact(map, "future-package", [modified("future/src/lib.rs")]);
  assert.equal(selected.mode, "broad");
  assert.match(selected.reason, /no focused Rust test-impact contract/u);
  assert.throws(
    () => validateRustTestImpactMap({ schema_version: 2, packages: {} }),
    /unsupported Rust test-impact schema/u,
  );
  assert.throws(
    () =>
      validateRustTestImpactMap({
        schema_version: 1,
        packages: {
          sample: {
            path_prefix: "sample/",
            broad_reason: "fallback",
            groups: [
              { id: "same", reason: "one", filter: "test(one)", paths: ["sample/a.rs"] },
              { id: "same", reason: "two", filter: "test(two)", paths: ["sample/b.rs"] },
            ],
          },
        },
      }),
    /duplicate Rust test-impact group/u,
  );
  assert.throws(
    () =>
      validateRustTestImpactMap({
        schema_version: 1,
        packages: {
          sample: {
            path_prefix: "sample/",
            broad_reason: "fallback",
            groups: [
              {
                id: "first",
                reason: "one",
                filter: "test(one)",
                paths: ["sample/a.rs"],
              },
              {
                id: "second",
                reason: "two",
                filter: "test(two)",
                paths: ["sample/a.rs"],
              },
            ],
          },
        },
      }),
    /duplicate Rust test-impact path/u,
  );
});

void test("the guarded Rust baseline compares live schemas only after selected tests pass", () => {
  const calls: [string, string[]][] = [];
  const status = runWorkspaceRustImpact(workspacePlan(["Cargo.lock"]), {
    map,
    report() {},
    spawnSync(command, args) {
      calls.push([command, args]);
      return args[1] === "list"
        ? { status: 0, stdout: JSON.stringify(inventory(["one"])) }
        : { status: args[0] === "scripts/check-transport-contract.mts" ? 8 : 0 };
    },
  });
  assert.equal(status, 8);
  assert.deepEqual(requiredFixture(calls.at(-1)), [
    process.execPath,
    ["scripts/check-transport-contract.mts"],
  ]);
});
