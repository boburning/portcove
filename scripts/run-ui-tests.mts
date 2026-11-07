import { resourceEntrypoint } from "./resource-command.mts";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statSync } from "node:fs";
import { resolvePhysicalPath } from "./dev-storage.mts";
import { runCheckedGit } from "./checked-git.mts";
import { createCiMetrics } from "./ci-metrics.mts";
import { retainFrontendCoverageMaps } from "./coverage-maps.mts";
import { readCoveragePacket, frontendCoverageOptions } from "./test-coverage-config.mts";
import {
  resolveUiSelection,
  reconcileUiSelection,
  allowedUiSkippedFiles,
  uiShuffleSeed,
  failedUiSpecifications,
} from "./ui-test-selection.mts";
const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (mode !== "exact" && mode !== "related" && mode !== "shuffled")
  throw new Error(
    "Usage: run-ui-tests.mts exact [--last-failed] <literal files>... | exact --last-failed | related <literal files>... | shuffled <seed> <literal test files>...",
  );
// Validate the entire request before importing/initializing the runner.
const lastFailed = mode === "exact" && process.argv[3] === "--last-failed";
if (
  lastFailed &&
  (process.env.GITHUB_ACTIONS === "true" ||
    (process.env.CI && process.env.CI !== "false" && process.env.CI !== "0") ||
    process.env.PORTCOVE_UI_COVERAGE_PACKET)
)
  throw new Error("Failed-test feedback cannot satisfy CI or coverage acceptance; use a full run");
const seed = mode === "shuffled" ? uiShuffleSeed(process.argv[3]) : undefined;
const selectionMode = mode === "related" ? "related" : "exact";
const requestedFiles = process.argv.slice(mode === "shuffled" || lastFailed ? 4 : 3);
const files =
  lastFailed && !requestedFiles.length
    ? []
    : resolveUiSelection(requestedFiles, path.join(root, "apps/desktop"), selectionMode);
if (mode === "shuffled" && files.length > 16)
  throw new Error("Shuffled UI diagnostics accept at most 16 literal test files");
if (seed !== undefined)
  console.log(`UI shuffled run: ${JSON.stringify({ seed, files, retries: "unchanged" })}`);
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
      ...frontendCoverageOptions(root),
      ...(mode === "related" ? { related: files } : {}),
      ...(seed === undefined ? {} : { sequence: { shuffle: true, seed } }),
    }),
  );
  const key = (file: string) =>
    process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  try {
    await metrics.measureAsync("ui-project-initialization", () => runner.standalone());
    if (process.env.PORTCOVE_UI_COVERAGE_PACKET)
      await retainFrontendCoverageMaps(
        readCoveragePacket(root, process.env.PORTCOVE_UI_COVERAGE_PACKET),
        runner,
      );
    const specifications = await metrics.measureAsync("ui-specification-selection", async () => {
      if (selectionMode === "exact") {
        const expected = new Set(files.map(key));
        const selected = (await runner.globTestSpecifications()).filter(
          (specification) =>
            (lastFailed && !files.length) || expected.has(key(specification.moduleId)),
        );
        const discovered = selected.map((specification) => key(specification.moduleId));
        if (
          !(lastFailed && !files.length) &&
          (discovered.length !== expected.size || new Set(discovered).size !== expected.size)
        )
          throw new Error("Requested UI files have missing or duplicate project specifications");
        if (lastFailed) {
          let replay = selected;
          try {
            const relative = path.relative(
              resolvePhysicalPath(root),
              resolvePhysicalPath(runner.viteConfig.cacheDir),
            );
            if (
              !relative ||
              path.isAbsolute(relative) ||
              relative === ".." ||
              relative.startsWith(`..${path.sep}`)
            )
              throw new Error("Failed-test cache is not physically checkout-local");
            const headLog = runCheckedGit(
              ["rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"],
              { cwd: root },
            ).trim();
            const authorityFiles = new Set([
              headLog,
              ...[
                ".node-version",
                "package.json",
                "pnpm-workspace.yaml",
                "pnpm-lock.yaml",
                "apps/desktop/package.json",
              ].map((file) => path.join(root, file)),
              ...runner.viteConfig.configFileDependencies,
              ...runner.projects.flatMap((project) => project.vite.config.configFileDependencies),
            ]);
            const oldestRun = Math.max(
              Date.now() - 6 * 60 * 60 * 1000,
              ...[...authorityFiles].map((file) => statSync(file).mtimeMs),
            );
            replay = failedUiSpecifications(
              selected,
              (spec) => runner.cache.getTestSpecificationResult(spec),
              oldestRun,
            );
          } catch {
            // Missing Git/config/cache identity leaves the full requested scope.
          }
          console.log(
            replay === selected
              ? "No complete fresh failed-test history; running the full requested scope."
              : `Failed-test feedback: replaying ${replay.length} complete files of ${selected.length}; full CI remains required.`,
          );
          return replay;
        }
        return selected;
      }
      const selected = await runner.getRelevantTestSpecifications();
      if (selected.length) return selected;
      console.log("No related tests matched; running both maintained frontend projects.");
      return runner.globTestSpecifications();
    });
    if (seed !== undefined) {
      for (const specification of specifications) {
        const sequence = specification.project.config.sequence;
        if (sequence.seed !== seed || sequence.shuffle !== true)
          throw new Error(
            "Requested UI shuffle configuration was not applied to a selected project",
          );
      }
    }
    const expectedFiles =
      selectionMode === "exact" && !lastFailed
        ? files
        : specifications.map((specification) => specification.moduleId);
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
