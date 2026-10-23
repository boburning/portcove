import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { WebDriver } from "selenium-webdriver";
import { it, onTestFinished } from "vite-plus/test";
import { disposableDirectory } from "../../../scripts/fixtures/disposable-directory.mts";
import { listenerLifetimeScenario } from "./desktop-listener-lifetime-test.mts";
import { installListenerLifetimeProbe } from "./desktop-listener-lifetime-probe.mts";

it("the real listener scenario serializes its imported probe with the owned identities and mode", async () => {
  for (const mode of ["late", "reject"] as const) {
    const output = disposableDirectory(
      { after: (cleanup) => onTestFinished(cleanup) },
      path.join(os.tmpdir(), "portcove-listener-wiring-"),
    );
    const currentRoot = "/owned/current-library";
    const stopped = new Error("inert stop at the first serialized browser call");
    const calls: { script: unknown; args: unknown[] }[] = [];
    const invocations: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const browser = {
      executeScript(script: unknown, ...args: unknown[]) {
        calls.push({ script, args });
        throw stopped;
      },
    } as unknown as WebDriver;
    await assert.rejects(
      listenerLifetimeScenario({
        browser,
        output,
        artifacts: [],
        mode,
        chooseOwnedLibrary: async () => assert.fail("No native picker may run in this control"),
        observeRunning: async () => assert.fail("No operation may run in this control"),
        invoke: async (name, args) => {
          invocations.push({ name, args });
          if (name === "get_bootstrap_status")
            return {
              ok: true,
              value: {
                ready: true,
                library_root: currentRoot,
                selection: null,
                generation: 9,
                error: null,
              },
            };
          assert.equal(name, "get_library_identity");
          return { ok: true, value: { id: "owned-library", root: currentRoot } };
        },
      }),
      (error: unknown) => error === stopped,
    );
    assert.deepEqual(invocations, [
      { name: "get_bootstrap_status", args: undefined },
      { name: "get_library_identity", args: { generation: 9 } },
    ]);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.script, installListenerLifetimeProbe);
    assert.equal(call.args.length, 4);
    assert.match(String(call.args[0]), /^__portcoveListenerProbe_[a-f0-9-]{36}$/u);
    assert.deepEqual(call.args.slice(1), [
      path.join(output, "listener-reviewed-alternate"),
      currentRoot,
      mode,
    ]);
  }
});
