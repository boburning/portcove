import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { errorMessage } from "./runtime-values.mts";

void test("native compatibility retains exact primary and cleanup failures while writing evidence", async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL("../apps/desktop/test/native-compatibility.mts", import.meta.url),
      "utf8",
    ),
    { mode: "strip" },
  );
  const start = source.indexOf("async function waitForApplicationExit(");
  assert.ok(start >= 0);
  const artifactIdentity = { file: "owned-app", sha256: "a".repeat(64), size: 1 };
  const failures: unknown[] = [undefined, null, false, 0, "", new Error("primary")];
  for (const phase of ["primary", "cleanup"] as const) {
    for (const failure of failures) {
      const writes = new Map<string, string>();
      const logs: string[] = [];
      let quits = 0,
        kills = 0;
      const secondary = new Error("secondary cleanup failure");
      const browser = {
        takeScreenshot: async () => "aW5lcnQ=",
        quit: () => {
          quits += 1;
          return Promise.reject(phase === "cleanup" ? failure : secondary);
        },
      };
      class Builder {
        usingServer() {
          return this;
        }
        withCapabilities() {
          return this;
        }
        async build() {
          return browser;
        }
      }
      const applicationProcess: {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: () => boolean;
      } = {
        exitCode: null,
        signalCode: null,
        kill: () => {
          kills += 1;
          applicationProcess.exitCode = 0;
          return true;
        },
      };
      const result: unknown = runInNewContext(`(async () => { ${source.slice(start)} })()`, {
        artifactIdentity,
        port: 4445,
        evidenceDirectory: "owned-evidence",
        applicationOutput: "owned stdout",
        applicationProcess,
        applicationExit: Promise.resolve({ code: 0, signal: null }),
        spawnError: undefined,
        process: { env: {}, arch: "arm64", platform: "darwin" },
        fetch: async () => ({ ok: true }),
        AbortSignal,
        setTimeout,
        clearTimeout,
        Builder,
        By: {},
        Key: {},
        until: {},
        errorMessage,
        path,
        assertDesignCompatibility: () =>
          phase === "primary" ? Promise.reject(failure) : Promise.resolve({ observed: true }),
        writeFile: async (file: string, value: string) => {
          writes.set(file, value);
        },
        console: { log: (value: string) => logs.push(value) },
      });
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => Object.is(error, failure),
      );
      assert.equal(quits, 1);
      assert.equal(kills, 1);
      assert.equal(writes.get(path.join("owned-evidence", "application.log")), "owned stdout");
      const json = writes.get(path.join("owned-evidence", "result.json"));
      assert.ok(json);
      const evidence: unknown = JSON.parse(json);
      assert.ok(
        evidence !== null &&
          typeof evidence === "object" &&
          "status" in evidence &&
          "artifact" in evidence &&
          "revision" in evidence &&
          "applicationExit" in evidence,
      );
      assert.equal(evidence.status, "failed");
      const prefix = "Native compatibility result: ";
      const records = logs.filter((value) => value.startsWith(prefix));
      assert.equal(records.length, 1);
      assert.deepEqual(JSON.parse(records[0]!.slice(prefix.length)), {
        artifact: evidence.artifact,
        revision: evidence.revision,
        status: evidence.status,
        applicationExit: evidence.applicationExit,
        hasError: Object.hasOwn(evidence, "error"),
        hasCleanupError: Object.hasOwn(evidence, "cleanupError"),
      });
      assert.equal(
        JSON.stringify(evidence.applicationExit),
        JSON.stringify({ code: 0, signal: null }),
      );
    }
  }
});
