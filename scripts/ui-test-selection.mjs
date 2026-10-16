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

/** Reconcile actual public Vitest results; collection alone grants no execution coverage. */
export function reconcileUiSelection({ testModules, unhandledErrors }, files) {
  if (!Array.isArray(testModules) || !Array.isArray(unhandledErrors) || unhandledErrors.length)
    throw new Error("UI run is unsuccessful or incomplete");
  const expected = new Set(files.map((file) => identity(path.resolve(file))));
  if (!expected.size) throw new Error("UI selection is empty");
  const discovered = new Set(),
    executed = [];
  let passed = 0,
    skipped = 0;
  for (const module of testModules) {
    const key = identity(path.resolve(module.moduleId));
    if (!expected.has(key) || discovered.has(key))
      throw new Error(`Unexpected or duplicate UI suite: ${module.moduleId}`);
    discovered.add(key);
    if (!["passed", "skipped"].includes(module.state()) || !module.ok())
      throw new Error(`UI suite failed: ${module.moduleId}`);
    const tests = [...module.children.allTests()];
    if (!tests.length) throw new Error("UI suite has no test evidence");
    let ran = false;
    for (const test of tests) {
      const state = test.result().state;
      if (state === "passed") {
        passed++;
        ran = true;
      } else if (state === "skipped") skipped++;
      else throw new Error(`UI test did not finish successfully: ${test.fullName}`);
    }
    if (ran) executed.push(module.moduleId);
  }
  const missing = files.filter((file) => !discovered.has(identity(path.resolve(file))));
  if (missing.length) throw new Error(`Requested UI suites did not run: ${missing.join(", ")}`);
  if (!passed) throw new Error("UI selection has no runnable tests");
  return {
    requested_files: files,
    discovered_files: testModules.map((module) => module.moduleId),
    executed_files: executed,
    passed,
    skipped,
  };
}
