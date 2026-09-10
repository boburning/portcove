import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { slowTestThresholdMs } from "./test-duration-reporter.mjs";

export function checkVitestDurations(report) {
  if (report.success !== true)
    throw new Error("Vitest did not report a successful run");
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
  if (count === 0 || count !== report.numPassedTests)
    throw new Error("Incomplete Vitest timing report");
  return { count, longest, slow };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = checkVitestDurations(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  for (const test of result.slow)
    console.warn(`Slow UI test: ${test.name}: ${test.duration}ms`);
  console.log(
    `${result.count} UI tests measured; longest ${result.longest.toFixed(1)}ms`,
  );
}
