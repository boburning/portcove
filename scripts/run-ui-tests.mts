import { resourceEntrypoint } from "./resource-command.mts";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createCiMetrics } from "./ci-metrics.mts";
import {
  resolveUiSelection,
  reconcileUiSelection,
  allowedUiSkippedFiles,
} from "./ui-test-selection.mts";
const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (mode !== "exact" && mode !== "related")
  throw new Error("Usage: run-ui-tests.mts exact|related <literal files>...");
// Validate the entire request before importing/initializing the runner.
const files = resolveUiSelection(process.argv.slice(3), path.join(root, "apps/desktop"), mode);
process.exitCode = await resourceEntrypoint("browser", async () => {
  const metrics = createCiMetrics();
  const { createVitest } = await metrics.measureAsync(
    "ui-runner-import",
    () => import("vite-plus/test/node"),
  );
  const runner = await metrics.measureAsync("ui-runner-configuration", () =>
    createVitest({
      root,
      config: path.join(root, "vite.config.ts"),
      watch: false,
      run: true,
      ...(mode === "related" ? { related: files } : {}),
    }),
  );
  const key = (file: string) =>
    process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  try {
    await metrics.measureAsync("ui-project-initialization", () => runner.standalone());
    const specifications = await metrics.measureAsync("ui-specification-selection", async () => {
      if (mode === "exact") {
        const expected = new Set(files.map(key));
        const selected = (await runner.globTestSpecifications()).filter((specification) =>
          expected.has(key(specification.moduleId)),
        );
        const discovered = selected.map((specification) => key(specification.moduleId));
        if (discovered.length !== expected.size || new Set(discovered).size !== expected.size)
          throw new Error("Requested UI files have missing or duplicate project specifications");
        return selected;
      }
      const selected = await runner.getRelevantTestSpecifications();
      if (selected.length) return selected;
      console.log("No related tests matched; running both maintained frontend projects.");
      return runner.globTestSpecifications();
    });
    const expectedFiles =
      mode === "exact" ? files : specifications.map((specification) => specification.moduleId);
    const result = await metrics.measureAsync("ui-test-execution", () =>
      runner.runTestSpecifications(specifications),
    );
    const coverage = metrics.measure("ui-selection-reconciliation", () =>
      reconcileUiSelection(
        result,
        expectedFiles,
        allowedUiSkippedFiles(expectedFiles, path.join(root, "apps/desktop")),
      ),
    );
    for (const skipped of coverage.skipped_files)
      console.log(`UI file skipped: ${skipped.file}; ${skipped.reason}`);
    console.log(
      `UI files: requested ${coverage.requested_files.length}, discovered ${coverage.discovered_files.length}, executed ${coverage.executed_files.length}; passed ${coverage.passed}, skipped ${coverage.skipped}`,
    );
  } finally {
    await metrics.measureAsync("ui-runner-close", () => runner.close());
  }

  return Number(process.exitCode ?? 0);
});
