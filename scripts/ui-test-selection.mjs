import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const identity = (file) => (process.platform === "win32" ? file.toLowerCase() : file);

export function resolveUiSelection(files, desktopRoot, kind = "exact") {
  if (!["exact", "related"].includes(kind) || !files.length)
    throw new Error("UI selection requires literal files");
  const root = realpathSync(desktopRoot);
  const selected = new Map();
  for (const input of files) {
    if (input.startsWith("-") || /[?*{}[\]]/u.test(input))
      throw new Error(`UI selection requires a literal path: ${input}`);
    const relative = input.replaceAll("\\", "/").replace(/^apps\/desktop\//u, "");
    const file = path.resolve(root, relative);
    let actual;
    try {
      if (!lstatSync(file).isFile()) throw new Error("not a regular file");
      actual = realpathSync(file);
    } catch {
      throw new Error(`UI selection file is missing or not regular: ${input}`);
    }
    const within = path.relative(root, actual);
    if (!within || within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within))
      throw new Error(`UI selection is outside desktop: ${input}`);
    if (kind === "exact" && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(actual))
      throw new Error(`Expected a UI test file: ${input}`);
    if (kind === "related" && !/\.(?:[cm]?[jt]sx?|css)$/u.test(actual))
      throw new Error(`Expected a UI source file: ${input}`);
    selected.set(identity(actual), actual);
  }
  return [...selected.values()].sort();
}

export function reconcileUiSelection(report, files) {
  if (report.success !== true || !Array.isArray(report.testResults))
    throw new Error("UI report is unsuccessful or incomplete");
  const expected = new Set(files.map((file) => identity(path.resolve(file))));
  if (!expected.size) throw new Error("UI selection is empty");
  const discovered = new Set();
  let passed = 0;
  let skipped = 0;
  const executed = [];
  for (const suite of report.testResults) {
    if (
      typeof suite.name !== "string" ||
      !Array.isArray(suite.assertionResults) ||
      !suite.assertionResults.length
    )
      throw new Error("UI suite has no test evidence");
    const key = identity(path.resolve(suite.name));
    if (!expected.has(key) || discovered.has(key))
      throw new Error(`Unexpected or duplicate UI suite: ${suite.name}`);
    discovered.add(key);
    let ran = false;
    for (const test of suite.assertionResults) {
      if (test.status === "passed") {
        passed++;
        ran = true;
      } else if (["pending", "skipped", "todo"].includes(test.status)) skipped++;
      else throw new Error(`UI test is not successful: ${test.fullName ?? suite.name}`);
    }
    if (ran) executed.push(suite.name);
  }
  const missing = files.filter((file) => !discovered.has(identity(path.resolve(file))));
  if (missing.length) throw new Error(`Requested UI suites did not run: ${missing.join(", ")}`);
  if (!passed || passed !== report.numPassedTests || passed + skipped !== report.numTotalTests)
    throw new Error("UI selection has no runnable tests or inconsistent counts");
  return {
    requested_files: files,
    discovered_files: report.testResults.map((suite) => suite.name),
    executed_files: executed,
    passed,
    skipped,
  };
}
