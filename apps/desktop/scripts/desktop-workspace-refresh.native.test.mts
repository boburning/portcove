import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { executeBrowserScript as productionBrowserScript } from "./browser-script.mts";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
type Workspace = typeof import("./desktop-workspace-refresh-test.mts");
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function runContract<Arguments extends unknown[]>(
  contract: (subject: Workspace, ...args: Arguments) => Promise<void>,
  args: Arguments,
  options?: { alias?: keyof Workspace; disabled?: keyof Workspace; expected?: string },
) {
  return runDesktopModuleFixture(
    new URL("./desktop-workspace-refresh-test.mts", import.meta.url),
    `
    import {runInNewContext} from 'node:vm';
    const {executeBrowserScript:productionBrowserScript}=await import(new URL('./browser-script.mts',entry));
    const object=${object.toString()};
    const actual=await import(entry);
    const disabled=${JSON.stringify(options?.disabled ?? null)};
    const subject=disabled?{...actual,[disabled]:(...args)=>{
      const done=args.at(-1);if(typeof done==='function')done({ok:true});
      return {restored:true,commands:[]};
    }}:actual;
    let rejected=false;
    try { await (${contract.toString()})(subject,...${JSON.stringify(args)}); }
    catch(error) {
      if(!disabled||error?.code!=='ERR_ASSERTION'||!error.message.includes(${JSON.stringify(options?.expected ?? null)}))throw error;
      rejected=true;console.log('WORKSPACE_EXPECTED_BEHAVIORAL_REJECTION '+disabled);
    }
    if(disabled)assert.equal(rejected,true,'Disabled callback unexpectedly retained its behavior');
  `,
    options?.alias ? { exportName: options.alias, variant: "aliased" } : undefined,
  );
}

async function terminalContract(subject: Workspace) {
  const target = "http://ipc.localhost/create_support_bundle";
  const calls: { input: unknown; args: unknown[] }[] = [];
  const original = async (input: unknown, ...args: unknown[]) => {
    calls.push({ input, args });
    return new Response("native result");
  };
  const events: unknown[][] = [];
  const window = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: () => target,
      invoke: async (...args: unknown[]) => {
        events.push(args);
      },
    },
    __portcoveExternalReconciliationProbe: { originalFetch: original, commands: [] },
  };
  const execute = (callback: unknown, args: unknown[] = []) => {
    assert.ok(typeof callback === "function");
    const result: unknown = runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, args, URL, Response },
      { timeout: 1000 },
    );
    return result;
  };
  const browser = {
    executeScript: async (callback: unknown, ...args: unknown[]) => execute(callback, args),
    executeAsyncScript: (callback: unknown, activity: unknown) =>
      new Promise<unknown>((done, reject) => {
        try {
          execute(callback, [activity, done]);
        } catch (error) {
          reject(error);
        }
      }),
  };
  const invokeBrowser = (callback: unknown, ...args: unknown[]): unknown =>
    Reflect.apply(productionBrowserScript, undefined, [browser, callback, ...args]);
  const adoptedActivity = {
    id: "owned-terminal",
    operation: "adopt",
    target_kind: "port",
    target_id: "owned-port",
  };
  const reply = await browser.executeAsyncScript(subject.replayTerminalActivity, adoptedActivity);
  assert.equal(object(reply).ok, true);
  assert.equal(events.length, 1, "workspace terminal progress event");
  const event = object(events[0]?.[1]);
  const payload = object(event.payload);
  assert.equal(event.event, "portcove://operation");
  assert.equal(payload.operation_id, adoptedActivity.id);
  assert.equal(payload.operation, adoptedActivity.operation);
  assert.equal(payload.type, "progress");
  assert.equal(JSON.stringify(payload.target), JSON.stringify({ kind: "port", id: "owned-port" }));
  await invokeBrowser(subject.installReconciliationSupportGate);
  const options = { method: "POST", headers: { retained: "yes" } };
  const pending = window.fetch(target, options);
  assert.equal(calls.length, 0, "workspace support held before dispatch");
  assert.equal(Reflect.get(window.__portcoveExternalReconciliationProbe, "supportRequests"), 1);
  const unrelated = "http://ipc.localhost/get_activities";
  assert.equal(await (await window.fetch(unrelated, options)).text(), "native result");
  assert.equal(calls[0]?.input, unrelated);
  const release: unknown = Reflect.get(
    window.__portcoveExternalReconciliationProbe,
    "releaseSupport",
  );
  assert.ok(typeof release === "function");
  await invokeBrowser(subject.releaseReconciliationSupportGate);
  assert.equal(await (await pending).text(), "native result");
  assert.equal(calls[1]?.input, target);
  assert.equal(calls[1]?.args[0], options);
}

