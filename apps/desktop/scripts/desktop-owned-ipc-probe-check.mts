// The fixture alone owns intentionally retained callback state. Public Channel
// types correctly hide this method; inspect its pinned runtime before calling.
function cleanupFixtureChannel(channel: object) {
  const cleanup: unknown = Reflect.get(channel, "cleanupCallback");
  assert.ok(typeof cleanup === "function");
  Reflect.apply(cleanup, channel, []);
}
function fixtureValue<T>(value: T): NonNullable<T> {
  assert.ok(value != null);
  return value;
}
function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined);
  return value;
}
import type { ProbeNative } from "./desktop-owned-ipc-probe.mts";
import type { OutputOperationEvent } from "../src/transport-types.generated.d.ts";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import {
  beginProgressiveScanProbe,
  beginReviewedUpdateProbe,
  isUntrustworthyProbeError,
  requireTrustedProbeCleanup,
} from "./desktop-owned-ipc-probe.mts";

const pins = {
  "core.js": "71056442a732cca1f03572ccae96d68e16104c3a591c64de9618cd304e063070",
  "ipc-protocol.js": "68ae690606006f733bde75dd8bb6748464954a22c7e83914a93b1abc221d7072",
  "process-ipc-message-fn.js": "d51917f89e4d3d318d63f1f4f5a7ac7ea1399a5b85c81a840c4d606597f29132",
};

