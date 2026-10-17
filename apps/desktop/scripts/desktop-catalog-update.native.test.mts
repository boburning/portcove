import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext, runInThisContext } from "node:vm";
import { executeBrowserScript } from "./browser-script.mts";

void test("catalog field presentation reaches the browser as executable JavaScript with both element arguments", async () => {
  const source = stripTypeScriptTypes(
    readFileSync(new URL("./desktop-catalog-update-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const start = source.indexOf("const fieldPresentation = await executeBrowserScript(");
  const end = source.indexOf("for (const presentation of fieldPresentation)", start);
  assert.ok(start >= 0 && end > start);
  const factory: unknown = runInThisContext(
    `(async function(executeBrowserScript,browser,publicKeyField,locationField){${source.slice(start, end)} return fieldPresentation;})`,
  );
  assert.ok(typeof factory === "function");
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
  const result: unknown = await Reflect.apply(factory, undefined, [
    executeBrowserScript,
    browser,
    ...fields,
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(result, fields);
});
