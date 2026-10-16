import { spec } from "node:test/reporters";
import { Readable } from "node:stream";

export const slowTestThresholdMs = 5_000;

export function isSlowTest(event) {
  return (
    ["test:pass", "test:fail"].includes(event.type) &&
    event.data.details.type === "test" &&
    !event.data.skip &&
    !event.data.todo &&
    event.data.details.duration_ms > slowTestThresholdMs
  );
}

// Report measured latency independently of the hang timeout. In particular,
// synchronous work can block the event loop beyond an asynchronous deadline.
export default async function* report(source) {
  const slow = [];
  const workerFailures = [];
  async function* inspect() {
    for await (const event of source) {
      if (isSlowTest(event)) slow.push(event.data);
      const error = event.data.details?.error;
      if (event.type === "test:fail" && error && ("exitCode" in error || "signal" in error)) {
        workerFailures.push({
          exitCode: Number.isSafeInteger(error.exitCode) ? error.exitCode : null,
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
  yield* Readable.from(inspect()).compose(spec());
  for (const failure of workerFailures)
    yield `Worker process failure: ${JSON.stringify(failure)}\n`;
  if (slow.length) {
    yield `\nSlow tests to investigate (${slowTestThresholdMs}ms):\n`;
    for (const test of slow) yield `  ${test.name}: ${test.details.duration_ms.toFixed(1)}ms\n`;
  }
}