async function transport() {
  const runtime: Record<string, string> = {};
  for (const [file, digest] of Object.entries(pins)) {
    const bytes = await readFile(new URL(`./testdata/tauri-2.11.6/${file}.txt`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, file);
    runtime[file] = bytes.toString("utf8");
  }
  const api = new URL("../node_modules/@tauri-apps/api/", import.meta.url);
  assert.match(
    await readFile(new URL("../../../Cargo.lock", import.meta.url), "utf8"),
    /name = "tauri"\nversion = "2\.12\.5"/,
  );
  const manifest: unknown = JSON.parse(await readFile(new URL("package.json", api), "utf8"));
  assert.ok(isRecord(manifest));
  assert.equal(manifest.version, "2.12.4");
  const clientSource = await readFile(new URL("core.js", api), "utf8");
  assert.equal(
    createHash("sha256").update(clientSource).digest("hex"),
    "956eba26ffeb23576f29f70813c272c2915722b3b19bf00f86718c335b313da0",
  );
  const tslibUrl = new URL("external/tslib/tslib.es6.js", api);
  assert.equal(
    createHash("sha256")
      .update(await readFile(tslibUrl))
      .digest("hex"),
    "88571c39817ebe327cfb45cf2d5ff9e68c544523d526f09ac2cc99acfc8fcf1b",
  );
  const tslib: unknown = await import(tslibUrl.href);
  assert.ok(isRecord(tslib));
  const asyncErrors: unknown[] = [];
  const dispatch = { forwarded: 0, fallback: 0 };
  const context = createContext({
    Response,
    Headers,
    TextDecoder,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    // The current real Channel reports throwing handlers asynchronously while
    // continuing delivery. Observe only this isolated runtime's scheduled errors.
    queueMicrotask(callback: () => void) {
      queueMicrotask(() => {
        try {
          callback();
        } catch (error) {
          asyncErrors.push(error);
        }
      });
    },
    __classPrivateFieldSet: tslib.__classPrivateFieldSet,
    __classPrivateFieldGet: tslib.__classPrivateFieldGet,
    console: { warn() {} },
    crypto: webcrypto,
    __TAURI_INTERNALS__: {},
  });
  context.window = context;
  context.fetch = async () => {
    dispatch.forwarded++;
    return new Response('"inert native dispatch"');
  };
  context.ipc = {
    postMessage(data: string) {
      dispatch.fallback++;
      const payload: unknown = JSON.parse(data);
      assert.ok(isRecord(payload) && typeof payload.error === "number");
      const native = context.__TAURI_INTERNALS__ as ProbeNative;
      native.runCallback(payload.error, "inert fallback dispatch");
    },
  };
  runInContext(
    fixtureValue(runtime["core.js"])
      .replaceAll("__TEMPLATE_os_name__", '"windows"')
      .replaceAll("__TEMPLATE_protocol_scheme__", '"http"'),
    context,
  );
  runInContext(
    fixtureValue(runtime["ipc-protocol.js"])
      .replaceAll("__TEMPLATE_invoke_key__", '"inert-test-key"')
      .replaceAll("__TEMPLATE_os_name__", '"windows"')
      .replaceAll("__TEMPLATE_fetch_channel_data_command__", '"plugin:__TAURI_CHANNEL__|fetch"')
      .replaceAll(
        "__RAW_process_ipc_message_fn__",
        fixtureValue(runtime["process-ipc-message-fn.js"]),
      ),
    context,
  );
  const native = context.__TAURI_INTERNALS__ as ProbeNative & {
    ipc: unknown;
    postMessage: unknown;
  };
  native.ipc = native.postMessage;
  // Preserve the hash-pinned API implementation. Only its one import/export
  // boundary is wired into this VM, avoiding process-global window/error hooks.
  const importLine =
    "import { __classPrivateFieldSet, __classPrivateFieldGet } from './external/tslib/tslib.es6.js';";
  const exportLine =
    "export { Channel, PluginListener, Resource, SERIALIZE_TO_IPC_FN, addPluginListener, checkPermissions, convertFileSrc, invoke, isTauri, requestPermissions, transformCallback };";
  assert.ok(clientSource.startsWith(importLine));
  assert.ok(clientSource.endsWith(`${exportLine}\n`));
  runInContext(
    clientSource
      .replace(importLine, "")
      .replace(exportLine, exportLine.replace("export ", "globalThis.__client = ")),
    context,
  );
  const browser = {
    // Mirror Selenium's generic serialization contract in this isolated VM only.
    executeScript: async <Result,>(
      fn: string | ((...args: never[]) => unknown),
      ...args: unknown[]
    ): Promise<Result> => {
      context.__args = args;
      const value: unknown = await runInContext(`(${fn.toString()})(...__args)`, context);
      const serialized: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
      return serialized as Result;
    },
  };
  // Hash-pinned API source above owns this runtime shape; use its authoritative public declarations.
  const client = context.__client as typeof import("@tauri-apps/api/core");
  const checkedContext = context as typeof context & {
    __TAURI_INTERNALS__: ProbeNative;
    fetch: typeof globalThis.fetch;
  };
  return { context: checkedContext, browser, dispatch, client, asyncErrors };
}

async function runCase(
  check: (fixture: Awaited<ReturnType<typeof transport>>) => Promise<void>,
  expectedAsyncErrors: readonly string[] = [],
) {
  const fixture = await transport();
  await check(fixture);
  assert.deepEqual(fixture.asyncErrors.map(errorMessage), expectedAsyncErrors);
  assert.deepEqual(fixture.dispatch, { forwarded: 0, fallback: 0 });
}

const source = { profile_id: "owned", path: "owned", sha256: "owned", size: 1 };
const update = {
  portId: "owned",
  generation: 4,
  plan: { plan_sha256: "owned-controlled-update-plan" },
  failure: { message: "Controlled update failure", mutation_state: "unknown" },
};

export async function verifyOwnedProbeTransport() {
  const primary = Object.freeze(new Error("Primary scenario failure"));
  requireTrustedProbeCleanup({ trustworthy: false }, primary);
  assert.equal(isUntrustworthyProbeError(primary), true);
  assert.equal(primary.message, "Primary scenario failure");
  assert.throws(
    () => requireTrustedProbeCleanup({ trustworthy: false }),
    (error) => isUntrustworthyProbeError(error),
  );
  for (const primary of ["thrown failure", 7, false, 0, "", null, undefined]) {
    assert.throws(
      () => requireTrustedProbeCleanup({ trustworthy: false }, primary),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          isUntrustworthyProbeError(error),
          true,
          "Unproven cleanup must force outer teardown",
        );
        assert.strictEqual(error.cause, primary, "Retain the original primitive failure");
        return true;
      },
    );
  }
  for (const payload of [
    null,
    7,
    "unexpected",
    [],
    {},
    { onEvent: "__CHANNEL__:foreign" },
    new Uint8Array([123]),
  ]) {
    await runCase(async ({ context, browser, client }) => {
      const probe = await beginProgressiveScanProbe(browser, { source });
      // @ts-expect-error Deliberately malformed primitive/array IPC arguments must reach the pinned runtime.
      await assert.rejects(client.invoke("scan_game_file_roots", payload), /Controlled scan/);
      const report = await probe.restore();
      assert.equal(report.restored, true);
      assert.equal(fixtureElement(report.response_cleanup, 0).completed, true);
      assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
    });
    for (const command of ["plan_game_update", "apply_game_update"])
      await runCase(async ({ context, browser, client }) => {
        const probe = await beginReviewedUpdateProbe(browser, update);
        // @ts-expect-error Deliberately malformed IPC arguments exercise actual transport rejection.
        await assert.rejects(client.invoke(command, payload), (error) => {
          assert.deepEqual(error, update.failure);
          return true;
        });
        const report = await probe.restore();
        assert.equal(report.restored, true);
        assert.equal(fixtureElement(report.response_cleanup, 0).completed, true);
        assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
      });
  }
  // A malformed tuple still settles the actual invocation and its admitted Channel.
  for (const mismatch of [
    { portId: "foreign" },
    { activate: true },
    { generation: -1 },
    { expectedPlan: "foreign" },
  ])
    await runCase(async ({ context, browser, client }) => {
      const probe = await beginReviewedUpdateProbe(browser, update);
      const channel = new client.Channel(() => assert.fail("Update probe emits no progress"));
      await assert.rejects(
        client.invoke("apply_game_update", {
          portId: update.portId,
          generation: update.generation,
          activate: false,
          expectedPlan: update.plan.plan_sha256,
          onEvent: channel,
          ...mismatch,
        }),
        (error) => {
          assert.deepEqual(error, update.failure);
          return true;
        },
      );
      const report = await probe.restore();
      assert.equal(report.channels, 1);
      assert.equal(fixtureElement(report.channel_cleanup, 0).attempted, true);
      assert.equal(fixtureElement(report.channel_cleanup, 0).completed, true);
      assert.equal(fixtureElement(report.response_cleanup, 0).completed, true);
      assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
    });
  await runCase(async ({ context, browser, client }) => {
    const probe = await beginReviewedUpdateProbe(browser, update);
    const tuple = { portId: update.portId, generation: update.generation, activate: false };
    assert.deepEqual(await client.invoke("plan_game_update", tuple), update.plan);
    await assert.rejects(
      client.invoke("apply_game_update", {
        ...tuple,
        expectedPlan: update.plan.plan_sha256,
        onEvent: new client.Channel(),
      }),
      (error) => {
        assert.deepEqual(error, update.failure);
        return true;
      },
    );
    assert.deepEqual(await client.invoke("plan_game_update", tuple), update.plan);
    const report = await probe.restore();
    assert.equal(report.trustworthy, true);
    assert.equal(report.plans, 2);
    assert.equal(report.applies, 1);
    assert.equal(report.channels, 1);
    assert.deepEqual(report.mismatches, []);
    assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
  });
  for (const fault of ["none", "channel-close", "foreign-fetch", "event-handler"]) {
    await runCase(
      async ({ context, browser, client, asyncErrors }) => {
        const events: OutputOperationEvent[] = [];
        if (fault === "channel-close") {
          const native = context.__TAURI_INTERNALS__;
          const facade: ProbeNative = Object.create(native) as ProbeNative;
          Object.defineProperty(facade, "runCallback", {
            value(id: number, value: unknown) {
              if (isRecord(value) && value.end) throw new Error("Owned Channel close failed");
              return native.runCallback(id, value);
            },
          });
          context.__TAURI_INTERNALS__ = facade;
        }
        const original = context.fetch;
        const probe = await beginProgressiveScanProbe(browser, { source });
        const channel = new client.Channel<OutputOperationEvent>((message) => {
          if (fault === "event-handler") throw new Error("Owned event handler failed");
          events.push(message);
        });
        const invocation = client.invoke("scan_game_file_roots", { onEvent: channel });
        const rejected = assert.rejects(invocation, /Controlled scan/);
        assert.deepEqual(
          events.map((event) => event.type),
          fault === "event-handler" ? [] : ["started", "source_candidate"],
        );
        if (fault !== "event-handler") {
          assert.equal(
            context.__TAURI_INTERNALS__.callbacks.size,
            3,
            "Owned response stays pending",
          );
          assert.equal(
            fixtureElement(fixtureValue(await probe.capture()).response_cleanup, 0).attempted,
            false,
          );
        }
        const foreign = () => assert.fail("Foreign replacement must not run during cleanup");
        if (fault === "foreign-fetch") context.fetch = foreign;
        const first = probe.restore();
        assert.strictEqual(probe.restore(), first, "Concurrent restoration is the same operation");
        const report = await first;
        await rejected;
        assert.strictEqual(await probe.restore(), report, "Terminal report is retained");
        assert.equal(fixtureElement(report.response_cleanup, 0).attempted, true);
        assert.equal(
          fixtureElement(report.response_cleanup, 0).completed,
          true,
          "Channel failure cannot prevent response completion",
        );
        assert.equal(fixtureElement(report.channel_cleanup, 0).index, 2);
        assert.deepEqual(
          asyncErrors.map(errorMessage),
          fault === "event-handler"
            ? ["Owned event handler failed", "Owned event handler failed"]
            : [],
        );
        assert.equal(report.trustworthy, fault === "none" || fault === "event-handler");
        if (fault === "channel-close") {
          assert.equal(fixtureElement(report.channel_cleanup, 0).attempted, true);
          assert.equal(fixtureElement(report.channel_cleanup, 0).completed, false);
          assert.match(
            fixtureValue(fixtureElement(report.channel_cleanup, 0).error),
            /close failed/,
          );
          assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 1);
          cleanupFixtureChannel(channel); // Test fixture owns the intentionally retained callback.
        } else assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
        assert.strictEqual(context.fetch, fault === "foreign-fetch" ? foreign : original);
        assert.equal(report.fetch.attempted, fault !== "foreign-fetch");
        assert.equal(report.fetch.completed, fault !== "foreign-fetch");
      },
      fault === "event-handler" ? ["Owned event handler failed", "Owned event handler failed"] : [],
    );
  }
  for (const fault of ["missing-state", "lost-window"]) {
    await runCase(async ({ browser }) => {
      const probe = await beginProgressiveScanProbe(browser, { source });
      if (fault === "missing-state") {
        await executeBrowserScript(browser, () => {
          for (const key of Object.keys(window).filter((key: string) =>
            key.startsWith("__portcoveOwnedIpcProbe_"),
          ))
            Reflect.deleteProperty(window, key);
        });
        assert.equal(await probe.capture(), null);
      } else
        browser.executeScript = async () => {
          throw new Error("Owned renderer unavailable");
        };
      const report = await probe.restore();
      assert.equal(report.trustworthy, false);
      assert.equal(report.restored, false);
      assert.equal(report.fetch.attempted, false);
      assert.strictEqual(await probe.restore(), report);
    });
  }
  await runCase(async ({ context, browser, client }) => {
    const foreignEvents: unknown[] = [];
    const foreign = new client.Channel((event) => foreignEvents.push(event));
    const probe = await beginProgressiveScanProbe(browser, { source });
    const rejected = assert.rejects(
      client.invoke("scan_game_file_roots", { onEvent: `__CHANNEL__:${foreign.id}` }),
      /Controlled scan/,
    );
    const report = await probe.restore();
    await rejected;
    assert.deepEqual(foreignEvents, []);
    assert.equal(context.__TAURI_INTERNALS__.callbacks.has(foreign.id), true);
    assert.equal(report.trustworthy, false);
    assert.equal(fixtureElement(report.channel_cleanup, 0).owned, false);
    cleanupFixtureChannel(foreign);
  });
  for (const fault of ["removed", "replaced"]) {
    await runCase(async ({ context, browser, client }) => {
      const probe = await beginProgressiveScanProbe(browser, { source });
      const channel = new client.Channel();
      const rejected = assert.rejects(
        client.invoke("scan_game_file_roots", { onEvent: channel }),
        /Controlled scan/,
      );
      const foreign = () => assert.fail("Foreign Channel callback must remain untouched");
      const callbacks = context.__TAURI_INTERNALS__.callbacks;
      if (fault === "removed") callbacks.delete(channel.id);
      else callbacks.set(channel.id, foreign);
      const report = await probe.restore();
      await rejected;
      assert.equal(report.trustworthy, false);
      assert.equal(fixtureElement(report.channel_cleanup, 0).attempted, false);
      assert.equal(fixtureElement(report.channel_cleanup, 0).completed, null);
      assert.equal(fixtureElement(report.response_cleanup, 0).completed, true);
      assert.strictEqual(callbacks.get(channel.id), fault === "removed" ? undefined : foreign);
      callbacks.delete(channel.id); // Fixture alone owns its injected replacement.
    });
    await runCase(async ({ context, browser, client }) => {
      const probe = await beginProgressiveScanProbe(browser, { source });
      const channel = new client.Channel();
      const invocation = client.invoke("scan_game_file_roots", { onEvent: channel });
      const callbacks = context.__TAURI_INTERNALS__.callbacks;
      const bindings = [...callbacks].filter(([id]) => id !== channel.id);
      let settled = false;
      const rejected = assert.rejects(invocation, /Fixture settlement/).then(() => {
        settled = true;
      });
      const foreign = () => assert.fail("Foreign invoke callback must remain untouched");
      for (const [id] of bindings)
        if (fault === "removed") callbacks.delete(id);
        else callbacks.set(id, foreign);
      const report = await probe.restore();
      assert.equal(settled, false, "Callback absence does not establish invoke completion");
      assert.equal(report.trustworthy, false);
      assert.equal(fixtureElement(report.channel_cleanup, 0).completed, true);
      assert.equal(fixtureElement(report.response_cleanup, 0).attempted, false);
      assert.equal(fixtureElement(report.response_cleanup, 0).completed, null);
      for (const [id] of bindings)
        assert.strictEqual(callbacks.get(id), fault === "removed" ? undefined : foreign);
      // Re-admit only the fixture's original observers, then reap its pending invocation.
      for (const [id, callback] of bindings) callbacks.set(id, callback);
      fixtureElement(bindings, 1)[1]("Fixture settlement");
      await rejected;
    });
  }
  await runCase(async ({ context, browser, client }) => {
    const probe = await beginProgressiveScanProbe(browser, { source });
    await assert.rejects(
      client.invoke("scan_game_file_roots", {
        toJSON() {
          const ids = [...context.__TAURI_INTERNALS__.callbacks.keys()];
          return { onEvent: `__CHANNEL__:${ids[0]}` };
        },
      }),
      /Controlled scan/,
    );
    const report = await probe.restore();
    assert.equal(fixtureElement(report.channel_cleanup, 0).owned, false);
    assert.equal(fixtureElement(report.response_cleanup, 0).completed, true);
    assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
  });
}

if (process.argv[2] === "--transport-preflight") {
  await verifyOwnedProbeTransport();
  console.log("Owned probe pinned-transport preflight passed.");
}
