import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-install-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function segment(from: string, until: string, offset = 0) {
  const start = source.indexOf(from, offset),
    end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
void test("serialized install refresh rejection, explicit retry and restoration preserve real IPC forwarding", async () => {
  const target = "http://ipc.localhost/get_workspace_snapshot";
  const calls: { input: unknown; args: unknown[]; response: Promise<Response> }[] = [];
  const original = (input: unknown, ...args: unknown[]) => {
    const response = Promise.resolve(new Response("native commit result"));
    calls.push({ input, args, response });
    return response;
  };
  const window = { fetch: original, __TAURI_INTERNALS__: { convertFileSrc: () => target } };
  let clicks = 0;
  const document = {
    querySelectorAll: () => [
      {
        textContent: "Retry refresh",
        click: () => {
          clicks++;
        },
      },
    ],
  };
  const execute = (callback: unknown, args: unknown[] = []): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      { window, document, args, Response, URL, location: { href: "https://owned.example/" } },
      { timeout: 1000 },
    );
  };
  const browser = {
    executeAsyncScript: (callback: unknown) =>
      new Promise<unknown>((done, reject) => {
        try {
          execute(callback, [done]);
        } catch (error) {
          reject(error);
        }
      }),
  };
  const executeBrowserScript = (_browser: unknown, callback: unknown) => execute(callback);
  const installation = segment(
    "const installedProbe = await browser.executeAsyncScript",
    "assert.equal(object(installedProbe)",
  );
  const installed: unknown = await runInNewContext(
    `(async () => {${installation} return installedProbe;})()`,
    { browser },
  );
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
  const retry = segment(
    "await executeBrowserScript(browser, () => {",
    "        true,",
    source.indexOf("const retryButton") - 250,
  );
  const retried: unknown = await runInNewContext(
    `(async () => {return ${retry.trim().replace(/,$/u, "")};})()`,
    { browser, executeBrowserScript },
  );
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
  const restore = segment(
    "await executeBrowserScript(browser, () => {",
    "        assert.ok(observations.probe.installed)",
    source.indexOf("observations.probe ="),
  );
  const restored: unknown = await runInNewContext(`(async () => {return ${restore};})()`, {
    browser,
    executeBrowserScript,
  });
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
});
void test("serialized staged layout retains action identity, state and actual placement facts", () => {
  const layout = segment("function readStagedLayout(", "function assertStagedActionPlacement(");
  const bounds = { left: 20, right: 128, top: 20, bottom: 60 };
  const summary = { contains: () => true };
  let groupOpacity = "1";
  let shown = true;
  let ariaDisabled: string | null = null;
  const group = {
    getBoundingClientRect: () => ({ ...bounds, right: 340 }),
    closest: () => summary,
    querySelectorAll: (): unknown[] => controls,
    parentElement: null,
  };
  const button = (textContent: string, rectangle = bounds) => ({
    textContent,
    disabled: false,
    getBoundingClientRect: () => rectangle,
    getClientRects: () => (shown ? [rectangle] : []),
    getAttribute: (name: string) => (name === "aria-disabled" ? ariaDisabled : null),
    closest: (): typeof group => group,
    parentElement: group,
  });
  const play = button("Play");
  const activate = button("Use update · 2.0.0-fixture", { ...bounds, left: 136, right: 339 });
  let controls = [play, activate];
  const detail = {
    querySelectorAll: (selector: string) =>
      selector === ".primary-actions button"
        ? [play, activate]
        : [{ textContent: "Updates", getBoundingClientRect: () => ({ top: 100 }) }],
    querySelector: (selector: string) => ({
      textContent: selector.includes("hero-state")
        ? "Ready to play"
        : selector.includes("hero-reason")
          ? ""
          : "Play the installed version or use the saved update 2.0.0-fixture.",
    }),
  };
  const observe = () =>
    object(
      runInNewContext(
        `${layout} readStagedLayout("2.0.0-fixture")`,
        {
          document: {
            querySelector: () => detail,
            documentElement: { scrollWidth: 960, clientWidth: 960 },
          },
          innerWidth: 960,
          innerHeight: 640,
          getComputedStyle: (element: unknown) => ({
            visibility: "visible",
            display: "flex",
            opacity: element === group ? groupOpacity : "1",
            rowGap: "8px",
            columnGap: "8px",
          }),
        },
        { timeout: 1000 },
      ),
    );
  const result = observe();
  assert.equal(result.state, "Ready to play");
  assert.equal(result.reason, "");
  assert.equal(
    result.attention,
    "Play the installed version or use the saved update 2.0.0-fixture.",
  );
  assert.equal(result.documentOverflow, false);
  assert.equal(result.orderedNeighbors, true);
  assert.equal(result.inSummary, true);
  assert.equal(result.rowGap, 8);
  assert.equal(result.columnGap, 8);
  assert.equal(object(result.viewport).width, 960);
  assert.equal(object(result.play).right, 128);
  assert.equal(object(result.play).enabled, true);
  assert.equal(object(result.activate).left, 136);
  assert.equal(object(result.activate).visible, true);
  assert.equal(
    JSON.stringify(result.play),
    JSON.stringify({ ...bounds, enabled: true, visible: true }),
  );
  assert.equal(
    JSON.stringify(result.activate),
    JSON.stringify({ ...bounds, left: 136, right: 339, enabled: true, visible: true }),
  );
  groupOpacity = "0";
  assert.equal(object(observe().play).visible, false);
  assert.equal(object(observe().activate).visible, false);
  groupOpacity = "1";
  shown = false;
  assert.equal(object(observe().play).visible, false);
  assert.equal(object(observe().activate).visible, false);
  shown = true;
  ariaDisabled = "true";
  assert.equal(object(observe().play).enabled, false);
  assert.equal(object(observe().activate).enabled, false);
  ariaDisabled = null;
  play.disabled = true;
  activate.disabled = true;
  assert.equal(object(observe().play).enabled, false);
  assert.equal(object(observe().activate).enabled, false);
  play.disabled = false;
  activate.disabled = false;
  controls = [activate, play];
  assert.equal(observe().orderedNeighbors, false);
  controls = [play, button("Intervening action"), activate];
  assert.equal(observe().orderedNeighbors, false);
  activate.closest = () => ({ ...group });
  assert.equal(observe().orderedNeighbors, false);
});

