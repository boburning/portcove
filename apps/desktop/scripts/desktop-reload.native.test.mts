import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext, runInThisContext } from "node:vm";
const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-reload-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
const helperStart = source.indexOf("function commandObservations(");
const helperEnd = source.indexOf("import { executeBrowserScript", helperStart);
const scenarioStart = source.indexOf("export async function reloadScenario(");
assert.ok(helperStart >= 0 && helperEnd > helperStart && scenarioStart > helperEnd);
const program =
  source.slice(helperStart, helperEnd) + source.slice(scenarioStart).replace("export ", "");
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
void test("serialized reload reads bind each bootstrap generation and stop at the first rejected batch", async () => {
  for (const mode of ["success", "commands", "bootstrap-reject", "bootstrap-malformed"] as const) {
    const failure = mode !== "success";
    const bootstrapFailure = mode.startsWith("bootstrap-");
    let refreshes = 0;
    const calls: { command: string; args: unknown }[] = [];
    const reports: unknown[] = [];
    const artifacts: string[] = [];
    const original = { code: "owned fixture rejection", detail: "retained" };
    const browser = {
      navigate: () => ({
        refresh: async () => {
          refreshes++;
        },
      }),
      findElements: async () => [],
      wait: async (predicate: unknown) => {
        if (typeof predicate === "function") {
          const result: unknown = Reflect.apply(predicate, undefined, []);
          assert.equal(await result, true);
        }
      },
      executeAsyncScript: (callback: unknown, commands: unknown) =>
        new Promise<unknown>((done, reject) => {
          assert.ok(typeof callback === "function");
          const window = {
            __TAURI_INTERNALS__: {
              invoke: async (command: string, args?: unknown) => {
                calls.push({ command, args });
                if (command === "get_bootstrap_status") {
                  if (mode === "bootstrap-reject") {
                    // Native bootstrap IPC rejects structured failure records.
                    // oxlint-disable-next-line typescript/only-throw-error
                    throw original;
                  }
                  if (mode === "bootstrap-malformed") return {};
                  return { generation: refreshes };
                }
                if (mode === "commands" && command === "get_doctor_report") {
                  // Native IPC rejects structured failure records rather than JavaScript Error instances.
                  // oxlint-disable-next-line typescript/only-throw-error
                  throw original;
                }
                return { owned: true };
              },
            },
          };
          try {
            runInNewContext(
              `(${callback.toString()})(commands, done)`,
              { window, commands, done },
              { timeout: 1000 },
            );
          } catch (error) {
            reject(error);
          }
        }),
    };
    const context = {
      browser,
      cycles: 2,
      output: "owned-output",
      artifacts,
      scenario: async (_name: string, action: () => unknown) => await action(),
    };
    const executeBrowserScript = async (_browser: unknown, callback: unknown) => {
      assert.ok(typeof callback === "function");
      const value: unknown = runInNewContext(
        `(${callback.toString()})()`,
        { document: { querySelectorAll: () => [] } },
        { timeout: 1000 },
      );
      const serialized: unknown = JSON.parse(JSON.stringify(value));
      return serialized;
    };
    const execute: unknown = runInThisContext(
      `(function({context, assert, path, executeBrowserScript, By, until, writeFile}) {${program} return reloadScenario(context);})`,
    );
    assert.ok(typeof execute === "function");
    const result: unknown = Reflect.apply(execute, undefined, [
      {
        context,
        assert,
        path,
        executeBrowserScript,
        By: { css: () => "navigation" },
        until: { elementLocated: () => "located" },
        writeFile: async (_file: string, bytes: string) => {
          const value: unknown = JSON.parse(bytes);
          reports.push(value);
        },
      },
    ]);
    if (failure) await assert.rejects(Promise.resolve(result));
    else await result;
    assert.equal(refreshes, failure ? 1 : 2);
    assert.deepEqual(
      calls.map((call) => call.command),
      bootstrapFailure
        ? ["get_bootstrap_status"]
        : Array.from({ length: refreshes }, () => [
            "get_bootstrap_status",
            "get_workspace_snapshot",
            "get_doctor_report",
          ]).flat(),
    );
    for (const [index, call] of calls.entries()) {
      if (index % 3 === 0) assert.equal(call.args, undefined);
      else
        assert.equal(
          JSON.stringify(call.args),
          JSON.stringify({ generation: Math.floor(index / 3) + 1 }),
        );
    }
    assert.deepEqual(artifacts, [path.join("owned-output", "reload-observations.json")]);
    assert.equal(reports.length, 1);
    const observations = reports[0];
    assert.ok(Array.isArray(observations));
    assert.equal(observations.length, refreshes);
    if (failure) {
      const commands: unknown = object(observations[0]).commands;
      assert.ok(Array.isArray(commands));
      const failed = object(commands[bootstrapFailure ? 0 : 1]);
      assert.equal(failed.ok, false);
      assert.equal(failed.command, bootstrapFailure ? "get_bootstrap_status" : "get_doctor_report");
      if (mode === "bootstrap-malformed") {
        const message = object(failed.error).message;
        assert.ok(typeof message === "string");
        assert.match(message, /Bootstrap generation unavailable/);
      } else assert.deepEqual(failed.error, original);
      assert.equal(object(observations[0]).completed_at, undefined);
    } else
      assert.ok(
        observations.every((value: unknown) => typeof object(value).completed_at === "string"),
      );
  }
});
