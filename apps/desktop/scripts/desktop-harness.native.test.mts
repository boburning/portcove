import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { isRecord } from "../../../scripts/runtime-values.mts";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
const helpers = source.slice(
  source.indexOf("function required"),
  source.indexOf("function driverBrowser("),
);

void test("connected inspector stays owned when post-connect media verification refuses", async () => {
  const start = source.indexOf("async function connectObservedDriver()");
  const end = source.indexOf("async function connect()", start);
  assert.ok(start >= 0 && end > start);
  const actual = source.slice(start, end);
  const dependency = 'await import("../../../scripts/desktop-linux-media.mts")';
  assert.equal(actual.split(dependency).length, 2);
  // Inject only this module dependency; execute the actual erased function.
  const action = actual.replace(dependency, "injectedMedia");
  for (const mode of ["ready", "inputs", "configuration", "identity"] as const) {
    let closed = 0;
    const failure = new Error(`media-${mode}`);
    const input = { path: "/owned-media", bytes: 1, sha256: "a".repeat(64) };
    const inspector = {
      ownedProcessIdentity: {},
      quit: async () => {
        closed++;
      },
    };
    const observed: unknown = await runInNewContext(
      `${helpers}
      ${action}
      (async () => {
        let failure;
        try {await connectObservedDriver();} catch(error) {failure = {error};}
        finally {if(browser) await browser.quit();}
        return {failure, tracked: browser === inspector};
      })()`,
      {
        assert,
        isRecord,
        path,
        browser: undefined,
        inspector,
        admission: { verify: async () => {} },
        custody: undefined,
        linuxPackagedInspector: true,
        linuxLaunch: {},
        output: "/owned-output",
        artifacts: [],
        port: 9000,
        application: "/owned-app",
        inputs: [input],
        applicationMediaEvidence: "/owned-readiness",
        connectLinuxInspector: async (options: {
          beforeConnect: (deadline: number) => Promise<void>;
        }) => {
          await options.beforeConnect(Date.now() + 1000);
          return inspector;
        },
        injectedMedia: {
          awaitApplicationMediaReadiness: async () => ({
            configuration: mode === "configuration" ? { ...input, sha256: "b".repeat(64) } : input,
            source: input,
          }),
          verifyApplicationMediaInputs: async () => {
            if (mode === "inputs") throw failure;
          },
          assertApplicationMediaReadiness: () => {
            if (mode === "identity") throw failure;
          },
        },
      },
      { timeout: 1000 },
    );
    assert.ok(isRecord(observed));
    assert.equal(
      observed.tracked,
      true,
      String(isRecord(observed.failure) ? observed.failure.error : observed.failure),
    );
    assert.equal(closed, 1);
    if (mode === "ready") assert.equal(observed.failure, undefined);
    else {
      assert.ok(isRecord(observed.failure));
      if (mode !== "configuration") assert.equal(observed.failure.error, failure);
      else assert.ok(observed.failure.error);
    }
  }
});

void test("runner phase metadata is checked at initial read before native execution", () => {
  const start = source.indexOf("const phases = runnerMetadata.phases;");
  const end = source.indexOf("let acceptancePreflight", start);
  assert.ok(start > source.indexOf('if (values["run-metadata"])') && end > start);
  assert.ok(end < source.indexOf("await startDriver();"));
  assert.equal(source.split("const phases = runnerMetadata.phases;").length, 2);
  for (const phases of [undefined, [], [{ phase: "build", opaque_metadata: 42 }]]) {
    const actual: unknown = runInNewContext(
      `${helpers} ${source.slice(start, end)} metadataPhases;`,
      {
        assert,
        isRecord,
        runnerMetadata: { phases },
      },
      { timeout: 1000 },
    );
    assert.equal(JSON.stringify(actual), JSON.stringify(phases ?? []));
  }
  for (const phases of [null, false, "build", {}, [null], [false], ["build"]]) {
    assert.throws(() =>
      runInNewContext(
        `${helpers} ${source.slice(start, end)} metadataPhases;`,
        {
          assert,
          isRecord,
          runnerMetadata: { phases },
        },
        { timeout: 1000 },
      ),
    );
  }
});
