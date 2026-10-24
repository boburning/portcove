import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { writeSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestModule, TestSuite } from "vite-plus/test/node";
import { isRecord } from "./runtime-values.mts";

/** Bounded diagnostics; public runner results and exits retain their authority. */
export function createFrontendCaseObservations(
  root: string,
  {
    write = (line: string) => {
      writeSync(1, line);
    },
    environment = process.env,
  }: { write?: (line: string) => void; environment?: NodeJS.ProcessEnv } = {},
): Reporter {
  const text = (value: unknown, limit: number) =>
    typeof value === "string" ? Buffer.from(value).subarray(0, limit).toString("utf8") : null;
  const revision = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : null;
  const integer = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const duration = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const relative = (value: unknown) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) return null;
    const file = path.relative(root, value).replaceAll("\\", "/");
    return !file || file === ".." || file.startsWith("../") || path.isAbsolute(file)
      ? null
      : Buffer.byteLength(file) <= 4096
        ? file
        : null;
  };
  const failure = (error: unknown, depth = 0): unknown => {
    if (!isRecord(error)) return { message: text(error, 1024) };
    return {
      name: text(error.name, 128),
      message: text(error.message, 1024),
      stack: text(error.stack, 2048),
      cause: depth < 1 && error.cause !== undefined ? failure(error.cause, depth + 1) : null,
    };
  };
  let invocation = randomUUID(),
    index = 0,
    observed = 0,
    invalid = 0,
    omitted = 0,
    bytes = 0;
  let seen = new WeakSet<TestCase>();
  let seenContainers = new WeakSet<TestModule | TestSuite>();
  const record = (kind: "test" | "module" | "suite", row: Record<string, unknown>) => {
    const observation = ++index;
    const line = `Frontend test case observation: ${JSON.stringify({
      format_version: 1,
      invocation_id: invocation,
      observation_index: observation,
      kind,
      ...row,
    })}\n`;
    const size = Buffer.byteLength(line);
    if (observed >= 4096 || size > 16 * 1024 || bytes + size > 4 * 1024 * 1024) {
      omitted++;
      return;
    }
    write(line);
    bytes += size;
    observed++;
  };
  const emit = (test: TestCase) => {
    if (seen.has(test)) return;
    seen.add(test);
    try {
      const result = test.result(),
        diagnostic = test.diagnostic();
      if (!["pending", "passed", "failed", "skipped"].includes(result.state)) {
        invalid++;
        return;
      }
      const file = relative(test.module.moduleId),
        project = text(test.project.name, 256),
        name = text(test.fullName, 1024),
        location = test.location
          ? { line: integer(test.location.line), column: integer(test.location.column) }
          : null;
      const errors = result.errors ?? [];
      record("test", {
        definition_id:
          file && name
            ? createHash("sha256")
                .update(JSON.stringify([test.project.name, file, location, test.fullName]))
                .digest("hex")
            : null,
        runner_id: text(test.id, 256),
        project,
        file,
        name,
        name_truncated: Buffer.byteLength(test.fullName) > 1024,
        location,
        outcome: result.state,
        mode: test.options.mode,
        skip_reason: result.state === "skipped" ? text(result.note, 1024) : null,
        duration_ms: duration(diagnostic?.duration),
        start_time_ms: duration(diagnostic?.startTime),
        retry_count: integer(diagnostic?.retryCount),
        repeat_count: integer(diagnostic?.repeatCount),
        errors: errors.slice(0, 2).map((error) => failure(error)),
        omitted_errors: Math.max(0, errors.length - 2),
      });
    } catch {
      invalid++;
    }
  };
  const emitContainer = (container: TestModule | TestSuite) => {
    if (seenContainers.has(container)) return;
    seenContainers.add(container);
    try {
      const errors = container.errors();
      const module = container.type === "module" ? container : container.module;
      record(container.type, {
        file: relative(module.moduleId),
        project: text(container.project.name, 256),
        runner_id: text(container.id, 256),
        name: container.type === "suite" ? text(container.fullName, 1024) : null,
        outcome: container.state(),
        duration_ms: container.type === "module" ? duration(container.diagnostic().duration) : null,
        errors: errors.slice(0, 2).map((error) => failure(error)),
        omitted_errors: Math.max(0, errors.length - 2),
      });
    } catch {
      invalid++;
    }
  };
  return {
    onTestRunStart() {
      invocation = randomUUID();
      index = observed = invalid = omitted = bytes = 0;
      seen = new WeakSet();
      seenContainers = new WeakSet();
    },
    onTestCaseResult: emit,
    onTestModuleEnd: emitContainer,
    onTestSuiteResult: emitContainer,
    onTestRunEnd(modules, errors, reason) {
      try {
        for (const module of modules) {
          for (const test of module.children.allTests()) emit(test);
          for (const suite of module.children.allSuites()) emitContainer(suite);
          emitContainer(module);
        }
      } catch {
        invalid++;
      }
      try {
        const context = {
          format_version: 1,
          invocation_id: invocation,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          source: revision(environment.PORTCOVE_HEAD_SHA),
          checkout: revision(environment.GITHUB_SHA),
          run: text(environment.GITHUB_RUN_ID, 64),
          attempt: text(environment.GITHUB_RUN_ATTEMPT, 32),
          reason,
          observed,
          invalid,
          omitted,
          bytes,
          unhandled_errors: errors.length,
          original_unhandled_errors: errors.slice(0, 2).map((error) => failure(error)),
          omitted_unhandled_errors: Math.max(0, errors.length - 2),
        };
        const line = () => `Frontend test case observation context: ${JSON.stringify(context)}\n`;
        if (Buffer.byteLength(line()) > 16 * 1024) {
          context.original_unhandled_errors = [];
          context.omitted_unhandled_errors = errors.length;
        }
        write(line());
      } catch {
        // Reporting cannot mask the runner's original failure or shutdown.
      }
    },
  };
}
