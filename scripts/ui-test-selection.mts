import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TestModule, TestCase } from "vite-plus/test/node";
import { browserTraceProbe } from "../apps/desktop/src/browser/failure-probe-contract.ts";

type TestObservation = Pick<TestCase, "fullName"> & {
  result(): Pick<ReturnType<TestCase["result"]>, "state"> & { note?: string };
};
export type UiModuleObservation = Pick<TestModule, "moduleId" | "state" | "ok"> & {
  children: { allTests(): Iterable<TestObservation> };
};
export interface UiRunObservation {
  testModules: readonly UiModuleObservation[];
  unhandledErrors: readonly unknown[];
}

export interface UiSkipContract {
  category: "explicit-diagnostic";
  reason: string;
  prerequisite: string;
  intended_route: string;
  cases: readonly string[];
}

export function declaredUiSkip(file: string, desktopRoot: string): UiSkipContract | null {
  if (
    identity(path.resolve(file)) !==
    identity(path.resolve(desktopRoot, "src/browser/failure-probe.browser.test.tsx"))
  )
    return null;
  return {
    category: "explicit-diagnostic",
    reason: browserTraceProbe.reason,
    prerequisite: `${browserTraceProbe.environment}=1 enables the deliberate failure`,
    intended_route: browserTraceProbe.intendedRoute,
    cases: [browserTraceProbe.name],
  };
}

const identity = (file: string): string =>
  process.platform === "win32" ? file.toLowerCase() : file;

/** Explicit reproducible input; absent or malformed seeds never become a clock seed. */
export function uiShuffleSeed(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value))
    throw new Error("Shuffled UI runs require a decimal seed from 0 through 4294967295");
  const seed = Number(value);
  if (seed > 0xffff_ffff)
    throw new Error("Shuffled UI runs require a decimal seed from 0 through 4294967295");
  return seed;
}

/** This diagnostic deliberately fails only when explicitly enabled. */
export function allowedUiSkippedFiles(
  files: readonly string[],
  desktopRoot: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): ReadonlyMap<string, UiSkipContract> {
  return new Map(
    files.flatMap((file) => {
      const contract = declaredUiSkip(file, desktopRoot);
      return contract && environment[browserTraceProbe.environment] !== "1"
        ? [[file, contract] as const]
        : [];
    }),
  );
}

export function resolveUiSelection(
  files: readonly string[],
  desktopRoot: string,
  kind: string = "exact",
): string[] {
  if (!["exact", "related"].includes(kind) || !files.length)
    throw new Error("UI selection requires literal files");
  const root = realpathSync(desktopRoot);
  const selected = new Map<string, string>();
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
export function reconcileUiSelection(
  { testModules, unhandledErrors }: UiRunObservation,
  files: readonly string[],
  allowedSkippedFiles: ReadonlyMap<string, UiSkipContract> = new Map(),
) {
  const rawModules: unknown = testModules;
  const rawErrors: unknown = unhandledErrors;
  if (!Array.isArray(rawModules) || !Array.isArray(rawErrors) || rawErrors.length)
    throw new Error("UI run is unsuccessful or incomplete");
  const expected = new Set(files.map((file: string) => identity(path.resolve(file))));
  if (!expected.size) throw new Error("UI selection is empty");
  const permissions = new Map<string, UiSkipContract>();
  for (const [file, contract] of allowedSkippedFiles) {
    const key = identity(path.resolve(file));
    if (
      !expected.has(key) ||
      permissions.has(key) ||
      typeof contract !== "object" ||
      contract === null ||
      contract.category !== "explicit-diagnostic" ||
      ![contract.reason, contract.prerequisite, contract.intended_route].every(
        (value) => typeof value === "string" && value.trim() && value.length <= 4096,
      ) ||
      !Array.isArray(contract.cases) ||
      !contract.cases.length ||
      contract.cases.length > 1024 ||
      new Set(contract.cases).size !== contract.cases.length ||
      contract.cases.some((name) => typeof name !== "string" || !name.trim() || name.length > 4096)
    )
      throw new Error(`Invalid UI skipped-file permission: ${file}`);
    permissions.set(key, contract);
  }
  const discovered = new Set<string>(),
    executed: string[] = [];
  const skippedFiles: { file: string; reason: string }[] = [];
  const skippedCases: {
    file: string;
    name: string;
    original_skip_reason: string | null;
    contract: UiSkipContract;
  }[] = [];
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
      const result = test.result(),
        state = result.state;
      if (state === "passed") {
        passed++;
        ran = true;
      } else if (state === "skipped") {
        const contract = permissions.get(key);
        if (!contract || !contract.cases.includes(test.fullName))
          throw new Error(
            `Unexpected UI skip or wholly skipped suite: ${module.moduleId}: ${test.fullName}`,
          );
        skipped++;
        skippedCases.push({
          file: module.moduleId,
          name: test.fullName,
          original_skip_reason: typeof result.note === "string" ? result.note : null,
          contract,
        });
      } else throw new Error(`UI test did not finish successfully: ${test.fullName}`);
    }
    if (ran) executed.push(module.moduleId);
    else {
      const contract = permissions.get(key);
      if (!contract) throw new Error(`Requested UI suite was wholly skipped: ${module.moduleId}`);
      skippedFiles.push({ file: module.moduleId, reason: contract.reason });
    }
  }
  const missing = files.filter((file: string) => !discovered.has(identity(path.resolve(file))));
  if (missing.length) throw new Error(`Requested UI suites did not run: ${missing.join(", ")}`);
  if (!passed) throw new Error("UI selection has no runnable tests");
  return {
    requested_files: files,
    discovered_files: testModules.map((module) => module.moduleId),
    executed_files: executed,
    skipped_files: skippedFiles,
    skipped_cases: skippedCases,
    passed,
    skipped,
  };
}
