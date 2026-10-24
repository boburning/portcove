import { writeSync } from "node:fs";

export type CoordinatorFixturePhase = "directory" | "source" | "checkpoint" | "version" | "cleanup";
export interface CoordinatorFixturePhases {
  measure<T>(phase: CoordinatorFixturePhase, operation: () => Promise<T>): Promise<T>;
}

/** Observations for one fixture's fixed setup/cleanup spans; never a deadline. */
export function createCoordinatorFixturePhases(
  testName: string,
  {
    write = (line: string) => {
      writeSync(2, line);
    },
    now = () => performance.now(),
    environment = process.env,
    fileConcurrency = null,
  }: {
    write?: (line: string) => void;
    now?: () => number;
    environment?: NodeJS.ProcessEnv;
    fileConcurrency?: number | null;
  } = {},
): CoordinatorFixturePhases {
  const label = (value: unknown, limit: number) =>
    typeof value === "string" ? Buffer.from(value).subarray(0, limit).toString("utf8") : null;
  const revision = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : null;
  const context = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    test: label(testName, 512),
    test_truncated: Buffer.byteLength(testName) > 512,
    source: revision(environment.PORTCOVE_HEAD_SHA),
    checkout: revision(environment.GITHUB_SHA),
    node_test_context: label(environment.NODE_TEST_CONTEXT, 64),
    file_concurrency:
      typeof fileConcurrency === "number" &&
      Number.isSafeInteger(fileConcurrency) &&
      fileConcurrency > 0
        ? fileConcurrency
        : null,
  };
  let span = 0;
  let lastCompleted: CoordinatorFixturePhase | null = null;
  let lastFailed: CoordinatorFixturePhase | null = null;
  const clock = () => {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const emit = (
    phase: CoordinatorFixturePhase,
    state: "started" | "completed" | "failed",
    started: number | null,
    id: number,
  ) => {
    try {
      const ended = clock();
      const line = `Coordinator fixture phase: ${JSON.stringify({
        format_version: 1,
        context,
        span: id,
        phase,
        state,
        last_completed: lastCompleted,
        last_failed: lastFailed,
        recorded_at: new Date().toISOString(),
        elapsed_ms: started !== null && ended !== null ? Math.max(0, ended - started) : null,
      })}\n`;
      if (Buffer.byteLength(line) <= 4096) write(line);
    } catch {
      // Diagnostics cannot replace the operation's original result or failure.
    }
  };
  return {
    async measure<T>(phase: CoordinatorFixturePhase, operation: () => Promise<T>) {
      const started = clock(),
        id = ++span;
      emit(phase, "started", started, id);
      try {
        const result = await operation();
        lastCompleted = phase;
        emit(phase, "completed", started, id);
        return result;
      } catch (error) {
        lastFailed = phase;
        emit(phase, "failed", started, id);
        throw error;
      }
    },
  };
}
