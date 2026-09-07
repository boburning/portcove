import { spec } from "node:test/reporters";
import { Readable } from "node:stream";

export const testBudgetMs = 5_000;

export function exceedsTestBudget(event) {
  return ["test:pass", "test:fail"].includes(event.type)
    && event.data.details.type === "test"
    && !event.data.skip && !event.data.todo
    && event.data.details.duration_ms > testBudgetMs;
}

// Node's timeout can interrupt asynchronous tests, but a synchronous test can
// block the event loop beyond its deadline. Check its measured duration too.
export default async function* report(source) {
  const slow = [];
  async function* inspect() {
    for await (const event of source) {
      if (exceedsTestBudget(event)) slow.push(event.data);
      yield event;
    }
  }
  yield* Readable.from(inspect()).compose(spec());
  if (slow.length) {
    process.exitCode = 1;
    yield `\nUnit-test budget exceeded (${testBudgetMs}ms):\n`;
    for (const test of slow) yield `  ${test.name}: ${test.details.duration_ms.toFixed(1)}ms\n`;
  }
}
