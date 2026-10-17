import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import type { WebDriver } from "selenium-webdriver";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { artworkObservations } from "./desktop-artwork-observations.mts";

function object(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function objects(value: unknown) {
  assert.ok(Array.isArray(value));
  const entries: unknown[] = value;
  return entries.map(object);
}

void test("native serialized artwork probe preserves responses, bounds observations and restores fetch", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-artwork-probe-"));
  const artifacts: string[] = [];
  let body: unknown = {
    availability: "ready",
    choice: { revision: 7, asset_sha256: "a".repeat(64) },
    png_base64: "YWJjZA==",
    ignored_secret: "private-body",
  };
  let result = "ok";
  let transportFailure = false;
  const original: typeof fetch = async () => {
    if (transportFailure) throw new Error("owned transport failure");
    return new Response(JSON.stringify(body), { headers: { "Tauri-Response": result } });
  };
  const window = { fetch: original };
  const context = createContext({
    window,
    URL,
    Response,
    performance,
    location: { href: "http://tauri.localhost" },
    document: { querySelectorAll: () => [] },
  });
  let serialized = 0;
  // This dependency-free transport fixture serializes callbacks after the native
  // Node loader erases annotations. Actual Selenium handle/serialization behavior
  // is separately protected by browser-script.test.mts.
  const driver: Pick<WebDriver, "executeScript"> = {
    async executeScript<Result>(
      script: string | { toString(): string },
      ...args: unknown[]
    ): Promise<Result> {
      context.args = args;
      serialized++;
      const source = typeof script === "string" ? `function(){${script}}` : script.toString();
      const value: unknown = runInContext(`(${source}).apply(null,args)`, context);
      // The generic WebDriver executor owns deserialization; this fixture uses
      // a VM as that boundary. All observable fields are independently checked below.
      return value as Result;
    },
  };
  const probe = artworkObservations({ browser: driver, output, artifacts });
  const flush = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const settled: unknown = runInContext(
        "window.__portcoveArtworkProbe.requests.every(record => record.completed || record.observation_error)",
        context,
      );
      if (settled === true) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("owned response observations did not settle");
  };
  try {
    await probe.begin();
    const response = await window.fetch("http://ipc.localhost/get_artwork", {
      headers: { "private-header": "never-record-header" },
    });
    assert.deepEqual(await response.json(), body);
    await flush();
    // @ts-expect-error Untyped WebIDL callers can provide URL-coercible primitives.
    const primitiveResponse = await window.fetch(123);
    assert.deepEqual(
      await primitiveResponse.json(),
      body,
      "primitive inputs must still be forwarded",
    );
    const foreignInput: unknown = runInNewContext(
      '({ toString() { return "http://ipc.localhost/get_artwork"; } })',
    );
    // A foreign JavaScript URL-coercible object intentionally crosses the typed
    // fetch boundary; native fetch accepts its string form without a local URL brand.
    // @ts-expect-error Deliberate foreign-realm input has no trustworthy static Fetch type.
    await window.fetch(foreignInput);
    await flush();
    const observedCount: unknown = runInContext(
      "window.__portcoveArtworkProbe.requests.length",
      context,
    );
    assert.equal(
      observedCount,
      2,
      "a foreign URL-coercible input must retain observation coverage",
    );
    result = "error";
    body = {
      code: "owned-error",
      message: "x".repeat(700),
      presentation: { summary: "s".repeat(700), mutation_state: "unchanged" },
      ignored_secret: "private-error-body",
    };
    await window.fetch(new URL("http://ipc.localhost/import_artwork"));
    await flush();
    body = { presentation: { summary: 42 } };
    await window.fetch("http://ipc.localhost/reset_artwork");
    await flush();
    // The parser rejection is only diagnostic; the caller still gets its response.
    for (let attempt = 0; attempt < 100; attempt++) {
      const recorded: unknown = runInContext(
        "Boolean(window.__portcoveArtworkProbe.requests[3].observation_error)",
        context,
      );
      if (recorded === true) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    transportFailure = true;
    await assert.rejects(
      window.fetch("http://ipc.localhost/get_artwork_thumbnail"),
      /owned transport failure/,
    );
    transportFailure = false;
    for (let index = 5; index < 258; index++)
      await window.fetch("http://ipc.localhost/get_artwork");
    await flush();
    await probe.finish("owned failure marker");
    assert.equal(window.fetch, original);
    assert.ok(
      serialized >= 2,
      "native-loaded callback source must execute in a separate JavaScript VM",
    );
    assert.equal(artifacts.length, 1);
    const text = await readFile(path.join(output, "artwork-request-observations.json"), "utf8");
    for (const secret of ["YWJjZA==", "private-body", "private-error-body", "never-record-header"])
      assert.ok(!text.includes(secret));
    const report = object(JSON.parse(text));
    const documents = objects(report.documents);
    const document = documents[0];
    assert.ok(document);
    assert.equal(document.restored, true);
    assert.equal(document.omitted_requests, 2);
    const requests = objects(document.requests);
    assert.equal(requests.length, 256);
    const first = requests[0],
      failure = requests[2],
      malformed = requests[3],
      transport = requests[4];
    assert.ok(first && failure && malformed && transport);
    assert.deepEqual(object(first.observation), {
      availability: "ready",
      revision: 7,
      asset_sha256: "a".repeat(64),
      png_encoded_bytes: 8,
      png_bytes: 4,
    });
    assert.equal(object(failure.failure).message, "x".repeat(512));
    assert.equal(object(failure.failure).summary, "s".repeat(512));
    assert.match(String(malformed.observation_error), /summary must be text/);
    assert.equal(transport.transport_error, "owned transport failure");
    assert.equal(Object.hasOwn(window, "__portcoveArtworkProbe"), false);
  } finally {
    assert.equal(path.dirname(output), tmpdir());
    await rm(output, { recursive: true, force: true });
  }
});
