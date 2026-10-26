import type { TestEvent } from "node:test/reporters";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import report, { nodeFileObservation } from "./test-duration-reporter.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { parseNodeTestSuites, type NodePlatformSkipContract } from "./node-test-suites.mts";
import { createNodePlatformSkipInventory } from "./node-platform-skips.mts";

const maximumFiles = 512;
const maximumCases = 16_384;
const identity = (file: string) => {
  const absolute = path.resolve(file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

/** Execution requirements are separate from the bounded, passive diagnostic reporter. */
export function createNodeExecutionInventory(
  requestedFiles: readonly string[],
  filters: readonly string[] = [],
  options: {
    platformSkips?:
      | Record<string, NodePlatformSkipContract | NodePlatformSkipContract[]>
      | undefined;
    registryError?: string | undefined;
    registeredFiles?: readonly string[] | undefined;
    root?: string | undefined;
    platform?: NodeJS.Platform | undefined;
  } = {},
) {
  const platformSkips = createNodePlatformSkipInventory(
    requestedFiles,
    filters,
    options.platformSkips ?? {},
    {
      root: options.root ?? process.cwd(),
      platform: options.platform ?? process.platform,
      ...(options.registeredFiles ? { registered: options.registeredFiles } : {}),
    },
  );
  const errors = new Set<string>();
  const requested = new Map<string, string>();
  const observed = new Set<string>();
  const instances = new Set<string>();
  const summaries = new Map<string, number>();
  const files = new Map<
    string,
    { passed: number; failed: number; cancelled: number; skipped: number; todo: number }
  >();
  let nativeFailure = false;
  let terminal = false;
  const error = (message: string) => {
    if (errors.size < 32) errors.add(message);
  };
  if (options.registryError) error(options.registryError);
  for (const file of requestedFiles.slice(0, maximumFiles)) {
    if (!file || file.length > 4096 || /[*?{}[\]]/u.test(file)) {
      error("Required Node execution needs explicit test files");
      continue;
    }
    const key = identity(file);
    if (requested.has(key)) error("Duplicate requested Node test file");
    requested.set(key, file);
  }
  if (!requested.size || requestedFiles.length > maximumFiles)
    error("Required Node execution needs one to 512 explicit test files");
  return {
    capture(event: TestEvent) {
      platformSkips.capture(event);
      if (event.type === "test:fail") {
        const ignored =
          event.data.skip === true ||
          typeof event.data.skip === "string" ||
          event.data.todo === true ||
          typeof event.data.todo === "string";
        if (!ignored) nativeFailure = true;
      }
      if (event.type === "test:summary" && event.data.file === undefined) {
        if (terminal) error("Duplicate terminal Node runner summary");
        if (typeof event.data.success !== "boolean")
          error("Malformed terminal Node runner summary");
        else {
          terminal = true;
          if (!event.data.success) nativeFailure = true;
        }
      }
      const summary = nodeFileObservation(event);
      if (event.type === "test:summary" && event.data.file !== undefined && !summary)
        error("Malformed Node entry-file summary");
      if (summary) {
        const key = identity(summary.entry_file ?? summary.file);
        if (!requested.has(key)) error("Unexpected Node entry file in execution summary");
        else {
          observed.add(key);
          if (summaries.has(key)) error("Duplicate Node entry-file summary");
          summaries.set(key, summary.counts.tests);
        }
      }
      if (event.type !== "test:pass" && event.type !== "test:fail") return;
      const data: unknown = event.data;
      // Pinned Node's process/file wrapper has no entryFile. Empty files and zero
      // name matches can emit a successful wrapper; neither proves a case ran.
      if (!isRecord(data) || !isRecord(data.details) || typeof data.entryFile !== "string") return;
      const key = identity(data.entryFile);
      if (!requested.has(key)) {
        error("Unexpected Node entry file in case execution");
        return;
      }
      observed.add(key);
      if (data.details.type === "suite") return;
      if (
        data.details.type !== "test" ||
        typeof data.testId !== "number" ||
        !Number.isSafeInteger(data.testId) ||
        data.testId < 1
      ) {
        error("Node case execution lacks an instance identity");
        return;
      }
      const instance = JSON.stringify([key, data.testId]);
      if (instances.has(instance)) {
        error("Duplicate Node case execution instance");
        return;
      }
      if (instances.size >= maximumCases) {
        error("Node execution inventory exceeds 16384 case instances");
        return;
      }
      instances.add(instance);
      const counts = files.get(key) ?? { passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
      files.set(key, counts);
      if (data.skip === true || typeof data.skip === "string") counts.skipped++;
      else if (data.todo === true || typeof data.todo === "string") counts.todo++;
      else if (event.type === "test:fail") {
        const failure = isRecord(data.details.error) ? data.details.error.failureType : undefined;
        if (
          typeof failure === "string" &&
          ["cancelledByParent", "testTimeoutFailure", "testAborted"].includes(failure)
        )
          counts.cancelled++;
        else counts.failed++;
      } else counts.passed++;
    },
    finish() {
      const skipInventory = platformSkips.finish();
      for (const message of skipInventory.errors) error(message);
      if (!terminal) error("Node execution has no terminal runner summary");
      for (const key of requested.keys()) {
        if (!observed.has(key))
          error("Requested Node file has no case or file-summary observation");
        if (!summaries.has(key))
          error("Requested Node file has no valid native entry-file summary");
      }
      for (const [key, total] of summaries) {
        const counts = files.get(key);
        const actual = counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : 0;
        if (actual !== total)
          error("Node case outcomes differ from the native entry-file test count");
      }
      const totals = { passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
      for (const counts of files.values())
        for (const key of ["passed", "failed", "cancelled", "skipped", "todo"] as const)
          totals[key] += counts[key];
      if (!totals.passed && !totals.failed)
        error(
          totals.skipped || totals.todo
            ? "Required Node family has only skipped or todo cases; its intended execution route did not run"
            : "Required Node family has no executed cases; check its files and name filters",
        );
      return {
        format_version: 1,
        requested_files: [...requested.values()],
        filters: [...filters],
        discovery_case_inventory:
          "unavailable: Node reports runtime registration, not complete discovery",
        selected_case_inventory:
          "unavailable: requested files and filters do not enumerate dynamic cases",
        outcome_identity_records: "Node test case observation",
        ...(skipInventory.contracts.length ? { platform_skip_inventory: skipInventory } : {}),
        files: [...requested].map(([key, file]) => ({
          file,
          observed: observed.has(key),
          ...(files.get(key) ?? { passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 }),
        })),
        ...totals,
        native_failure: nativeFailure,
        complete: terminal && errors.size === 0,
        errors: [...errors],
      };
    },
  };
}

export default async function* requiredReport(source: AsyncIterable<TestEvent>) {
  const filters: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const value = process.execArgv[index]!;
    if (!/^--test-(?:name|skip)-pattern(?:=|$)/u.test(value)) continue;
    filters.push(value);
    if (!value.includes("=")) filters.push(process.execArgv[++index] ?? "");
  }
  let platformSkips:
    | Record<string, NodePlatformSkipContract | NodePlatformSkipContract[]>
    | undefined;
  let registryError: string | undefined;
  let registeredFiles: string[] | undefined;
  try {
    const registry = parseNodeTestSuites(
      readFileSync(new URL("./node-test-suites.json", import.meta.url), "utf8"),
    );
    platformSkips = registry.platformSkips;
    registeredFiles = [...new Set(Object.values(registry.suites).flatMap((suite) => suite.files))];
  } catch (error) {
    registryError = "Platform skip ownership unavailable: " + errorMessage(error);
  }
  const inventory = createNodeExecutionInventory(process.argv.slice(1), filters, {
    platformSkips,
    registeredFiles,
    registryError,
    root: fileURLToPath(new URL("../", import.meta.url)),
  });
  async function* inspect() {
    for await (const event of source) {
      inventory.capture(event);
      yield event;
    }
  }
  // Consume the original stream completely so failures and worker diagnostics are
  // retained before the additional nonempty-family requirement is evaluated.
  yield* report(inspect());
  const result = inventory.finish();
  yield `Node test execution inventory: ${JSON.stringify(result)}\n`;
  if (!result.complete && !result.native_failure) throw new Error(result.errors.join("; "));
}
