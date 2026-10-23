import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  activateManualRefresh,
  installListenerLifetimeProbe,
} from "../apps/desktop/scripts/desktop-listener-lifetime-probe.mts";

void test("manual refresh arms only an idle unique visible owner and activates it in the same turn", () => {
  const calls: string[] = [];
  let busy = true;
  let duplicates = false;
  let hidden = false;
  let visibility = "visible";
  class Button {
    textContent = "Refresh now";
    disabled = false;
    isConnected = true;
    closest() {
      return hidden ? {} : null;
    }
    getClientRects() {
      return [{}];
    }
    click() {
      calls.push("click");
    }
  }
  const button = new Button();
  const notice = {
    querySelectorAll(selector: string) {
      return selector === "strong"
        ? [{ textContent: "Live workspace updates are unavailable" }]
        : [button];
    },
  };
  const raw: unknown = runInNewContext(`(${activateManualRefresh.toString()})`, {
    document: {
      querySelectorAll(selector: string) {
        assert.equal(selector, '[role="status"][aria-busy="false"]');
        return busy ? [] : duplicates ? [notice, notice] : [notice];
      },
    },
    window: {
      probe: {
        armRefresh() {
          calls.push("arm");
        },
      },
    },
    HTMLButtonElement: Button,
    getComputedStyle: () => ({ display: "inline-flex", visibility }),
  });
  assert.equal(typeof raw, "function");
  const activate = raw as (key: string) => boolean;
  assert.equal(activate("probe"), false);
  busy = false;
  duplicates = true;
  assert.equal(activate("probe"), false);
  duplicates = false;
  button.disabled = true;
  assert.equal(activate("probe"), false);
  button.disabled = false;
  hidden = true;
  assert.equal(activate("probe"), false);
  hidden = false;
  button.isConnected = false;
  assert.equal(activate("probe"), false);
  button.isConnected = true;
  visibility = "hidden";
  assert.equal(activate("probe"), false);
  assert.deepEqual(calls, []);
  visibility = "visible";
  assert.equal(activate("probe"), true);
  assert.deepEqual(calls, ["arm", "click"]);
});

for (const outcome of ["ok", "error"])
  void test(`listener probe distinguishes actual ${outcome} from HTTP200`, async () => {
    const callbacks = new Map<number, (value: unknown) => void>();
    let next = 1;
    let eventId = 10;
    type Probe = {
      capture(): { listeners: { event_id: unknown; callback_present: boolean }[] };
      release(): void;
      restore(): Promise<{
        trustworthy: boolean;
        listeners: { unlistened: boolean; callback_present: boolean }[];
        responses: { settled: boolean }[];
      }>;
    };
    const window: {
      __TAURI_INTERNALS__: {
        callbacks: typeof callbacks;
        convertFileSrc: (command: string) => string;
      };
      fetch: (command: string, request?: RequestInit) => Promise<Response>;
      probe?: Probe;
    } = {
      __TAURI_INTERNALS__: { callbacks, convertFileSrc: (command: string) => command },
      fetch: async (command: string) =>
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
    const rawInstall: unknown = runInNewContext(`(${installListenerLifetimeProbe.toString()})`, {
      window,
      Headers,
      Response,
      TextDecoder,
      setTimeout,
      Map,
    });
    assert.ok(typeof rawInstall === "function");
    const install = rawInstall as (key: string, reviewed: string, currentRoot: string) => void;
    install("probe", "owned-reviewed", "owned-current");
    async function invoke(command: string, body: Record<string, unknown>) {
      const success = next++,
        failure = next++;
      let result: { ok: boolean; value: unknown } | undefined;
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
      const callback = callbacks.get(
        response.headers.get("Tauri-Response") === "ok" ? success : failure,
      );
      assert.ok(callback);
      callback(await response.json());
      callbacks.delete(success);
      callbacks.delete(failure);
      assert.ok(result);
      return result;
    }
    const firstHandler = next++;
    callbacks.set(firstHandler, () => {});
    const first = invoke("plugin:event|listen", {
      event: "portcove://operation",
      handler: firstHandler,
    });
    assert.ok(window.probe);
    while (!window.probe.capture().listeners[0]?.event_id)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(window.probe.capture().listeners[0]?.callback_present, true);
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
    assert.equal(cleanup.listeners[0]?.unlistened, outcome === "ok");
    assert.equal(cleanup.listeners[0]?.callback_present, false);
    assert.equal(cleanup.listeners[1]?.callback_present, true);
    assert.equal(callbacks.has(secondHandler), true);
    assert.equal(window.fetch, original);
    assert.ok(cleanup.responses.every((entry) => entry.settled));
  });
