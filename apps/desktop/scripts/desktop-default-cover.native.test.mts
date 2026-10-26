import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../../../scripts/runtime-values.mts";

import { createImageRefusal, restoreCacheAfterObservation } from "./desktop-cover-observations.mts";

void test("default cover restoration preserves primary failures and still closes the refusal proxy", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-cover-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("owned inert cover bytes"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const original = path.join(directory, `${digest}.jpg`),
    retained = path.join(directory, "retained.jpg");
  const blocked = path.join(directory, "blocked");
  await writeFile(blocked, "ordinary file blocks diagnostic publication");
  t.mock.method(console, "error", () => {});
  for (const primary of [undefined, null, false, 0, "", new Error("primary")]) {
    for (const failureSite of ["restore", "close", "diagnostic"] as const) {
      let closes = 0;
      const artifacts: string[] = [];
      const cleanupError = new Error("restoration refused"),
        closeError = new Error("proxy close refused");
      const result = restoreCacheAfterObservation({
        withheld: { original, retained },
        primaryFailure: { error: primary },
        output: failureSite === "diagnostic" ? blocked : directory,
        artifacts,
        restart: () => (failureSite === "close" ? Promise.resolve() : Promise.reject(cleanupError)),
        refusal: {
          close: () => {
            closes += 1;
            return Promise.reject(closeError);
          },
        },
      });
      await result; // The enclosing scenario rethrows its original primary failure.
      assert.equal(closes, 1);
      assert.equal(artifacts.length, failureSite === "diagnostic" ? 0 : 1);
      if (failureSite !== "diagnostic") {
        const diagnostic = artifacts[0];
        assert.ok(diagnostic);
        assert.equal(
          await readFile(diagnostic, "utf8"),
          JSON.stringify({
            primary: errorMessage(primary),
            cleanup: failureSite === "close" ? closeError.message : cleanupError.message,
          }),
        );
      }
    }
  }
  for (const failure of [undefined, null, false, 0, "", new Error("cleanup")]) {
    for (const site of ["restore", "close"] as const) {
      let closes = 0;
      const result = restoreCacheAfterObservation({
        withheld: site === "restore" ? { original, retained } : undefined,
        restart: () => Promise.reject(failure),
        primaryFailure: undefined,
        output: directory,
        artifacts: [],
        refusal: {
          close: () => {
            closes += 1;
            return Promise.reject(
              site === "close" ? failure : new Error("secondary close failure"),
            );
          },
        },
      });
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => Object.is(error, failure),
      );
      assert.equal(closes, 1);
    }
  }
  await writeFile(retained, bytes);
  let closes = 0;
  await restoreCacheAfterObservation({
    withheld: { original, retained },
    primaryFailure: undefined,
    output: directory,
    artifacts: [],
    restart: async (_name, prepare) => {
      assert.ok(prepare);
      await prepare();
    },
    refusal: {
      close: async () => {
        closes += 1;
      },
    },
  });
  assert.equal(closes, 1);
  assert.deepEqual(await readFile(original), bytes);
  await assert.rejects(readFile(retained), { code: "ENOENT" });
});

void test("default cover observation remains inert when its scenario is not selected", async () => {
  const source = stripTypeScriptTypes(
    await readFile(new URL("./desktop-default-cover-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const start = source.indexOf("export async function defaultCoverScenario(");
  const end = source.indexOf("async function assertEmptyCache(", start);
  assert.ok(start >= 0 && end > start);
  const scenario = source.slice(start, end).replace("export ", "");
  assert.match(scenario, /\bawait\s+restoreCacheAfterObservation\s*\(/u);
  let visited = 0;
  const result: unknown = runInNewContext(`${scenario} defaultCoverScenario(context)`, {
    context: {
      browser: undefined,
      scenario: async () => {
        visited += 1;
      },
    },
  });
  await result;
  assert.equal(visited, 1);
});

void test("default cover refusal proxy rejects owned CONNECT traffic without retaining request secrets", async (t) => {
  const proxy = await createImageRefusal();
  t.after(() => proxy.close());
  const environment = proxy.environment;
  const address = new URL(environment.HTTPS_PROXY);
  assert.equal(address.hostname, "127.0.0.1");
  const socket = connect(Number(address.port), address.hostname);
  t.after(() => socket.destroy());
  const response = await new Promise<string>((resolve, reject) => {
    let output = "";
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("owned refusal proxy did not respond"));
    });
    socket.once("error", reject);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    socket.once("end", () => resolve(output));
    socket.once("connect", () =>
      socket.write(
        "CONNECT images.igdb.com:443 HTTP/1.1\r\nHost: images.igdb.com:443\r\nAuthorization: test-secret-never-retain\r\n\r\n",
      ),
    );
  });
  assert.match(response, /^HTTP\/1\.1 503 Service Unavailable/u);
  assert.equal(JSON.stringify(proxy.origins), JSON.stringify(["images.igdb.com"]));
});
