import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { slowTestThresholdMs } from "./test-duration-reporter.mjs";

import { spawnCommand } from "./dev-storage.mjs";
import { fileURLToPath } from "node:url";

export function completeRelatedUiCoverage(report, run = spawnCommand) {
  const measurement = checkVitestDurations(report, { allowEmpty: true });
  if (!Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < report.numPassedTests)
    throw new Error("Incomplete frontend test report");
  if (measurement.count === 0) {
    console.log("No related tests matched; running the complete frontend unit suite.");
    const result = run("corepack", ["pnpm", "test"], {
      cwd: fileURLToPath(new URL("../apps/desktop/", import.meta.url)),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Complete frontend fallback failed: ${result.status ?? "unknown"}`);
  }
  return measurement;
}

export function checkVitestDurations(report, options = {}) {
  if (report.success !== true) throw new Error("Vitest did not report a successful run");
  let count = 0;
  let longest = 0;
  const slow = [];
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "passed") continue;
      if (!Number.isFinite(test.duration) || test.duration < 0) {
        throw new Error(`Missing duration for ${test.fullName}`);
      }
      if (test.duration > slowTestThresholdMs) {
        slow.push({ name: test.fullName, duration: test.duration });
      }
      count++;
      longest = Math.max(longest, test.duration);
    }
  }
  if (count !== report.numPassedTests || (count === 0 && !options.allowEmpty))
    throw new Error("Incomplete Vitest timing report");
  return { count, longest, slow };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const reportPath = args.shift();
  const allowEmpty = args.length === 1 && args[0] === "--allow-empty";
  const fullOnEmpty = args.length === 1 && args[0] === "--full-suite-on-empty";
  if (!reportPath || (args.length > 0 && !allowEmpty && !fullOnEmpty))
    throw new Error(
      "usage: check-vitest-durations.mjs <report> [--allow-empty|--full-suite-on-empty]",
    );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = fullOnEmpty
    ? completeRelatedUiCoverage(report)
    : checkVitestDurations(report, { allowEmpty });
  for (const test of result.slow) console.warn(`Slow UI test: ${test.name}: ${test.duration}ms`);
  console.log(`${result.count} UI tests measured; longest ${result.longest.toFixed(1)}ms`);
}
