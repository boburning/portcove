import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { observeDesktopHarnessInputs } from "../../../scripts/native-helper-dependencies.mts";
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

void test("runner phase metadata is checked at initial read before native execution", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-runner-phases-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = path.join(directory, "metadata.json");
  const custody = { inputs: [] };
  const inspect = async (phases: unknown) => {
    await writeFile(metadata, JSON.stringify({ source_state: { declared: true }, phases }));
    return observeDesktopHarnessInputs({
      custody,
      runMetadata: metadata,
      capture: {
        root: directory,
        values: { app: process.execPath },
        plan: { receiptInputs: [], selection: { selected_scenarios: [] } },
        output: directory,
        revision: "a".repeat(40),
        validate: async () => assert.fail("Existing custody must not trigger capture"),
      },
    });
  };
  for (const phases of [undefined, [], [{ phase: "build", opaque_metadata: 42 }]]) {
    const actual = await inspect(phases);
    assert.deepEqual(actual.metadataPhases, phases ?? []);
    assert.deepEqual(custody.inputs, [], "Phase observations must not enlarge custody");
    assert.equal(actual.inputs.length, 1);
    assert.equal(actual.inputs[0]?.path, metadata);
    if (Array.isArray(actual.runnerMetadata.phases)) {
      assert.notEqual(actual.metadataPhases, actual.runnerMetadata.phases);
      assert.equal(actual.metadataPhases[0], actual.runnerMetadata.phases[0]);
    }
  }
  for (const phases of [null, false, "build", {}, [null], [false], ["build"], [[]]]) {
    await assert.rejects(() => inspect(phases), { code: "ERR_ASSERTION" });
    assert.deepEqual(custody.inputs, []);
  }
});
