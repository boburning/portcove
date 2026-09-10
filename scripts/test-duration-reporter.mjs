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
  async function* inspect() {
    for await (const event of source) {
      if (isSlowTest(event)) slow.push(event.data);
      yield event;
    }
  }
  yield* Readable.from(inspect()).compose(spec());
  if (slow.length) {
    yield `\nSlow tests to investigate (${slowTestThresholdMs}ms):\n`;
    for (const test of slow)
      yield `  ${test.name}: ${test.details.duration_ms.toFixed(1)}ms\n`;
  }
}