async function forwardingContract(subject: Workspace, kind: "refresh" | "reconciliation") {
  const target = "http://ipc.localhost/get_workspace_snapshot";
  const calls: { input: unknown; args: unknown[]; response: Promise<Response> }[] = [];
  const original = (input: unknown, ...args: unknown[]) => {
    const response = Promise.resolve(new Response("native result"));
    calls.push({ input, args, response });
    return response;
  };
  const events: unknown[][] = [];
  const window = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: () => target,
      invoke: async (...args: unknown[]) => {
        events.push(args);
      },
    },
  };
  const execute = (callback: unknown, args: unknown[] = []) => {
    assert.ok(typeof callback === "function");
    const result: unknown = runInNewContext(
      `(${callback.toString()})(...args)`,
      {
        window,
        args,
        Response,
        URL,
        location: { href: "https://app.example/" },
      },
      { timeout: 1000 },
    );
    return result;
  };
  const browser = {
    executeScript: async (callback: unknown, ...args: unknown[]) => execute(callback, args),
    executeAsyncScript: (callback: unknown) =>
      new Promise<unknown>((done, reject) => {
        try {
          execute(callback, [done]);
        } catch (error) {
          reject(error);
        }
      }),
  };
  const invokeBrowser = (callback: unknown, ...args: unknown[]): unknown =>
    Reflect.apply(productionBrowserScript, undefined, [browser, callback, ...args]);
  const installed =
    kind === "refresh"
      ? await browser.executeAsyncScript(subject.installWorkspaceRefreshProbe)
      : await invokeBrowser(subject.installExternalReconciliationProbe);
  if (kind === "refresh") {
    assert.equal(object(installed).ok, true);
    assert.equal(
      JSON.stringify(events),
      JSON.stringify([
        ["plugin:event|emit", { event: "portcove://library-changed", payload: "refresh-probe" }],
      ]),
      "workspace refresh installation event",
    );
  }
  if (kind === "reconciliation")
    assert.ok(
      Object.hasOwn(window, "__portcoveExternalReconciliationProbe"),
      "workspace reconciliation installation",
    );
  const options = { method: "POST", headers: { "x-retained": "yes" } };
  const inputs: unknown[] = [
    target,
    new URL(target),
    new Request(target),
    runInNewContext("({toString() {return target}})", { target }),
    { url: target },
    { url: null, toString: () => target },
    { url: undefined, toString: () => target },
  ];
  for (const [index, input] of inputs.entries()) {
    const before = calls.length;
    const response = window.fetch(input, options);
    if (kind === "refresh" && index === 0) {
      assert.equal(calls.length, before);
      const rejected = await response;
      assert.equal(rejected.headers.get("Tauri-Response"), "error");
      const payload = object(await rejected.json());
      assert.equal(payload.code, "state");
      assert.equal(payload.message, "synthetic-native-refresh-failure");
    } else {
      const call = calls.at(-1);
      assert.ok(call);
      assert.equal(call.input, input);
      assert.deepEqual(call.args, [options]);
      assert.equal(response, call.response);
      assert.equal(await (await response).text(), "native result");
    }
  }
  const restored = await invokeBrowser(
    kind === "refresh"
      ? subject.restoreWorkspaceRefreshProbe
      : subject.restoreExternalReconciliationProbe,
  );
  const observation = object(restored);
  assert.equal(observation.restored, true);
  assert.equal(window.fetch, original, `workspace ${kind} exact fetch restoration`);
  const commands: unknown = observation.commands;
  assert.ok(Array.isArray(commands));
  assert.equal(commands.length, inputs.length);
  assert.ok(commands.every((command: unknown) => command === "get_workspace_snapshot"));
  assert.equal(
    Object.hasOwn(
      window,
      kind === "refresh" ? "__portcoveRefreshProbe" : "__portcoveExternalReconciliationProbe",
    ),
    false,
  );
}

