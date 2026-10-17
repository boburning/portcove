import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-bootstrap-recovery-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
void test("serialized bootstrap technical details retain labels, values and overlap measurements", async () => {
  const start = source.indexOf("const technicalRows = await executeBrowserScript"),
    end = source.indexOf("assert.ok(technicalRows.length", start);
  assert.ok(start >= 0 && end > start);
  const callbackSource = source.slice(start, end);
  const label = {
    textContent: "invalid_host_preference_document",
    clientWidth: 200,
    scrollWidth: 199,
    getBoundingClientRect: () => ({ right: 200 }),
  };
  const value = { textContent: "true", getBoundingClientRect: () => ({ left: 220 }) };
  let missing = false;
  const failure = {
    querySelectorAll: () => [
      { querySelector: (selector: string) => (missing ? null : selector === "dt" ? label : value) },
    ],
  };
  const executeBrowserScript = (
    _browser: unknown,
    callback: unknown,
    ...args: unknown[]
  ): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(`(${callback.toString()})(...args)`, { args }, { timeout: 1000 });
  };
  const run = (): unknown =>
    runInNewContext(`(async () => {${callbackSource} return technicalRows;})()`, {
      executeBrowserScript,
      browser: {},
      failure,
    });
  const observation: unknown = await run();
  assert.equal(
    JSON.stringify(observation),
    JSON.stringify([
      {
        label: label.textContent,
        value: value.textContent,
        labelWidth: 200,
        labelScrollWidth: 199,
        labelRight: 200,
        valueLeft: 220,
      },
    ]),
  );
  missing = true;
  await assert.rejects(
    (async () => {
      await run();
    })(),
    /Technical detail row unavailable/,
  );
});
