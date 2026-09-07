import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { testBudgetMs } from "./test-duration-reporter.mjs";

export function checkVitestDurations(report) {
  if (report.success !== true) throw new Error("Vitest did not report a successful run");
  let count = 0;
  let longest = 0;
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "passed") continue;
      if (!Number.isFinite(test.duration) || test.duration < 0) {
        throw new Error(`Missing duration for ${test.fullName}`);
      }
      if (test.duration > testBudgetMs) {
        throw new Error(`${test.fullName} exceeded ${testBudgetMs}ms: ${test.duration}ms`);
      }
      count++;
      longest = Math.max(longest, test.duration);
    }
  }
  if (count === 0 || count !== report.numPassedTests) throw new Error("Incomplete Vitest timing report");
  return { count, longest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkVitestDurations(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log(`${result.count} UI tests within ${testBudgetMs}ms; longest ${result.longest.toFixed(1)}ms`);
}