async function sourceFormatContract(subject: Workspace) {
  const target = "http://ipc.localhost/get_workspace_snapshot";
  let payload: unknown = {
    revision: "preserved",
    statuses: [
      {
        port_id: "selected",
        readiness: { launchable: true, retained: 1 },
        port_actions: [{ action: "launch" }, { action: "backup", retained: 2 }],
      },
      { port_id: "other", retained: 3 },
    ],
  };
  const calls: unknown[][] = [];
  const original = async (...args: unknown[]) => {
    calls.push(args);
    return new Response(JSON.stringify(payload), { headers: { "X-Custody": "original" } });
  };
  const window = {
    fetch: original,
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: { convertFileSrc: () => target },
    __portcoveExternalReconciliationProbe: { originalFetch: original, commands: [] },
  };
  const browser = {
    executeScript: async (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function");
      const result: unknown = runInNewContext(
        `(${callback.toString()})(...args)`,
        { window, args, Response, Event },
        { timeout: 1000 },
      );
      return result;
    },
  };
  const invokeBrowser = (callback: unknown, ...args: unknown[]): unknown =>
    Reflect.apply(productionBrowserScript, undefined, [browser, callback, ...args]);
  await invokeBrowser(subject.installSourceFormatProbe, "selected");
  const init = { method: "POST" };
  const response = await window.fetch(target, init);
  assert.equal(response.headers.get("X-Custody"), "original");
  const modified: unknown = await response.json();
  const result = object(modified);
  assert.equal(result.revision, "preserved");
  assert.ok(Array.isArray(result.statuses));
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.statuses)),
    [
      {
        port_id: "selected",
        readiness: {
          launchable: false,
          retained: 1,
          source: "current",
          blockers: ["incompatible_source"],
          required_source_extension: "z64",
        },
        port_actions: [
          { action: "launch", availability: "waiting", reason: "incompatible_source" },
          { action: "backup", retained: 2 },
        ],
      },
      { port_id: "other", retained: 3 },
    ],
    "workspace source format selected status",
  );
  assert.equal(calls[0]?.[0], target);
  assert.equal(calls[0]?.[1], init);
  const forwardedInputs: unknown[] = [
    new URL(target),
    { url: target },
    { url: undefined, toString: () => target },
    { url: null, toString: () => target },
    runInNewContext("({ toString() { return target; } })", { target }),
    runInNewContext("Object.assign(function () {}, { url: target })", { target }),
  ];
  for (const input of forwardedInputs) {
    const response = await window.fetch(input, init);
    const observed = object(await response.json());
    assert.ok(Array.isArray(observed.statuses));
    assert.equal(object(object(observed.statuses[0]).readiness).required_source_extension, "z64");
    assert.equal(calls.at(-1)?.[0], input);
    assert.equal(calls.at(-1)?.[1], init);
  }
  for (const input of [42, true, undefined, null]) {
    assert.deepEqual(await (await window.fetch(input, init)).json(), payload);
    assert.equal(calls.at(-1)?.[0], input);
  }
  payload = { statuses: [{ port_id: "other", preserved: true }] };
  assert.deepEqual(await (await window.fetch(target)).json(), payload);
  payload = { statuses: [{ port_id: "selected", readiness: null, port_actions: [] }] };
  await assert.rejects(window.fetch(target), /Workspace readiness/);
  const restored = await invokeBrowser(subject.restoreSourceFormatProbe);
  assert.equal(restored, true, "workspace source format restoration result");
  assert.equal(window.fetch, original);
}

void test("serialized terminal-activity replay and support gate preserve executable callbacks and request custody", () => {
  runContract(terminalContract, []);
  runContract(terminalContract, [], { alias: "replayTerminalActivity" });
});
for (const kind of ["refresh", "reconciliation"] as const) {
  void test(`serialized workspace ${kind} probe preserves forwarding, injection and restoration`, () => {
    runContract(forwardingContract, [kind]);
    runContract(forwardingContract, [kind], {
      alias:
        kind === "refresh" ? "installWorkspaceRefreshProbe" : "installExternalReconciliationProbe",
    });
  });
}
void test("serialized source-format injection preserves unrelated snapshots and restores its exact fetch", () => {
  runContract(sourceFormatContract, []);
  runContract(sourceFormatContract, [], { alias: "installSourceFormatProbe" });
});
void test("workspace contracts reject disabled production callback dependencies", () => {
  const expected = {
    replayTerminalActivity: "workspace terminal progress event",
    installReconciliationSupportGate: "workspace support held before dispatch",
    installWorkspaceRefreshProbe: "workspace refresh installation event",
    restoreWorkspaceRefreshProbe: "workspace refresh exact fetch restoration",
    installExternalReconciliationProbe: "workspace reconciliation installation",
    restoreExternalReconciliationProbe: "workspace reconciliation exact fetch restoration",
    installSourceFormatProbe: "workspace source format selected status",
    restoreSourceFormatProbe: "workspace source format restoration result",
  } as const;
  function reject<Arguments extends unknown[]>(
    contract: (subject: Workspace, ...args: Arguments) => Promise<void>,
    args: Arguments,
    disabled: keyof typeof expected,
  ) {
    const output = runContract(contract, args, { disabled, expected: expected[disabled] });
    assert.equal(output.trim(), "WORKSPACE_EXPECTED_BEHAVIORAL_REJECTION " + disabled);
  }
  for (const disabled of ["replayTerminalActivity", "installReconciliationSupportGate"] as const)
    reject(terminalContract, [], disabled);
  for (const disabled of ["installWorkspaceRefreshProbe", "restoreWorkspaceRefreshProbe"] as const)
    reject(forwardingContract, ["refresh"], disabled);
  for (const disabled of [
    "installExternalReconciliationProbe",
    "restoreExternalReconciliationProbe",
  ] as const)
    reject(forwardingContract, ["reconciliation"], disabled);
  for (const disabled of ["installSourceFormatProbe", "restoreSourceFormatProbe"] as const)
    reject(sourceFormatContract, [], disabled);
});
