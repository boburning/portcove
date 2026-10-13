import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import {
  beginProgressiveScanProbe,
  beginReviewedUpdateProbe,
  isUntrustworthyProbeError,
  requireTrustedProbeCleanup,
} from "./desktop-owned-ipc-probe.mjs";

const pins = {
  "core.js": "71056442a732cca1f03572ccae96d68e16104c3a591c64de9618cd304e063070",
  "ipc-protocol.js": "68ae690606006f733bde75dd8bb6748464954a22c7e83914a93b1abc221d7072",
  "process-ipc-message-fn.js": "d51917f89e4d3d318d63f1f4f5a7ac7ea1399a5b85c81a840c4d606597f29132",
};

async function transport() {
  const runtime = {};
  for (const [file, digest] of Object.entries(pins)) {
    const bytes = await readFile(new URL(`./testdata/tauri-2.11.6/${file}.txt`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, file);
    runtime[file] = bytes.toString("utf8");
  }
  const api = new URL("../node_modules/@tauri-apps/api/", import.meta.url);
  assert.match(
    await readFile(new URL("../../../Cargo.lock", import.meta.url), "utf8"),
    /name = "tauri"\nversion = "2\.11\.6"/,
  );
  assert.equal(JSON.parse(await readFile(new URL("package.json", api), "utf8")).version, "2.11.1");
  assert.equal(
    createHash("sha256")
      .update(await readFile(new URL("core.js", api)))
      .digest("hex"),
    "b2187a1c0c0a25806dc64f8823757ce553c09d3bbe3e409bd05cab32e245f1c9",
  );
  const dispatch = { forwarded: 0, fallback: 0 };
  const context = createContext({
    Response,
    Headers,
    TextDecoder,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
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
    postMessage(data) {
      dispatch.fallback++;
      context.__TAURI_INTERNALS__.runCallback(JSON.parse(data).error, "inert fallback dispatch");
    },
  };
  runInContext(
    runtime["core.js"]
      .replaceAll("__TEMPLATE_os_name__", '"windows"')
      .replaceAll("__TEMPLATE_protocol_scheme__", '"http"'),
    context,
  );
  runInContext(
    runtime["ipc-protocol.js"]
      .replaceAll("__TEMPLATE_invoke_key__", '"inert-test-key"')
      .replaceAll("__TEMPLATE_os_name__", '"windows"')
      .replaceAll("__TEMPLATE_fetch_channel_data_command__", '"plugin:__TAURI_CHANNEL__|fetch"')
      .replaceAll("__RAW_process_ipc_message_fn__", runtime["process-ipc-message-fn.js"]),
    context,
  );
  context.__TAURI_INTERNALS__.ipc = context.__TAURI_INTERNALS__.postMessage;
  const browser = {
    executeScript: async (fn, ...args) => {
      context.__args = args;
      const value = await runInContext(`(${fn.toString()})(...__args)`, context);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
  };
  return { context, browser, dispatch, client: await import(new URL("core.js", api)) };
}

async function runCase(check) {
  const fixture = await transport();
  const previous = globalThis.window;
  globalThis.window = fixture.context;
  try {
    await check(fixture);
    assert.deepEqual(fixture.dispatch, { forwarded: 0, fallback: 0 });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
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
      await assert.rejects(client.invoke("scan_game_file_roots", payload), /Controlled scan/);
      const report = await probe.restore();
      assert.equal(report.restored, true);
      assert.equal(report.response_cleanup[0].completed, true);
      assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
    });
    for (const command of ["plan_game_update", "apply_game_update"])
      await runCase(async ({ context, browser, client }) => {
        const probe = await beginReviewedUpdateProbe(browser, update);
        await assert.rejects(client.invoke(command, payload), (error) => {
          assert.deepEqual(error, update.failure);
          return true;
        });
        const report = await probe.restore();
        assert.equal(report.restored, true);
        assert.equal(report.response_cleanup[0].completed, true);
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
      assert.equal(report.channel_cleanup[0].attempted, true);
      assert.equal(report.channel_cleanup[0].completed, true);
      assert.equal(report.response_cleanup[0].completed, true);
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
    await runCase(async ({ context, browser, client }) => {
      const events = [];
      if (fault === "channel-close") {
        const native = context.__TAURI_INTERNALS__;
        const facade = Object.create(native);
        Object.defineProperty(facade, "runCallback", {
          value(id, value) {
            if (value.end) throw new Error("Owned Channel close failed");
            return native.runCallback(id, value);
          },
        });
        context.__TAURI_INTERNALS__ = facade;
      }
      const original = context.fetch;
      const probe = await beginProgressiveScanProbe(browser, { source });
      const channel = new client.Channel((message) => {
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
        assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 3, "Owned response stays pending");
        assert.equal((await probe.capture()).response_cleanup[0].attempted, false);
      }
      const foreign = () => assert.fail("Foreign replacement must not run during cleanup");
      if (fault === "foreign-fetch") context.fetch = foreign;
      const first = probe.restore();
      assert.strictEqual(probe.restore(), first, "Concurrent restoration is the same operation");
      const report = await first;
      await rejected;
      assert.strictEqual(await probe.restore(), report, "Terminal report is retained");
      assert.equal(report.response_cleanup[0].attempted, true);
      assert.equal(
        report.response_cleanup[0].completed,
        true,
        "Channel failure cannot prevent response completion",
      );
      assert.equal(report.channel_cleanup[0].index, fault === "event-handler" ? 0 : 2);
      assert.equal(report.trustworthy, fault === "none" || fault === "event-handler");
      if (fault === "channel-close") {
        assert.equal(report.channel_cleanup[0].attempted, true);
        assert.equal(report.channel_cleanup[0].completed, false);
        assert.match(report.channel_cleanup[0].error, /close failed/);
        assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 1);
        channel.cleanupCallback(); // Test fixture owns the intentionally retained callback.
      } else assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
      assert.strictEqual(context.fetch, fault === "foreign-fetch" ? foreign : original);
      assert.equal(report.fetch.attempted, fault !== "foreign-fetch");
      assert.equal(report.fetch.completed, fault !== "foreign-fetch");
    });
  }
  for (const fault of ["missing-state", "lost-window"]) {
    await runCase(async ({ browser }) => {
      const probe = await beginProgressiveScanProbe(browser, { source });
      if (fault === "missing-state") {
        await browser.executeScript(() => {
          for (const key of Object.keys(window).filter((key) =>
            key.startsWith("__portcoveOwnedIpcProbe_"),
          ))
            delete window[key];
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
    const foreignEvents = [];
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
    assert.equal(report.channel_cleanup[0].owned, false);
    foreign.cleanupCallback();
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
      assert.equal(report.channel_cleanup[0].attempted, false);
      assert.equal(report.channel_cleanup[0].completed, null);
      assert.equal(report.response_cleanup[0].completed, true);
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
      assert.equal(report.channel_cleanup[0].completed, true);
      assert.equal(report.response_cleanup[0].attempted, false);
      assert.equal(report.response_cleanup[0].completed, null);
      for (const [id] of bindings)
        assert.strictEqual(callbacks.get(id), fault === "removed" ? undefined : foreign);
      // Re-admit only the fixture's original observers, then reap its pending invocation.
      for (const [id, callback] of bindings) callbacks.set(id, callback);
      bindings[1][1]("Fixture settlement");
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
    assert.equal(report.channel_cleanup[0].owned, false);
    assert.equal(report.response_cleanup[0].completed, true);
    assert.equal(context.__TAURI_INTERNALS__.callbacks.size, 0);
  });
}

if (process.argv[2] === "--transport-preflight") {
  await verifyOwnedProbeTransport();
  console.log("Owned probe pinned-transport preflight passed.");
}
