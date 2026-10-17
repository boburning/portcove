import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../apps/desktop/scripts/desktop-listener-lifetime-test.mjs", import.meta.url),
  "utf8",
);
const marker = "function install(key, reviewed, currentRoot) {";
assert.equal(source.indexOf(marker), source.lastIndexOf(marker));
assert.ok(source.indexOf(marker) > 0);

for (const outcome of ["ok", "error"])
  test(`listener probe distinguishes actual ${outcome} from HTTP200`, async () => {
    const callbacks = new Map();
    let next = 1;
    let eventId = 10;
    const window = {
      __TAURI_INTERNALS__: { callbacks, convertFileSrc: (command) => command },
      fetch: async (command) =>
        new Response(
          JSON.stringify(
            command.endsWith("listen") && !command.endsWith("unlisten") ? eventId++ : null,
          ),
          {
            status: 200,
            headers: { "Tauri-Response": command.endsWith("unlisten") ? outcome : "ok" },
          },
        ),
    };
    const original = window.fetch;
    const install = runInNewContext(`${source.slice(source.indexOf(marker))}\ninstall`, {
      window,
      Headers,
      Response,
      TextDecoder,
      setTimeout,
    });
    install("probe", "owned-reviewed", "owned-current");
    async function invoke(command, body) {
      const success = next++,
        failure = next++;
      let result;
      callbacks.set(success, (value) => {
        result = { ok: true, value };
      });
      callbacks.set(failure, (value) => {
        result = { ok: false, value };
      });
      const response = await window.fetch(command, {
        headers: { "Tauri-Callback": String(success), "Tauri-Error": String(failure) },
        body: JSON.stringify(body),
      });
      callbacks.get(response.headers.get("Tauri-Response") === "ok" ? success : failure)(
        await response.json(),
      );
      callbacks.delete(success);
      callbacks.delete(failure);
      return result;
    }
    const firstHandler = next++;
    callbacks.set(firstHandler, () => {});
    const first = invoke("plugin:event|listen", {
      event: "portcove://operation",
      handler: firstHandler,
    });
    while (!window.probe.capture().listeners[0]?.event_id)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const secondHandler = next++;
    callbacks.set(secondHandler, () => {});
    await invoke("plugin:event|listen", { event: "portcove://operation", handler: secondHandler });
    window.probe.release();
    const registered = await first;
    // Pinned event API removes this JS callback even when the native RPC rejects.
    callbacks.delete(firstHandler);
    await invoke("plugin:event|unlisten", {
      event: "portcove://operation",
      eventId: registered.value,
    });
    const cleanup = await window.probe.restore();
    assert.equal(cleanup.trustworthy, outcome === "ok");
    assert.equal(cleanup.listeners[0].unlistened, outcome === "ok");
    assert.equal(callbacks.has(secondHandler), true);
    assert.equal(window.fetch, original);
    assert.ok(cleanup.responses.every((entry) => entry.settled));
  });
