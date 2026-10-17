import type { TestEvent } from "node:test/reporters";
import { isRecord } from "./runtime-values.mts";
import { spec } from "node:test/reporters";
import { Readable } from "node:stream";

export const slowTestThresholdMs = 5_000;

interface SlowTestObservation {
  type: "test:pass" | "test:fail";
  data: { name: string; details: { type: "test"; duration_ms: number } };
}
export function isSlowTest(event: unknown): event is SlowTestObservation {
  if (
    !isRecord(event) ||
    (event.type !== "test:pass" && event.type !== "test:fail") ||
    !isRecord(event.data) ||
    !isRecord(event.data.details)
  )
    return false;
  return (
    typeof event.data.name === "string" &&
    event.data.details.type === "test" &&
    !event.data.skip &&
    !event.data.todo &&
    typeof event.data.details.duration_ms === "number" &&
    event.data.details.duration_ms > slowTestThresholdMs
  );
}

// Report measured latency independently of the hang timeout. In particular,
// synchronous work can block the event loop beyond an asynchronous deadline.
export default async function* report(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string | Buffer> {
  const slow: SlowTestObservation["data"][] = [];
  const workerFailures: {
    exitCode: number | null;
    signal: string | null;
    failureType: string;
    code: string;
  }[] = [];
  async function* inspect() {
    for await (const event of source) {
      if (isSlowTest(event)) slow.push(event.data);
      const error = event.type === "test:fail" ? event.data.details.error : undefined;
      if (
        event.type === "test:fail" &&
        isRecord(error) &&
        ("exitCode" in error || "signal" in error)
      ) {
        workerFailures.push({
          exitCode:
            typeof error.exitCode === "number" && Number.isSafeInteger(error.exitCode)
              ? error.exitCode
              : null,
          signal:
            typeof error.signal === "string" && /^SIG[A-Z0-9]{1,12}$/u.test(error.signal)
              ? error.signal
              : null,
          failureType: error.failureType === "testCodeFailure" ? error.failureType : "unknown",
          code: error.code === "ERR_TEST_FAILURE" ? error.code : "unknown",
        });
      }
      yield event;
    }
  }
  for await (const chunk of Readable.from(inspect()).compose(spec())) {
    const output: unknown = chunk;
    if (typeof output !== "string" && !Buffer.isBuffer(output))
      throw new TypeError("Node spec reporter emitted non-text output");
    yield output;
  }
  for (const failure of workerFailures)
    yield `Worker process failure: ${JSON.stringify(failure)}\n`;
  if (slow.length) {
    yield `\nSlow tests to investigate (${slowTestThresholdMs}ms):\n`;
    for (const test of slow) yield `  ${test.name}: ${test.details.duration_ms.toFixed(1)}ms\n`;
  }
}
