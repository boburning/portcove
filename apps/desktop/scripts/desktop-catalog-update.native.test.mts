import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readReviewFieldStyles } from "./desktop-review-presentation.mts";
import { catalogUpdateScenario as actualCatalogUpdateScenario } from "./desktop-catalog-update-test.mts";

void test("catalog field presentation reaches the browser as executable JavaScript with both element arguments", async () => {
  assert.match(actualCatalogUpdateScenario.toString(), /\bawait\s+readReviewFieldStyles\s*\(/u);
  const fields = [
    {
      width: "240px",
      paddingLeft: "12px",
      borderStyle: "solid",
      borderWidth: "1px",
      backgroundColor: "rgb(1, 2, 3)",
      color: "rgb(240, 240, 240)",
    },
    {
      width: "480px",
      paddingLeft: "16px",
      borderStyle: "solid",
      borderWidth: "2px",
      backgroundColor: "rgb(4, 5, 6)",
      color: "rgb(250, 250, 250)",
    },
  ];
  let calls = 0;
  const browser = {
    executeScript(script: (...args: unknown[]) => unknown, ...args: unknown[]) {
      calls++;
      assert.equal(args[0], fields[0]);
      assert.equal(args[1], fields[1]);
      const result: unknown = runInNewContext(`(${script.toString()})(...args)`, {
        args,
        getComputedStyle: (field: unknown) => field,
      });
      const transported: unknown = JSON.parse(JSON.stringify(result));
      return Promise.resolve(transported);
    },
  };
  const result: unknown = await Reflect.apply(readReviewFieldStyles, undefined, [
    browser,
    ...fields,
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(result, fields);
});

void test("catalog transport is required only after its scenario is selected", async () => {
  const catalogUpdateScenario = (context: {
    browser: undefined;
    invoke: () => Promise<unknown>;
    output: string;
    artifacts: string[];
    scenario: (name: string, run: () => Promise<void>) => Promise<void>;
  }): Promise<unknown> => {
    const result: unknown = Reflect.apply(actualCatalogUpdateScenario, undefined, [context]);
    return Promise.resolve(result);
  };
  let invoked = 0;
  const context = {
    browser: undefined,
    invoke: async () => {
      invoked++;
      return {};
    },
    output: "/owned",
    artifacts: [],
  };
  const selected: string[] = [];
  await catalogUpdateScenario({
    ...context,
    scenario: async (name) => {
      selected.push(name);
    },
  });
  assert.deepEqual(selected, ["native-catalog-update-dialog"]);
  assert.equal(invoked, 0);
  await assert.rejects(
    catalogUpdateScenario({
      ...context,
      scenario: async (_name, run) => {
        await run();
      },
    }),
    /Selected catalog scenario requires its connected WebDriver transport/u,
  );
  assert.equal(invoked, 0);
});
