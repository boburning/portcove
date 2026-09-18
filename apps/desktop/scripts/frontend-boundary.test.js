// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const policy = readFileSync(path.join(desktop, ".fallowrc.json"), "utf8");
const binary = path.join(desktop, "node_modules/fallow/bin/fallow");

function inspect(
  sharedSource,
  featureSource = "export const value = 2; export type FeatureState = { value: number };\n",
) {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-boundary-"));
  try {
    mkdirSync(path.join(root, "src/shared"), { recursive: true });
    mkdirSync(path.join(root, "src/features/workspace"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "boundary-fixture",
        type: "module",
        main: "src/index.ts",
      }),
    );
    writeFileSync(path.join(root, ".fallowrc.json"), policy);
    writeFileSync(path.join(root, "src/index.ts"), 'export * from "./shared/fixture";\n');
    writeFileSync(path.join(root, "src/shared/utility.ts"), "export const value = 1;\n");
    writeFileSync(path.join(root, "src/features/workspace/model.ts"), featureSource);
    writeFileSync(path.join(root, "src/shared/fixture.ts"), sharedSource);
    const result = spawnSync(
      process.execPath,
      [binary, "dead-code", "--root", root, "--format", "json", "--quiet"],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    expect([0, 1]).toContain(result.status);
    const report = JSON.parse(result.stdout);
    expect(report.kind).toBe("dead-code");
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("allows shared-to-shared imports using the actual maintained boundary policy", () => {
  const report = inspect('export { value } from "./utility";\n');
  expect(report.boundary_violations).toEqual([]);
});

it("allows feature-to-shared imports", () => {
  const report = inspect(
    'export { value } from "./utility";',
    'export { value } from "../../shared/utility";',
  );
  expect(report.boundary_violations).toEqual([]);
});

it.each([
  'import { value } from "../features/workspace/model"; export { value };',
  'export { value } from "../features/workspace/model";',
  'export type { FeatureState } from "../features/workspace/model";',
  'export const feature = () => import("../features/workspace/model");',
])("rejects shared-to-feature dependencies: %s", (source) => {
  const report = inspect(source);
  expect(report.boundary_violations).toHaveLength(1);
  expect(report.boundary_violations[0]).toMatchObject({ from_zone: "shared", to_zone: "features" });
});
