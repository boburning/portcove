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

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.join(root, "node_modules/fallow/bin/fallow");

function analyze(directory: string, args: readonly string[]): unknown {
  const result = spawnSync(
    process.execPath,
    [
      binary,
      "--root",
      directory,
      "--config",
      path.join(directory, ".fallow-tooling.json"),
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

// Inventory is inexpensive graph discovery, not the full qualification analysis.
void test("tooling graph includes maintained command entries without promoting helpers to roots", () => {
  const inventory = inventoryReport(
    analyze(root, ["list", "--entry-points", "--files", "--plugins"]),
  );
  const entries = new Set(inventory.entry_points.map((entry) => entry.path));
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
    const source = readFileSync(path.join(root, file), "utf8").replace(/^import .* from .*$/gm, "");
    for (const match of source.matchAll(
      /(?:\.\.\/\.\.\/)?(?:apps\/desktop\/)?scripts\/[A-Za-z0-9_./*-]+\.(?:[mc]?[jt]s|tsx)/g,
    )) {
      let target = match[0];
      if (file === "apps/desktop/package.json")
        target = target.startsWith("../../") ? target.slice(6) : `apps/desktop/${target}`;
      if (files.includes(target))
        assert.ok(entries.has(target), `${file} command is absent from Fallow entries: ${target}`);
    }
  }
  for (const representative of [
    "scripts/local-validation",
    "scripts/roadmap",
    "scripts/check-fallow-report.test",
    "scripts/generate-catalog",
    "scripts/migrate-catalog-schema2",
    "apps/desktop/public/theme-bootstrap",
    "scripts/fallow-summary.test",
    "scripts/container-entry",
    "scripts/container-build-entry",
    "scripts/container-build",
    "scripts/rust-test-tree-supervisor",
    "apps/desktop/src/main",
  ]) {
    assert.ok(
      [...entries].some(
        (entry: string) => entry.replace(/\.(?:[mc]?[jt]s|tsx)$/, "") === representative,
      ),
      `missing representative entry: ${representative}`,
    );
  }
  assert.ok(
    ![...entries].some((entry) => /^scripts\/checked-git\.(?:mjs|mts)$/.test(entry)),
    "ordinary imported helper must remain a dependency",
  );
  assert.ok(
    inventory.files.some((file) => file.replace(/\.(?:mjs|mts)$/, "") === "scripts/checked-git"),
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
