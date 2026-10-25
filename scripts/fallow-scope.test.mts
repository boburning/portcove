import config from "../.fallow-tooling.json" with { type: "json" };
import desktopConfig from "../apps/desktop/.fallowrc.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
import type { UnusedFileFinding } from "fallow/types";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.join(root, "node_modules/fallow/bin/fallow");

function analyze(
  directory: string,
  args: readonly string[],
  configuration = ".fallow-tooling.json",
): unknown {
  const result = spawnSync(
    process.execPath,
    [
      binary,
      "--root",
      directory,
      "--config",
      path.join(directory, configuration),
      "--threads",
      "2",
      "--format",
      "json",
      "--quiet",
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return JSON.parse(result.stdout);
}

function record(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function values(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function findingPath(value: unknown): UnusedFileFinding["path"] {
  const candidate = typeof value === "string" ? value : record(value).path;
  assert.ok(typeof candidate === "string");
  return candidate;
}
function inventoryReport(value: unknown) {
  const report = record(value);
  return {
    entry_points: values(report.entry_points).map((entry) => ({ path: findingPath(entry) })),
    files: values(report.files).map(findingPath),
    plugins: values(report.plugins).map((entry) => {
      const name = record(entry).name;
      assert.ok(typeof name === "string");
      return { name };
    }),
  };
}
function deadCodeReport(value: unknown) {
  const report = record(value);
  const violations = report.boundary_violations;
  assert.ok(violations === undefined || Array.isArray(violations));
  return {
    unused_files: values(report.unused_files).map(findingPath),
    ...(violations === undefined ? {} : { boundary_violations: values(violations) }),
  };
}

function maintainedScriptReferences(file: string, source: string) {
  // Workflow path filters and other metadata do not execute scripts. Parsing also
  // resolves folded commands, doubled quotes and shared anchored steps.
  const sources = file.startsWith(".github/workflows/")
    ? Object.values(record(record(parseYaml(source)).jobs)).flatMap((job) =>
        values(record(job).steps ?? []).flatMap((step) => {
          const run = record(step).run;
          if (run === undefined) return [];
          assert.ok(typeof run === "string");
          return [run];
        }),
      )
    : [source];
  // Inline Node imports are dependencies.
  // Match each occurrence so a direct command for the same file still requires an entry.
  return sources.flatMap((command) =>
    [
      ...command
        .replace(/^import .* from .*$/gm, "")
        .matchAll(
          /(\bimport\s*\(\s*['"](?:\.\/)?)?((?:\.\.\/\.\.\/)?(?:apps\/desktop\/)?scripts\/[A-Za-z0-9_./*-]+\.(?:[mc]?[jt]s|tsx))/g,
        ),
    ].map(([, imported, target]) => ({ target: target!, imported: imported !== undefined })),
  );
}

void test("workflow script discovery distinguishes path filters and imports from commands", () => {
  const source = `
on:
  push:
    paths: [scripts/helper.mts, scripts/filter-only.mts]
jobs:
  example:
    steps:
      - run: node --input-type=module -e "await (await
          import('./scripts/helper.mts')).check()"
      - run: 'node --input-type=module -e "await (await
          import(''./scripts/helper.mts'')).check()"'
      - &command
        run: node scripts/helper.mts
      - *command
      - run: |
          node --input-type=module -e 'await import("./scripts/other.mts")'; node scripts/after.mts
`;
  assert.deepEqual(maintainedScriptReferences(".github/workflows/fixture.yml", source), [
    { target: "scripts/helper.mts", imported: true },
    { target: "scripts/helper.mts", imported: true },
    { target: "scripts/helper.mts", imported: false },
    { target: "scripts/helper.mts", imported: false },
    { target: "scripts/other.mts", imported: true },
    { target: "scripts/after.mts", imported: false },
  ]);
});

// Inventory is inexpensive graph discovery, not the full qualification analysis.
void test("tooling graph includes maintained command entries without promoting helpers to roots", () => {
  const inventory = inventoryReport(
    analyze(root, ["list", "--entry-points", "--files", "--plugins"]),
  );
  const entries = new Set(inventory.entry_points.map((entry) => entry.path));
  const graphFiles = new Set(inventory.files);
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.trim().split(/\r?\n/);
  const maintainedCommands = files.filter(
    (file: string) =>
      file === "justfile" ||
      file.endsWith("package.json") ||
      file.startsWith(".github/workflows/") ||
      file === "vite.config.ts",
  );
  for (const file of maintainedCommands) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const reference of maintainedScriptReferences(file, source)) {
      let target = reference.target;
      if (file === "apps/desktop/package.json")
        target = target.startsWith("../../") ? target.slice(6) : `apps/desktop/${target}`;
      if (files.includes(target)) {
        assert.ok(
          graphFiles.has(target),
          `${file} reference is absent from Fallow files: ${target}`,
        );
        if (!reference.imported)
          assert.ok(
            entries.has(target),
            `${file} command is absent from Fallow entries: ${target}`,
          );
      }
    }
  }
  for (const representative of [
    "scripts/local-validation",
    "scripts/roadmap",
    "scripts/check-fallow-report.test",
    "scripts/checked-git",
    "scripts/generate-catalog",
    "scripts/migrate-catalog-schema2",
    "apps/desktop/public/theme-bootstrap",
    "scripts/fallow-summary.test",
    "scripts/container-entry",
    "scripts/container-build-entry",
    "scripts/container-build",
    "scripts/rust-test-tree-supervisor",
    "scripts/daily-discovery",
    "scripts/qualify-semantic-isolation",
    "scripts/release-reviewed-inputs",
    "apps/desktop/scripts/browser-script.test",
    "apps/desktop/scripts/desktop-controller-test.test",
    "apps/desktop/scripts/desktop-source-dialog-test.test",
    "apps/desktop/src/main",
  ]) {
    assert.ok(
      [...entries].some(
        (entry: string) => entry.replace(/\.(?:[mc]?[jt]s|tsx)$/, "") === representative,
      ),
      `missing representative entry: ${representative}`,
    );
  }
  assert.ok(graphFiles.has("scripts/release-authority-configuration.mts"));
  assert.ok(
    !entries.has("scripts/release-authority-configuration.mts"),
    "inline workflow imports must remain dependencies",
  );
  for (const plugin of ["vitest", "typescript", "vite", "tailwind"])
    assert.ok(
      inventory.plugins.some((entry) => entry.name === plugin),
      `missing ${plugin} discovery`,
    );
});

void test("tooling graph follows cross-root consumers and still finds an unreferenced module", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-scope-"));
  function put(name: string, contents: string) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  try {
    put(".fallow-tooling.json", JSON.stringify(config));
    put(
      "package.json",
      JSON.stringify({
        private: true,
        type: "module",
        workspaces: ["apps/desktop"],
        scripts: { build: "node scripts/local-validation.mts" },
      }),
    );
    put(
      "scripts/local-validation.mts",
      'import { helper } from "./helper.mjs"; console.log(helper);',
    );
    put("scripts/helper.mjs", "export const helper = 1;");
    put("scripts/cross-root.mjs", "export const shared = 2;");
    put("scripts/orphan.mjs", "export const orphan = 3;");
    put(
      "apps/desktop/package.json",
      JSON.stringify({ private: true, type: "module", scripts: { test: "node src/main.mjs" } }),
    );
    put(
      "apps/desktop/src/main.mjs",
      'import { shared } from "../../../scripts/cross-root.mjs"; console.log(shared);',
    );
    put("work/generated.mjs", "export const generated = 4;");
    const report = deadCodeReport(analyze(directory, ["dead-code"]));
    const unused = report.unused_files;
    assert.ok(unused.includes("scripts/orphan.mjs"), JSON.stringify(report));
    for (const retained of [
      "scripts/helper.mjs",
      "scripts/cross-root.mjs",
      "apps/desktop/src/main.mjs",
      "work/generated.mjs",
    ])
      assert.ok(!unused.includes(retained), `${retained} was incorrectly unused`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("Desktop unit-test discovery retains test roots without promoting production helpers", () => {
  const actual = inventoryReport(
    analyze(
      path.join(root, "apps/desktop"),
      ["list", "--entry-points", "--files", "--plugins"],
      ".fallowrc.json",
    ),
  );
  const actualEntries = new Set(actual.entry_points.map((entry) => entry.path));
  for (const file of [
    "scripts/browser-script.test.mts",
    "scripts/desktop-controller-test.test.mts",
    "scripts/desktop-source-dialog-test.test.mts",
  ])
    assert.ok(actualEntries.has(file), `missing maintained Desktop test root: ${file}`);
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-desktop-tests-"));
  function put(name: string, contents: string) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  try {
    put(".fallow-tooling.json", JSON.stringify(desktopConfig));
    put("package.json", JSON.stringify({ type: "module", main: "src/main.ts" }));
    put("src/main.ts", "console.log('production');");
    put("scripts/helper.ts", "export const helper = 1;");
    put("scripts/orphan.mts", "export const orphan = 2;");
    const tests = [
      "scripts/browser-script.test.mts",
      "scripts/desktop-controller-test.test.mts",
      "scripts/desktop-source-dialog-test.test.mts",
      "scripts/nested/example.test.mts",
      "scripts/nested/example.test.ts",
    ];
    for (const file of tests) {
      const helper = file.includes("/nested/") ? "../helper" : "./helper";
      put(file, `import { helper } from "${helper}"; console.log(helper);`);
    }
    const inventory = inventoryReport(
      analyze(directory, ["list", "--entry-points", "--files", "--plugins"]),
    );
    const entries = new Set(inventory.entry_points.map((entry) => entry.path));
    for (const file of tests) assert.ok(entries.has(file), `missing Desktop test root: ${file}`);
    assert.ok(!entries.has("scripts/helper.ts"), "test helpers must remain dependencies");
    const unused = deadCodeReport(analyze(directory, ["dead-code"])).unused_files;
    assert.ok(unused.includes("scripts/orphan.mts"), "unreachable ordinary scripts stay visible");
    for (const file of [...tests, "scripts/helper.ts"])
      assert.ok(!unused.includes(file), `test dependency incorrectly unused: ${file}`);
    const production = inventoryReport(
      analyze(directory, ["list", "--entry-points", "--files", "--plugins", "--production"]),
    );
    assert.deepEqual(
      production.entry_points.map((entry) => entry.path),
      ["src/main.ts"],
    );
    put(
      "src/shared/example.ts",
      'import { feature } from "../features/example/model"; console.log(feature);',
    );
    put("src/features/example/model.ts", "export const feature = 3;");
    put("scripts/boundary.test.mts", 'import "../src/shared/example";');
    assert.equal(
      deadCodeReport(analyze(directory, ["dead-code"])).boundary_violations?.length,
      1,
      "test discovery must preserve shared-to-feature enforcement",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("repository graph preserves the established Desktop shared-to-feature rule", () => {
  const desktop = desktopConfig;
  assert.deepEqual(config.boundaries.rules, desktop.boundaries.rules);
  assert.deepEqual(
    config.boundaries.zones,
    desktop.boundaries.zones.map((zone) => ({
      ...zone,
      patterns: zone.patterns.map((pattern) => `apps/desktop/${pattern}`),
    })),
  );
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-boundary-scope-"));
  try {
    mkdirSync(path.join(directory, "apps/desktop/src/shared"), { recursive: true });
    mkdirSync(path.join(directory, "apps/desktop/src/features/example"), { recursive: true });
    writeFileSync(path.join(directory, ".fallow-tooling.json"), JSON.stringify(config));
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module", main: "apps/desktop/src/shared/example.ts" }),
    );
    writeFileSync(
      path.join(directory, "apps/desktop/src/shared/example.ts"),
      'import { feature } from "../features/example/model"; console.log(feature);',
    );
    writeFileSync(
      path.join(directory, "apps/desktop/src/features/example/model.ts"),
      "export const feature = 1;",
    );
    const report = deadCodeReport(analyze(directory, ["dead-code"]));
    assert.ok(report.boundary_violations);
    assert.equal(report.boundary_violations.length, 1);
    writeFileSync(path.join(directory, "apps/desktop/src/shared/example.ts"), "console.log(1);");
    assert.equal(
      deadCodeReport(analyze(directory, ["dead-code"])).boundary_violations?.length ?? 0,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("native-test export credits retain outside consumers without masking other exports", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-native-consumers-"));
  function put(name: string, contents: string) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  try {
    put(".fallow-tooling.json", JSON.stringify(desktopConfig));
    put(
      "package.json",
      JSON.stringify({
        type: "module",
        main: "src/main.ts",
        devDependencies: { "axe-core": "4.13.0" },
      }),
    );
    put("src/main.ts", "console.log('production');");
    put(
      "scripts/desktop-test.mts",
      'import "../test/capture-target"; import "./native-linux-driver-http.mts"; import "./native-linux-isolated-session.mts";',
    );
    put(
      "test/capture-target.ts",
      'import axe from "axe-core"; console.log(axe); export const requireCompleteCaptureTarget = 1; export const unconsumed = 2;',
    );
    const nativeExports = [
      [
        "scripts/native-linux-driver-http.mts",
        ["privateNativeDriverAgentState", "inspectPrivateNativeDriverRequest"],
      ],
      ["scripts/native-linux-isolated-session.mts", ["createNativeNamespaceStreamCapture"]],
    ] as const;
    for (const [source, names] of nativeExports)
      put(source, [...names, "unconsumed"].map((name) => `export const ${name} = 1;`).join("\n"));
    const raw = record(analyze(directory, ["dead-code"]));
    const unused = values(raw.unused_exports).map(record);
    assert.ok(unused.some((item) => item.export_name === "unconsumed"));
    assert.ok(!unused.some((item) => item.export_name === "requireCompleteCaptureTarget"));
    for (const [source, names] of nativeExports) {
      const findings = unused.filter((item) =>
        findingPath(item).replaceAll("\\", "/").endsWith(source),
      );
      assert.ok(
        findings.some((item) => item.export_name === "unconsumed"),
        source,
      );
      for (const name of names)
        assert.ok(!findings.some((item) => item.export_name === name), `${source}: ${name}`);
    }
    assert.equal(
      values(raw.dev_dependencies_in_production).length,
      0,
      "native test dependencies must not become production requirements",
    );
    put("src/main.ts", 'import axe from "axe-core"; console.log(axe);');
    const production = record(analyze(directory, ["dead-code"]));
    assert.equal(
      values(production.dev_dependencies_in_production).length,
      1,
      "real production imports of development dependencies must remain findings",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const [source, name, consumer] of [
    [
      "scripts/desktop-bootstrap-recovery-test.mts",
      "technicalDetailHasSeparation",
      "scripts/desktop-scenarios.test.mts",
    ],
    ["scripts/transport-values.mts", "checkTransportSchemas", "scripts/transport-values.test.mts"],
    ["test/capture-target.ts", "requireCompleteCaptureTarget", "scripts/capture-target.test.mts"],
    [
      "scripts/native-linux-driver-http.mts",
      "privateNativeDriverAgentState",
      "scripts/native-linux-driver-http.test.mts",
    ],
    [
      "scripts/native-linux-driver-http.mts",
      "inspectPrivateNativeDriverRequest",
      "scripts/native-linux-driver-http.test.mts",
    ],
    [
      "scripts/native-linux-isolated-session.mts",
      "createNativeNamespaceStreamCapture",
      "scripts/release-native-linux-driver.test.mts",
    ],
  ]) {
    const text = readFileSync(path.join(root, consumer!), "utf8");
    assert.ok(
      text.includes(name!),
      `${source} export credit lost its outside consumer ${consumer}`,
    );
    assert.ok(text.includes(`apps/desktop/${source}`), `${consumer} no longer imports ${source}`);
  }
});

void test("native process member credits preserve unrelated and unconsumed member findings", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fallow-process-members-"));
  const members = ["signalCode", "stdout", "stderr"];
  function put(name: string, contents: string) {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  try {
    put(".fallow-tooling.json", JSON.stringify(desktopConfig));
    put("package.json", JSON.stringify({ type: "module", main: "src/main.ts" }));
    put("src/main.ts", "console.log('production');");
    put(
      "scripts/desktop-test.mts",
      'import { DeclaredDriver, UnrelatedDriver } from "./account-view.mts"; new DeclaredDriver(); new UnrelatedDriver();',
    );
    put(
      "scripts/account-view.mts",
      `interface NativeAccountDriverProcess {}
       export class DeclaredDriver implements NativeAccountDriverProcess {
         signalCode = null; stdout = 1; stderr = 2; unconsumed = 3;
       }
       export class UnrelatedDriver { signalCode = null; stdout = 1; stderr = 2; }`,
    );
    const findings = values(record(analyze(directory, ["dead-code"])).unused_class_members).map(
      record,
    );
    assert.ok(
      findings.some(
        (item) => item.parent_name === "DeclaredDriver" && item.member_name === "unconsumed",
      ),
    );
    for (const name of members) {
      assert.ok(
        !findings.some(
          (item) => item.parent_name === "DeclaredDriver" && item.member_name === name,
        ),
        name,
      );
      assert.ok(
        findings.some(
          (item) => item.parent_name === "UnrelatedDriver" && item.member_name === name,
        ),
        name,
      );
    }
    const withoutCredit = structuredClone(desktopConfig);
    for (const plugin of withoutCredit.framework) delete record(plugin).usedClassMembers;
    put(".fallow-tooling.json", JSON.stringify(withoutCredit));
    const uncredited = values(record(analyze(directory, ["dead-code"])).unused_class_members).map(
      record,
    );
    for (const name of members)
      assert.ok(
        uncredited.some(
          (item) => item.parent_name === "DeclaredDriver" && item.member_name === name,
        ),
        name,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const source = readFileSync(
    path.join(root, "apps/desktop/scripts/desktop-native-account-session.mts"),
    "utf8",
  );
  assert.match(
    source,
    /class AccountDriverView extends EventEmitter implements NativeAccountDriverProcess/u,
  );
  const consumer = readFileSync(
    path.join(root, "scripts/desktop-native-account-session.test.mts"),
    "utf8",
  );
  for (const name of members) assert.ok(consumer.includes(`view.${name}`), name);
});