const placement: unknown = runInNewContext(
  `${segment("function assertStagedActionPlacement(", "export async function installScenarios(")} assertStagedActionPlacement`,
  { assert },
  { timeout: 1000 },
);
function checkPlacement(value: unknown) {
  assert.ok(typeof placement === "function");
  Reflect.apply(placement, undefined, [value]);
}
const row = {
  play: { left: 20, right: 128, top: 20, bottom: 60, enabled: true, visible: true },
  activate: { left: 136, right: 339, top: 20, bottom: 60, enabled: true, visible: true },
  group: { left: 20, right: 340, top: 20, bottom: 60 },
  orderedNeighbors: true,
  inSummary: true,
  rowGap: 8,
  columnGap: 8,
  viewport: { width: 960, height: 640 },
  updatesTop: 100,
  documentOverflow: false,
};
const wrapped = {
  ...row,
  play: { ...row.play, right: 276 },
  activate: { ...row.activate, left: 20, right: 223, top: 68, bottom: 108 },
  group: { ...row.group, right: 276, bottom: 108 },
  updatesTop: 140,
};
for (const [name, value] of [
  ["same row", row],
  ["immediate wrapped row", wrapped],
] as const) {
  void test(`staged actions accept ${name}`, () => checkPlacement(value));
}
const invalid: [string, unknown][] = [
  [
    "far continuation",
    {
      ...wrapped,
      activate: { ...wrapped.activate, top: 200, bottom: 240 },
      group: { ...wrapped.group, bottom: 300 },
      updatesTop: 400,
    },
  ],
  ["horizontal overlap", { ...row, activate: { ...row.activate, left: 120 } }],
  ["vertical overlap", { ...wrapped, activate: { ...wrapped.activate, top: 55, bottom: 95 } }],
  ["reversed visual order", { ...row, play: row.activate, activate: row.play }],
  ["split or intervening controls", { ...row, orderedNeighbors: false }],
  ["outside summary", { ...row, inSummary: false }],
  ["group overflow", { ...row, activate: { ...row.activate, right: 350 } }],
  ["viewport overflow", { ...row, viewport: { width: 300, height: 640 } }],
  ["hidden action", { ...row, activate: { ...row.activate, visible: false } }],
  ["disabled action", { ...row, activate: { ...row.activate, enabled: false } }],
  ["zero size", { ...row, play: { ...row.play, right: row.play.left } }],
  ["nonfinite bounds", { ...row, play: { ...row.play, left: NaN } }],
  ["missing action", { ...row, play: undefined }],
  ["unbounded computed gap", { ...wrapped, rowGap: 200 }],
  ["missing computed gap", { ...wrapped, rowGap: NaN }],
  ["after update decisions", { ...wrapped, updatesTop: 80 }],
  ["document overflow", { ...row, documentOverflow: true }],
];
for (const [name, value] of invalid) {
  void test(`staged actions reject ${name}`, () => assert.throws(() => checkPlacement(value)));
}
