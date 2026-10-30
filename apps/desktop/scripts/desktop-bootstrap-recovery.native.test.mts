import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

async function technicalDetailBehavior(
  subject: (browser: unknown, root: unknown) => Promise<unknown>,
) {
  const label = {
    textContent: "invalid_host_preference_document",
    clientWidth: 200,
    scrollWidth: 199,
    getBoundingClientRect: () => ({ right: 200 }),
  };
  const value = { textContent: "true", getBoundingClientRect: () => ({ left: 220 }) };
  let missing = false;
  const failure = {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "dl > div");
      return [
        {
          querySelector: (part: string) => {
            assert.ok(part === "dt" || part === "dd");
            return missing ? null : part === "dt" ? label : value;
          },
        },
      ];
    },
  };
  const browser = {
    executeScript: async (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function");
      const result: unknown = runInNewContext(
        `(${callback.toString()})(...args)`,
        { args },
        { timeout: 1000 },
      );
      return result;
    },
  };
  const run = () => subject(browser, failure);
  const observation: unknown = await run();
  assert.ok(Array.isArray(observation), "BOOTSTRAP_DETAILS_CONTRACT rows");
  const normalized: unknown = JSON.parse(JSON.stringify(observation));
  assert.deepEqual(normalized, [
    {
      label: label.textContent,
      value: value.textContent,
      labelWidth: 200,
      labelScrollWidth: 199,
      labelRight: 200,
      valueLeft: 220,
    },
  ]);
  missing = true;
  await assert.rejects(
    (async () => {
      await run();
    })(),
    /Technical detail row unavailable/,
  );
}

void test("serialized bootstrap technical details retain labels, values and overlap measurements", () => {
  const entry = new URL("./desktop-bootstrap-recovery-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      import {runInNewContext} from 'node:vm';
      const {observeTechnicalDetails} = await import(entry);
      await (${String(technicalDetailBehavior)})(observeTechnicalDetails);
      await (${String(technicalDetailBehavior)})(async (...args) => {
        const rows = await observeTechnicalDetails(...args);
        return rows.map(row => Object.fromEntries(Object.entries(row).reverse()));
      });
    `,
        variant === "original" ? undefined : { exportName: "observeTechnicalDetails", variant },
      );
    if (variant === "wrong-export") assert.throws(execute, /BOOTSTRAP_DETAILS_CONTRACT rows/);
    else execute();
  }
});
