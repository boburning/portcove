/** Inert browser-realm oracles; actual production modules provide every caller.
 * Source fragments are never reconstructed. Browser callbacks and foreign inputs
 * still execute in their intended separate JavaScript realm.
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mock } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const object = record;
function ipcSource(target: string) {
  const convertFileSrc = (command: string, protocol: string) => {
    assert.equal(command, "get_workspace_snapshot", "NATIVE_FETCH_IPC_COMMAND");
    assert.equal(protocol, "ipc", "NATIVE_FETCH_IPC_PROTOCOL");
    return target;
  };
  assert.throws(() => convertFileSrc("wrong_command", "ipc"), {
    code: "ERR_ASSERTION",
    message: /NATIVE_FETCH_IPC_COMMAND/,
  });
  assert.throws(() => convertFileSrc("get_workspace_snapshot", "wrong_protocol"), {
    code: "ERR_ASSERTION",
    message: /NATIVE_FETCH_IPC_PROTOCOL/,
  });
  return convertFileSrc;
}
function reverseFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseFields);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseFields(entry)]),
    );
  return value;
}
function nativeCall(
  subject: Readonly<Record<string, unknown>>,
  name: string,
  args: unknown[],
): unknown {
  const method = subject[name];
  assert.ok(typeof method === "function", "NATIVE_FETCH_PROBE_EXPORT");
  return Reflect.apply(method, undefined, args);
}

export async function runReadinessFetchProbeOracle(
  subject: Readonly<Record<string, unknown>>,
  kind: "action" | "readiness",
  reordered = false,
) {
  const target = "https://ipc.example/get_workspace_snapshot";
  const inputValues: unknown[] = [
    target,
    new URL(target),
    new Request(target),
    runInNewContext("({toString() { return target; }})", { target }),
    { url: target },
    { url: undefined, toString: () => target },
    { url: null, toString: () => target },
  ];
  const other = {
    port_id: "other",
    readiness: { launchable: true },
    port_actions: [{ action: "launch", availability: "allowed", extra: "other" }],
  };
  const first = {
    port_id: "owned",
    readiness: { launchable: true },
    port_actions: [
      { action: "launch", availability: "allowed", extra: "first" },
      { action: "install", availability: "waiting", extra: "unrelated" },
    ],
  };
  const second = {
    port_id: "owned",
    readiness: { launchable: true },
    port_actions: [
      { action: "launch", availability: "allowed", extra: "second" },
      { action: "backup", availability: "allowed", extra: "second-only" },
    ],
  };
  let payload: unknown = { metadata: { retained: true }, statuses: [first, other, second] };
  const calls: { input: unknown; args: unknown[]; response: Response }[] = [];
  const original = async (input: unknown, ...args: unknown[]) => {
    const response = new Response(JSON.stringify(reordered ? reverseFields(payload) : payload), {
      headers: { "x-retained": "yes" },
    });
    calls.push({ input, args, response });
    return response;
  };
  const window: {
    fetch: typeof original;
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string, protocol: string) => string;
      invoke: () => Promise<void>;
    };
    __portcoveActionHoldProbe?: unknown;
    __portcoveReadinessProbe?: unknown;
  } = {
    fetch: original,
    __TAURI_INTERNALS__: { convertFileSrc: ipcSource(target), invoke: async () => {} },
  };
  const browser = {
    executeScript: (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function");
      return runInNewContext(
        `(${callback.toString()})(...args)`,
        { window, args },
        { timeout: 1000 },
      );
    },
    executeAsyncScript: async (callback: unknown, ...args: unknown[]): Promise<unknown> => {
      assert.ok(typeof callback === "function");
      return new Promise<unknown>((done, reject) => {
        try {
          runInNewContext(
            `(${callback.toString()})(...args, done)`,
            { window, args, done, Response, URL, Request, Error },
            { timeout: 1000 },
          );
        } catch (error) {
          reject(error);
        }
      });
    },
  };
  const installed = nativeCall(
    subject,
    kind === "action" ? "injectActionHold" : "injectReadinessOmission",
    kind === "action" ? [browser, "owned", "launch"] : [browser, "owned"],
  );
  await installed;
  assert.notEqual(window.fetch, original, "NATIVE_FETCH_PROBE_INSTALLATION");
  const options = { method: "POST", headers: { "x-exact": "retained" } };
  for (const input of inputValues) {
    const fetched: unknown = runInNewContext("window.fetch(input, options)", {
      window,
      input,
      options,
    });
    const response = await fetched;
    assert.ok(response instanceof Response);
    assert.equal(response.headers.get("x-retained"), "yes");
    const value = record(await response.json());
    assert.deepEqual(structuredClone(value.metadata), { retained: true });
    assert.ok(Array.isArray(value.statuses));
    const statuses: unknown[] = value.statuses;
    assert.deepEqual(structuredClone(statuses[1]), other);
    for (const [index, expected] of [
      [0, "first"],
      [2, "second"],
    ] as const) {
      const row = record(statuses[index]);
      if (kind === "readiness") {
        assert.equal(row.readiness, null);
        assert.deepEqual(
          structuredClone(row.port_actions),
          index === 0 ? first.port_actions : second.port_actions,
        );
      } else {
        assert.ok(Array.isArray(row.port_actions));
        const actions: unknown[] = row.port_actions;
        assert.equal(record(actions[0]).availability, "held");
        assert.equal(record(actions[0]).extra, expected);
        assert.deepEqual(
          structuredClone(actions[1]),
          (index === 0 ? first : second).port_actions[1],
        );
      }
    }
    const call = calls.at(-1);
    assert.ok(call);
    assert.equal(call.input, input);
    assert.equal(call.args[0], options);
  }
  for (const input of [null, undefined, false, 0, {}, "https://foreign.example/"]) {
    const fetched: unknown = runInNewContext("window.fetch(input, options)", {
      window,
      input,
      options,
    });
    const response = await fetched;
    assert.equal(
      response,
      calls.at(-1)?.response,
      "untargeted responses must be forwarded unchanged",
    );
  }
  for (const malformed of [null, [], { statuses: null }, { statuses: [null, {}] }]) {
    payload = malformed;
    const response = await window.fetch(target, options);
    assert.equal(
      response,
      calls.at(-1)?.response,
      "malformed unmatched snapshots must remain unchanged",
    );
  }
  if (kind === "action") {
    const restored = nativeCall(subject, "restoreActionHold", [browser, "allowed"]);
    await restored;
    assert.equal(window.__portcoveActionHoldProbe, undefined);
  } else {
    const observations: { probe?: unknown } = {};
    observations.probe = await nativeCall(subject, "restoreReadinessOmission", [browser]);
    assert.equal(record(observations.probe).restored, true);
    assert.equal(window.__portcoveReadinessProbe, undefined);
  }
  assert.equal(window.fetch, original);
}

export async function runInstallFetchProbeOracle(subject: Readonly<Record<string, unknown>>) {
  const target = "http://ipc.localhost/get_workspace_snapshot";
  const calls: { input: unknown; args: unknown[]; response: Promise<Response> }[] = [];
  const original = (input: unknown, ...args: unknown[]) => {
    const response = Promise.resolve(new Response("native commit result"));
    calls.push({ input, args, response });
    return response;
  };
  const window = { fetch: original, __TAURI_INTERNALS__: { convertFileSrc: ipcSource(target) } };
  let clicks = 0;
  const document = {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "button", "INSTALL_REFRESH_RETRY_SELECTOR");
      return [
        {
          textContent: "Retry refresh",
          click: () => {
            clicks++;
          },
        },
      ];
    },
  };
  assert.throws(() => document.querySelectorAll("unrelated"), {
    code: "ERR_ASSERTION",
    message: /INSTALL_REFRESH_RETRY_SELECTOR/,
  });
  const execute = (callback: unknown, args: unknown[] = []): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, document, args, Response, URL, location: { href: "https://owned.example/" } },
      { timeout: 1000 },
    );
  };
  const browser = {
    executeScript: (callback: unknown, ...args: unknown[]) => execute(callback, args),
    executeAsyncScript: (callback: unknown) =>
      new Promise<unknown>((done, reject) => {
        try {
          execute(callback, [done]);
        } catch (error) {
          reject(error);
        }
      }),
  };
  const installed = await nativeCall(subject, "installRefreshProbe", [browser]);
  assert.ok(installed !== undefined, "INSTALL_REFRESH_PROBE_INSTALLATION");
  assert.equal(object(installed).installed, true);
  const inputs: unknown[] = [
    target,
    new URL(target),
    new Request(target),
    runInNewContext("({toString() {return target;}})", { target }),
    { url: target },
    { url: null, toString: () => target },
    { url: undefined, toString: () => target },
  ];
  const options = { method: "POST", headers: { "x-exact": "retained" } };
  for (const input of inputs) {
    const response = await window.fetch(input, options);
    assert.equal(response.headers.get("Tauri-Response"), "error");
    const payload = object(await response.json());
    assert.equal(payload.code, "state");
    assert.equal(payload.message, "synthetic-post-install-refresh-failure");
  }
  assert.equal(calls.length, 0);
  const retried = await nativeCall(subject, "retryRefreshProbe", [browser]);
  assert.equal(retried, true);
  assert.equal(clicks, 1);
  for (const input of inputs) {
    const response = window.fetch(input, options);
    const call = calls.at(-1);
    assert.ok(call);
    assert.equal(call.input, input);
    assert.deepEqual(call.args, [options]);
    assert.equal(response, call.response);
    assert.equal(await (await response).text(), "native commit result");
  }
  const restored = await nativeCall(subject, "restoreRefreshProbe", [browser]);
  const probe = object(restored);
  assert.equal(probe.installed, true);
  assert.equal(probe.restored, true);
  assert.equal(probe.failing, false);
  assert.equal(probe.injected, inputs.length);
  assert.ok(Array.isArray(probe.commands));
  assert.equal(probe.commands.length, inputs.length * 2);
  assert.ok(probe.commands.every((command: unknown) => command === "get_workspace_snapshot"));
  assert.equal(window.fetch, original);
  assert.equal(Object.hasOwn(window, "__portcoveInstallRefreshProbe"), false);
}

/** Enter the actual scenario and stop only after its omission is installed. */
export async function runReadinessCallerProbe(
  entry: string,
  replies: { command: string; value: Record<string, unknown> }[],
) {
  const port = replies.find((reply) => reply.command === "port")?.value;
  const status = replies.find((reply) => reply.command === "status")?.value;
  assert.ok(port && status, "NATIVE_READINESS_DECLARED_REPLIES");
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-readiness-caller-"));
  const sentinel = new Error("owned readiness caller stopped after probe installation");
  const original = async () => new Response("{}");
  const window: Record<string, unknown> = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string, protocol: string) => {
        assert.equal(command, "get_workspace_snapshot");
        assert.equal(protocol, "ipc");
        return "https://ipc.example/get_workspace_snapshot";
      },
      invoke: async (command: string) => {
        assert.equal(command, "plugin:event|emit");
      },
    },
  };
  const browser = {
    executeScript: (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function");
      return runInNewContext(
        `(${callback.toString()})(...args)`,
        { window, args },
        { timeout: 1000 },
      );
    },
    executeAsyncScript: (callback: unknown, ...args: unknown[]) =>
      new Promise<unknown>((done, reject) => {
        assert.ok(typeof callback === "function");
        try {
          runInNewContext(
            `(${callback.toString()})(...args,done)`,
            { window, args, done, Response, URL, Request, Error },
            { timeout: 1000 },
          );
        } catch (error) {
          reject(error);
        }
      }),
    wait: async () => {
      assert.ok(window.__portcoveReadinessProbe, "NATIVE_READINESS_PROBE_REQUIRED");
      throw sentinel;
    },
  };
  let selected = 0;
  let stopped = false;
  try {
    const subject: Readonly<Record<string, unknown>> = await import(entry);
    try {
      await nativeCall(subject, "readinessScenario", [
        {
          browser,
          output: root,
          artifacts: [],
          command: (args: string[]) => {
            if (args.join(" ") === "catalog show opengoal-jak1") return port;
            assert.deepEqual(args, ["status", port.id]);
            return status;
          },
          open: async (actual: unknown, refresh: unknown) => {
            assert.equal(actual, port);
            assert.equal(refresh, false);
          },
          scenario: async (name: string, operation: () => Promise<void>) => {
            if (name !== "native-missing-readiness-recovery") return;
            selected++;
            await operation();
          },
        },
      ]);
    } catch (error) {
      assert.equal(error, sentinel, "NATIVE_READINESS_CALLER_FAILURE_IDENTITY");
      stopped = true;
    }
    assert.equal(stopped, true, "NATIVE_READINESS_CALLER_NOT_INVOKED");
    assert.equal(selected, 1);
    assert.equal(window.fetch, original, "NATIVE_READINESS_CALLER_RESTORATION");
    assert.equal(window.__portcoveReadinessProbe, undefined);
    const report = path.join(root, "readiness-observations.json");
    const bytes = await readFile(report, "utf8");
    assert.equal(record(JSON.parse(bytes)).failure, sentinel.message);
    await assert.rejects(writeFile(report, "overwrite", { flag: "wx" }), { code: "EEXIST" });
    assert.equal(await readFile(report, "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Public scenario wiring uses an inert selector provider and never starts an install. */
export async function runInstallCallerProbe(entry: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-install-caller-"));
  const sentinel = new Error("owned install caller stopped after probe installation");
  const original = async () => new Response("native commit result");
  const window: Record<string, unknown> = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: ipcSource("http://ipc.localhost/get_workspace_snapshot"),
    },
  };
  const element = { click: async () => {}, sendKeys: async () => {} };
  const browser = {
    executeScript: (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function");
      return runInNewContext(
        `(${callback.toString()})(...args)`,
        { window, args },
        { timeout: 1000 },
      );
    },
    executeAsyncScript: (callback: unknown, ...args: unknown[]) =>
      new Promise<unknown>((done, reject) => {
        assert.ok(typeof callback === "function");
        try {
          runInNewContext(
            `(${callback.toString()})(...args,done)`,
            { window, args, done, Response, URL, Error },
            { timeout: 1000 },
          );
        } catch (error) {
          reject(error);
        }
      }),
    findElement: async () => {
      if (window.__portcoveInstallRefreshProbe) throw sentinel;
      return element;
    },
    wait: async () => element,
  };
  const controlsUrl = new URL("./desktop-review-controls.mts", entry).href;
  const controls: Readonly<Record<string, unknown>> = await import(controlsUrl);
  mock.module(controlsUrl, {
    namedExports: {
      ...controls,
      selectCatalogPort: async (actual: unknown, id: unknown) => {
        assert.equal(actual, browser);
        assert.equal(id, "owned-refresh", "NATIVE_INSTALL_SELECTED_TARGET");
      },
    },
  });
  let selected = 0;
  let stopped = false;
  try {
    const subject: Readonly<Record<string, unknown>> = await import(entry);
    try {
      await nativeCall(subject, "installScenarios", [
        {
          browser,
          library: root,
          output: root,
          artifacts: [],
          inputs: [],
          fixture: { requests: [], refreshPort: { id: "owned-refresh", name: "Owned refresh" } },
          invoke: async () => {
            throw new Error("NATIVE_INSTALL_UNEXPECTED_IPC");
          },
          confirmNative: () => {
            throw new Error("NATIVE_INSTALL_UNEXPECTED_CONFIRMATION");
          },
          restartApplication: async () => {
            throw new Error("NATIVE_INSTALL_UNEXPECTED_RESTART");
          },
          scenario: async (name: string, operation: () => Promise<void>) => {
            if (name !== "install-commit-refresh-recovery") return;
            selected++;
            await operation();
          },
        },
      ]);
    } catch (error) {
      assert.equal(error, sentinel, "NATIVE_INSTALL_CALLER_FAILURE_IDENTITY");
      stopped = true;
    }
    assert.equal(stopped, true, "NATIVE_INSTALL_CALLER_NOT_INVOKED");
    assert.equal(selected, 1);
    assert.equal(window.fetch, original, "NATIVE_INSTALL_CALLER_RESTORATION");
    assert.equal(window.__portcoveInstallRefreshProbe, undefined);
    const report = path.join(root, "install-commit-refresh-recovery.json");
    const bytes = await readFile(report, "utf8");
    assert.equal(record(JSON.parse(bytes)).failure, sentinel.message);
    await assert.rejects(writeFile(report, "overwrite", { flag: "wx" }), { code: "EEXIST" });
    assert.equal(await readFile(report, "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
